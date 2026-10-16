// Unit tests for the pure per-execution allocation (core/allocation.js). No SQL, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const A = load('core/allocation.js');

const H = 3600000;
const T0 = Date.parse('2026-10-14T10:00:00Z');
const close = (a, b, msg, eps = 1e-12) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg ?? ''} expected ${b}, got ${a}`);
const iv = (id, startMs, endMs, cost, warehouseId = 'w1') => ({ id, warehouseId, startMs, endMs, cost });
const ex = (id, startMs, endMs, warehouseId = 'w1') => ({ id, warehouseId, startMs, endMs });

function conserved(r) {
  for (const i of r.intervals) close(i.allocated + i.idle, i.cost, 'interval ' + i.id);
  close(r.allocated + r.idle, r.cost, 'total');
  const sumExec = Object.values(r.byExecution).reduce((s, e) => s + e.amount, 0);
  close(sumExec, r.allocated, 'per-execution sum equals allocated');
}

test('active window = [max(start, end − execution), end]; no measurable time → null', () => {
  assert.deepEqual(A.activeWindow({ startMs: 1000, endMs: 11000, executionMs: 4000 }), { startMs: 7000, endMs: 11000 });
  // Execution longer than wall time (clock skew): clamp to the start.
  assert.deepEqual(A.activeWindow({ startMs: 1000, endMs: 3000, executionMs: 9000 }), { startMs: 1000, endMs: 3000 });
  assert.equal(A.activeWindow({ startMs: 1000, endMs: 3000, executionMs: 0 }), null);
  assert.equal(A.activeWindow({ startMs: 1000, endMs: null, executionMs: 50 }), null);
  assert.equal(A.activeWindow({ startMs: 1000, endMs: 3000, executionMs: null }), null);
  assert.equal(A.activeWindow({ startMs: 5000, endMs: 3000, executionMs: 10 }), null);
});

test('single execution covering part of an interval: share by duration, rest idle, conserved', () => {
  const r = A.allocate([iv('i1', T0, T0 + H, 6)], [ex('q1', T0 + 10 * 60000, T0 + 20 * 60000)]);
  close(r.byExecution.q1.amount, 1); // 10 of 60 minutes
  close(r.intervals[0].idle, 5);
  assert.equal(r.byExecution.q1.intervals, 1);
  assert.equal(r.byExecution.q1.concurrency, 1);
  conserved(r);
});

test('concurrent executions split each segment equally', () => {
  // q1 10–40 min, q2 20–30 min in a 60-minute $6 interval ($0.10/min).
  const r = A.allocate([iv('i1', T0, T0 + H, 6)], [ex('q1', T0 + 10 * 60000, T0 + 40 * 60000), ex('q2', T0 + 20 * 60000, T0 + 30 * 60000)]);
  // q1: 10 min alone (1.0) + 10 min shared (0.5) + 10 min alone (1.0) = 2.5; q2: 0.5
  close(r.byExecution.q1.amount, 2.5);
  close(r.byExecution.q2.amount, 0.5);
  assert.equal(r.byExecution.q1.concurrency, 2);
  assert.equal(r.byExecution.q2.concurrency, 2);
  close(r.idle, 3);
  conserved(r);
});

test('identical windows share equally; three-way split', () => {
  const r = A.allocate([iv('i1', T0, T0 + H, 9)], [ex('a', T0, T0 + H), ex('b', T0, T0 + H), ex('c', T0, T0 + H)]);
  for (const id of ['a', 'b', 'c']) close(r.byExecution[id].amount, 3);
  close(r.idle, 0);
  conserved(r);
});

test('partial overlap across interval boundaries and multiple intervals', () => {
  const intervals = [iv('i1', T0, T0 + H, 6), iv('i2', T0 + H, T0 + 2 * H, 12)];
  // q1 spans 50 min into i1 → 30 min into i2.
  const r = A.allocate(intervals, [ex('q1', T0 + 50 * 60000, T0 + H + 30 * 60000), ex('outside', T0 + 3 * H, T0 + 4 * H)]);
  close(r.byExecution.q1.amount, 6 * (10 / 60) + 12 * (30 / 60));
  assert.equal(r.byExecution.q1.intervals, 2);
  assert.equal(r.byExecution.outside, undefined, 'execution outside every interval gets nothing');
  conserved(r);
});

test('touching windows are not concurrent; zero-length executions get nothing', () => {
  const r = A.allocate([iv('i1', T0, T0 + H, 6)], [ex('a', T0, T0 + 30 * 60000), ex('b', T0 + 30 * 60000, T0 + H), ex('z', T0 + 10 * 60000, T0 + 10 * 60000)]);
  close(r.byExecution.a.amount, 3);
  close(r.byExecution.b.amount, 3);
  assert.equal(r.byExecution.a.concurrency, 1);
  assert.equal(r.byExecution.z, undefined);
  conserved(r);
});

test('tiny nonzero values are preserved (no rounding to zero)', () => {
  const r = A.allocate([iv('i1', T0, T0 + H, 0.0000037)], [ex('q1', T0, T0 + 1000), ex('q2', T0 + 500, T0 + 1500)]);
  assert.ok(r.byExecution.q1.amount > 0 && r.byExecution.q2.amount > 0);
  close(r.byExecution.q1.amount, 0.0000037 * (500 / H) + (0.0000037 * (500 / H)) / 2, 'q1', 1e-9);
  conserved(r);
  const sub = A.allocate([iv('i1', T0, T0 + H, 1e-12)], [ex('q', T0, T0 + 1)]);
  assert.ok(sub.byExecution.q.amount > 0, 'sub-picodollar share stays positive');
});

test('negative correction intervals allocate signed amounts and stay conserved', () => {
  const intervals = [iv('orig', T0, T0 + H, 10), iv('retract', T0, T0 + H, -10), iv('restate', T0, T0 + H, 8)];
  const r = A.allocate(intervals, [ex('q1', T0, T0 + 30 * 60000)]);
  close(r.byExecution.q1.amount, (10 - 10 + 8) / 2);
  close(r.cost, 8);
  conserved(r);
  const neg = A.allocate([iv('retract', T0, T0 + H, -4)], [ex('q1', T0, T0 + 15 * 60000)]);
  close(neg.byExecution.q1.amount, -1, 'a net-negative interval allocates a negative share');
  conserved(neg);
});

test('zero-length and non-finite intervals: never split, never allocated', () => {
  const r = A.allocate([iv('zero', T0, T0, 5), iv('nan', T0, T0 + H, NaN)], [ex('q1', T0 - 1000, T0 + 1000)]);
  assert.equal(r.byExecution.q1, undefined);
  close(r.idle, 5);
  close(r.cost, 5, 'non-finite (unpriced) interval excluded from cost');
});

test('warehouses never share each other\'s intervals', () => {
  const r = A.allocateByWarehouse(
    [iv('a1', T0, T0 + H, 6, 'wA'), iv('b1', T0, T0 + H, 60, 'wB')],
    [ex('qa', T0, T0 + H, 'wA'), ex('qb', T0, T0 + 30 * 60000, 'wB'), ex('qb2', T0, T0 + 30 * 60000, 'wB')]
  );
  close(r.byExecution.qa.amount, 6);
  close(r.byExecution.qb.amount, 15);
  close(r.byExecution.qb2.amount, 15);
  close(r.allocated + r.idle, r.cost);
  assert.equal(r.warehouses.length, 2);
});

test('randomized conservation over many overlapping executions', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const intervals = [];
  for (let i = 0; i < 6; i++) intervals.push(iv('i' + i, T0 + i * H, T0 + (i + 1) * H, (rnd() - 0.2) * 50));
  const execs = [];
  for (let i = 0; i < 400; i++) {
    const s = T0 - H + Math.floor(rnd() * 8 * H);
    execs.push(ex('q' + i, s, s + Math.floor(rnd() * 2 * H)));
  }
  const r = A.allocate(intervals, execs);
  for (const i of r.intervals) close(i.allocated + i.idle, i.cost, i.id, 1e-9);
  const sumExec = Object.values(r.byExecution).reduce((s, e) => s + e.amount, 0);
  close(sumExec, r.allocated, 'sum', 1e-9);
});

test('coverage and span helpers', () => {
  assert.equal(A.coveredMs([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 20 }, { startMs: 30, endMs: 40 }], 0, 35), 25);
  assert.deepEqual(A.mergeSpans([{ startMs: 5, endMs: 9 }, { startMs: 0, endMs: 5 }, { startMs: 20, endMs: 30 }]), [{ startMs: 0, endMs: 9 }, { startMs: 20, endMs: 30 }]);
});

test('shared label vocabulary is exact', () => {
  assert.deepEqual(Object.values(A.LABELS), [
    'Waiting for history', 'Waiting for billing', 'Cached · unallocated', 'Execution pending', 'Match ambiguous',
    'Row unavailable', 'Compute unsupported', 'Price unavailable', 'Estimate unavailable',
  ]);
});
