/*
 * Genie Conversation API (Chat mode): request builders and strict normalization.
 *
 * Verified against the official reference on 2026-10-15 (see notes/GENIE.md):
 *   GET  /api/2.0/genie/spaces                                       list Genie Agents
 *   POST /api/2.0/genie/spaces/{space}/start-conversation            first question
 *   POST /api/2.0/genie/spaces/{space}/conversations/{conv}/messages follow-up question
 *   GET  .../conversations/{conv}/messages/{msg}                     poll the message
 *   GET  .../messages/{msg}/attachments/{att}/query-result           the query's rows
 *   POST .../messages/{msg}/attachments/{att}/execute-query          re-run an expired result
 *
 * Everything from the API is untrusted: IDs are validated, statuses are mapped to a small set of
 * phases (unknown values mean "still working"), text is stripped of control characters and
 * capped, and tables are capped by rows, columns, cell length and total size. Nothing here
 * touches the network, storage or the DOM.
 */
(function (root) {
  'use strict';
  const NODE = typeof module === 'object' && module && module.exports;
  const dep = (name, path) => (NODE ? require(path) : root.DCC[name]);
  const V = dep('validate', '../core/validate.js');
  const errors = dep('errors', '../errors.js');

  const BASE = '/api/2.0/genie/spaces';
  // Documented as UUIDs; examples are 32 lowercase hex characters. Accept both shapes.
  const ID_SRC = '(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
  // Attachment IDs are "string" with no documented format.
  const ATT_SRC = '[A-Za-z0-9_-]{1,64}';
  const ID = new RegExp('^' + ID_SRC + '$');
  const ATTACHMENT_ID = new RegExp('^' + ATT_SRC + '$');
  // Same character set the HTTP client accepts for query values; anything else is not followed.
  const PAGE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
  const ERROR_TYPE = /^[A-Z][A-Z0-9_]{0,79}$/;
  const STATUS_SHAPE = /^[A-Z][A-Z_]{0,39}$/;

  const LIMITS = Object.freeze({
    question: 2000,
    spaces: 200,
    title: 200,
    description: 500,
    text: 8000,
    texts: 4,
    sql: 20000,
    suggested: 5,
    suggestedLength: 300,
    rows: 200,
    columns: 40,
    columnName: 120,
    cell: 300,
    tableChars: 150000,
    attachments: 12,
    errorText: 300,
  });

  const STATUSES = Object.freeze(['SUBMITTED', 'FETCHING_METADATA', 'FILTERING_CONTEXT', 'ASKING_AI', 'PENDING_WAREHOUSE', 'EXECUTING_QUERY', 'COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED']);
  const TERMINAL = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED']);
  /** Short, plain descriptions of the in-progress steps (shown under the status chip). */
  const STEP_TEXT = Object.freeze({
    SUBMITTED: 'Question received',
    FETCHING_METADATA: 'Reading table metadata',
    FILTERING_CONTEXT: 'Finding relevant context',
    ASKING_AI: 'Writing the answer',
    PENDING_WAREHOUSE: 'Waiting for the SQL warehouse',
    EXECUTING_QUERY: 'Running the query',
  });
  const NUMERIC_TYPES = new Set(['BYTE', 'SHORT', 'INT', 'INTEGER', 'LONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'TINYINT', 'SMALLINT']);

  const isId = (v) => typeof v === 'string' && ID.test(v);
  const isAttachmentId = (v) => typeof v === 'string' && ATTACHMENT_ID.test(v);
  const isTerminal = (status) => TERMINAL.includes(status);

  /** Status → UI phase. Unknown or undocumented values (e.g. IN_PROGRESS) still count as working. */
  function phaseOf(status) {
    switch (status) {
      case 'COMPLETED':
        return 'done';
      case 'FAILED':
        return 'failed';
      case 'CANCELLED':
        return 'cancelled';
      case 'QUERY_RESULT_EXPIRED':
        return 'expired';
      case 'PENDING_WAREHOUSE':
      case 'EXECUTING_QUERY':
        return 'query';
      default:
        return 'working';
    }
  }

  function bad(message) {
    return new errors.DccError({ code: 'UNKNOWN', message });
  }

  function assertId(v, what) {
    if (!isId(v)) throw bad('Invalid Genie ' + what + ' ID');
    return v;
  }

  /** Keep line breaks and tabs, drop other control characters, normalize CRLF, trim. */
  function cleanText(v, max) {
    if (typeof v !== 'string') return '';
    return V.safeText(v.replace(/\r\n?/g, '\n'), max).trim();
  }

  /** The user's question, or null when empty or too long (never silently cut). */
  function cleanQuestion(v) {
    if (typeof v !== 'string') return null;
    const t = V.safeText(v.replace(/\r\n?/g, '\n'), LIMITS.question + 1).trim();
    if (!t || t.length > LIMITS.question) return null;
    return t;
  }

  function messagePath(spaceId, conversationId, messageId) {
    return BASE + '/' + assertId(spaceId, 'agent') + '/conversations/' + assertId(conversationId, 'conversation') + '/messages/' + assertId(messageId, 'message');
  }

  function attachmentPath(spaceId, conversationId, messageId, attachmentId) {
    if (!isAttachmentId(attachmentId)) throw bad('Invalid Genie attachment ID');
    return messagePath(spaceId, conversationId, messageId) + '/attachments/' + attachmentId;
  }

  function questionBody(question) {
    const content = cleanQuestion(question);
    if (!content) throw bad('Question is empty or too long');
    return { content };
  }

  const requests = Object.freeze({
    listSpaces(pageToken) {
      const query = { page_size: '100' };
      if (pageToken !== undefined && pageToken !== null) {
        if (!PAGE_TOKEN.test(String(pageToken))) throw bad('Unsupported page token');
        query.page_token = String(pageToken);
      }
      return { method: 'GET', path: BASE, query };
    },
    startConversation(spaceId, question) {
      return { method: 'POST', path: BASE + '/' + assertId(spaceId, 'agent') + '/start-conversation', body: questionBody(question) };
    },
    createMessage(spaceId, conversationId, question) {
      return { method: 'POST', path: BASE + '/' + assertId(spaceId, 'agent') + '/conversations/' + assertId(conversationId, 'conversation') + '/messages', body: questionBody(question) };
    },
    getMessage(spaceId, conversationId, messageId) {
      return { method: 'GET', path: messagePath(spaceId, conversationId, messageId), query: {} };
    },
    queryResult(spaceId, conversationId, messageId, attachmentId) {
      return { method: 'GET', path: attachmentPath(spaceId, conversationId, messageId, attachmentId) + '/query-result', query: {} };
    },
    executeQuery(spaceId, conversationId, messageId, attachmentId) {
      return { method: 'POST', path: attachmentPath(spaceId, conversationId, messageId, attachmentId) + '/execute-query', body: {} };
    },
  });

  /* ---------------------------------------------------------------- spaces */

  /**
   * @returns {{spaces:[{id,title,description}], nextPageToken:string|null, more:boolean, dropped:number}}
   * `more` without `nextPageToken` means a further page exists that we can't safely follow.
   */
  function normalizeSpaces(json, max = LIMITS.spaces) {
    const list = json && Array.isArray(json.spaces) ? json.spaces : [];
    const spaces = [];
    const seen = new Set();
    let dropped = 0;
    for (const s of list) {
      const id = s && s.space_id;
      if (!isId(id) || seen.has(id)) {
        dropped++;
        continue;
      }
      if (spaces.length >= max) {
        dropped++;
        continue;
      }
      seen.add(id);
      spaces.push({ id, title: cleanText(s.title, LIMITS.title).replace(/\s+/g, ' ') || 'Untitled agent', description: cleanText(s.description, LIMITS.description) || null });
    }
    const raw = json && typeof json.next_page_token === 'string' && json.next_page_token ? json.next_page_token : null;
    return { spaces, nextPageToken: raw && PAGE_TOKEN.test(raw) ? raw : null, more: Boolean(raw), dropped };
  }

  /* ---------------------------------------------------------------- messages */

  function normalizeStatus(v) {
    if (STATUSES.includes(v)) return { status: v, known: true };
    return { status: typeof v === 'string' && STATUS_SHAPE.test(v) ? v : 'UNKNOWN', known: false };
  }

  function rowCountOf(v) {
    const n = typeof v === 'string' && /^[0-9]{1,15}$/.test(v) ? Number(v) : v;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  }

  function normalizeError(err) {
    if (!err || typeof err !== 'object') return null;
    const type = typeof err.type === 'string' && ERROR_TYPE.test(err.type) ? err.type : null;
    const text = cleanText(typeof err.error === 'string' ? err.error : typeof err.message === 'string' ? err.message : '', LIMITS.errorText) || null;
    if (!type && !text) return null;
    return { type, text: text ? errors.redact(text) : null, rateLimited: Boolean(type && /RATE_LIMIT/.test(type)) };
  }

  /**
   * A message (from start-conversation, create-message or get-message) in a stable shape.
   * @returns {{messageId, conversationId, status, known, phase, texts:[{content, purpose}],
   *            query:{attachmentId,title,description,sql,statementId,rowCount,truncated}|null,
   *            suggested:string[], error:{type,text,rateLimited}|null, dropped:number}}
   */
  function normalizeMessage(json) {
    const m = json && typeof json === 'object' ? json : {};
    const { status, known } = normalizeStatus(m.status);
    const out = {
      messageId: isId(m.message_id) ? m.message_id : isId(m.id) ? m.id : null,
      conversationId: isId(m.conversation_id) ? m.conversation_id : null,
      status,
      known,
      phase: phaseOf(status),
      texts: [],
      query: null,
      suggested: [],
      error: normalizeError(m.error),
      dropped: 0,
    };
    const atts = Array.isArray(m.attachments) ? m.attachments.slice(0, LIMITS.attachments) : [];
    if (Array.isArray(m.attachments) && m.attachments.length > LIMITS.attachments) out.dropped += m.attachments.length - LIMITS.attachments;
    for (const a of atts) {
      if (!a || typeof a !== 'object') {
        out.dropped++;
        continue;
      }
      if (a.text && typeof a.text === 'object') {
        const content = cleanText(a.text.content, LIMITS.text);
        if (content && out.texts.length < LIMITS.texts) out.texts.push({ content, purpose: a.text.purpose === 'FOLLOW_UP_QUESTION' ? 'followUp' : 'answer' });
        else out.dropped++;
      } else if (a.query && typeof a.query === 'object') {
        if (out.query) {
          out.dropped++; // one result table per answer; later query attachments are not shown
          continue;
        }
        const q = a.query;
        const meta = q.query_result_metadata && typeof q.query_result_metadata === 'object' ? q.query_result_metadata : {};
        const legacy = m.query_result && typeof m.query_result === 'object' ? m.query_result : {};
        const sid = String(q.statement_id || '').toLowerCase();
        out.query = {
          attachmentId: isAttachmentId(a.attachment_id) ? a.attachment_id : null,
          title: cleanText(q.title, LIMITS.title).replace(/\s+/g, ' ') || null,
          description: cleanText(q.description, LIMITS.description) || null,
          sql: cleanText(q.query, LIMITS.sql) || null,
          statementId: V.isStatementId(sid) ? sid : null,
          rowCount: rowCountOf(meta.row_count !== undefined ? meta.row_count : legacy.row_count),
          truncated: meta.is_truncated === true || legacy.is_truncated === true,
        };
      } else if (a.suggested_questions && typeof a.suggested_questions === 'object') {
        const qs = Array.isArray(a.suggested_questions.questions) ? a.suggested_questions.questions : [];
        for (const s of qs) {
          const t = cleanText(s, LIMITS.suggestedLength).replace(/\s+/g, ' ');
          if (t && out.suggested.length < LIMITS.suggested && !out.suggested.includes(t)) out.suggested.push(t);
        }
      } else if (!a.viz) {
        out.dropped++;
      }
    }
    return out;
  }

  /** start-conversation response: IDs at the top level, in `conversation`, or in `message`. */
  function normalizeStart(json) {
    const j = json && typeof json === 'object' ? json : {};
    const conv = j.conversation && typeof j.conversation === 'object' ? j.conversation : {};
    const msg = normalizeMessage(j.message && typeof j.message === 'object' ? j.message : j);
    const conversationId = [j.conversation_id, conv.conversation_id, conv.id, msg.conversationId].find(isId) || null;
    const messageId = [j.message_id, msg.messageId].find(isId) || null;
    return {
      conversationId,
      messageId,
      title: cleanText(conv.title, LIMITS.title).replace(/\s+/g, ' ') || null,
      message: Object.assign(msg, { conversationId, messageId }),
    };
  }

  /* ---------------------------------------------------------------- query result */

  function cell(v) {
    if (v === null || v === undefined) return null;
    const s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
    const t = V.safeText(s, LIMITS.cell + 1);
    return t.length > LIMITS.cell ? t.slice(0, LIMITS.cell - 1) + '…' : t;
  }

  /**
   * statement_response → a capped table.
   * @returns {{state, ready:boolean, failed:boolean, error?, columns:[{name,type,numeric}], rows:(string|null)[][],
   *            totalRows:number|null, shown:number, clipped:boolean, serverTruncated:boolean, columnsHidden:number}}
   */
  function normalizeQueryResult(json) {
    const sr = json && json.statement_response && typeof json.statement_response === 'object' ? json.statement_response : json && typeof json === 'object' ? json : {};
    const state = sr.status && typeof sr.status.state === 'string' && /^[A-Z_]{1,20}$/.test(sr.status.state) ? sr.status.state : sr.result || sr.manifest ? 'SUCCEEDED' : 'UNKNOWN';
    const base = { state, ready: state === 'SUCCEEDED', failed: ['FAILED', 'CANCELED', 'CLOSED'].includes(state), columns: [], rows: [], totalRows: null, shown: 0, clipped: false, serverTruncated: false, columnsHidden: 0 };
    if (base.failed) {
      const e = sr.status && sr.status.error;
      base.error = normalizeError(e ? { error: e.message, type: typeof e.error_code === 'string' ? e.error_code : null } : null);
      return base;
    }
    if (!base.ready) return base;
    const manifest = sr.manifest && typeof sr.manifest === 'object' ? sr.manifest : {};
    const rawCols = manifest.schema && Array.isArray(manifest.schema.columns) ? manifest.schema.columns.slice() : [];
    rawCols.sort((a, b) => (Number(a && a.position) || 0) - (Number(b && b.position) || 0));
    const result = sr.result && typeof sr.result === 'object' ? sr.result : {};
    const data = Array.isArray(result.data_array) ? result.data_array : [];
    let width = rawCols.length;
    if (!width) width = data.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : 0), 0);
    const keep = Math.min(width, LIMITS.columns);
    base.columnsHidden = width - keep;
    for (let i = 0; i < keep; i++) {
      const c = rawCols[i] || {};
      const type = typeof c.type_name === 'string' && /^[A-Z_]{1,30}$/.test(c.type_name) ? c.type_name : null;
      base.columns.push({ name: cleanText(c.name, LIMITS.columnName).replace(/\s+/g, ' ') || 'column ' + (i + 1), type, numeric: Boolean(type && NUMERIC_TYPES.has(type)) });
    }
    let budget = LIMITS.tableChars;
    for (const r of data) {
      if (base.rows.length >= LIMITS.rows || !Array.isArray(r)) break;
      const row = [];
      for (let i = 0; i < keep; i++) row.push(cell(r[i]));
      budget -= row.reduce((n, v) => n + (v === null ? 4 : v.length + 3), 2);
      if (budget < 0) break;
      base.rows.push(row);
    }
    base.shown = base.rows.length;
    const total = rowCountOf(manifest.total_row_count);
    const moreChunks = (Number(manifest.total_chunk_count) || 0) > 1 || (result.next_chunk_index !== undefined && result.next_chunk_index !== null);
    base.totalRows = total !== null ? total : moreChunks ? null : data.length;
    base.serverTruncated = manifest.truncated === true;
    base.clipped = moreChunks || base.shown < data.length || (base.totalRows !== null && base.shown < base.totalRows);
    return base;
  }

  /** Classify an error the Genie API returned on a message. */
  function messageErrorCode(err) {
    return err && err.rateLimited ? 'GENIE_RATE_LIMITED' : 'GENIE_FAILED';
  }

  const api = Object.freeze({
    BASE,
    LIMITS,
    STATUSES,
    TERMINAL,
    STEP_TEXT,
    ID_SRC,
    ATT_SRC,
    isId,
    isAttachmentId,
    isTerminal,
    phaseOf,
    cleanQuestion,
    requests,
    normalizeSpaces,
    normalizeMessage,
    normalizeStart,
    normalizeQueryResult,
    normalizeError,
    messageErrorCode,
  });
  if (NODE) module.exports = api;
  else (root.DCC || (root.DCC = {})).genieApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
