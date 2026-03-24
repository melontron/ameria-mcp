#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  errorResponse,
  computeDateRange,
  computeTotals,
  formatTransaction,
  formatEvent,
  formatCard,
  formatAccount,
} from "./helpers.js";

const AMERIA_BASE_URL = "https://ob.myameria.am/api";
const TOKEN_URL = "https://account.myameria.am/auth/realms/ameria/protocol/openid-connect/token";
const REQUEST_TIMEOUT_MS = 30_000;

// --- Vault abstraction ---
// AMERIA_VAULT: "1password" | "keychain" | unset (env-only, no persistence)
// AMERIA_VAULT_KEY: the item name/ID in the vault (e.g. "ameria-mcp" or "Ameria Bank")

const VAULT_TYPE = (process.env.AMERIA_VAULT || "").toLowerCase();
const VAULT_KEY = process.env.AMERIA_VAULT_KEY || "";

async function _exec(cmd, args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const { stdout } = await run(cmd, args, { timeout: 10_000 });
  return stdout.trim();
}

const vault = {
  async read(field) {
    if (VAULT_TYPE === "1password") {
      // op read "op://Private/VAULT_KEY/field"
      // For simplicity, use item get with field extraction
      return _exec("op", ["item", "get", VAULT_KEY, "--fields", field, "--reveal"]);
    }
    if (VAULT_TYPE === "keychain") {
      // macOS Keychain: service = VAULT_KEY, account = field
      return _exec("security", ["find-generic-password", "-s", VAULT_KEY, "-a", field, "-w"]);
    }
    return null;
  },

  async write(field, value) {
    if (VAULT_TYPE === "1password") {
      await _exec("op", ["item", "edit", VAULT_KEY, `${field}=${value}`]);
      console.error(`[ameria-mcp] Saved ${field} to 1Password (${VAULT_KEY})`);
      return;
    }
    if (VAULT_TYPE === "keychain") {
      // Delete old entry if exists, then add new one
      try {
        await _exec("security", ["delete-generic-password", "-s", VAULT_KEY, "-a", field]);
      } catch { /* entry may not exist yet */ }
      await _exec("security", ["add-generic-password", "-s", VAULT_KEY, "-a", field, "-w", value, "-U"]);
      console.error(`[ameria-mcp] Saved ${field} to macOS Keychain (${VAULT_KEY})`);
      return;
    }
    // No vault configured — nothing to persist
  },

  get enabled() {
    return (VAULT_TYPE === "1password" || VAULT_TYPE === "keychain") && VAULT_KEY !== "";
  },
};

// --- Token state ---

let refreshToken = process.env.AMERIA_TOKEN || null;
let clientAuth = process.env.AMERIA_CLIENT_AUTH || null; // Base64 "client_id:client_secret"
let clientId = process.env.AMERIA_CLIENT_ID || null; // Client-Id header for API calls
let accessToken = null;
let tokenExpiresAt = 0;

async function loadCredentials() {
  // Load refresh_token
  if (!refreshToken && vault.enabled) {
    try {
      refreshToken = await vault.read("refresh_token");
      if (refreshToken) console.error(`[ameria-mcp] Loaded refresh_token from ${VAULT_TYPE}`);
    } catch (err) {
      console.error(`[ameria-mcp] Could not read refresh_token from ${VAULT_TYPE}: ${err.message}`);
    }
  }
  if (!refreshToken) {
    throw new Error("No refresh token found. Set AMERIA_TOKEN env var, or store refresh_token in your vault.");
  }

  // Load client_auth
  if (!clientAuth && vault.enabled) {
    try {
      clientAuth = await vault.read("client_auth");
      if (clientAuth) console.error(`[ameria-mcp] Loaded client_auth from ${VAULT_TYPE}`);
    } catch (err) {
      console.error(`[ameria-mcp] Could not read client_auth from ${VAULT_TYPE}: ${err.message}`);
    }
  }
  if (!clientAuth) {
    throw new Error("No client_auth found. Set AMERIA_CLIENT_AUTH env var, or store client_auth in your vault (Base64-encoded client_id:client_secret).");
  }

  // Load client_id
  if (!clientId && vault.enabled) {
    try {
      clientId = await vault.read("client_id");
      if (clientId) console.error(`[ameria-mcp] Loaded client_id from ${VAULT_TYPE}`);
    } catch (err) {
      console.error(`[ameria-mcp] Could not read client_id from ${VAULT_TYPE}: ${err.message}`);
    }
  }
  if (!clientId) {
    throw new Error("No client_id found. Set AMERIA_CLIENT_ID env var, or store client_id in your vault.");
  }
}

