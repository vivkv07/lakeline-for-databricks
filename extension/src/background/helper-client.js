/*
 * Client for the local helper bridge (127.0.0.1 only). Requests carry the session pairing key
 * in a header; the helper also checks the extension Origin. Capability checks gate SQL that an
 * older running helper could build incorrectly. A version difference alone never forces a
 * restart.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const errors = NODE ? require('../errors.js') : root.DCC.errors;

  const PROTOCOL = 1;
  const MIN_PRICE_ADAPTER = 2;

  /** Which capabilities a request needs. */
  function requiredCapabilities(kind, conn, args) {
    const need = { priceAdapterVersion: MIN_PRICE_ADAPTER };
    if (conn && conn.priceTable === 'system.billing.account_prices') need.accountPrices = true;
    const refs = (args && args.refs) || [];
    if (kind === 'rows' && refs.some((r) => r.type === 'job' || r.type === 'job_run')) need.jobPipelineAttribution = true;
    if (kind === 'exploreSummary' || kind === 'exploreEntities' || kind === 'exploreRuns') need.jobPipelineAttribution = true;
    if (kind === 'monitor') need.monitor = true;
    return need;
  }

  /** @returns {string[]} missing capability names */
  function missingCapabilities(caps, need) {
    const c = caps || {};
    const missing = [];
    if ((c.priceAdapterVersion || 0) < need.priceAdapterVersion) missing.push('priceAdapterVersion>=' + need.priceAdapterVersion);
    if (need.accountPrices && c.accountPrices !== true) missing.push('accountPrices');
    if (need.jobPipelineAttribution && c.jobPipelineAttribution !== true) missing.push('jobPipelineAttribution');
    if (need.monitor && c.monitor !== true) missing.push('monitor');
    return missing;
  }

  function create({ fetch: doFetch, getBridge }) {
    async function call(path, body) {
      const bridge = await getBridge();
      if (!bridge) throw new errors.DccError({ code: 'HELPER_UNREACHABLE', message: 'Helper not paired' });
      let res;
      try {
        res = await doFetch('http://127.0.0.1:' + bridge.port + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DCC-Key': bridge.key, 'X-DCC-Protocol': String(PROTOCOL) },
          body: JSON.stringify(body || {}),
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        });
      } catch (e) {
        throw new errors.DccError({ code: 'HELPER_UNREACHABLE', message: e && e.message });
      }
      let json = null;
      try {
        json = await res.json();
      } catch (_) {
        json = null;
      }
      if (res.status === 401 || res.status === 403) throw new errors.DccError({ code: 'HELPER_UNREACHABLE', message: 'Helper rejected the pairing; start the helper again and reconnect.' });
      if (!res.ok || !json || json.ok === false) {
        const e = (json && json.error) || {};
        throw new errors.DccError({ code: e.code, errorCode: e.details && e.details.errorCode, message: (e.details && e.details.message) || e.title || 'Helper error', statementId: e.details && e.details.statementId, httpStatus: e.details && e.details.httpStatus });
      }
      return json;
    }

    return {
      call,
      hello: () => call('/bridge/hello', {}),
      async assertCapable(kind, conn, args) {
        const bridge = await getBridge();
        const missing = missingCapabilities(bridge && bridge.capabilities, requiredCapabilities(kind, conn, args));
        if (missing.length) throw new errors.DccError({ code: 'HELPER_OUTDATED', message: 'Running helper lacks: ' + missing.join(', ') });
      },
    };
  }

  const api = Object.freeze({ PROTOCOL, MIN_PRICE_ADAPTER, requiredCapabilities, missingCapabilities, create });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).helperClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
