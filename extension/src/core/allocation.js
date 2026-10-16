/*
 * Per-execution allocation of SQL warehouse billing intervals. Pure: no I/O, no DOM.
 *
 * Method (spec §8):
 *   1. active_start = MAX(query_start, query_end − execution_duration_ms), active_end = query_end.
 *   2. Each priced billing interval is split at every execution-window boundary inside it.
 *   3. A segment with k > 0 active executions gives each of them
 *        interval_cost × segment_duration / interval_duration / k.
 *   4. Segments with no active execution stay unallocated (idle / unused capacity).
 *   5. Shares are summed per execution.
 * Conservation: for every interval, allocated + idle = interval cost (signed; corrections stay
 * negative). Allocations need not add up to the warehouse bill.
 *
 * Also holds the shared vocabulary for allocated query estimates, so the service worker and the
 * content script show exactly the same labels.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  /** Status code → visible label. `ok` items show an amount instead. */
  const LABELS = Object.freeze({
    waiting_history: 'Waiting for history',
    waiting_billing: 'Waiting for billing',
    cached: 'Cached · unallocated',
    pending: 'Execution pending',
    ambiguous: 'Match ambiguous',
    row_unavailable: 'Row unavailable',
    compute_unsupported: 'Compute unsupported',
    price_unavailable: 'Price unavailable',
    unavailable: 'Estimate unavailable',
  });

  /** Assumptions every allocated estimate carries (tooltips, guide, explanatory note). */
  const ASSUMPTIONS = Object.freeze([
    'Cost is assumed uniform within each warehouse billing interval.',
    'Queries active at the same time share a segment equally.',
    'Active time is approximated from start time, end time and execution duration.',
    'Executions not visible to your identity are not counted, so shares can be overstated.',
    'Billing can be delayed or partial; later corrections change the estimate.',
    'Idle time and unused capacity stay unallocated.',
    'Not measured CPU or memory, and not an invoice line.',
  ]);

  /**
   * Active execution window from query metadata (epoch ms).
   * @param {{startMs:number, endMs:number, executionMs:number}} m
   * @returns {{startMs:number, endMs:number}|null} null when there is no measurable execution time
   */
  function activeWindow(m) {
    if (!m) return null;
    const start = Number(m.startMs);
    const end = Number(m.endMs);
    const execMs = Number(m.executionMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(execMs)) return null;
    if (m.endMs === null || m.endMs === undefined || m.executionMs === null || m.executionMs === undefined) return null;
    if (!(execMs > 0) || end < start) return null;
    const activeStart = Math.max(start, end - execMs);
    if (!(end > activeStart)) return null;
    return { startMs: activeStart, endMs: end };
  }

  /**
   * Allocate one warehouse's billing intervals among its executions.
   * @param {{id:string, startMs:number, endMs:number, cost:number}[]} intervals priced intervals
   * @param {{id:string, startMs:number, endMs:number}[]} executions active windows
   * @returns {{
   *   byExecution: Object<string, {amount:number, intervals:number, concurrency:number}>,
   *   intervals: {id, cost, allocated, idle, executions:number}[],
   *   cost:number, allocated:number, idle:number
   * }}
   */
  function allocate(intervals, executions) {
    const execs = (executions || [])
      .filter((e) => e && Number.isFinite(e.startMs) && Number.isFinite(e.endMs) && e.endMs > e.startMs)
      .slice()
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const byExecution = {};
    const perInterval = [];
    let totalCost = 0;
    let totalAllocated = 0;
    let totalIdle = 0;

    for (const iv of intervals || []) {
      const cost = Number(iv.cost);
      const dur = iv.endMs - iv.startMs;
      const rec = { id: iv.id, cost, allocated: 0, idle: 0, executions: 0 };
      perInterval.push(rec);
      if (!Number.isFinite(cost)) continue; // unpriced intervals never reach allocation
      totalCost += cost;
      if (!(dur > 0)) {
        // A zero-length interval cannot be split; its cost stays unallocated.
        rec.idle = cost;
        totalIdle += cost;
        continue;
      }
      const overlapping = [];
      for (const e of execs) {
        if (e.startMs >= iv.endMs) break;
        if (e.endMs <= iv.startMs) continue;
        overlapping.push({ id: e.id, s: Math.max(e.startMs, iv.startMs), e: Math.min(e.endMs, iv.endMs) });
      }
      rec.executions = overlapping.length;
      const points = new Set([iv.startMs, iv.endMs]);
      const startsAt = new Map();
      const endsAt = new Map();
      for (const o of overlapping) {
        points.add(o.s);
        points.add(o.e);
        if (!startsAt.has(o.s)) startsAt.set(o.s, []);
        startsAt.get(o.s).push(o);
        if (!endsAt.has(o.e)) endsAt.set(o.e, []);
        endsAt.get(o.e).push(o);
      }
      const sorted = [...points].sort((a, b) => a - b);
      const active = new Set();
      const touched = new Set();
      for (let i = 0; i < sorted.length - 1; i++) {
        const p = sorted[i];
        for (const o of endsAt.get(p) || []) active.delete(o);
        for (const o of startsAt.get(p) || []) active.add(o);
        const segCost = (cost * (sorted[i + 1] - p)) / dur;
        const k = active.size;
        if (k === 0) {
          rec.idle += segCost;
          continue;
        }
        const share = segCost / k;
        for (const o of active) {
          const acc = byExecution[o.id] || (byExecution[o.id] = { amount: 0, intervals: 0, concurrency: 0 });
          acc.amount += share;
          if (k > acc.concurrency) acc.concurrency = k;
          touched.add(o.id);
        }
        rec.allocated += segCost;
      }
      for (const id of touched) byExecution[id].intervals += 1;
      totalAllocated += rec.allocated;
      totalIdle += rec.idle;
    }
    return { byExecution, intervals: perInterval, cost: totalCost, allocated: totalAllocated, idle: totalIdle };
  }

  /**
   * Allocate intervals and executions that carry `warehouseId`, warehouse by warehouse.
   * Executions on one warehouse never share another warehouse's intervals.
   */
  function allocateByWarehouse(intervals, executions) {
    const groups = new Map();
    const group = (wh) => {
      if (!groups.has(wh)) groups.set(wh, { intervals: [], executions: [] });
      return groups.get(wh);
    };
    for (const iv of intervals || []) group(iv.warehouseId).intervals.push(iv);
    for (const e of executions || []) group(e.warehouseId).executions.push(e);
    const byExecution = {};
    const warehouses = [];
    let cost = 0;
    let allocated = 0;
    let idle = 0;
    for (const [warehouseId, g] of groups) {
      if (!g.intervals.length) continue;
      const r = allocate(g.intervals, g.executions);
      Object.assign(byExecution, r.byExecution);
      warehouses.push({ warehouseId, cost: r.cost, allocated: r.allocated, idle: r.idle, intervals: r.intervals.length });
      cost += r.cost;
      allocated += r.allocated;
      idle += r.idle;
    }
    return { byExecution, warehouses, cost, allocated, idle };
  }

  /** Total length of the union of [s, e) spans clipped to [from, to). */
  function coveredMs(spans, from, to) {
    const clipped = (spans || [])
      .map((x) => [Math.max(x.startMs, from), Math.min(x.endMs, to)])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curS = null;
    let curE = null;
    for (const [s, e] of clipped) {
      if (curE === null || s > curE) {
        if (curE !== null) total += curE - curS;
        curS = s;
        curE = e;
      } else if (e > curE) curE = e;
    }
    if (curE !== null) total += curE - curS;
    return total;
  }

  /** Merge overlapping or touching spans (sorted output). */
  function mergeSpans(spans) {
    const sorted = (spans || []).filter((x) => x.endMs > x.startMs).slice().sort((a, b) => a.startMs - b.startMs);
    const out = [];
    for (const x of sorted) {
      const last = out[out.length - 1];
      if (last && x.startMs <= last.endMs) last.endMs = Math.max(last.endMs, x.endMs);
      else out.push({ startMs: x.startMs, endMs: x.endMs });
    }
    return out;
  }

  const api = Object.freeze({ LABELS, ASSUMPTIONS, activeWindow, allocate, allocateByWarehouse, coveredMs, mergeSpans });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).allocation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
