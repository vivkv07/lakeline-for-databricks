/*
 * Local import (mode B): validated per-workspace, per-resource, per-period summaries from a
 * user-provided costs.json. Imported summaries contain only what was imported — no query
 * history or run detail is implied.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const V = NODE ? require('./validate.js') : root.DCC.validate;
  const ids = NODE ? require('./ids.js') : root.DCC.ids;

  const TYPES = Object.freeze(['workspace', 'job', 'pipeline', 'warehouse', 'notebook', 'app']);
  const MAX_ENTRIES = 5000;
  const MAX_BYTES = 5 * 1024 * 1024;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const optNum = (v) => v === null || v === undefined || num(v);

  /** Resource ID shape per type (same rules as native parsing). */
  function validId(type, id) {
    switch (type) {
      case 'workspace': return V.isWorkspaceId(id);
      case 'job': case 'notebook': return V.isNumericId(id);
      case 'pipeline': return V.isUuid(id);
      case 'warehouse': return V.isWarehouseId(id);
      case 'app': return V.isAppName(id);
      default: return false;
    }
  }

  /**
   * @param {string} text raw JSON
   * @returns {{ok:true, value:{entries, importedAt}} | {ok:false, errors:string[]}}
   */
  function parseImport(text) {
    if (typeof text !== 'string' || text.length > MAX_BYTES) return { ok: false, errors: ['File is empty or larger than 5 MB.'] };
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (_) {
      return { ok: false, errors: ['File is not valid JSON.'] };
    }
    const list = Array.isArray(doc) ? doc : doc && Array.isArray(doc.entries) ? doc.entries : null;
    if (!list) return { ok: false, errors: ['Expected an array of entries or {"entries": [...]}.'] };
    if (list.length > MAX_ENTRIES) return { ok: false, errors: ['Too many entries (max ' + MAX_ENTRIES + ').'] };
    const errors = [];
    const entries = [];
    list.forEach((e, i) => {
      const at = 'Entry ' + (i + 1) + ': ';
      if (!e || typeof e !== 'object') return errors.push(at + 'not an object.');
      const ws = String(e.workspace || '');
      const cls = ids.classifyOrigin(ws);
      if (!cls.ok && !V.isWorkspaceId(ws)) errors.push(at + 'workspace must be a workspace URL or numeric ID.');
      if (!TYPES.includes(e.type)) errors.push(at + 'type must be one of ' + TYPES.join(', ') + '.');
      else if (!validId(e.type, String(e.id))) errors.push(at + 'id is not valid for type ' + e.type + '.');
      if (![7, 30, 90].includes(e.periodDays)) errors.push(at + 'periodDays must be 7, 30 or 90.');
      if (!V.isCurrency(e.currency)) errors.push(at + 'currency must be a three-letter code.');
      if (!optNum(e.total)) errors.push(at + 'total must be a number or null.');
      if (!optNum(e.previous)) errors.push(at + 'previous must be a number or null.');
      if (e.updatedAt !== undefined && !ISO_RE.test(String(e.updatedAt))) errors.push(at + 'updatedAt must be an ISO timestamp.');
      if (e.coverageEnd !== undefined && !DATE_RE.test(String(e.coverageEnd))) errors.push(at + 'coverageEnd must be YYYY-MM-DD.');
      const daily = e.daily === undefined ? [] : e.daily;
      if (!Array.isArray(daily) || daily.some((d) => !d || !DATE_RE.test(String(d.date)) || !optNum(d.cost))) errors.push(at + 'daily must be [{date: YYYY-MM-DD, cost: number|null}].');
      if (errors.length) return;
      entries.push({
        workspace: cls.ok ? cls.origin : ws,
        type: e.type,
        id: String(e.id),
        periodDays: e.periodDays,
        currency: e.currency,
        total: num(e.total) ? e.total : null,
        previous: num(e.previous) ? e.previous : null,
        basis: V.safeText(e.basis || 'imported', 40),
        owner: e.owner ? V.safeText(e.owner, 120) : null,
        allocation: e.allocation ? V.safeText(e.allocation, 120) : null,
        updatedAt: e.updatedAt || null,
        coverageEnd: e.coverageEnd || null,
        daily: daily.map((d) => ({ date: d.date, cost: num(d.cost) ? d.cost : null })),
      });
    });
    if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
    return { ok: true, value: { entries, importedAt: Date.now() } };
  }

  function matchesWorkspace(entry, origin, workspaceId) {
    return entry.workspace === origin || entry.workspace === workspaceId;
  }

  /** Summary for the banner from the workspace-level entry; null if none was imported. */
  function workspaceSummary(data, origin, workspaceId, periodDays) {
    if (!data) return null;
    const e = data.entries.find((x) => x.type === 'workspace' && x.periodDays === periodDays && matchesWorkspace(x, origin, workspaceId));
    if (!e) return null;
    return {
      kind: 'summary',
      imported: true,
      pricingBasis: 'import',
      importBasis: e.basis,
      priceTable: null,
      currency: e.currency,
      currentAmount: e.total,
      previousAmount: e.previous,
      current: { coverage: e.total === null ? 'empty' : 'complete', total: e.total },
      previous: { coverage: e.previous === null ? 'empty' : 'complete', total: e.previous },
      daily: e.daily.map((d) => ({ period: 'cur', date: d.date, product: 'IMPORTED', sku: 'IMPORTED', cost: d.cost, complete: d.cost !== null })),
      latestUsageMs: e.updatedAt ? Date.parse(e.updatedAt) : null,
      coverageEnd: e.coverageEnd,
      owner: e.owner,
      allocation: e.allocation,
    };
  }

  function resourceAmount(data, origin, workspaceId, periodDays, ref) {
    if (!data) return null;
    const idByType = { job: ref.jobId, pipeline: ref.pipelineId, warehouse: ref.warehouseId, notebook: ref.notebookId, app: ref.appName };
    const e = data.entries.find((x) => x.type === ref.type && x.id === idByType[ref.type] && x.periodDays === periodDays && matchesWorkspace(x, origin, workspaceId));
    return e && e.total !== null ? { amount: e.total, currency: e.currency, basis: e.basis } : null;
  }

  const api = Object.freeze({ TYPES, parseImport, workspaceSummary, resourceAmount });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).importData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
