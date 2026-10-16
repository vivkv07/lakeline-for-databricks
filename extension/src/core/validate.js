/*
 * Strict validators for every value that crosses a trust boundary: message payloads, saved
 * settings, URLs parsed from the page, and identifiers placed into SQL.
 *
 * Shared module: runs as a classic script (service worker importScripts, content scripts,
 * extension pages → globalThis.DCC.validate) and as CommonJS under `node --test`.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const WORKSPACE_ID = /^[1-9][0-9]{0,18}$/;
  const NUMERIC_ID = /^[0-9]{1,20}$/;
  const WAREHOUSE_ID = /^[0-9a-f]{16}$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  const CURRENCY = /^[A-Z]{3}$/;
  const IDENT_PART = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
  // Databricks App names: lowercase letters, digits and hyphens, 2–30 chars, no leading/trailing hyphen.
  const APP_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/;
  const CLUSTER_ID = /^[0-9]{4}-[0-9]{6}-[a-z0-9]{8}$/;
  const PAIRING_KEY = /^[0-9a-f]{24}$/;
  const PERIODS = Object.freeze([7, 30, 90]);

  const isString = (v) => typeof v === 'string';

  const api = {
    PERIODS,
    isWorkspaceId: (v) => isString(v) && WORKSPACE_ID.test(v),
    isNumericId: (v) => isString(v) && NUMERIC_ID.test(v),
    isWarehouseId: (v) => isString(v) && WAREHOUSE_ID.test(v),
    isUuid: (v) => isString(v) && UUID.test(v),
    isStatementId: (v) => isString(v) && UUID.test(v),
    isClusterId: (v) => isString(v) && CLUSTER_ID.test(v),
    isAppName: (v) => isString(v) && APP_NAME.test(v),
    isHexColor: (v) => isString(v) && HEX_COLOR.test(v),
    isCurrency: (v) => isString(v) && CURRENCY.test(v),
    isPeriodDays: (v) => PERIODS.includes(v),
    isPairingKey: (v) => isString(v) && PAIRING_KEY.test(v),

    /** Personal access tokens: opaque, but bounded and whitespace-free. Never logged. */
    isPlausiblePat(v) {
      return isString(v) && v.length >= 20 && v.length <= 512 && /^[\x21-\x7e]+$/.test(v);
    },

    /**
     * Parse `catalog.schema.table` into validated parts. Returns null for anything else,
     * including quoted, wildcard, or two-part names.
     */
    parseThreePartName(v) {
      if (!isString(v)) return null;
      const parts = v.trim().split('.');
      if (parts.length !== 3 || !parts.every((p) => IDENT_PART.test(p))) return null;
      return parts.map((p) => p.toLowerCase());
    },

    /** Backtick-quote a validated three-part name. Throws for anything unvalidated. */
    quoteThreePartName(v) {
      const parts = api.parseThreePartName(v);
      if (!parts) throw new Error('Invalid three-part identifier');
      return parts.map((p) => '`' + p + '`').join('.');
    },

    normalizeHexColor(v) {
      return api.isHexColor(v) ? v.toUpperCase() : null;
    },

    /** Clamp free text shown in diagnostics: strip control chars and bound length. */
    safeText(v, max = 500) {
      if (v === null || v === undefined) return '';
      return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
    },
  };

  Object.freeze(api);
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).validate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
