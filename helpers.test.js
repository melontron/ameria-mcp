import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DATE_RE,
  errorResponse,
  computeDateRange,
  maskCardNumber,
  maskAccountNumber,
  computeTotals,
  formatTransaction,
  formatEvent,
  formatCard,
  formatAccount,
} from "./helpers.js";

// =============================================================================
// errorResponse
// =============================================================================

describe("errorResponse", () => {
  it("should return MCP error response structure with the message", () => {
    const result = errorResponse("Something went wrong");

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: Something went wrong" }],
      isError: true,
    });
  });

  it("should prepend 'Error: ' to the message", () => {
    const result = errorResponse("Token expired");

    expect(result.content[0].text).toBe("Error: Token expired");
  });

  it("should handle empty string message", () => {
    const result = errorResponse("");

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: " }],
      isError: true,
    });
  });

  it("should handle message with special characters", () => {
    const result = errorResponse('Invalid date "2024-13-45"');

    expect(result.content[0].text).toBe('Error: Invalid date "2024-13-45"');
  });
});

// =============================================================================
// DATE_RE (date regex)
// =============================================================================

describe("DATE_RE", () => {
  it("should match valid YYYY-MM-DD format", () => {
    expect(DATE_RE.test("2024-01-15")).toBe(true);
    expect(DATE_RE.test("2025-12-31")).toBe(true);
    expect(DATE_RE.test("1999-06-01")).toBe(true);
  });

  it("should reject invalid formats", () => {
    expect(DATE_RE.test("01-15-2024")).toBe(false); // MM-DD-YYYY
    expect(DATE_RE.test("15/01/2024")).toBe(false); // DD/MM/YYYY
    expect(DATE_RE.test("2024/01/15")).toBe(false); // slashes
    expect(DATE_RE.test("2024-1-15")).toBe(false); // single digit month
    expect(DATE_RE.test("2024-01-5")).toBe(false); // single digit day
    expect(DATE_RE.test("24-01-15")).toBe(false); // two digit year
  });

  it("should reject dates with extra characters", () => {
    expect(DATE_RE.test("2024-01-15T00:00:00")).toBe(false);
    expect(DATE_RE.test(" 2024-01-15")).toBe(false);
    expect(DATE_RE.test("2024-01-15 ")).toBe(false);
  });

  it("should reject empty and garbage input", () => {
    expect(DATE_RE.test("")).toBe(false);
    expect(DATE_RE.test("not-a-date")).toBe(false);
    expect(DATE_RE.test("YYYY-MM-DD")).toBe(false);
  });
});

// =============================================================================
// computeDateRange
// =============================================================================

