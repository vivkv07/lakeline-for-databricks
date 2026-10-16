/*
 * DEMO Genie: synthetic agents and canned answers for Demo mode. No network, no storage.
 *
 * createClient() returns an object with the same get(path, query) / post(path, body) surface as
 * the real HTTP client, answering the verified Genie paths with JSON shaped like the real API, so
 * Demo mode exercises the same background pipeline and normalization. It is stateless: message
 * and conversation IDs encode the agent, the canned answer and the creation time, so polling
 * keeps working after a service-worker restart. Every agent title and answer says DEMO.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;

  const ORIGIN = 'demo';
  const SPACES = Object.freeze([
    { space_id: 'de300000000000000000000000000001', title: 'Revenue analytics · DEMO', description: 'Synthetic orders and revenue by region. DEMO data, not from Databricks.' },
    { space_id: 'de300000000000000000000000000002', title: 'Pipeline operations · DEMO', description: 'Synthetic job and pipeline run history. DEMO data, not from Databricks.' },
    { space_id: 'de300000000000000000000000000003', title: 'Unavailable agent · DEMO', description: 'Always fails, to show how errors look.' },
  ]);
  // ms after the question: when each status starts.
  const TIMELINE = Object.freeze([
    [0, 'SUBMITTED'],
    [500, 'FILTERING_CONTEXT'],
    [1200, 'ASKING_AI'],
    [2400, 'EXECUTING_QUERY'],
    [3600, 'COMPLETED'],
  ]);
  const FAIL_TIMELINE = Object.freeze([
    [0, 'SUBMITTED'],
    [600, 'ASKING_AI'],
    [1600, 'FAILED'],
  ]);

  const ANSWERS = Object.freeze([
    {
      text: 'DEMO answer (synthetic): revenue last month was $1.24M, up 6.1% on the month before. EMEA grew fastest, and APAC had the most orders.',
      title: 'Revenue by region, last month',
      description: 'Sums synthetic order amounts per region for the previous calendar month.',
      sql: "SELECT region,\n       ROUND(SUM(amount_usd), 0) AS revenue_usd,\n       COUNT(*) AS orders,\n       ROUND(100 * (SUM(amount_usd) / LAG(SUM(amount_usd)) OVER (PARTITION BY region ORDER BY month) - 1), 1) AS change_pct\nFROM demo.sales.orders\nWHERE month = date_trunc('month', current_date() - INTERVAL 1 MONTH)\nGROUP BY region\nORDER BY revenue_usd DESC",
      columns: [['region', 'STRING'], ['revenue_usd', 'DECIMAL'], ['orders', 'LONG'], ['change_pct', 'DOUBLE']],
      rows: [
        ['EMEA', '412300', '3120', '9.4'],
        ['North America', '398900', '2875', '4.2'],
        ['APAC', '301750', '3410', '6.8'],
        ['LATAM', '96200', '1024', '2.1'],
        ['Other', '31850', '402', null],
      ],
      suggested: ['Which products drove the EMEA growth?', 'Show revenue by week for the last quarter'],
    },
    {
      text: 'DEMO answer (synthetic): 3 of 6 jobs had a failed run in the last 7 days. Nightly sales ETL failed twice, both at the load step.',
      title: 'Job runs and failures, last 7 days',
      description: 'Counts synthetic runs and failed runs per job.',
      sql: "SELECT job_name,\n       COUNT(*) AS runs,\n       COUNT_IF(result_state = 'FAILED') AS failed,\n       ROUND(100 * COUNT_IF(result_state = 'SUCCEEDED') / COUNT(*), 1) AS success_pct\nFROM demo.ops.job_runs\nWHERE period_start >= current_date() - INTERVAL 7 DAYS\nGROUP BY job_name\nORDER BY failed DESC, runs DESC",
      columns: [['job_name', 'STRING'], ['runs', 'LONG'], ['failed', 'LONG'], ['success_pct', 'DOUBLE']],
      rows: [
        ['Nightly sales ETL (demo)', '7', '2', '71.4'],
        ['Orders ingest (demo)', '28', '1', '96.4'],
        ['Feature refresh (demo)', '7', '1', '85.7'],
        ['Inventory snapshot (demo)', '7', '0', '100'],
        ['Marketing export (demo)', '4', '0', '100'],
        ['Data quality checks (demo)', '14', '0', '100'],
      ],
      suggested: ['Why did Nightly sales ETL fail?', 'Which pipeline updates ran longest this week?'],
    },
    {
      text: 'DEMO answer (synthetic): here are daily orders for the last 5 days. This is a canned answer, so try asking about revenue or failed jobs.',
      title: 'Daily orders, last 5 days',
      description: 'Counts synthetic orders per day.',
      sql: 'SELECT order_date, COUNT(*) AS orders\nFROM demo.sales.orders\nWHERE order_date >= current_date() - INTERVAL 5 DAYS\nGROUP BY order_date\nORDER BY order_date',
      columns: [['order_date', 'DATE'], ['orders', 'LONG']],
      rows: [
        ['2026-10-10', '1204'],
        ['2026-10-11', '1187'],
        ['2026-10-12', '1340'],
        ['2026-10-13', '1298'],
        ['2026-10-14', '1356'],
      ],
      suggested: ['What was revenue by region last month?', 'Which jobs failed this week?'],
    },
  ]);

  const ID = /^de3([0-9a-f])([0-9a-f])([0-9a-f]{12})([0-9a-f]{15})$/;

  function pickAnswer(spaceIndex, question) {
    const q = String(question || '').toLowerCase();
    if (spaceIndex === 2) return 1;
    if (/revenue|sales|region|customer|product|order value/.test(q)) return 0;
    if (/job|pipeline|fail|run|error|update/.test(q)) return 1;
    return spaceIndex === 1 ? 1 : 2;
  }

  /** 32 hex: de3 + agent (1) + answer (1) + created ms (12) + salt (15). */
  function makeId(spaceIndex, answer, createdMs, salt) {
    return 'de3' + spaceIndex.toString(16) + answer.toString(16) + Math.max(0, Math.floor(createdMs)).toString(16).padStart(12, '0').slice(-12) + salt;
  }

  function parseId(id) {
    const m = ID.exec(String(id || ''));
    if (!m) return null;
    return { spaceIndex: parseInt(m[1], 16), answer: parseInt(m[2], 16), createdMs: parseInt(m[3], 16) };
  }

  function statusAt(timeline, elapsed) {
    let s = timeline[0][1];
    for (const [t, name] of timeline) if (elapsed >= t) s = name;
    return s;
  }

  function notFound() {
    const e = new Error('DEMO: not found');
    e.httpStatus = 404;
    return e;
  }

  /**
   * @param {{now?:()=>number, random?:()=>number}} [o]
   */
  function createClient(o = {}) {
    const now = o.now || (() => Date.now());
    const random = o.random || Math.random;
    const salt = () => Array.from({ length: 15 }, () => Math.floor(random() * 16).toString(16)).join('');

    function message(spaceId, convId, msgId) {
      const info = parseId(msgId);
      if (!info) throw notFound();
      const failing = info.spaceIndex === 3;
      const status = statusAt(failing ? FAIL_TIMELINE : TIMELINE, now() - info.createdMs);
      const a = ANSWERS[info.answer] || ANSWERS[2];
      const msg = { message_id: msgId, conversation_id: convId, space_id: spaceId, status, attachments: [] };
      if (status === 'FAILED') msg.error = { error: 'DEMO: this agent always fails, to show how errors look.', type: 'DEMO_FAILURE' };
      if (status === 'EXECUTING_QUERY' || status === 'COMPLETED') {
        msg.attachments.push({ attachment_id: 'demo-query-' + info.answer, query: { title: a.title, description: a.description, query: a.sql, query_result_metadata: { row_count: a.rows.length, is_truncated: false } } });
      }
      if (status === 'COMPLETED') {
        msg.attachments.unshift({ attachment_id: 'demo-text-' + info.answer, text: { content: a.text, purpose: 'TEXT_ATTACHMENT_PURPOSE_ANSWER' } });
        msg.attachments.push({ attachment_id: 'demo-suggest-' + info.answer, suggested_questions: { questions: a.suggested } });
      }
      return msg;
    }

    function result(msgId) {
      const info = parseId(msgId);
      const a = info && ANSWERS[info.answer];
      if (!a) throw notFound();
      return {
        statement_response: {
          statement_id: null,
          status: { state: 'SUCCEEDED' },
          manifest: { format: 'JSON_ARRAY', schema: { columns: a.columns.map(([name, type], position) => ({ name, type_name: type, position })) }, total_row_count: a.rows.length, total_chunk_count: 1, truncated: false },
          result: { data_array: a.rows.map((r) => r.slice()), row_count: a.rows.length, chunk_index: 0 },
        },
      };
    }

    function ask(spaceId, convId, question) {
      const spaceIndex = SPACES.findIndex((s) => s.space_id === spaceId) + 1;
      if (!spaceIndex) throw notFound();
      const answer = pickAnswer(spaceIndex, question);
      const created = now();
      const conversationId = convId || makeId(spaceIndex, answer, created, salt());
      const messageId = makeId(spaceIndex, answer, created, salt());
      return { conversationId, messageId, message: message(spaceId, conversationId, messageId) };
    }

    async function get(path) {
      if (path === '/api/2.0/genie/spaces') return { spaces: SPACES.map((s) => Object.assign({}, s)) };
      let m = /^\/api\/2\.0\/genie\/spaces\/([0-9a-f]{32})\/conversations\/([0-9a-f]{32})\/messages\/([0-9a-f]{32})(\/attachments\/[A-Za-z0-9_-]+\/query-result)?$/.exec(path);
      if (m && m[4]) return result(m[3]);
      if (m) return message(m[1], m[2], m[3]);
      throw notFound();
    }

    async function post(path, body) {
      let m = /^\/api\/2\.0\/genie\/spaces\/([0-9a-f]{32})\/start-conversation$/.exec(path);
      if (m) {
        const out = ask(m[1], null, body && body.content);
        return { conversation_id: out.conversationId, conversation: { conversation_id: out.conversationId, space_id: m[1], title: 'DEMO conversation' }, message_id: out.messageId, message: out.message };
      }
      m = /^\/api\/2\.0\/genie\/spaces\/([0-9a-f]{32})\/conversations\/([0-9a-f]{32})\/messages$/.exec(path);
      if (m) return ask(m[1], m[2], body && body.content).message;
      m = /^\/api\/2\.0\/genie\/spaces\/[0-9a-f]{32}\/conversations\/[0-9a-f]{32}\/messages\/([0-9a-f]{32})\/attachments\/[A-Za-z0-9_-]+\/execute-query$/.exec(path);
      if (m) return result(m[1]);
      throw notFound();
    }

    return { get, post, demo: true };
  }

  const api = Object.freeze({ ORIGIN, SPACES, TIMELINE, FAIL_TIMELINE, ANSWERS, createClient, parseId, makeId });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).genieDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
