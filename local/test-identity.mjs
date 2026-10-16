import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const ids = load('core/ids.js');
const V = load('core/validate.js');

test('classifyOrigin accepts the three supported workspace host families', () => {
  assert.deepEqual(ids.classifyOrigin('https://dbc-a1b2c3d4-e5f6.cloud.databricks.com/jobs/1').cloud, 'aws');
  assert.deepEqual(ids.classifyOrigin('https://adb-1234567890123456.7.azuredatabricks.net/?o=1234567890123456').cloud, 'azure');
  assert.deepEqual(ids.classifyOrigin('https://1234567890123456.7.gcp.databricks.com/').cloud, 'gcp');
  assert.equal(ids.classifyOrigin('http://127.0.0.1:8765/workspace.html').kind, 'fixture');
});

test('classifyOrigin rejects account consoles, other sites, http and lookalikes', () => {
  for (const url of [
    'https://accounts.cloud.databricks.com/',
    'https://accounts.azuredatabricks.net/',
    'https://accounts.gcp.databricks.com/',
    'https://login.databricks.com/',
    'https://docs.databricks.com/',
    'http://dbc-1.cloud.databricks.com/',
    'https://cloud.databricks.com.evil.example/',
    'https://evilcloud.databricks.com.example.net/',
    'https://dbc-1.cloud.databricks.com:8443/',
    'https://user:pw@dbc-1.cloud.databricks.com/',
    'https://.azuredatabricks.net/',
    'http://127.0.0.1:8766/setup',
    'http://localhost:8765/',
    'not a url',
  ]) {
    assert.equal(ids.classifyOrigin(url).ok, false, url);
  }
});

