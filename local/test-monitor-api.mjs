// Monitor REST normalization (pure functions; fixtures are synthetic API responses).
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const mapi = load('databricks/monitor-api.js');
const http = load('databricks/http.js');

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const WS = '1234567890123';
const CTX = { origin: ORIGIN, workspaceId: WS };
const NOW = Date.parse('2026-10-15T12:00:00Z');
const H = 3600 * 1000;

const runUrl = (job, run, extra = '') => `${ORIGIN}/?o=${WS}#job/${job}/run/${run}${extra}`;

function run(over = {}) {
  return {
    job_id: 11,
    run_id: 22,
    run_name: 'Nightly ETL',
    start_time: NOW - 2 * H,
    end_time: NOW - H,
    run_duration: H,
    trigger: 'PERIODIC',
    run_page_url: runUrl(11, 22),
    status: { state: 'TERMINATED', termination_details: { code: 'SUCCESS', type: 'SUCCESS', message: '' } },
    ...over,
  };
}

test('jobs: status is authoritative; deprecated state is read only when status is absent', () => {
  const both = mapi.normalizeRun(
    run({
      status: { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR', type: 'CLIENT_ERROR', message: 'boom' } },
      state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
    }),
    CTX
  );
  assert.equal(both.outcome, 'failed');
  assert.equal(both.statusText, 'Failed');
  assert.equal(both.statusSource, 'status');
  assert.equal(both.code, 'RUN_EXECUTION_ERROR');

  const legacyOnly = mapi.normalizeRun(run({ status: undefined, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } }), CTX);
  assert.equal(legacyOnly.outcome, 'succeeded');
  assert.equal(legacyOnly.statusSource, 'state');

  const o = (status) => mapi.runOutcome({ status });
  assert.equal(o({ state: 'RUNNING' }).outcome, 'running');
  assert.equal(o({ state: 'TERMINATING' }).text, 'Finishing');
  assert.equal(o({ state: 'QUEUED' }).outcome, 'pending');
  assert.equal(o({ state: 'QUEUED' }).text, 'Queued');
  assert.equal(o({ state: 'BLOCKED' }).outcome, 'pending');
  assert.equal(o({ state: 'TERMINATED', termination_details: { code: 'SUCCESS_WITH_FAILURES', type: 'SUCCESS' } }).outcome, 'partial');
  assert.equal(o({ state: 'TERMINATED', termination_details: { code: 'USER_CANCELED', type: 'SUCCESS' } }).outcome, 'canceled');
  assert.equal(o({ state: 'TERMINATED', termination_details: { code: 'SKIPPED', type: 'SUCCESS' } }).outcome, 'skipped');
  assert.equal(o({ state: 'TERMINATED', termination_details: { code: 'CLOUD_FAILURE', type: 'CLOUD_FAILURE' } }).outcome, 'failed');
  assert.equal(o({ state: 'TERMINATED', termination_details: { code: 'SOME_NEW_CODE', type: 'INTERNAL_ERROR' } }).outcome, 'failed');
  assert.equal(o({ state: 'TERMINATED' }).outcome, 'unknown', 'no termination details is unknown, not success');
  assert.equal(o({ state: 'lower-case junk' }).outcome, 'unknown');

  const l = (state) => mapi.runOutcome({ state });
  assert.equal(l({ life_cycle_state: 'RUNNING' }).outcome, 'running');
  assert.equal(l({ life_cycle_state: 'PENDING' }).outcome, 'pending');
  assert.equal(l({ life_cycle_state: 'INTERNAL_ERROR' }).outcome, 'failed');
  assert.equal(l({ life_cycle_state: 'TERMINATED', result_state: 'TIMEDOUT' }).text, 'Timed out');
  assert.equal(l({ life_cycle_state: 'TERMINATED', result_state: 'UPSTREAM_CANCELED' }).outcome, 'canceled');
  assert.equal(l({ life_cycle_state: 'SKIPPED' }).outcome, 'skipped');
  assert.equal(mapi.runOutcome({}).outcome, 'unknown');
});

