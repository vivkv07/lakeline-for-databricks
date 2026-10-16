// Genie API module: request builders, strict normalization of untrusted responses, the HTTP
// allowlist and the error catalog. Pure unit tests on synthetic JSON shaped like the documented
// API (notes/GENIE.md); no network. SIMULATED: real Genie responses were never captured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './support/load.mjs';

const gapi = load('databricks/genie-api.js');
const http = load('databricks/http.js');
const errors = load('errors.js');
const demo = load('core/genie-demo.js');
const sender = load('background/sender.js');

const SPACE = '3c409c00b54a44c79f79da06b82460e2';
const CONV = 'e1ef34712a29169db030324fd0e1df5f';
const MSG = 'f1ef34712a29169db030324fd0e1df60';
const UUIDISH = '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ATT = 'att-01ef0a1b2c3d';

test('request builders: exact documented paths, bodies carry only the question', () => {
  assert.deepEqual(gapi.requests.listSpaces(), { method: 'GET', path: '/api/2.0/genie/spaces', query: { page_size: '100' } });
  assert.deepEqual(gapi.requests.listSpaces('o20').query, { page_size: '100', page_token: 'o20' });
  const why = (re) => (e) => re.test(e.dcc.details.message);
  assert.throws(() => gapi.requests.listSpaces('a/b=='), why(/page token/i));
  const start = gapi.requests.startConversation(SPACE, '  What was revenue?\r\nBy region  ');
  assert.deepEqual(start, { method: 'POST', path: `/api/2.0/genie/spaces/${SPACE}/start-conversation`, body: { content: 'What was revenue?\nBy region' } });
  assert.equal(gapi.requests.createMessage(SPACE, CONV, 'next').path, `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages`);
  assert.equal(gapi.requests.getMessage(SPACE, CONV, MSG).path, `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}`);
  assert.equal(gapi.requests.queryResult(SPACE, CONV, MSG, ATT).path, `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}/attachments/${ATT}/query-result`);
  assert.equal(gapi.requests.executeQuery(SPACE, CONV, MSG, ATT).method, 'POST');
  assert.ok(gapi.requests.getMessage(UUIDISH, CONV, MSG).path.includes(UUIDISH), 'hyphenated UUIDs are accepted too');
  for (const bad of ['../x', SPACE + '/../', 'ABC', '', null, SPACE.slice(1)]) assert.throws(() => gapi.requests.startConversation(bad, 'q'), why(/agent ID/));
  assert.throws(() => gapi.requests.queryResult(SPACE, CONV, MSG, 'a/b'), why(/attachment/));
  assert.throws(() => gapi.requests.startConversation(SPACE, '   '), why(/empty or too long/));
  assert.throws(() => gapi.requests.startConversation(SPACE, 'x'.repeat(2001)), why(/empty or too long/));
  assert.equal(gapi.cleanQuestion('a\u0000b\u0007c'), 'abc', 'control characters are removed');
  assert.equal(gapi.cleanQuestion('x'.repeat(2000)).length, 2000);
});

test('every built path passes the genie-scoped HTTP allowlist and nothing else', () => {
  const reqs = [
    gapi.requests.listSpaces(),
    gapi.requests.startConversation(SPACE, 'q'),
    gapi.requests.createMessage(SPACE, CONV, 'q'),
    gapi.requests.getMessage(SPACE, CONV, MSG),
    gapi.requests.queryResult(SPACE, CONV, MSG, ATT),
    gapi.requests.executeQuery(SPACE, CONV, MSG, ATT),
  ];
  for (const r of reqs) {
    assert.equal(http.isAllowed(r.method, r.path, { scope: 'genie' }), true, r.method + ' ' + r.path);
    assert.equal(http.isAllowed(r.method, r.path), false, 'the default allowlist (also used by the helper) never admits ' + r.path);
  }
});