async function refreshAccessToken() {
  await loadCredentials();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${clientAuth}`,
      Origin: "https://myameria.am",
      Referer: "https://myameria.am/",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${body.slice(0, 200)}. The refresh token may have expired — log into myameria.am and get a new one.`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  // Refresh 30s before actual expiry to avoid race conditions
  tokenExpiresAt = Date.now() + (data.expires_in - 30) * 1000;

  // If Keycloak rotated the refresh token, update in memory + vault
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    refreshToken = data.refresh_token;
    if (vault.enabled) {
      vault.write("refresh_token", data.refresh_token).catch((err) =>
        console.error(`[ameria-mcp] Failed to save rotated refresh token: ${err.message}`)
      );
    }
  }

  return accessToken;
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }
  return refreshAccessToken();
}

const server = new McpServer({
  name: "ameria-bank",
  version: "1.0.0",
});

// --- API Client ---

async function ameriaFetch(path, params, _retried = false) {
  const token = await getAccessToken();

  const url = new URL(path, AMERIA_BASE_URL + "/");
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Client-Id": clientId,
      Locale: "hy",
      "Timezone-Offset": "-240",
      Origin: "https://myameria.am",
      Referer: "https://myameria.am/",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // On 401, force-refresh the token and retry once
  if ((res.status === 401 || res.status === 403) && !_retried) {
    accessToken = null;
    tokenExpiresAt = 0;
    return ameriaFetch(path, params, true);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("Authentication failed after token refresh. The refresh token may have expired — log into myameria.am and get a new one.");
  }

  if (!res.ok) {
    throw new Error(`Ameria API returned ${res.status} ${res.statusText}. The bank API may be temporarily unavailable.`);
  }

  const result = await res.json();

  if (result.status !== "success") {
    throw new Error(`Ameria API error: ${JSON.stringify(result.errorMessages)}`);
  }

  return result;
}

// --- Shared Schemas ---

const dateSchema = {
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional()
    .describe("Start date in YYYY-MM-DD format (defaults to 30 days ago)"),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional()
    .describe("End date in YYYY-MM-DD format (defaults to today)"),
};

const paginationSchema = {
  page: z.number().int().min(1).max(1000).optional()
    .describe("Page number, starts at 1 (default: 1)"),
  size: z.number().int().min(1).max(100).optional()
    .describe("Number of items per page, max 100 (default: 50)"),
};