test('jobs: invalid or duplicate run IDs are dropped and counted', () => {
  const res = mapi.normalizeRunsResponse(
    {
      runs: [run(), run({ run_id: 'abc' }), run({ run_id: -1 }), run({ run_id: 1.5 }), run({ run_id: undefined }), run(), null, 'x', run({ run_id: '33', run_page_url: runUrl(11, 33) })],
      has_more: false,
    },
    CTX
  );
  assert.deepEqual(res.runs.map((r) => r.runId), ['22', '33']);
  assert.equal(res.dropped, 7);
  assert.equal(res.hasMore, false);
  const badJob = mapi.normalizeRun(run({ job_id: 'nope' }), CTX);
  assert.equal(badJob.jobId, null);
  assert.equal(badJob.url, null, 'no link without a valid job ID');
});

test('jobs: IDs above 2^53 are recovered only from a matching validated run URL', () => {
  const bigRun = '9007199254740993123';
  const parsed = JSON.parse(`{"job_id": 11, "run_id": ${bigRun}, "run_page_url": "${runUrl(11, bigRun)}", "status": {"state": "RUNNING"}}`);
  assert.equal(Number.isSafeInteger(parsed.run_id), false);
  const r = mapi.normalizeRun(parsed, CTX);
  assert.equal(r.runId, bigRun);
  assert.equal(r.url, runUrl(11, bigRun));
  const mismatch = JSON.parse(`{"job_id": 11, "run_id": ${bigRun}, "run_page_url": "${runUrl(11, '9007199254740993999999')}", "status": {"state": "RUNNING"}}`);
  assert.equal(mapi.normalizeRun(mismatch, CTX), null);
  const noUrl = JSON.parse(`{"job_id": 11, "run_id": ${bigRun}, "status": {"state": "RUNNING"}}`);
  assert.equal(mapi.normalizeRun(noUrl, CTX), null);
});

test('jobs: only a same-workspace run_page_url for that exact run is kept', () => {
  const url = (u, over = {}) => mapi.normalizeRun(run({ run_page_url: u, ...over }), CTX).url;
  assert.equal(url(runUrl(11, 22)), runUrl(11, 22));
  assert.equal(url(`${ORIGIN}/jobs/11/runs/22?o=${WS}`), `${ORIGIN}/jobs/11/runs/22?o=${WS}`);
  assert.equal(url('/jobs/11/runs/22'), `${ORIGIN}/jobs/11/runs/22`, 'relative resolves against the workspace origin');
  assert.equal(url('https://dbc-2.cloud.databricks.com/?o=' + WS + '#job/11/run/22'), null, 'other workspace host');
  assert.equal(url('https://evil.example/#job/11/run/22'), null);
  assert.equal(url('http://dbc-1.cloud.databricks.com/#job/11/run/22'), null, 'not https');
  assert.equal(url('javascript:alert(1)//#job/11/run/22'), null);
  assert.equal(url(`${ORIGIN}/?o=999#job/11/run/22`), null, 'other workspace ID');
  assert.equal(url(runUrl(11, 23)), null, 'different run');
  assert.equal(url(runUrl(12, 22)), null, 'different job');
  assert.equal(url(`${ORIGIN}/jobs/11`), null, 'job page, not a run page');
  assert.equal(url(`${ORIGIN}/jobs/11/runs/22/edit`), null);
  assert.equal(url(12345), null);
  assert.equal(url(runUrl(11, 21), { original_attempt_run_id: 21 }), runUrl(11, 21), 'original attempt link is the same run');
  assert.equal(mapi.normalizeRun(run(), { origin: 'https://accounts.cloud.databricks.com', workspaceId: WS }).url, null, 'account console origin');
});

test('jobs: unknown or missing values are null (never zero) and free-text messages are not kept', () => {
  const active = mapi.normalizeRun({ job_id: 11, run_id: 22, start_time: NOW - 5000, end_time: 0, run_duration: 0, status: { state: 'RUNNING' } }, CTX);
  assert.equal(active.active, true);
  assert.equal(active.endMs, null);
  assert.equal(active.durationMs, null);
  assert.equal(active.name, null);
  assert.equal(active.trigger, null);
  assert.equal(active.attempt, null);
  assert.equal(active.url, null);

  const bare = mapi.normalizeRun({ job_id: 11, run_id: 22, status: { state: 'TERMINATED', termination_details: { code: 'SUCCESS' } } }, CTX);
  assert.equal(bare.startMs, null);
  assert.equal(bare.endMs, null);
  assert.equal(bare.durationMs, null);

  const computed = mapi.normalizeRun(run({ run_duration: undefined, start_time: NOW - 3000, end_time: NOW }), CTX);
  assert.equal(computed.durationMs, 3000);

  const noisy = mapi.normalizeRun(
    run({
      status: { state: 'TERMINATED', termination_details: { code: 'RUN_EXECUTION_ERROR', type: 'CLIENT_ERROR', message: 'SELECT secret_col FROM t failed' } },
      state: { state_message: 'SELECT secret_col FROM t' },
      run_name: 'Nightly\u0000 ETL',
    }),
    CTX
  );
  assert.doesNotMatch(JSON.stringify(noisy), /secret_col/);
  assert.equal(noisy.name, 'Nightly ETL');
});

