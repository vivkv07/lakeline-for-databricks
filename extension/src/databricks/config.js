/*
 * Connection config validation. One cost connection per workspace origin.
 * Unknown fields are dropped; there is no free-text price table and no schema override.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('../core/validate.js') : root.DCC.validate;
  const ids = NODE ? require('../core/ids.js') : root.DCC.ids;
  const pricing = NODE ? require('./pricing.js') : root.DCC.pricing;

  const DEFAULT_USAGE_SOURCE = 'system.billing.usage';
  const DEFAULT_HISTORY_SOURCE = 'system.query.history';
  const AUTH_MODES = Object.freeze(['helper', 'pat']);

  /**
   * Approved source: the default system table, or a three-part view outside the `system`
   * catalog (a user's governed view). Other system tables are refused so the usage source can't
   * be pointed at a price table or anything else.
   */
  function validateSource(value, fallback) {
    const v = value === undefined || value === null || value === '' ? fallback : String(value).trim().toLowerCase();
    const parts = V.parseThreePartName(v);
    if (!parts) return { ok: false };
    const name = parts.join('.');
    if (parts[0] === 'system' && name !== fallback) return { ok: false };
    return { ok: true, value: name };
  }

  /**
   * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
   */
  function validateConnection(input) {
    const errors = [];
    const src = input && typeof input === 'object' ? input : {};
    const cls = ids.classifyOrigin(src.origin);
    if (!cls.ok) errors.push('Workspace URL must be a supported Databricks workspace (not an account console).');
    if (!V.isWorkspaceId(src.workspaceId)) errors.push('Workspace ID must be numeric.');
    if (!AUTH_MODES.includes(src.authMode)) errors.push('Choose browser sign-in or personal access token.');

    const priceTable = src.priceTable === undefined ? pricing.DEFAULT_PRICE_TABLE : src.priceTable;
    if (!Object.prototype.hasOwnProperty.call(pricing.PRICE_TABLES, priceTable)) {
      errors.push('Price table must be system.billing.list_prices or system.billing.account_prices.');
    }
    const usage = validateSource(src.usageSource, DEFAULT_USAGE_SOURCE);
    if (!usage.ok) errors.push('Usage source must be system.billing.usage or an approved catalog.schema.view outside the system catalog.');
    const history = validateSource(src.historySource, DEFAULT_HISTORY_SOURCE);
    if (!history.ok) errors.push('Query history source must be system.query.history or an approved catalog.schema.view outside the system catalog.');
    const currency = src.currency === undefined ? 'USD' : src.currency;
    if (!V.isCurrency(currency)) errors.push('Currency must be a three-letter code such as USD.');

    const wh = src.warehouse && typeof src.warehouse === 'object' ? src.warehouse : { mode: 'auto' };
    let warehouse = null;
    if (wh.mode === 'auto') {
      warehouse = { mode: 'auto', resolvedId: V.isWarehouseId(wh.resolvedId) ? wh.resolvedId : null, resolvedName: wh.resolvedName ? V.safeText(wh.resolvedName, 200) : null };
    } else if (wh.mode === 'manual' && V.isWarehouseId(wh.id)) {
      warehouse = { mode: 'manual', id: wh.id, name: wh.name ? V.safeText(wh.name, 200) : null };
    } else {
      errors.push('Choose Automatic or a specific SQL warehouse.');
    }

    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      value: {
        origin: cls.origin,
        cloud: cls.cloud,
        workspaceId: src.workspaceId,
        authMode: src.authMode,
        priceTable,
        usageSource: usage.value,
        historySource: history.value,
        currency,
        warehouse,
      },
    };
  }

  /** Effective warehouse ID for SQL: manual id, or the auto choice resolved at save/reconnect. */
  function effectiveWarehouseId(conn) {
    if (!conn || !conn.warehouse) return null;
    return conn.warehouse.mode === 'manual' ? conn.warehouse.id : conn.warehouse.resolvedId || null;
  }

  const api = Object.freeze({ DEFAULT_USAGE_SOURCE, DEFAULT_HISTORY_SOURCE, AUTH_MODES, validateConnection, validateSource, effectiveWarehouseId });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).config = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
