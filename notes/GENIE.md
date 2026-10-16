# Genie side panel: verified API facts

Checked 2026-10-15 against official Databricks and Microsoft Learn pages (WebFetch). Anything not
listed here as verified is treated as unknown, and the code degrades safely around it.

## Sources

- Use the Genie Agents API (AWS): https://docs.databricks.com/aws/en/genie-agents/conversation-api
  (the older URL https://docs.databricks.com/aws/en/genie/conversation-api serves the same page)
- Azure edition (updated 2026-10-12): https://learn.microsoft.com/en-us/azure/databricks/genie-agents/conversation-api
- REST reference, Conversation: https://docs.databricks.com/api/genie/v1/conversation
- REST reference pages: https://docs.databricks.com/api/workspace/genie/startconversation,
  .../getmessage, .../getmessageattachmentqueryresult, .../listspaces
- API scopes: https://docs.databricks.com/api/workspace/scopes (scope `genie`)
- Apps authorization (scope list, "All APIs" allows all supported scopes, `dashboards.genie`
  deprecated for `genie`): https://docs.databricks.com/aws/en/dev-tools/databricks-apps/auth
- Token with `all-apis` satisfies any app's scopes: https://docs.databricks.com/aws/en/dev-tools/databricks-apps/connect-local
- Resource limits: https://docs.databricks.com/aws/en/resources/limits
- Agent mode errors (429): https://docs.databricks.com/aws/en/genie-agents/api
- Genie billing and budgets: https://learn.microsoft.com/en-us/azure/databricks/genie/budgets

## Naming

"Genie Agents were formerly known as Genie Spaces." UI copy says **Genie Agent**. REST paths and
fields still say `spaces` and `space_id`, so code keeps `space` names.

## Endpoints used (all list "API scopes: genie")

| Method | Path | Notes |
|---|---|---|
| GET | `/api/2.0/genie/spaces` | `page_size` (max 100, default 20), `page_token`. Response `spaces[]` with `space_id`, `title`, `description`, `warehouse_id`; `next_page_token`. |
| POST | `/api/2.0/genie/spaces/{space_id}/start-conversation` | Body `{content}`. Response `{conversation_id, conversation:{title,...}, message_id, message:{...}}`. |
| POST | `/api/2.0/genie/spaces/{space_id}/conversations/{conversation_id}/messages` | Body `{content}` (follow-up). Response: the message. |
| GET | `/api/2.0/genie/spaces/{space_id}/conversations/{conversation_id}/messages/{message_id}` | Poll target. |
| GET | `.../messages/{message_id}/attachments/{attachment_id}/query-result` | `{statement_response:{statement_id, status.state, manifest{schema.columns[name,type_name,position], total_row_count, truncated, total_chunk_count}, result{data_array, row_count, next_chunk_index}}}`. Only when the message status is `EXECUTING_QUERY` or `COMPLETED`. |
| POST | `.../messages/{message_id}/attachments/{attachment_id}/execute-query` | Re-runs an expired attachment query (`QUERY_RESULT_EXPIRED`). Same response shape. |

Not used: list conversations, get space, feedback, comments, downloads, delete, Agent mode
(`/api/2.0/genie/agents/...`). The http allowlist admits only the six paths above, and only
through a client created with `scope: 'genie'`, so the local helper's GET forwarding (which uses
the default allowlist) can't reach Genie.

## Message object

- `message_id`, `conversation_id`, `space_id`, `status`, `content` (the question),
  `attachments[]`, `error {error, type}`. `id` is deprecated.
- Status enum: `SUBMITTED`, `FETCHING_METADATA`, `FILTERING_CONTEXT`, `ASKING_AI`,
  `PENDING_WAREHOUSE`, `EXECUTING_QUERY`, `COMPLETED`, `FAILED`, `CANCELLED`,
  `QUERY_RESULT_EXPIRED`. Doc examples also show an undocumented `IN_PROGRESS`; unknown values are
  treated as "still working" until the hard timeout.
- Attachment: `attachment_id` plus one of
  - `text {content, purpose}` with purpose `TEXT_ATTACHMENT_PURPOSE_ANSWER` (answer) or
    `FOLLOW_UP_QUESTION` (Genie asks a clarifying question),
  - `query {title, description, query (SQL), statement_id, query_result_metadata {row_count, is_truncated}}`,
  - `suggested_questions {questions[]}`,
  - `viz {...}` (ignored).
- `error.type` includes `RATE_LIMIT_EXCEEDED_GENERIC_EXCEPTION` and
  `RATE_LIMIT_EXCEEDED_SPECIFIED_WAIT_EXCEPTION`.
- ID formats: documented as UUID; examples are 32 lowercase hex characters. We accept 32 hex or
  hyphenated UUIDs (either case); attachment IDs are "string" with no documented format, so we
  accept `[A-Za-z0-9_-]{1,64}`.

## Polling, limits, auth

- Poll every 1 to 5 s, exponential backoff up to 1 min, stop after 10 min. The API doesn't retry
  for you. Start a new conversation per session.
- No published questions-per-minute limit for the Conversation API was found. Agent mode documents
  HTTP 429 `RATE_LIMIT_EXCEEDED`; the message error enum has the rate-limit types above. We treat
  429 and those types as `GENIE_RATE_LIMITED`.
- Limits: 200,000 conversations per agent, 10,000 messages per conversation. No documented row cap
  for query results (we show at most 200 rows and say "showing N of M").
- OAuth: every operation needs the `genie` API scope. "All APIs" allows all supported scopes, and
  an `all-apis` token satisfies any scope set, so the existing one-time app connection (SQL + All
  APIs) works with one `all-apis offline_access` sign-in shared by the monitor and Genie.
  A scoped PAT without `genie` gets 403 (shown as `GENIE_ACCESS_DENIED`).
- Prerequisites: Databricks SQL entitlement and CAN USE on a pro or serverless warehouse, plus
  access to the agent.
- Cost: Genie LLM usage beyond a free monthly allowance is billed, and its SQL runs on the agent's
  warehouse (billed separately; a stopped warehouse starts, seen as `PENDING_WAREHOUSE`).

## Not verified (designed around)

- A workspace UI route to open an agent. `/genie/rooms/<id>` appears only in unofficial sources,
  so the panel doesn't link into the workspace.
- Opening the side panel from a notification click (sidePanel.open needs a user gesture); we try
  it and fall back to opening the panel page in a tab.
- Real Genie was never called: tests use fakes and the local fixture.