describe("computeDateRange", () => {
  beforeEach(() => {
    // Freeze time to 2024-03-15 12:00:00 UTC for deterministic tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("valid date inputs", () => {
    it("should return timestamps for valid fromDate and toDate", () => {
      const result = computeDateRange("2024-01-01", "2024-01-31");

      // fromDate starts at beginning of day (local time)
      expect(result.from).toBe(new Date("2024-01-01").getTime());
      // toDate ends at 23:59:59.999
      expect(result.to).toBe(new Date("2024-01-31T23:59:59.999").getTime());
    });

    it("should default fromDate to 30 days ago when not provided", () => {
      const result = computeDateRange(undefined, "2024-03-15");

      // 30 days before 2024-03-15 is 2024-02-14
      const expected = new Date(2024, 2, 15 - 30).getTime(); // month is 0-indexed
      expect(result.from).toBe(expected);
    });

    it("should default toDate to now when not provided", () => {
      const result = computeDateRange("2024-03-01", undefined);

      // Should be current time (frozen at 2024-03-15T12:00:00.000Z)
      expect(result.to).toBe(new Date("2024-03-15T12:00:00.000Z").getTime());
    });

    it("should default both dates when neither provided", () => {
      const result = computeDateRange(undefined, undefined);

      const now = new Date("2024-03-15T12:00:00.000Z");
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime();

      expect(result.from).toBe(thirtyDaysAgo);
      expect(result.to).toBe(now.getTime());
    });

    it("should allow same day for fromDate and toDate", () => {
      const result = computeDateRange("2024-03-15", "2024-03-15");

      expect(result.from).toBeLessThan(result.to);
    });
  });

  describe("invalid date formats", () => {
    it("should throw for invalid fromDate format (MM-DD-YYYY)", () => {
      expect(() => computeDateRange("03-15-2024", "2024-03-31")).toThrow(
        'Invalid fromDate "03-15-2024". Use YYYY-MM-DD format.'
      );
    });

    it("should throw for invalid toDate format (DD/MM/YYYY)", () => {
      expect(() => computeDateRange("2024-03-01", "15/03/2024")).toThrow(
        'Invalid toDate "15/03/2024". Use YYYY-MM-DD format.'
      );
    });

    it("should throw for fromDate with single digit month", () => {
      expect(() => computeDateRange("2024-3-15", "2024-03-31")).toThrow(
        'Invalid fromDate "2024-3-15". Use YYYY-MM-DD format.'
      );
    });

    it("should throw for toDate with extra characters", () => {
      expect(() => computeDateRange("2024-03-01", "2024-03-15T00:00:00")).toThrow(
        'Invalid toDate "2024-03-15T00:00:00". Use YYYY-MM-DD format.'
      );
    });

    it("should throw for garbage input", () => {
      expect(() => computeDateRange("not-a-date", "2024-03-31")).toThrow(
        'Invalid fromDate "not-a-date". Use YYYY-MM-DD format.'
      );
    });

    it("should treat empty string fromDate as undefined (defaults to 30 days ago)", () => {
      // Empty string is falsy, so it defaults to 30 days ago rather than throwing
      const result = computeDateRange("", "2024-03-31");

      const now = new Date("2024-03-15T12:00:00.000Z"); // frozen time
      const thirtyDaysAgo = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime();

      expect(result.from).toBe(thirtyDaysAgo);
    });
  });

  describe("fromDate > toDate validation", () => {
    it("should throw when fromDate is after toDate", () => {
      expect(() => computeDateRange("2024-03-31", "2024-03-01")).toThrow(
        "fromDate (2024-03-31) cannot be after toDate (2024-03-01)."
      );
    });

    it("should throw with explicit dates in error message", () => {
      try {
        computeDateRange("2024-12-31", "2024-01-01");
        expect.fail("Should have thrown");
      } catch (e) {
        expect(e.message).toContain("2024-12-31");
        expect(e.message).toContain("2024-01-01");
      }
    });
  });

  describe("edge cases", () => {
    it("should handle year boundaries", () => {
      const result = computeDateRange("2023-12-31", "2024-01-01");

      expect(result.from).toBeLessThan(result.to);
    });

    it("should handle leap year date", () => {
      const result = computeDateRange("2024-02-29", "2024-03-01");

      expect(result.from).toBeLessThan(result.to);
    });

    it("should handle dates far in the past", () => {
      const result = computeDateRange("2000-01-01", "2000-12-31");

      expect(result.from).toBe(new Date("2000-01-01").getTime());
    });

    it("should handle dates in the future", () => {
      const result = computeDateRange("2025-01-01", "2025-12-31");

      expect(result.from).toBeLessThan(result.to);
    });
  });
});

// =============================================================================
// maskCardNumber
// =============================================================================