test('jobs: page tokens are validated; an unusable token marks the list truncated', () => {
  const ok = mapi.normalizeRunsResponse({ runs: [], next_page_token: 'CAEQ_abc-1.2:3', has_more: true }, CTX);
  assert.equal(ok.nextPageToken, 'CAEQ_abc-1.2:3');
  assert.equal(ok.truncated, false);
  const bad = mapi.normalizeRunsResponse({ runs: [], next_page_token: 'abc+/==', has_more: true }, CTX);
  assert.equal(bad.nextPageToken, null);
  assert.equal(bad.hasMore, true);
  assert.equal(bad.truncated, true);
});

test('pipelines: valid IDs only; keeps active or recently failed; newest update first', () => {
  const P = (id, over) => ({ pipeline_id: id, name: 'p-' + id.slice(0, 4), state: 'IDLE', ...over });
  const U = (id, state, iso) => ({ update_id: id, state, creation_time: iso });
  const uuid = (n) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;
  const res = mapi.normalizePipelinesResponse(
    {
      statuses: [
        P(uuid(1), { state: 'RUNNING', latest_updates: [U(uuid(9), 'SETTING_UP_TABLES', '2026-10-15T11:50:00Z'), U(uuid(8), 'COMPLETED', '2026-10-15T10:00:00Z')] }),
        P(uuid(2), { latest_updates: [U(uuid(7), 'FAILED', '2026-10-15T09:00:00.000Z')] }),
        P(uuid(3), { latest_updates: [U(uuid(6), 'FAILED', '2026-10-13T09:00:00Z')] }),
        P(uuid(4), { latest_updates: [U(uuid(5), 'COMPLETED', '2026-10-15T09:00:00Z')] }),
        P(uuid(5), { state: 'FAILED', health: 'UNHEALTHY', latest_updates: [] }),
        P(uuid(6), { latest_updates: [U('not-a-uuid', 'RUNNING'), U(uuid(4), 'QUEUED', 'garbage')] }),
        { pipeline_id: 'bad', state: 'RUNNING' },
      ],
    },
    NOW
  );
  assert.equal(res.dropped, 1);
  assert.equal(res.listed, 6);
  const byId = Object.fromEntries(res.pipelines.map((p) => [p.pipelineId, p]));
  assert.deepEqual(Object.keys(byId).sort(), [uuid(1), uuid(2), uuid(5), uuid(6)].sort());
  assert.equal(byId[uuid(1)].update.statusText, 'Setting up tables');
  assert.equal(byId[uuid(1)].update.createdMs, Date.parse('2026-10-15T11:50:00Z'));
  assert.equal(byId[uuid(2)].recentFailure, true);
  assert.equal(byId[uuid(5)].health, 'UNHEALTHY');
  assert.equal(byId[uuid(5)].update, null);
  assert.equal(byId[uuid(6)].update.updateId, uuid(4), 'invalid update ID skipped');
  assert.equal(byId[uuid(6)].update.createdMs, null, 'unparseable time is null');
  assert.equal(byId[uuid(6)].update.outcome, 'pending');
});

