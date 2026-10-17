/*
 * Safe, actionable diagnostics. Every error shown to the user goes through classify(), which
 * redacts secrets and maps Databricks/HTTP failures to a plain-language title and concrete next
 * steps, while preserving the sanitized SQL error code and statement ID.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('./core/validate.js') : root.DCC.validate;

  const REDACTIONS = [
    [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
    [/\bdapi[0-9a-f]{32}(?:-\d+)?\b/gi, '[redacted-pat]'],
    [/\b(?:dose|dkea|dsapi)[0-9a-f]{32}\b/gi, '[redacted-token]'],
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
    [/("?(?:access_token|refresh_token|id_token|client_secret|token|password|secret)"?\s*[:=]\s*)"?[^"\s,}&]+"?/gi, '$1[redacted]'],
    [/(x-dcc-key\s*[:=]\s*)[0-9a-f]{24}/gi, '$1[redacted]'],
    [/([#?&](?:key|k|pairing)=)[0-9a-f]{24}/gi, '$1[redacted]'],
    [/\b[0-9a-f]{24}\b/g, '[redacted-key]'],
  ];

  function redact(text) {
    let out = V.safeText(text, 2000);
    for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
    return out;
  }

  const CATALOG = {
    WAREHOUSE_ACCESS_DENIED: {
      title: 'No permission to use the selected SQL warehouse',
      steps: ['Ask a workspace admin for CAN USE on the warehouse, or pick another warehouse under Connection preferences.'],
    },
    BILLING_ACCESS_DENIED: {
      title: 'No permission to read billing system tables',
      steps: [
        'Ask an account or metastore admin to grant USE CATALOG on system, USE SCHEMA on system.billing, and SELECT on system.billing.usage and the selected price table.',
      ],
    },
    HISTORY_ACCESS_DENIED: {
      title: 'No permission to read query history',
      steps: ['Ask an admin for SELECT on system.query.history (or the configured approved view). Workspace totals keep working without it.'],
    },
    LAKEFLOW_ACCESS_DENIED: {
      title: 'No permission to read job/pipeline timelines',
      steps: ['Ask an admin for SELECT on system.lakeflow tables. Until then, job amounts are labeled "Direct job cost".'],
    },
    TABLE_ACCESS_DENIED: {
      title: 'No permission to read a required table',
      steps: ['Ask an admin for USE CATALOG, USE SCHEMA and SELECT on the table named in the technical details.'],
    },
    TABLE_NOT_FOUND: {
      title: 'A required table is not available',
      steps: [
        'Check that system tables are enabled for this metastore (system.billing, system.query, system.lakeflow).',
        'If the missing table is system.billing.account_prices, it may not be available for your account or cloud; switch the price table to system.billing.list_prices.',
      ],
    },
    PRICE_FIELD_MISMATCH: {
      title: 'Price table and price field do not match',
      steps: [
        'The query read pricing.effective_list from a table that does not have it: an account-price table was queried by a list-price adapter.',
        'Reload the extension and reconnect; if you use the local helper, restart it so both use the same price adapter.',
        'Only system.billing.list_prices and system.billing.account_prices are supported. Do not create a custom price view.',
      ],
    },
    SCHEMA_MISMATCH: {
      title: 'A table does not have the expected columns',
      steps: ['If you configured an approved view, make sure it exposes the same columns as the system table it replaces.', 'Otherwise, update the extension.'],
    },
    UNMATCHED_PRICES: {
      title: 'Some usage has no matching price',
      steps: ['Amounts are shown as a priced subtotal. See the expanded details for affected SKUs and dates.'],
    },
    SESSION_TAB_REQUIRED: {
      title: 'Open a Databricks tab for this workspace',
      steps: ['"Use my Databricks login" works through an open workspace tab. Open (or reload) a tab for this workspace and try again, or switch to Sign in with Databricks for background features.'],
    },
    SESSION_REJECTED: {
      title: 'Databricks did not accept your browser login for API calls',
      steps: [
        'The Databricks API answered that a browser login is not a supported credential for it. Nothing is wrong with your login.',
        'Use a personal access token (create it with the sql scope and tick Remember on this computer), or Sign in with Databricks.',
      ],
    },
    SESSION_EXPIRED: {
      title: 'Your Databricks login in this browser has expired',
      steps: ['Sign in to Databricks again in the workspace tab, then select Refresh.'],
    },
    AUTH_EXPIRED: {
      title: 'Sign-in expired',
      steps: ['Reconnect from the extension popup. For a personal access token, create a new token and save it under Connection preferences.'],
    },
    AUTH_INVALID: {
      title: 'Databricks rejected the credentials',
      steps: ['Check the token or sign in again from Connection preferences.'],
    },
    OAUTH_CLIENT_MISSING: {
      title: 'One-time sign-in setup needed',
      steps: [
        'An account admin registers Lakeline once: account console, Settings, App connections, Add connection. Redirect URL: the one shown in the extension. Scopes: SQL and All APIs. No client secret.',
        'Paste the resulting client ID in the extension. After that, Connect is one click for every workspace in that account.',
      ],
    },
    OAUTH_CLIENT_INVALID: {
      title: 'Databricks did not accept the OAuth client ID',
      steps: ['Check the client ID, and that the app connection lists the redirect URL shown in the extension. New app connections can take about 30 minutes to activate.'],
    },
    AUTH_CANCELLED: {
      title: 'Sign-in was cancelled',
      steps: ['Click Connect again and finish signing in to Databricks. If Databricks showed an error instead of signing you in, use a personal access token: Other ways to sign in, Use a token.'],
    },
    BUILTIN_SIGNIN_BLOCKED: {
      title: 'This Databricks account does not allow quick sign-in',
      steps: ['An admin may have turned off the built-in sign-in app. Use a personal access token instead: Other ways to sign in, Use a token.', 'Or ask an account admin to register Lakeline once and use that app connection.'],
    },
    PAT_REJECTED: {
      title: 'Databricks did not accept this token',
      steps: ['Check that you copied the whole token and that it has not expired or been revoked. Create a new one in Databricks: Settings, Developer, Access tokens.', 'If your workspace turned off personal access tokens, use Sign in with Databricks instead.'],
    },
    PAT_FORMAT: {
      title: 'That does not look like a Databricks token',
      steps: ['Copy the whole token from Databricks: Settings, Developer, Access tokens, Generate new token. It usually starts with dapi.'],
    },
    NETWORK: {
      title: 'Could not reach Databricks',
      steps: ['Check your network or VPN, then select Refresh.'],
    },
    SQL_TIMEOUT: {
      title: 'The cost query is taking too long',
      steps: ['The warehouse may be starting or busy. Wait a minute and select Refresh, or choose a running warehouse.'],
    },
    WAREHOUSE_UNAVAILABLE: {
      title: 'The selected warehouse is unavailable',
      steps: ['It may have been deleted or you may have lost access. Pick another warehouse under Connection preferences.'],
    },
    RESULT_TOO_LARGE: {
      title: 'The result was too large to show completely',
      steps: ['Narrow the period or filters. Partial results are never shown as complete totals.'],
    },
    HELPER_UNREACHABLE: {
      title: 'The local helper is not running',
      steps: ['Run the start script again (start-helper.command), then select Connect workspace.'],
    },
    HELPER_OUTDATED: {
      title: 'The running local helper is outdated',
      steps: ['Stop the old helper (close its terminal window or press Ctrl+C), run the start script again, then reconnect.'],
    },
    HELPER_CLI_MISSING: {
      title: 'Databricks CLI not found or too old',
      steps: ['Install or update the Databricks CLI (v1.12 or newer), then restart the helper. Or use a personal access token instead.'],
    },
    WORKSPACE_MISMATCH: {
      title: 'This page belongs to a different workspace',
      steps: ['The cost connection for this site is saved for another workspace ID. Open Connection preferences to choose which workspace to connect.'],
    },
    NOT_CONNECTED: {
      title: 'Not connected',
      steps: ['Open the extension popup and select Connect Databricks, or switch to Demo mode.'],
    },
    PERMISSION_NOT_GRANTED: {
      title: 'Site access not granted',
      steps: ['Open the extension popup on this workspace and allow access when asked.'],
    },
    GENIE_SIGNIN: {
      title: 'Allow Genie for this workspace',
      steps: ['Select "Allow Genie and run status". Databricks asks once for API access (all-apis). The run monitor uses the same sign-in, and cost queries keep their SQL-only sign-in.'],
    },
    GENIE_PAT_MISSING: {
      title: 'Save a personal access token first',
      steps: ['This workspace connects with a personal access token, and none is saved in this browser session. Open Connection preferences, save the token, then ask again.'],
    },
    GENIE_HELPER_MODE: {
      title: 'Genie needs Sign in with Databricks or a personal access token',
      steps: ['This workspace connects through the local helper, which runs cost queries only. Reconnect it with Connect in the popup (Sign in with Databricks), or save a personal access token in Connection preferences.'],
    },
    GENIE_AUTH_UNSUPPORTED: {
      title: 'Genie needs Sign in with Databricks or a personal access token',
      steps: ['This workspace connects with "Use my Databricks login", which relays through an open tab, so Genie can\'t keep working in the background with it. Reconnect with Sign in with Databricks from the popup, or save a personal access token in Connection preferences.'],
    },
    GENIE_MODE: {
      title: 'Genie is off in Local import mode',
      steps: ['Local import makes no Databricks requests. Switch to Connected mode in the popup to ask your Genie Agents, or to Demo mode to try the panel with synthetic answers.'],
    },
    GENIE_RATE_LIMITED: {
      title: 'Genie is busy right now',
      steps: ['Databricks limited how many questions can run at once in this workspace. Wait a minute, then ask again. This question was not answered.'],
    },
    GENIE_ACCESS_DENIED: {
      title: 'No access to this Genie Agent',
      steps: [
        'Ask the agent\'s owner to share it with you. Genie also needs the Databricks SQL entitlement and CAN USE on the agent\'s SQL warehouse.',
        'A personal access token with limited scopes needs the genie scope.',
      ],
    },
    GENIE_NOT_FOUND: {
      title: 'Genie Agent not found',
      steps: ['It may have been deleted or you may have lost access. Pick another agent from the list.'],
    },
    GENIE_UNAVAILABLE: {
      title: 'Genie isn\'t available in this workspace',
      steps: ['Genie Agents may be turned off for this workspace. Ask a workspace admin, or try another workspace.'],
    },
    GENIE_FAILED: {
      title: 'Genie couldn\'t answer',
      steps: ['Rephrase the question, or ask about data this agent covers, then try again.'],
    },
    GENIE_TIMEOUT: {
      title: 'Genie took too long',
      steps: ['There was no answer after 10 minutes, so Lakeline stopped waiting. The SQL warehouse may be starting or busy. Ask again in a moment.'],
    },
    GENIE_CANCELLED: {
      title: 'This question was cancelled',
      steps: ['It was cancelled in Databricks. Ask again if you still need the answer.'],
    },
    GENIE_SEND_UNCONFIRMED: {
      title: 'Couldn\'t confirm the question reached Genie',
      steps: ['The request stopped before Databricks confirmed it. Ask again. If Genie did receive it, the answer is also in the agent\'s history in Databricks.'],
    },
    GENIE_BUSY: {
      title: 'Genie is still answering',
      steps: ['Wait for the current answer, or start a new conversation. Up to three questions can run at once.'],
    },
    GENIE_RESULT_EXPIRED: {
      title: 'The query result expired',
      steps: ['Select Run query again to refresh the table. The query runs on the agent\'s SQL warehouse.'],
    },
    UNKNOWN: {
      title: 'Something went wrong',
      steps: ['Select Refresh. If it keeps happening, copy the technical details from Diagnostics.'],
    },
  };

  function tableFamily(msg) {
    if (/system\.billing|list_prices|account_prices|billing\.usage/i.test(msg)) return 'billing';
    if (/system\.query|query\.history/i.test(msg)) return 'history';
    if (/system\.lakeflow|_timeline/i.test(msg)) return 'lakeflow';
    return null;
  }

  function pickCode(input) {
    const msg = String(input.message || '');
    const code = String(input.errorCode || '');
    const status = input.httpStatus;
    if (input.code && CATALOG[input.code]) return input.code;
    if (input.network || /Failed to fetch|NetworkError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) return 'NETWORK';
    if (/FIELD_NOT_FOUND/i.test(code + msg) && /effective_list/i.test(msg)) return 'PRICE_FIELD_MISMATCH';
    if (/TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|CATALOG_NOT_FOUND/i.test(code + msg)) return 'TABLE_NOT_FOUND';
    if (/UNRESOLVED_COLUMN|FIELD_NOT_FOUND|DATATYPE_MISMATCH|UNRESOLVED_FIELD/i.test(code + msg)) return 'SCHEMA_MISMATCH';
    if (/CAN_USE|permission to use (the )?(sql )?warehouse|not authorized to use (this )?warehouse/i.test(msg)) return 'WAREHOUSE_ACCESS_DENIED';
    if (/INSUFFICIENT_PERMISSIONS|PERMISSION_DENIED|does not have (SELECT|USE CATALOG|USE SCHEMA)|not authorized/i.test(code + msg)) {
      const fam = tableFamily(msg);
      if (fam === 'billing') return 'BILLING_ACCESS_DENIED';
      if (fam === 'history') return 'HISTORY_ACCESS_DENIED';
      if (fam === 'lakeflow') return 'LAKEFLOW_ACCESS_DENIED';
      if (/warehouse/i.test(msg)) return 'WAREHOUSE_ACCESS_DENIED';
      return 'TABLE_ACCESS_DENIED';
    }
    if (status === 401 || /invalid access token|token (is )?expired|expired token|UNAUTHENTICATED/i.test(code + msg)) return 'AUTH_EXPIRED';
    if (status === 403) return 'AUTH_INVALID';
    if (/RESOURCE_DOES_NOT_EXIST/i.test(code) && /warehouse/i.test(msg)) return 'WAREHOUSE_UNAVAILABLE';
    if (status === 404 && /warehouse/i.test(msg)) return 'WAREHOUSE_UNAVAILABLE';
    return 'UNKNOWN';
  }

  /**
   * @param {{code?, message?, errorCode?, sqlState?, statementId?, httpStatus?, network?, detail?}} input
   * @returns {{code, title, steps, details:{errorCode, sqlState, statementId, httpStatus, message}}}
   */
  function classify(input = {}) {
    const code = pickCode(input);
    const entry = CATALOG[code];
    const statementId = V.isStatementId(String(input.statementId || '').toLowerCase()) ? String(input.statementId).toLowerCase() : null;
    return {
      code,
      title: entry.title,
      steps: entry.steps.slice(),
      details: {
        errorCode: input.errorCode ? redact(input.errorCode).slice(0, 80) : null,
        sqlState: input.sqlState && /^[0-9A-Z]{5}$/.test(input.sqlState) ? input.sqlState : null,
        statementId,
        httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
        message: input.message ? redact(input.message).slice(0, 600) : null,
      },
    };
  }

  /** Error object that carries a classification across async boundaries. */
  class DccError extends Error {
    constructor(input) {
      const c = classify(input);
      super(c.title);
      this.name = 'DccError';
      this.dcc = c;
    }
  }

  function toPayload(err) {
    if (err && err.dcc) return err.dcc;
    return classify({ message: err && err.message });
  }

  const api = Object.freeze({ CATALOG, redact, classify, DccError, toPayload });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).errors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
