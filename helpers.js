// Pure helper functions for the Ameria Bank MCP server

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creates an MCP error response object.
 * @param {string} message - The error message
 * @returns {{ content: Array<{ type: string, text: string }>, isError: boolean }}
 */
export function errorResponse(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Computes date range timestamps from optional fromDate and toDate strings.
 * Defaults to last 30 days if not specified.
 * @param {string|undefined} fromDate - Start date in YYYY-MM-DD format
 * @param {string|undefined} toDate - End date in YYYY-MM-DD format
 * @returns {{ from: number, to: number }} - Timestamps in milliseconds
 * @throws {Error} If dates are invalid or fromDate > toDate
 */
export function computeDateRange(fromDate, toDate) {
  const now = new Date();

  let from;
  if (fromDate) {
    if (!DATE_RE.test(fromDate)) throw new Error(`Invalid fromDate "${fromDate}". Use YYYY-MM-DD format.`);
    const parsed = new Date(fromDate);
    if (isNaN(parsed.getTime())) throw new Error(`Invalid fromDate "${fromDate}".`);
    from = parsed.getTime();
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30).getTime();
  }

  let to;
  if (toDate) {
    if (!DATE_RE.test(toDate)) throw new Error(`Invalid toDate "${toDate}". Use YYYY-MM-DD format.`);
    const parsed = new Date(toDate + "T23:59:59.999");
    if (isNaN(parsed.getTime())) throw new Error(`Invalid toDate "${toDate}".`);
    to = parsed.getTime();
  } else {
    to = now.getTime();
  }

  if (from > to) throw new Error(`fromDate (${fromDate}) cannot be after toDate (${toDate}).`);

  return { from, to };
}

/**
 * Masks a card number for display, showing first 4 and last 4 digits.
 * @param {string|null|undefined} num - The card number
 * @returns {string} - Masked card number
 */
export function maskCardNumber(num) {
  if (!num) return "****";
  const digits = num.replace(/[^0-9*]/g, "");
  if (digits.length < 8) return num;
  return digits.slice(0, 4) + " **** " + digits.slice(-4);
}

/**
 * Masks an account number for display, showing only last 4 digits.
 * @param {string|null|undefined} num - The account number
 * @returns {string} - Masked account number
 */
export function maskAccountNumber(num) {
  if (!num || num.length < 6) return num || "****";
  return "****" + num.slice(-4);
}

/**
 * Computes income and expense totals grouped by currency.
 * @param {Array} items - Array of items to total
 * @param {Function} getAmount - Extracts amount from item
 * @param {Function} getCurrency - Extracts currency from item
 * @param {Function} getDirection - Extracts direction from item
 * @param {*} incomeValue - The value that indicates income direction
 * @returns {string} - Formatted totals string
 */
export function computeTotals(items, getAmount, getCurrency, getDirection, incomeValue) {
  const byCurrency = {};
  for (const item of items) {
    const currency = getCurrency(item);
    const amount = getAmount(item);
    if (!byCurrency[currency]) byCurrency[currency] = { income: 0, expense: 0 };
    if (getDirection(item) === incomeValue) byCurrency[currency].income += amount;
    else byCurrency[currency].expense += amount;
  }
  return Object.entries(byCurrency)
    .map(([c, { income, expense }]) => `${c}: +${income.toFixed(2)}/-${expense.toFixed(2)}`)
    .join(" | ");
}

/**
 * Formats a transaction object for display.
 * @param {Object} tx - Transaction object
 * @returns {string} - Formatted transaction string
 */
export function formatTransaction(tx) {
  const date = tx.transactionDate
    ? new Date(tx.transactionDate).toISOString().split("T")[0]
    : "Unknown";
  const direction = tx.flowDirection === "INCOME" ? "+" : "-";
  const amt = tx.transactionAmount || {};
  const amount = `${direction}${amt.value ?? "?"} ${amt.currency ?? ""}`;
  const merchant = tx.details || tx.beneficiaryName || "Unknown";
  return `${date} | ${amount} | ${tx.transactionType || "unknown"} | ${merchant}`;
}

/**
 * Formats an account event object for display.
 * @param {Object} entry - Event entry object
 * @returns {string} - Formatted event string
 */
export function formatEvent(entry) {
  const date = entry.operationDate ? entry.operationDate.split("T")[0] : "Unknown";
  const direction = entry.accountingType === "CREDIT" ? "+" : "-";
  const amt = entry.amount || {};
  const amount = `${direction}${amt.amount ?? "?"} ${amt.currency ?? ""}`;
  const merchant = entry.details || entry.beneficiaryName || "Unknown";
  return `${date} | ${amount} | ${entry.transactionType || "unknown"} | ${merchant}`;
}

/**
 * Formats a card object for display.
 * @param {Object} card - Card object
 * @returns {string} - Formatted card string
 */
export function formatCard(card) {
  const balance = card.productType === "EXTERNALCARD"
    ? `${card.balance?.balance ?? "?"} ${card.currency}`
    : `${card.balance ?? "?"} ${card.currency}`;
  const category = card.cardCategory || card.productType;
  const masked = maskCardNumber(card.cardNumber);
  const overdraftInfo = card.overdraft
    ? ` | Overdraft: ${card.overdraft.usedAmount?.amount ?? "?"}/${card.overdraft.initialAmount?.amount ?? "?"} ${card.overdraft.initialAmount?.currency?.code ?? ""} used (${card.overdraft.percentage ?? "?"}%)`
    : "";
  return `${masked} | ${card.name} | ${category} | Balance: ${balance} | Status: ${card.status || "N/A"} | Expires: ${card.expirationDate} | ID: ${card.id} | AccountID: ${card.accountId}${overdraftInfo}`;
}

/**
 * Formats an account object for display.
 * @param {Object} account - Account object
 * @returns {string} - Formatted account string
 */
export function formatAccount(account) {
  const masked = maskAccountNumber(account.accountNumber);
  return `${masked} | ${account.name} | Balance: ${account.balance} ${account.currency} | Status: ${account.status} | ID: ${account.id}`;
}