describe("maskCardNumber", () => {
  describe("standard card numbers", () => {
    it("should mask 16-digit card number", () => {
      expect(maskCardNumber("1234567890123456")).toBe("1234 **** 3456");
    });

    it("should mask card number with spaces", () => {
      expect(maskCardNumber("1234 5678 9012 3456")).toBe("1234 **** 3456");
    });

    it("should mask card number with dashes", () => {
      expect(maskCardNumber("1234-5678-9012-3456")).toBe("1234 **** 3456");
    });

    it("should handle card numbers with mixed separators", () => {
      expect(maskCardNumber("1234 5678-9012 3456")).toBe("1234 **** 3456");
    });
  });

  describe("card numbers with existing masks", () => {
    it("should preserve existing asterisks in card number", () => {
      // The regex strips everything except digits and asterisks
      expect(maskCardNumber("1234****5678")).toBe("1234 **** 5678");
    });

    it("should handle partially masked card numbers", () => {
      expect(maskCardNumber("1234********3456")).toBe("1234 **** 3456");
    });
  });

  describe("short card numbers", () => {
    it("should return original for card number shorter than 8 digits", () => {
      expect(maskCardNumber("1234567")).toBe("1234567");
    });

    it("should mask exactly 8 digit card number", () => {
      expect(maskCardNumber("12345678")).toBe("1234 **** 5678");
    });

    it("should return original for very short numbers", () => {
      expect(maskCardNumber("1234")).toBe("1234");
    });
  });

  describe("null-safe handling", () => {
    it("should return '****' for null", () => {
      expect(maskCardNumber(null)).toBe("****");
    });

    it("should return '****' for undefined", () => {
      expect(maskCardNumber(undefined)).toBe("****");
    });

    it("should return '****' for empty string", () => {
      expect(maskCardNumber("")).toBe("****");
    });
  });

  describe("edge cases", () => {
    it("should handle card number with letters (strips them)", () => {
      expect(maskCardNumber("1234ABCD56789012")).toBe("1234 **** 9012");
    });

    it("should handle card number with special characters", () => {
      expect(maskCardNumber("1234!@#$5678%^&*9012")).toBe("1234 **** 9012");
    });

    it("should handle 15-digit Amex-style number", () => {
      expect(maskCardNumber("123456789012345")).toBe("1234 **** 2345");
    });

    it("should handle 19-digit card number", () => {
      expect(maskCardNumber("1234567890123456789")).toBe("1234 **** 6789");
    });
  });
});

// =============================================================================
// maskAccountNumber
// =============================================================================

describe("maskAccountNumber", () => {
  describe("standard account numbers", () => {
    it("should mask long account number showing last 4 digits", () => {
      expect(maskAccountNumber("31023550200")).toBe("****0200");
    });

    it("should mask 10-digit account number", () => {
      expect(maskAccountNumber("1234567890")).toBe("****7890");
    });

    it("should mask 6-digit account number", () => {
      expect(maskAccountNumber("123456")).toBe("****3456");
    });
  });

  describe("short account numbers", () => {
    it("should return original for 5-digit account number", () => {
      expect(maskAccountNumber("12345")).toBe("12345");
    });

    it("should return original for 4-digit account number", () => {
      expect(maskAccountNumber("1234")).toBe("1234");
    });

    it("should return original for 1-digit account number", () => {
      expect(maskAccountNumber("1")).toBe("1");
    });
  });

  describe("null-safe handling", () => {
    it("should return '****' for null", () => {
      expect(maskAccountNumber(null)).toBe("****");
    });

    it("should return '****' for undefined", () => {
      expect(maskAccountNumber(undefined)).toBe("****");
    });

    it("should return '****' for empty string", () => {
      expect(maskAccountNumber("")).toBe("****");
    });
  });

  describe("edge cases", () => {
    it("should handle account number with letters", () => {
      expect(maskAccountNumber("ABCD1234567890")).toBe("****7890");
    });

    it("should handle very long account number", () => {
      expect(maskAccountNumber("12345678901234567890")).toBe("****7890");
    });
  });
});

// =============================================================================
// computeTotals
// =============================================================================

