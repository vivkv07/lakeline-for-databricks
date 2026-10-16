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

  // Canned answers. Text is Markdown (like real Genie answers); the tables cover every chart the
  // panel draws: categorical bars (0, 1), a multi-series line with a gap (2), KPI tiles (3), a
  // scatter (4), a wide table with timestamps and nulls (5) and a single-series line (6).
  const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'];
  const WEB = [41200, 39850, 43610, 45020, 44100, 38200, 36950, 42800, 44950, 46310, 47020, 45880, 40120, 39400];
  const STORE = [28400, 27950, 29100, 30250, 31800, 34900, 33600, 28700, 29350, 30100, 30880, 32500, 35200, 34100];
  const PARTNER = [12100, 11800, 12950, null, 13400, 14200, 13900, 12600, 13050, 13700, 14100, 14650, 15200, 14900];
  const RUNS = [
    ['801104417', '4.2', '3.9'], ['801104502', '6.8', '6.1'], ['801104588', '7.5', '7.9'], ['801104671', '9.1', '8.2'], ['801104730', '11.4', '10.8'],
    ['801104812', '12.9', '14.6'], ['801104901', '15.3', '13.7'], ['801104977', '17.8', '18.9'], ['801105046', '19.2', null], ['801105120', '21.6', '19.4'],
    ['801105211', '24.0', '26.3'], ['801105287', '27.5', '24.1'], ['801105360', '31.2', '33.0'], ['801105444', '34.8', '30.2'], ['801105519', '39.6', '41.7'],
    ['801105603', '44.1', '38.5'], ['801105688', '51.3', '55.2'], ['801105772', '57.9', '49.8'],
  ];

  const ANSWERS = Object.freeze([
    {
      text: '**DEMO answer (synthetic).** Revenue last month was **$1.24M**, up 6.1% on the month before.\n\n- **EMEA** grew fastest, up 9.4%.\n- **APAC** had the most orders: 3,410.\n- *Other* has no prior month, so its change is n/a.',
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
      suggested: ['Show daily revenue by channel for the last 2 weeks', 'What were our headline numbers last month?'],
    },
    {
      text: '**DEMO answer (synthetic).** 3 of 6 jobs had a failed run in the last 7 days.\n\n1. **Nightly sales ETL** failed twice, both at the `load` step.\n2. **Orders ingest** and **Feature refresh** failed once each.\n\nEverything else succeeded on every run.',
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
      suggested: ['How do run duration and DBUs relate?', 'Show the latest pipeline updates'],
    },
    {
      text: '**DEMO answer (synthetic).** Daily revenue by channel for the last 2 weeks:\n\n- **Web** peaked at $47,020 on Oct 11.\n- **Store** is strongest on weekends.\n- **Partner** has no data for Oct 4, so that day is a gap.',
      title: 'Daily revenue by channel, last 14 days',
      description: 'Sums synthetic order amounts per day and sales channel.',
      sql: "SELECT order_date,\n       SUM(CASE WHEN channel = 'web' THEN amount_usd END) AS web_usd,\n       SUM(CASE WHEN channel = 'store' THEN amount_usd END) AS store_usd,\n       SUM(CASE WHEN channel = 'partner' THEN amount_usd END) AS partner_usd\nFROM demo.sales.orders\nWHERE order_date >= current_date() - INTERVAL 14 DAYS\nGROUP BY order_date\nORDER BY order_date",
      columns: [['order_date', 'DATE'], ['web_usd', 'DECIMAL'], ['store_usd', 'DECIMAL'], ['partner_usd', 'DECIMAL']],
      rows: DAYS.map((d, i) => [d, String(WEB[i]), String(STORE[i]), PARTNER[i] === null ? null : String(PARTNER[i])]),
      suggested: ['What were our headline numbers last month?', 'What was revenue by region last month?'],
    },
    {
      text: '**DEMO answer (synthetic).** Last month in one line: **$1.24M** revenue from **10,831** orders, an average of $114.53 per order, up 6.1% on the month before.',
      title: 'Headline numbers, last month',
      description: 'Totals synthetic orders for the previous calendar month.',
      sql: "SELECT SUM(amount_usd) AS total_revenue_usd,\n       COUNT(*) AS orders,\n       AVG(amount_usd) AS avg_order_value_usd,\n       SUM(amount_usd) / LAG(SUM(amount_usd)) OVER (ORDER BY month) - 1 AS change_ratio,\n       date_trunc('month', current_date() - INTERVAL 1 MONTH) AS month\nFROM demo.sales.orders\nWHERE month = date_trunc('month', current_date() - INTERVAL 1 MONTH)",
      columns: [['total_revenue_usd', 'DECIMAL'], ['orders', 'LONG'], ['avg_order_value_usd', 'DECIMAL'], ['change_ratio', 'DOUBLE'], ['month', 'DATE']],
      rows: [['1240512.40', '10831', '114.53', '0.061', '2026-09-01']],
      suggested: ['What was revenue by region last month?', 'Show daily revenue by channel for the last 2 weeks'],
    },
    {
      text: '**DEMO answer (synthetic).** Longer runs use more DBUs, roughly **0.95 DBU per minute**. One run (`801105046`) has no DBU figure yet, so it is left out of the chart.',
      title: 'Run duration vs DBUs, last 7 days',
      description: 'One point per synthetic job run.',
      sql: 'SELECT run_id,\n       ROUND(duration_ms / 60000, 1) AS duration_min,\n       ROUND(dbus, 1) AS dbus\nFROM demo.ops.job_run_usage\nWHERE period_start >= current_date() - INTERVAL 7 DAYS\nORDER BY duration_min',
      columns: [['run_id', 'BIGINT'], ['duration_min', 'DOUBLE'], ['dbus', 'DOUBLE']],
      rows: RUNS.map((r) => r.slice()),
      suggested: ['Show the latest pipeline updates', 'Which jobs failed this week?'],
    },
    {
      text: '**DEMO answer (synthetic).** The 8 latest pipeline updates. Two failed:\n\n- `orders_silver` stopped on a schema change.\n- `inventory_gold` timed out waiting for compute.\n\n> Cost is n/a where the update was still being priced.',
      title: 'Latest pipeline updates',
      description: 'Synthetic pipeline update history with state, timing, volume and cost.',
      sql: 'SELECT update_id, pipeline_name, state, started_at, duration_min, rows_written, error_ratio, cost_usd, compute, cause\nFROM demo.ops.pipeline_updates\nORDER BY started_at DESC\nLIMIT 8',
      columns: [['update_id', 'STRING'], ['pipeline_name', 'STRING'], ['state', 'STRING'], ['started_at', 'TIMESTAMP'], ['duration_min', 'DOUBLE'], ['rows_written', 'LONG'], ['error_ratio', 'DOUBLE'], ['cost_usd', 'DECIMAL'], ['compute', 'STRING'], ['cause', 'STRING']],
      rows: [
        ['9f2c41d0-demo-0008', 'orders_bronze', 'COMPLETED', '2026-10-14T23:10:05.000Z', '6.4', '1840211', '0', '3.12', 'Serverless', null],
        ['9f2c41d0-demo-0007', 'orders_silver', 'FAILED', '2026-10-14T22:40:51.000Z', '2.1', '0', '1', '0.88', 'Serverless', 'Schema change in source column amount_usd (DECIMAL to STRING)'],
        ['9f2c41d0-demo-0006', 'inventory_gold', 'FAILED', '2026-10-14T21:05:17.000Z', '30', '0', null, null, 'Pipelines cluster', 'Timed out waiting for compute'],
        ['9f2c41d0-demo-0005', 'customers_silver', 'COMPLETED', '2026-10-14T20:15:44.000Z', '11.8', '402118', '0.0021', '5.47', 'Serverless', null],
        ['9f2c41d0-demo-0004', 'orders_bronze', 'COMPLETED', '2026-10-14T17:10:02.000Z', '5.9', '1722930', '0', '2.98', 'Serverless', null],
        ['9f2c41d0-demo-0003', 'clicks_bronze', 'COMPLETED', '2026-10-14T16:00:00.000Z', '24.3', '18220419', '0.0004', '14.20', 'Pipelines cluster', null],
        ['9f2c41d0-demo-0002', 'inventory_gold', 'COMPLETED', '2026-10-14T09:05:12.000Z', '17.2', '96004', '0', null, 'Pipelines cluster', null],
        ['9f2c41d0-demo-0001', 'customers_silver', 'COMPLETED', '2026-10-14T08:15:30.000Z', '12.6', '398765', '0.0018', '5.61', 'Serverless', null],
      ],
      suggested: ['Which jobs failed this week?', 'How do run duration and DBUs relate?'],
    },
    {
      text: '**DEMO answer (synthetic).** Here are daily orders for the last 2 weeks. This is a canned answer, so try asking about revenue, channels, headline numbers or failed jobs.',
      title: 'Daily orders, last 14 days',
      description: 'Counts synthetic orders per day.',
      sql: 'SELECT order_date, COUNT(*) AS orders\nFROM demo.sales.orders\nWHERE order_date >= current_date() - INTERVAL 14 DAYS\nGROUP BY order_date\nORDER BY order_date',
      columns: [['order_date', 'DATE'], ['orders', 'LONG']],
      rows: DAYS.map((d, i) => [d, String(1180 + ((i * 37) % 190) + (i % 7 === 5 ? 140 : 0))]),
      suggested: ['What was revenue by region last month?', 'Which jobs failed this week?'],
    },
  ]);

  const ID = /^de3([0-9a-f])([0-9a-f])([0-9a-f]{12})([0-9a-f]{15})$/;

  /** Keyword routing to a canned answer (order matters: specific phrases first). */
  function pickAnswer(spaceIndex, question) {
    const q = String(question || '').toLowerCase();
    if (/headline|kpi|overall|in total|totals?\b|summary/.test(q)) return 3;
    if (/channel|daily revenue|trend|over time|by day|by week|weekly/.test(q)) return 2;
    if (/duration|dbus?\b|relate|correlat|scatter/.test(q)) return 4;
    if (/pipeline updates?|latest updates?|update history|updates/.test(q)) return 5;
    if (/revenue|sales|region|customer|product|order value/.test(q)) return 0;
    if (/job|pipeline|fail|run|error/.test(q)) return 1;
    return spaceIndex === 2 ? 1 : 6;
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
      const a = ANSWERS[info.answer] || ANSWERS[6];
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