test('resolveWorkspaceId reads o=, w=, workspace_id=, hash params, and documented hosts', () => {
  assert.deepEqual(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/jobs?o=42'), { id: '42', source: 'param:o' });
  assert.equal(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/?w=77').id, '77');
  assert.equal(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/?workspace_id=88').id, '88');
  assert.equal(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/#job/5?o=99').id, '99');
  assert.deepEqual(ids.resolveWorkspaceId('https://adb-1234567890123456.7.azuredatabricks.net/'), { id: '1234567890123456', source: 'host' });
  assert.equal(ids.resolveWorkspaceId('https://555.1.gcp.databricks.com/').id, '555');
});

test('resolveWorkspaceId falls back to observed tab, then saved connection, and refuses conflicts', () => {
  const url = 'https://dbc-1.cloud.databricks.com/jobs';
  assert.deepEqual(ids.resolveWorkspaceId(url, { observedId: '11', savedId: '22' }), { id: '11', source: 'observed-tab' });
  assert.deepEqual(ids.resolveWorkspaceId(url, { savedId: '22' }), { id: '22', source: 'saved-connection' });
  assert.equal(ids.resolveWorkspaceId(url, {}).id, null);
  const conflict = ids.resolveWorkspaceId('https://adb-111.7.azuredatabricks.net/?o=222');
  assert.equal(conflict.id, null);
  assert.equal(conflict.conflict, true);
  assert.equal(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/?o=12abc').conflict, true);
  assert.equal(ids.resolveWorkspaceId('https://dbc-1.cloud.databricks.com/?o=1&o=2').conflict, true);
});

const ORIGIN = 'https://dbc-1.cloud.databricks.com';
const PIPE = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const UPD = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('parseResourceLink resolves native job, run, pipeline, update, warehouse, notebook, app links', () => {
  const p = (href) => ids.parseResourceLink(href, ORIGIN, '42');
  assert.deepEqual(p('/jobs/123?o=42'), { type: 'job', jobId: '123', origin: ORIGIN, workspaceId: '42' });
  assert.equal(p('/jobs/123/runs/456').type, 'job_run');
  assert.equal(p('/jobs/123/runs/456').runId, '456');
  assert.equal(p(`/pipelines/${PIPE}`).pipelineId, PIPE);
  assert.equal(p(`/pipelines/${PIPE}/updates/${UPD}`).updateId, UPD);
  assert.equal(p('/sql/warehouses/0123456789abcdef').warehouseId, '0123456789abcdef');
  assert.equal(p('/editor/notebooks/987').notebookId, '987');
  assert.equal(p('/apps/sales-dashboard').appName, 'sales-dashboard');
  assert.equal(p('/#job/12/run/34').type, 'job_run');
  assert.equal(p(`/#joblist/pipelines/${PIPE}`).type, 'pipeline');
  assert.equal(p('/#notebook/55').notebookId, '55');
  const stmt = '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.deepEqual(p(`/sql/history?o=42&queryId=${stmt}`), { type: 'statement', statementId: stmt, origin: ORIGIN, workspaceId: '42' });
});

test('parseResourceLink rejects external, cross-workspace, edit/create and navigation-only links', () => {
  const p = (href) => ids.parseResourceLink(href, ORIGIN, '42');
  assert.equal(p('https://evil.example/jobs/1'), null);
  assert.equal(p('https://dbc-2.cloud.databricks.com/jobs/1'), null);
  assert.equal(p('/jobs/1?o=43'), null);
  assert.equal(p('/jobs/create'), null);
  assert.equal(p('/jobs/1/edit'), null);
  assert.equal(p('/jobs/1/settings'), null);
  assert.equal(p('/jobs'), null);
  assert.equal(p('/apps/create'), null);
  assert.equal(p('/pipelines/not-a-uuid'), null);
  assert.equal(p('/sql/warehouses/XYZ'), null);
  assert.equal(p('javascript:alert(1)'), null);
});

test('parsePageRoute identifies detail pages including tab sub-routes', () => {
  assert.deepEqual(ids.parsePageRoute(`${ORIGIN}/jobs/7/runs?o=42`), { type: 'job', jobId: '7' });
  assert.equal(ids.parsePageRoute(`${ORIGIN}/jobs/7/runs/8`).type, 'job_run');
  assert.equal(ids.parsePageRoute(`${ORIGIN}/pipelines/${PIPE}/updates`).type, 'pipeline');
  assert.equal(ids.parsePageRoute(`${ORIGIN}/sql/history?o=42`).type, 'query_history');
});

test('sanitizeRef re-validates refs received over messaging', () => {
  assert.deepEqual(ids.sanitizeRef({ type: 'job', jobId: '1', extra: 'x' }), { type: 'job', jobId: '1' });
  assert.equal(ids.sanitizeRef({ type: 'job', jobId: '1 OR 1=1' }), null);
  assert.equal(ids.sanitizeRef({ type: 'warehouse', warehouseId: "abc'; DROP" }), null);
  assert.equal(ids.sanitizeRef({ type: 'app', appName: 'create' }), null);
  assert.equal(ids.sanitizeRef({ type: 'nope' }), null);
  assert.equal(ids.refKey({ type: 'job_run', jobId: '1', runId: '2' }), 'job_run:1:2');
});

test('validators: three-part names, colors, IDs', () => {
  assert.equal(V.quoteThreePartName('system.billing.usage'), '`system`.`billing`.`usage`');
  assert.equal(V.quoteThreePartName('Finops.Views.Usage_v2'), '`finops`.`views`.`usage_v2`');
  for (const bad of ['system.billing', 'a.b.c.d', 'a.b.`c`', 'a.b.c;--', 'a.b.*', ' . . ', 'a.b.c d']) {
    assert.equal(V.parseThreePartName(bad), null, bad);
  }
  assert.throws(() => V.quoteThreePartName('x'));
  assert.equal(V.isHexColor('#1A2b3C'), true);
  for (const bad of ['#123', '123456', '#12345g', '#1234567', 'red', '#123456;}', null]) assert.equal(V.isHexColor(bad), false, String(bad));
  assert.equal(V.isWorkspaceId('0'), false);
  assert.equal(V.isWorkspaceId('1234567890123456789'), true);
  assert.equal(V.isWorkspaceId('12345678901234567890'), false);
  assert.equal(V.isPairingKey('0123456789abcdef01234567'), true);
  assert.equal(V.isPairingKey('0123456789ABCDEF01234567'), false);
});