describe("computeTotals", () => {
  describe("single currency calculations", () => {
    it("should compute totals for single currency with income and expense", () => {
      const items = [
        { amount: 100, currency: "AMD", direction: "INCOME" },
        { amount: 50, currency: "AMD", direction: "EXPENSE" },
        { amount: 200, currency: "AMD", direction: "INCOME" },
        { amount: 75, currency: "AMD", direction: "EXPENSE" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("AMD: +300.00/-125.00");
    });

    it("should compute totals with only income", () => {
      const items = [
        { amount: 100, currency: "USD", direction: "INCOME" },
        { amount: 200, currency: "USD", direction: "INCOME" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("USD: +300.00/-0.00");
    });

    it("should compute totals with only expenses", () => {
      const items = [
        { amount: 50, currency: "EUR", direction: "EXPENSE" },
        { amount: 150, currency: "EUR", direction: "EXPENSE" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("EUR: +0.00/-200.00");
    });
  });

  describe("multiple currency grouping", () => {
    it("should group totals by currency", () => {
      const items = [
        { amount: 100, currency: "AMD", direction: "INCOME" },
        { amount: 50, currency: "USD", direction: "INCOME" },
        { amount: 200, currency: "AMD", direction: "EXPENSE" },
        { amount: 25, currency: "USD", direction: "EXPENSE" },
        { amount: 10, currency: "EUR", direction: "INCOME" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      // Order depends on insertion order, but all currencies should be present
      expect(result).toContain("AMD: +100.00/-200.00");
      expect(result).toContain("USD: +50.00/-25.00");
      expect(result).toContain("EUR: +10.00/-0.00");
      expect(result.split(" | ")).toHaveLength(3);
    });

    it("should separate currencies with pipe character", () => {
      const items = [
        { amount: 100, currency: "AMD", direction: "INCOME" },
        { amount: 50, currency: "USD", direction: "INCOME" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toMatch(/\|/);
    });
  });

  describe("different income value configurations", () => {
    it("should work with CREDIT as income value", () => {
      const items = [
        { amount: 100, currency: "AMD", type: "CREDIT" },
        { amount: 50, currency: "AMD", type: "DEBIT" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.type,
        "CREDIT"
      );

      expect(result).toBe("AMD: +100.00/-50.00");
    });

    it("should work with numeric direction values", () => {
      const items = [
        { amount: 100, currency: "AMD", direction: 1 },
        { amount: 50, currency: "AMD", direction: 0 },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        1
      );

      expect(result).toBe("AMD: +100.00/-50.00");
    });
  });

  describe("edge cases", () => {
    it("should return empty string for empty items array", () => {
      const result = computeTotals(
        [],
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("");
    });

    it("should handle decimal amounts", () => {
      const items = [
        { amount: 100.5, currency: "AMD", direction: "INCOME" },
        { amount: 50.25, currency: "AMD", direction: "EXPENSE" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("AMD: +100.50/-50.25");
    });

    it("should handle zero amounts", () => {
      const items = [
        { amount: 0, currency: "AMD", direction: "INCOME" },
        { amount: 0, currency: "AMD", direction: "EXPENSE" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("AMD: +0.00/-0.00");
    });

    it("should handle very large amounts", () => {
      const items = [
        { amount: 1000000000, currency: "AMD", direction: "INCOME" },
      ];

      const result = computeTotals(
        items,
        (i) => i.amount,
        (i) => i.currency,
        (i) => i.direction,
        "INCOME"
      );

      expect(result).toBe("AMD: +1000000000.00/-0.00");
    });
  });
});

// =============================================================================
// formatTransaction
// =============================================================================

describe("formatTransaction", () => {
  describe("complete transaction data", () => {
    it("should format income transaction correctly", () => {
      const tx = {
        transactionDate: "2024-03-15T10:30:00.000Z",
        flowDirection: "INCOME",
        transactionAmount: { value: 50000, currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Salary payment",
      };

      const result = formatTransaction(tx);

      expect(result).toBe("2024-03-15 | +50000 AMD | TRANSFER | Salary payment");
    });

    it("should format expense transaction correctly", () => {
      const tx = {
        transactionDate: "2024-03-15T14:00:00.000Z",
        flowDirection: "EXPENSE",
        transactionAmount: { value: 5000, currency: "AMD" },
        transactionType: "PURCHASE",
        details: "YANDEX TAXI",
      };

      const result = formatTransaction(tx);

      expect(result).toBe("2024-03-15 | -5000 AMD | PURCHASE | YANDEX TAXI");
    });

    it("should use beneficiaryName when details is missing", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "EXPENSE",
        transactionAmount: { value: 1000, currency: "USD" },
        transactionType: "TRANSFER",
        beneficiaryName: "John Doe",
      };

      const result = formatTransaction(tx);

      expect(result).toBe("2024-03-15 | -1000 USD | TRANSFER | John Doe");
    });
  });

  describe("null-safe handling", () => {
    it("should show 'Unknown' for missing date", () => {
      const tx = {
        flowDirection: "INCOME",
        transactionAmount: { value: 100, currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatTransaction(tx);

      expect(result).toMatch(/^Unknown \|/);
    });

    it("should show '?' for missing amount value", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "INCOME",
        transactionAmount: { currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatTransaction(tx);

      expect(result).toContain("+? AMD");
    });

    it("should show empty string for missing currency", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "INCOME",
        transactionAmount: { value: 100 },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatTransaction(tx);

      expect(result).toContain("+100 ");
    });

    it("should show 'unknown' for missing transaction type", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "INCOME",
        transactionAmount: { value: 100, currency: "AMD" },
        details: "Test",
      };

      const result = formatTransaction(tx);

      expect(result).toContain("| unknown |");
    });

    it("should show 'Unknown' for missing details and beneficiaryName", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "INCOME",
        transactionAmount: { value: 100, currency: "AMD" },
        transactionType: "TRANSFER",
      };

      const result = formatTransaction(tx);

      expect(result).toMatch(/\| Unknown$/);
    });

    it("should handle completely missing transactionAmount", () => {
      const tx = {
        transactionDate: "2024-03-15T12:00:00.000Z",
        flowDirection: "INCOME",
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatTransaction(tx);

      expect(result).toContain("+? ");
    });

    it("should handle minimal transaction object", () => {
      const tx = {};

      const result = formatTransaction(tx);

      // Note: there's a trailing space after "?" because currency is empty string
      expect(result).toBe("Unknown | -?  | unknown | Unknown");
    });
  });

  describe("direction handling", () => {
    it("should use + for INCOME direction", () => {
      const tx = { flowDirection: "INCOME", transactionAmount: { value: 100 } };
      const result = formatTransaction(tx);
      expect(result).toContain("+100");
    });

    it("should use - for EXPENSE direction", () => {
      const tx = { flowDirection: "EXPENSE", transactionAmount: { value: 100 } };
      const result = formatTransaction(tx);
      expect(result).toContain("-100");
    });

    it("should use - for any non-INCOME direction", () => {
      const tx = { flowDirection: "OTHER", transactionAmount: { value: 100 } };
      const result = formatTransaction(tx);
      expect(result).toContain("-100");
    });

    it("should use - for undefined direction", () => {
      const tx = { transactionAmount: { value: 100 } };
      const result = formatTransaction(tx);
      expect(result).toContain("-100");
    });
  });
});

// =============================================================================
// formatEvent
// =============================================================================

describe("formatEvent", () => {
  describe("complete event data", () => {
    it("should format credit event correctly", () => {
      const entry = {
        operationDate: "2024-03-15T10:30:00.000Z",
        accountingType: "CREDIT",
        amount: { amount: 50000, currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Incoming transfer",
      };

      const result = formatEvent(entry);

      expect(result).toBe("2024-03-15 | +50000 AMD | TRANSFER | Incoming transfer");
    });

    it("should format debit event correctly", () => {
      const entry = {
        operationDate: "2024-03-15T14:00:00.000Z",
        accountingType: "DEBIT",
        amount: { amount: 5000, currency: "AMD" },
        transactionType: "PURCHASE",
        details: "Card purchase",
      };

      const result = formatEvent(entry);

      expect(result).toBe("2024-03-15 | -5000 AMD | PURCHASE | Card purchase");
    });

    it("should use beneficiaryName when details is missing", () => {
      const entry = {
        operationDate: "2024-03-15T12:00:00.000Z",
        accountingType: "DEBIT",
        amount: { amount: 1000, currency: "USD" },
        transactionType: "TRANSFER",
        beneficiaryName: "Jane Smith",
      };

      const result = formatEvent(entry);

      expect(result).toBe("2024-03-15 | -1000 USD | TRANSFER | Jane Smith");
    });
  });

  describe("null-safe handling", () => {
    it("should show 'Unknown' for missing operation date", () => {
      const entry = {
        accountingType: "CREDIT",
        amount: { amount: 100, currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatEvent(entry);

      expect(result).toMatch(/^Unknown \|/);
    });

    it("should show '?' for missing amount value", () => {
      const entry = {
        operationDate: "2024-03-15T12:00:00.000Z",
        accountingType: "CREDIT",
        amount: { currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatEvent(entry);

      expect(result).toContain("+? AMD");
    });

    it("should handle missing amount object", () => {
      const entry = {
        operationDate: "2024-03-15T12:00:00.000Z",
        accountingType: "CREDIT",
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatEvent(entry);

      expect(result).toContain("+? ");
    });

    it("should handle minimal event object", () => {
      const entry = {};

      const result = formatEvent(entry);

      // Note: there's a trailing space after "?" because currency is empty string
      expect(result).toBe("Unknown | -?  | unknown | Unknown");
    });
  });

  describe("direction handling", () => {
    it("should use + for CREDIT accounting type", () => {
      const entry = { accountingType: "CREDIT", amount: { amount: 100 } };
      const result = formatEvent(entry);
      expect(result).toContain("+100");
    });

    it("should use - for DEBIT accounting type", () => {
      const entry = { accountingType: "DEBIT", amount: { amount: 100 } };
      const result = formatEvent(entry);
      expect(result).toContain("-100");
    });

    it("should use - for any non-CREDIT accounting type", () => {
      const entry = { accountingType: "OTHER", amount: { amount: 100 } };
      const result = formatEvent(entry);
      expect(result).toContain("-100");
    });
  });

  describe("date extraction", () => {
    it("should extract date portion from ISO string", () => {
      const entry = {
        operationDate: "2024-12-31T23:59:59.999Z",
        accountingType: "CREDIT",
        amount: { amount: 100, currency: "AMD" },
        transactionType: "TRANSFER",
        details: "Test",
      };

      const result = formatEvent(entry);

      expect(result).toMatch(/^2024-12-31/);
    });
  });
});

// =============================================================================
// formatCard
// =============================================================================

describe("formatCard", () => {
  describe("standard Ameria card", () => {
    it("should format card with all fields", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "My Visa Card",
        cardCategory: "VISA",
        productType: "CARD",
        balance: 50000,
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "12/25",
        id: "123456",
        accountId: "31023550200",
      };

      const result = formatCard(card);

      expect(result).toBe(
        "1234 **** 3456 | My Visa Card | VISA | Balance: 50000 AMD | Status: ACTIVE | Expires: 12/25 | ID: 123456 | AccountID: 31023550200"
      );
    });

    it("should use productType when cardCategory is missing", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "My Card",
        productType: "CARD",
        balance: 1000,
        currency: "USD",
        status: "ACTIVE",
        expirationDate: "01/26",
        id: "789",
        accountId: "12345",
      };

      const result = formatCard(card);

      expect(result).toContain("| CARD |");
    });
  });

  describe("external card", () => {
    it("should format external card with nested balance", () => {
      const card = {
        cardNumber: "9876543210987654",
        name: "External Card",
        productType: "EXTERNALCARD",
        balance: { balance: 25000 },
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "06/27",
        id: "ext123",
        accountId: "ext456",
      };

      const result = formatCard(card);

      expect(result).toContain("Balance: 25000 AMD");
    });

    it("should show '?' for missing external card balance", () => {
      const card = {
        cardNumber: "9876543210987654",
        name: "External Card",
        productType: "EXTERNALCARD",
        balance: {},
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "06/27",
        id: "ext123",
        accountId: "ext456",
      };

      const result = formatCard(card);

      expect(result).toContain("Balance: ? AMD");
    });
  });

  describe("card with overdraft", () => {
    it("should include overdraft information when present", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "Overdraft Card",
        cardCategory: "MASTERCARD",
        productType: "CARD",
        balance: 10000,
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "03/26",
        id: "od123",
        accountId: "od456",
        overdraft: {
          usedAmount: { amount: 5000 },
          initialAmount: { amount: 50000, currency: { code: "AMD" } },
          percentage: 10,
        },
      };

      const result = formatCard(card);

      expect(result).toContain("| Overdraft: 5000/50000 AMD used (10%)");
    });

    it("should handle partial overdraft data", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "Overdraft Card",
        cardCategory: "VISA",
        productType: "CARD",
        balance: 10000,
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "03/26",
        id: "od123",
        accountId: "od456",
        overdraft: {},
      };

      const result = formatCard(card);

      // Note: the format includes a space after currency code (empty) and "%" after percentage
      expect(result).toContain("| Overdraft: ?/?  used (?%)");
    });
  });

  describe("null-safe handling", () => {
    it("should show 'N/A' for missing status", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "Test Card",
        productType: "CARD",
        balance: 1000,
        currency: "AMD",
        expirationDate: "12/25",
        id: "123",
        accountId: "456",
      };

      const result = formatCard(card);

      expect(result).toContain("Status: N/A");
    });

    it("should show '?' for missing balance", () => {
      const card = {
        cardNumber: "1234567890123456",
        name: "Test Card",
        productType: "CARD",
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "12/25",
        id: "123",
        accountId: "456",
      };

      const result = formatCard(card);

      expect(result).toContain("Balance: ? AMD");
    });

    it("should mask null card number", () => {
      const card = {
        cardNumber: null,
        name: "Test Card",
        productType: "CARD",
        balance: 1000,
        currency: "AMD",
        status: "ACTIVE",
        expirationDate: "12/25",
        id: "123",
        accountId: "456",
      };

      const result = formatCard(card);

      expect(result).toMatch(/^\*{4} \|/);
    });
  });
});

// =============================================================================
// formatAccount
// =============================================================================

describe("formatAccount", () => {
  describe("standard account", () => {
    it("should format account with all fields", () => {
      const account = {
        accountNumber: "31023550200",
        name: "Savings Account",
        balance: 100000,
        currency: "AMD",
        status: "ACTIVE",
        id: "acc123",
      };

      const result = formatAccount(account);

      expect(result).toBe(
        "****0200 | Savings Account | Balance: 100000 AMD | Status: ACTIVE | ID: acc123"
      );
    });

    it("should handle different currencies", () => {
      const account = {
        accountNumber: "12345678901",
        name: "USD Account",
        balance: 5000.5,
        currency: "USD",
        status: "ACTIVE",
        id: "usd456",
      };

      const result = formatAccount(account);

      expect(result).toContain("Balance: 5000.5 USD");
    });
  });

  describe("null-safe handling", () => {
    it("should mask null account number", () => {
      const account = {
        accountNumber: null,
        name: "Test Account",
        balance: 1000,
        currency: "AMD",
        status: "ACTIVE",
        id: "123",
      };

      const result = formatAccount(account);

      expect(result).toMatch(/^\*{4} \|/);
    });

    it("should handle short account number", () => {
      const account = {
        accountNumber: "12345",
        name: "Short Account",
        balance: 500,
        currency: "AMD",
        status: "ACTIVE",
        id: "short1",
      };

      const result = formatAccount(account);

      expect(result).toMatch(/^12345 \|/);
    });

    it("should handle undefined fields", () => {
      const account = {
        accountNumber: "31023550200",
        name: undefined,
        balance: undefined,
        currency: undefined,
        status: undefined,
        id: undefined,
      };

      const result = formatAccount(account);

      expect(result).toBe(
        "****0200 | undefined | Balance: undefined undefined | Status: undefined | ID: undefined"
      );
    });
  });

  describe("edge cases", () => {
    it("should handle zero balance", () => {
      const account = {
        accountNumber: "31023550200",
        name: "Empty Account",
        balance: 0,
        currency: "AMD",
        status: "ACTIVE",
        id: "empty1",
      };

      const result = formatAccount(account);

      expect(result).toContain("Balance: 0 AMD");
    });

    it("should handle negative balance", () => {
      const account = {
        accountNumber: "31023550200",
        name: "Overdrawn Account",
        balance: -5000,
        currency: "AMD",
        status: "ACTIVE",
        id: "neg1",
      };

      const result = formatAccount(account);

      expect(result).toContain("Balance: -5000 AMD");
    });
  });
});