test('warehouses and clusters: validated IDs, serverless flag, active clusters only, missing → null', () => {
  const wh = mapi.normalizeWarehousesResponse({
    warehouses: [
      { id: '0123456789abcdef', name: 'Starter', state: 'RUNNING', cluster_size: 'Small', enable_serverless_compute: true, num_clusters: 1, warehouse_type: 'PRO' },
      { id: 'fedcba9876543210', name: 'Big', state: 'STOPPED', cluster_size: 'Large' },
      { id: 'not-an-id', state: 'RUNNING' },
    ],
  });
  assert.equal(wh.dropped, 1);
  assert.equal(wh.warehouses[0].serverless, true);
  assert.equal(wh.warehouses[0].activeClusters, 1);
  assert.equal(wh.warehouses[1].serverless, false);
  assert.equal(wh.warehouses[1].activeClusters, null);

  const cl = mapi.normalizeClustersResponse({
    clusters: [
      { cluster_id: '0923-164208-meows279', cluster_name: 'Shared', state: 'RUNNING', cluster_source: 'UI', autoscale: { min_workers: 2, max_workers: 8 }, start_time: NOW - H },
      { cluster_id: '0923-164208-abcd1234', cluster_name: 'job-1-run-2', state: 'PENDING', cluster_source: 'JOB', num_workers: 0 },
      { cluster_id: '0923-164208-zzzz9999', state: 'TERMINATED' },
      { cluster_id: 'bogus', state: 'RUNNING' },
    ],
    next_page_token: 'tok',
  });
  assert.equal(cl.dropped, 1);
  assert.deepEqual(cl.clusters.map((c) => c.clusterId), ['0923-164208-meows279', '0923-164208-abcd1234']);
  assert.deepEqual(cl.clusters[0].autoscale, { min: 2, max: 8 });
  assert.equal(cl.clusters[0].workers, null);
  assert.equal(cl.clusters[1].workers, 0, 'a real zero stays zero');
  assert.equal(cl.clusters[1].startMs, null);
  assert.equal(cl.clusters[1].statusText, 'Starting');
  assert.equal(cl.lastActive, false);
  assert.equal(cl.hasMore, true);
});

test('counts: sections that never loaded are null, not zero', () => {
  const runs = mapi.normalizeRunsResponse(
    {
      runs: [
        run({ run_id: 1, run_page_url: runUrl(11, 1), status: { state: 'RUNNING' } }),
        run({ run_id: 2, run_page_url: runUrl(11, 2), status: { state: 'QUEUED' } }),
      ],
    },
    CTX
  ).runs;
  const recent = mapi.normalizeRunsResponse(
    {
      runs: [
        run({ run_id: 3, run_page_url: runUrl(11, 3), status: { state: 'TERMINATED', termination_details: { code: 'DRIVER_ERROR', type: 'CLIENT_ERROR' } } }),
        run({ run_id: 4, run_page_url: runUrl(11, 4) }),
        run({ run_id: 5, run_page_url: runUrl(11, 5), end_time: NOW - 30 * H, start_time: NOW - 31 * H }),
      ],
    },
    CTX
  ).runs;
  const c = mapi.summarize({ runsActive: runs, runsRecent: recent }, NOW);
  assert.equal(c.running, 1);
  assert.equal(c.pending, 1);
  assert.equal(c.failed, 1);
  assert.equal(c.succeeded, 1, 'run that ended 30 h ago is outside the 24 h window');
  assert.equal(c.pipelinesActive, null);
  assert.equal(c.warehousesRunning, null);
  assert.equal(c.clustersActive, null);
  const none = mapi.summarize({}, NOW);
  assert.ok(Object.values(none).every((v) => v === null));
});

test('requests: only the four monitor GET paths, all within the HTTP allowlist, with valid query values', () => {
  assert.deepEqual([...mapi.MONITOR_PATHS].sort(), ['/api/2.0/pipelines', '/api/2.0/sql/warehouses', '/api/2.1/clusters/list', '/api/2.2/jobs/runs/list']);
  assert.equal(mapi.isMonitorPath('/api/2.0/sql/statements'), false);
  const reqs = [mapi.requests.activeRuns(), mapi.requests.recentRuns(NOW, 'CAEQ'), mapi.requests.pipelines(), mapi.requests.warehouses(null), mapi.requests.clusters('tok')];
  for (const r of reqs) {
    assert.ok(mapi.isMonitorPath(r.path));
    assert.ok(http.isAllowed('GET', r.path));
    assert.doesNotThrow(() => http.buildUrl(ORIGIN, r.path, r.query));
  }
  assert.equal(reqs[0].query.active_only, 'true');
  assert.equal(reqs[0].query.limit, '25');
  assert.equal(reqs[1].query.completed_only, 'true');
  assert.equal(reqs[1].query.start_time_from, String(NOW - 24 * H));
  assert.equal(reqs[1].query.page_token, 'CAEQ');
  assert.equal(reqs[2].query.max_results, '100');
  assert.equal(mapi.requests.recentRuns(NOW, 'bad token!').query.page_token, undefined);
});