const readOnlyAnnotations = {
  destructiveHint: false,
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// --- Tools ---

server.tool(
  "get_transactions",
  "Get transaction history from Ameria Bank. Returns a page of transactions within a date range. Defaults to last 30 days. Use page parameter to paginate — check hasNext in the response to know if more pages exist. For finding specific merchants, prefer search_transactions instead.",
  { ...dateSchema, ...paginationSchema },
  readOnlyAnnotations,
  async ({ fromDate, toDate, page, size }) => {
    try {
      const { from, to } = computeDateRange(fromDate, toDate);

      const result = await ameriaFetch("history", {
        fromDate: from,
        toDate: to,
        page: page || 1,
        size: size || 50,
      });

      const { transactions, hasNext } = result.data;
      const lines = transactions.map(formatTransaction);
      const totals = computeTotals(
        transactions,
        (tx) => tx.transactionAmount?.value ?? 0,
        (tx) => tx.transactionAmount?.currency ?? "AMD",
        (tx) => tx.flowDirection,
        "INCOME"
      );

      const summary = [
        `Page ${page || 1} | ${transactions.length} transactions | hasNext: ${hasNext}`,
        `Page totals — ${totals}`,
        "---",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (error) {
      return errorResponse(error.message);
    }
  }
);

server.tool(
  "search_transactions",
  "Search Ameria Bank transactions by keyword within a date range. Filters against merchant names, transfer descriptions, and beneficiary names (case-insensitive). IMPORTANT: searches within a single page only — to find all matches, iterate through pages or use a larger page size. Useful for questions like 'how much did I spend on YANDEX this month?'.",
  {
    query: z.string().describe("Search keyword to match against transaction details and beneficiary name (case-insensitive)"),
    ...dateSchema,
    ...paginationSchema,
  },
  readOnlyAnnotations,
  async ({ query, fromDate, toDate, page, size }) => {
    try {
      const { from, to } = computeDateRange(fromDate, toDate);

      const result = await ameriaFetch("history", {
        fromDate: from,
        toDate: to,
        page: page || 1,
        size: size || 50,
      });

      const { transactions, hasNext } = result.data;
      const q = query.toLowerCase();
      const matched = transactions.filter((tx) => {
        const haystack = `${tx.details || ""} ${tx.beneficiaryName || ""}`.toLowerCase();
        return haystack.includes(q);
      });

      const lines = matched.map(formatTransaction);
      const totals = computeTotals(
        matched,
        (tx) => tx.transactionAmount?.value ?? 0,
        (tx) => tx.transactionAmount?.currency ?? "AMD",
        (tx) => tx.flowDirection,
        "INCOME"
      );

      const summary = [
        `Search: "${query}" | Page ${page || 1} | ${matched.length} matches out of ${transactions.length} transactions | hasNext: ${hasNext}`,
        `Matched totals — ${totals}`,
        "---",
        ...(lines.length > 0 ? lines : ["No matching transactions found."]),
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (error) {
      return errorResponse(error.message);
    }
  }
);

server.tool(
  "get_accounts_and_cards",
  "Get all accounts and cards from Ameria Bank. Returns balances, card types, statuses, overdraft info, and product IDs. Includes both Ameria cards and linked external cards. Call this FIRST to discover available account/card IDs before using get_available_balance or get_account_events.",
  {},
  readOnlyAnnotations,
  async () => {
    try {
      const result = await ameriaFetch("accounts-and-cards", {
        size: 8,
        skipApplications: true,
        specifications: "SIMPLE",
        isFullList: true,
      });

      const { accountsAndCards } = result.data;

      const cards = accountsAndCards.filter((item) => item.productType === "CARD");
      const externalCards = accountsAndCards.filter((item) => item.productType === "EXTERNALCARD");
      const accounts = accountsAndCards.filter((item) => item.productType === "ACCOUNT");

      const sections = [];

      if (cards.length > 0) {
        sections.push(`## Ameria Cards (${cards.length})`, ...cards.map(formatCard));
      }
      if (externalCards.length > 0) {
        sections.push("", `## External Cards (${externalCards.length})`, ...externalCards.map(formatCard));
      }
      if (accounts.length > 0) {
        sections.push("", `## Accounts (${accounts.length})`, ...accounts.map(formatAccount));
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (error) {
      return errorResponse(error.message);
    }
  }
);

server.tool(
  "get_available_balance",
  "Get detailed balance breakdown for a specific card or account. Returns balance, available balance, frozen balance, and offline available amount. Use get_accounts_and_cards first to find the product ID.",
  {
    productId: z.string().describe("The product ID of the card or account (e.g. '1128773037' — get this from get_accounts_and_cards 'id' field)"),
    productType: z.enum(["CARD", "ACCOUNT"]).optional().describe("Product type (default: 'CARD')"),
  },
  readOnlyAnnotations,
  async ({ productId, productType }) => {
    try {
      const result = await ameriaFetch("accounts-and-cards/available-balance", {
        productType: productType || "CARD",
        productId,
      });

      const d = result.data;
      const lines = [
        `Balance: ${d.balance}`,
        `Available: ${d.availableBalance}`,
        `Frozen: ${d.frozenBalance}`,
        `Offline Available: ${d.offlineAvailable}`,
      ];
      if (d.details) lines.push(`Details: ${d.details}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return errorResponse(error.message);
    }
  }
);

server.tool(
  "get_account_events",
  "Get past events (transactions) for a specific Ameria Bank account. Filters by account and minimum amount. Use get_accounts_and_cards first to find the accountId — use the 'accountId' field from cards or 'id' field from accounts (e.g. '31023550200').",
  {
    accountIds: z.string().describe("Account ID to filter by (e.g. '31023550200' — from get_accounts_and_cards)"),
    fromAmount: z.number().min(0).optional().describe("Minimum transaction amount to include (default: 0.1)"),
    ...paginationSchema,
  },
  readOnlyAnnotations,
  async ({ accountIds, fromAmount, page, size }) => {
    try {
      const result = await ameriaFetch("events/past", {
        locale: "hy",
        fromAmount: fromAmount ?? 0.1,
        accountIds,
        sort: "date",
        size: size || 50,
        page: page || 1,
      });

      const { totalCount, entries } = result.data;
      const lines = entries.map(formatEvent);
      const totals = computeTotals(
        entries,
        (e) => e.amount?.amount ?? 0,
        (e) => e.amount?.currency ?? "AMD",
        (e) => e.accountingType,
        "CREDIT"
      );

      const hasNext = (page || 1) * (size || 50) < totalCount;

      const summary = [
        `Account: ${accountIds} | Page ${page || 1} | ${entries.length} events | Total: ${totalCount} | hasNext: ${hasNext}`,
        `Page totals — ${totals}`,
        "---",
        ...lines,
      ].join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (error) {
      return errorResponse(error.message);
    }
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