test('http allowlist: Genie POSTs only for start, follow-up and execute-query; other writes stay blocked', () => {
  const g = { scope: 'genie' };
  const blocked = [
    ['POST', '/api/2.0/genie/spaces'], // create agent
    ['PATCH', `/api/2.0/genie/spaces/${SPACE}`],
    ['DELETE', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}`],
    ['POST', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}/feedback`],
    ['POST', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}/comments`],
    ['POST', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}/attachments/${ATT}/downloads`],
    ['GET', `/api/2.0/genie/spaces/${SPACE}`],
    ['GET', `/api/2.0/genie/spaces/${SPACE}/conversations`],
    ['GET', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages`],
    ['POST', '/api/2.0/genie/agents/' + SPACE + '/conversations'],
    ['GET', `/api/2.0/genie/spaces/${SPACE}/conversations/${CONV}/messages/${MSG}/attachments/a/b/query-result`],
    ['GET', `/api/2.0/genie/spaces/${SPACE}x/conversations/${CONV}/messages/${MSG}`],
    ['GET', '/api/2.0/genie/spaces?x=1'],
    ['POST', '/api/2.0/sql/statements'], // a Genie client can't run SQL
    ['GET', '/api/2.0/sql/warehouses'],
    ['POST', '/api/2.0/jobs/run-now'],
  ];
  for (const [m, p] of blocked) assert.equal(http.isAllowed(m, p, g), false, m + ' ' + p);
  // The default client is unchanged.
  assert.equal(http.isAllowed('POST', '/api/2.0/sql/statements'), true);
  assert.equal(http.isAllowed('GET', '/api/2.0/sql/warehouses'), true);
  assert.equal(http.isAllowed('POST', '/api/2.0/jobs/run-now'), false);
  assert.equal(http.isAllowed('GET', undefined, g), false);
});

test('http client enforces the scope at request time, with no redirects and no cookies', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"spaces":[]}' };
  };
  const genie = http.create({ origin: 'https://dbc-aaa.cloud.databricks.com', token: 'tok-genie-123', fetch: fetchImpl, scope: 'genie' });
  await genie.get('/api/2.0/genie/spaces', { page_size: '100' });
  assert.equal(seen[0].url, 'https://dbc-aaa.cloud.databricks.com/api/2.0/genie/spaces?page_size=100');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.credentials, 'omit');
  await assert.rejects(genie.post('/api/2.0/sql/statements', {}), /Blocked|allowlisted|Something went wrong/);
  const plain = http.create({ origin: 'https://dbc-aaa.cloud.databricks.com', token: 't', fetch: fetchImpl });
  await assert.rejects(plain.get('/api/2.0/genie/spaces'), (e) => e.dcc && /non-allowlisted/.test(e.dcc.details.message));
  assert.equal(seen.length, 1, 'blocked calls never reach fetch');
});

test('normalizeSpaces: valid IDs only, deduplicated, capped, text cleaned, unsafe page tokens not followed', () => {
  const out = gapi.normalizeSpaces({
    spaces: [
      { space_id: SPACE, title: '  Sales\nanalytics ', description: 'Orders\u0000 and revenue', warehouse_id: 'abc' },
      { space_id: SPACE, title: 'dup' },
      { space_id: '../../evil', title: 'x' },
      { space_id: UUIDISH, title: '' },
      null,
    ],
    next_page_token: 'abc/def==',
  });
  assert.deepEqual(out.spaces, [
    { id: SPACE, title: 'Sales analytics', description: 'Orders and revenue' },
    { id: UUIDISH, title: 'Untitled agent', description: null },
  ]);
  assert.equal(out.dropped, 3);
  assert.equal(out.nextPageToken, null);
  assert.equal(out.more, true, 'a further page exists even though its token is not followed');
  const many = gapi.normalizeSpaces({ spaces: Array.from({ length: 250 }, (_, i) => ({ space_id: i.toString(16).padStart(32, '0'), title: 'A' + i })) });
  assert.equal(many.spaces.length, gapi.LIMITS.spaces);
  assert.equal(gapi.normalizeSpaces({ spaces: [], next_page_token: 'o100' }).nextPageToken, 'o100');
  assert.deepEqual(gapi.normalizeSpaces(null).spaces, []);
});

test('normalizeMessage: statuses map to phases; unknown statuses keep "working"', () => {
  const phases = Object.fromEntries(gapi.STATUSES.map((s) => [s, gapi.normalizeMessage({ status: s }).phase]));
  assert.deepEqual(phases, {
    SUBMITTED: 'working',
    FETCHING_METADATA: 'working',
    FILTERING_CONTEXT: 'working',
    ASKING_AI: 'working',
    PENDING_WAREHOUSE: 'query',
    EXECUTING_QUERY: 'query',
    COMPLETED: 'done',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    QUERY_RESULT_EXPIRED: 'expired',
  });
  const odd = gapi.normalizeMessage({ status: 'IN_PROGRESS' });
  assert.deepEqual([odd.status, odd.known, odd.phase], ['IN_PROGRESS', false, 'working']);
  assert.equal(gapi.normalizeMessage({ status: '<script>' }).status, 'UNKNOWN');
  assert.equal(gapi.isTerminal('COMPLETED') && gapi.isTerminal('QUERY_RESULT_EXPIRED') && !gapi.isTerminal('IN_PROGRESS'), true);
});

test('normalizeMessage: text, follow-up question, query and suggested attachments; caps and junk dropped', () => {
  const m = gapi.normalizeMessage({
    message_id: MSG,
    conversation_id: CONV,
    status: 'COMPLETED',
    attachments: [
      { attachment_id: 'a1', text: { content: 'Revenue was **$1.2M**.\r\nUp 6%.', purpose: 'TEXT_ATTACHMENT_PURPOSE_ANSWER' } },
      { attachment_id: 'a2', text: { content: 'Which region do you mean?', purpose: 'FOLLOW_UP_QUESTION' } },
      { attachment_id: ATT, query: { title: 'Revenue', description: 'Sum of orders', query: 'SELECT 1', statement_id: '01EF0A1B-2C3D-4E5F-8A9B-0C1D2E3F4A5B', query_result_metadata: { row_count: 1234, is_truncated: true } } },
      { attachment_id: 'a4', query: { title: 'Second query', query: 'SELECT 2' } },
      { attachment_id: 'a5', suggested_questions: { questions: ['By month?', 'By month?', ' By  product ', 7, 'x'.repeat(400)] } },
      { attachment_id: 'a6', viz: { title: 'chart' } },
      { attachment_id: 'a7', mystery: {} },
      'junk',
    ],
  });
  assert.equal(m.messageId, MSG);
  assert.equal(m.conversationId, CONV);
  assert.deepEqual(m.texts, [
    { content: 'Revenue was **$1.2M**.\nUp 6%.', purpose: 'answer' },
    { content: 'Which region do you mean?', purpose: 'followUp' },
  ]);
  assert.deepEqual(m.query, { attachmentId: ATT, title: 'Revenue', description: 'Sum of orders', sql: 'SELECT 1', statementId: '01ef0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', rowCount: 1234, truncated: true });
  assert.equal(m.suggested[0], 'By month?');
  assert.equal(m.suggested[1], 'By product');
  assert.equal(m.suggested.length, 3);
  assert.ok(m.suggested[2].length <= gapi.LIMITS.suggestedLength);
  assert.equal(m.dropped, 3, 'second query, unknown attachment and a non-object');
  const big = gapi.normalizeMessage({ status: 'COMPLETED', attachments: [{ attachment_id: 'x', text: { content: 'y'.repeat(20000) } }, { attachment_id: 'q', query: { query: 'S'.repeat(50000) } }] });
  assert.equal(big.texts[0].content.length, gapi.LIMITS.text);
  assert.equal(big.query.sql.length, gapi.LIMITS.sql);
  assert.equal(big.query.attachmentId, 'q');
  assert.equal(gapi.normalizeMessage({ attachments: [{ attachment_id: 'bad/id', query: { query: 'S' } }] }).query.attachmentId, null);
  // Deprecated fields still read.
  const legacy = gapi.normalizeMessage({ id: MSG, attachments: [{ attachment_id: 'q', query: { query: 'S' } }], query_result: { row_count: 9 } });
  assert.equal(legacy.messageId, MSG);
  assert.equal(legacy.query.rowCount, 9);
});

test('normalizeMessage errors: rate limits are recognized, secrets in error text are redacted', () => {
  const rl = gapi.normalizeMessage({ status: 'FAILED', error: { error: 'Too many requests', type: 'RATE_LIMIT_EXCEEDED_SPECIFIED_WAIT_EXCEPTION' } });
  assert.deepEqual(rl.error, { type: 'RATE_LIMIT_EXCEEDED_SPECIFIED_WAIT_EXCEPTION', text: 'Too many requests', rateLimited: true });
  assert.equal(gapi.messageErrorCode(rl.error), 'GENIE_RATE_LIMITED');
  const other = gapi.normalizeMessage({ status: 'FAILED', error: { error: 'Bearer abc.def.ghi failed', type: 'TABLES_MISSING_EXCEPTION' } });
  assert.equal(gapi.messageErrorCode(other.error), 'GENIE_FAILED');
  assert.ok(!other.error.text.includes('abc.def.ghi'));
  assert.equal(gapi.normalizeMessage({ status: 'FAILED', error: { type: 'bad type!' } }).error, null);
});

test('normalizeStart: IDs from the top level, the conversation or the message', () => {
  const a = gapi.normalizeStart({ conversation_id: CONV, conversation: { title: 'Revenue  question' }, message_id: MSG, message: { status: 'SUBMITTED' } });
  assert.deepEqual([a.conversationId, a.messageId, a.title, a.message.status, a.message.messageId], [CONV, MSG, 'Revenue question', 'SUBMITTED', MSG]);
  const b = gapi.normalizeStart({ message: { message_id: MSG, conversation_id: CONV, status: 'ASKING_AI' } });
  assert.deepEqual([b.conversationId, b.messageId], [CONV, MSG]);
  const c = gapi.normalizeStart({ conversation_id: 'nope', message_id: 'nope' });
  assert.deepEqual([c.conversationId, c.messageId], [null, null]);
});

function result({ rows, cols = [['region', 'STRING'], ['revenue', 'DECIMAL']], total, chunks = 1, truncated = false, state = 'SUCCEEDED' }) {
  return {
    statement_response: {
      statement_id: UUIDISH,
      status: { state },
      manifest: { format: 'JSON_ARRAY', schema: { columns: cols.map(([name, type_name], position) => ({ name, type_name, position })).reverse() }, total_row_count: total, total_chunk_count: chunks, truncated },
      result: { data_array: rows, row_count: rows.length },
    },
  };
}

test('normalizeQueryResult: columns by position, numeric types, nulls kept, row and cell caps, "showing N of M"', () => {
  const t = gapi.normalizeQueryResult(result({ rows: [['EMEA', '412300.50'], ['APAC', null]], total: 2 }));
  assert.deepEqual(t.columns, [
    { name: 'region', type: 'STRING', numeric: false },
    { name: 'revenue', type: 'DECIMAL', numeric: true },
  ]);
  assert.deepEqual(t.rows, [['EMEA', '412300.50'], ['APAC', null]]);
  assert.deepEqual([t.totalRows, t.shown, t.clipped, t.ready], [2, 2, false, true]);

  const many = gapi.normalizeQueryResult(result({ rows: Array.from({ length: 500 }, (_, i) => ['r' + i, String(i)]), total: 5000, chunks: 3, truncated: true }));
  assert.equal(many.shown, gapi.LIMITS.rows);
  assert.equal(many.totalRows, 5000);
  assert.equal(many.clipped, true);
  assert.equal(many.serverTruncated, true);

  const noTotal = gapi.normalizeQueryResult(result({ rows: [['a', '1']], total: undefined, chunks: 2 }));
  assert.deepEqual([noTotal.totalRows, noTotal.clipped], [null, true], 'unknown total with more chunks: "showing the first N"');

  const wide = gapi.normalizeQueryResult(result({ rows: [Array.from({ length: 60 }, (_, i) => 'v' + i)], cols: Array.from({ length: 60 }, (_, i) => ['c' + i, 'STRING']), total: 1 }));
  assert.equal(wide.columns.length, gapi.LIMITS.columns);
  assert.equal(wide.columnsHidden, 20);
  assert.equal(wide.rows[0].length, gapi.LIMITS.columns);

  const longCell = gapi.normalizeQueryResult(result({ rows: [['x'.repeat(5000), '1']], total: 1 }));
  assert.equal(longCell.rows[0][0].length, gapi.LIMITS.cell);
  assert.ok(longCell.rows[0][0].endsWith('…'));

  // Total size budget: large cells stop the table before the row cap.
  const four = [['a', 'STRING'], ['b', 'STRING'], ['c', 'STRING'], ['d', 'STRING']];
  const heavy = gapi.normalizeQueryResult(result({ rows: Array.from({ length: 200 }, () => Array.from({ length: 4 }, () => 'z'.repeat(1000))), cols: four, total: 200 }));
  assert.ok(heavy.shown < 200 && heavy.shown > 0 && heavy.clipped);
  assert.ok(JSON.stringify(heavy.rows).length <= gapi.LIMITS.tableChars + 2000);

  const pending = gapi.normalizeQueryResult(result({ rows: [], state: 'RUNNING' }));
  assert.deepEqual([pending.ready, pending.failed], [false, false]);
  const failed = gapi.normalizeQueryResult({ statement_response: { status: { state: 'FAILED', error: { message: 'Table missing', error_code: 'TABLE_OR_VIEW_NOT_FOUND' } } } });
  assert.deepEqual([failed.failed, failed.error.text], [true, 'Table missing']);
  // Missing schema: positional names; objects are stringified, never executed or rendered as HTML.
  const bare = gapi.normalizeQueryResult({ statement_response: { status: { state: 'SUCCEEDED' }, result: { data_array: [[{ a: 1 }, '<b>x</b>']] } } });
  assert.deepEqual(bare.columns.map((c) => c.name), ['column 1', 'column 2']);
  assert.deepEqual(bare.rows[0], ['{"a":1}', '<b>x</b>']);
});

test('error catalog: every GENIE_* code has a plain title and next steps, without em dashes', () => {
  const codes = Object.keys(errors.CATALOG).filter((c) => c.startsWith('GENIE_'));
  assert.ok(codes.length >= 12, codes.join(','));
  for (const c of codes) {
    const e = errors.classify({ code: c });
    assert.equal(e.code, c);
    assert.ok(e.title.length > 5 && e.steps.length >= 1, c);
    assert.ok(!/—/.test(e.title + e.steps.join(' ')), c + ' has an em dash');
  }
});

test('demo client: synthetic, stateless and time-driven through the same normalizers', async () => {
  let t = 1_000_000;
  const c = demo.createClient({ now: () => t, random: () => 0.5 });
  const spaces = gapi.normalizeSpaces(await c.get('/api/2.0/genie/spaces'));
  assert.equal(spaces.spaces.length, 3);
  assert.ok(spaces.spaces.every((s) => /DEMO/.test(s.title)));
  const sp = spaces.spaces[0].id;
  const start = gapi.normalizeStart(await c.post(gapi.requests.startConversation(sp, 'Revenue by region?').path, { content: 'Revenue by region?' }));
  assert.ok(gapi.isId(start.conversationId) && gapi.isId(start.messageId));
  const seen = [];
  for (const dt of [0, 600, 1300, 2500, 3700]) {
    t = 1_000_000 + dt;
    // A fresh client (as after a service-worker restart) still knows the message.
    const fresh = demo.createClient({ now: () => t });
    const m = gapi.normalizeMessage(await fresh.get(gapi.requests.getMessage(sp, start.conversationId, start.messageId).path));
    seen.push(m.status);
    if (m.status === 'COMPLETED') {
      assert.match(m.texts[0].content, /DEMO/);
      const r = gapi.normalizeQueryResult(await fresh.get(gapi.requests.queryResult(sp, start.conversationId, start.messageId, m.query.attachmentId).path));
      assert.equal(r.columns[0].name, 'region');
      assert.equal(r.shown, 5);
      assert.ok(m.suggested.length >= 1);
    }
  }
  assert.deepEqual(seen, ['SUBMITTED', 'FILTERING_CONTEXT', 'ASKING_AI', 'EXECUTING_QUERY', 'COMPLETED']);
  const failing = demo.SPACES[2].space_id;
  t = 5_000_000;
  const f = gapi.normalizeStart(await c.post(gapi.requests.startConversation(failing, 'anything').path, { content: 'anything' }));
  t += 2000;
  const fm = gapi.normalizeMessage(await c.get(gapi.requests.getMessage(failing, f.conversationId, f.messageId).path));
  assert.equal(fm.status, 'FAILED');
  assert.match(fm.error.text, /DEMO/);
  await assert.rejects(c.get('/api/2.0/sql/warehouses'), (e) => e.httpStatus === 404);
});

test('sender: the side panel is a page sender (not admin); look-alike paths and origins are refused', () => {
  const ctx = { extensionId: 'abcdefghijklmnopabcdefghijklmnop', extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' };
  const s = (url, id = ctx.extensionId) => ({ id, url });
  assert.ok(sender.PAGE_PATHS.includes('/ui/sidepanel.html'));
  assert.deepEqual(sender.validatePageSender(s(ctx.extensionOrigin + '/ui/sidepanel.html'), ctx), { ok: true, page: '/ui/sidepanel.html' });
  assert.equal(sender.validatePageSender(s(ctx.extensionOrigin + '/ui/sidepanel.html'), ctx, { admin: true }).ok, false);
  assert.equal(sender.validatePageSender(s(ctx.extensionOrigin + '/ui/sidepanel.htm'), ctx).ok, false);
  assert.equal(sender.validatePageSender(s('chrome-extension://otherotherotherotherotherotherot/ui/sidepanel.html', 'otherotherotherotherotherotherot'), ctx).ok, false);
  assert.equal(sender.validatePageSender(s('https://dbc-aaa.cloud.databricks.com/ui/sidepanel.html'), ctx).ok, false);
});
