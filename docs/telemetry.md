# Telemetry

Agent Runtime includes a built-in telemetry system for tracking operations
across the CLI, web client, control plane, Slack bot, and deployed agents.
Events are stored per-tenant in SQLite and are queryable through the API and
the web dashboard.

## Data Model

Every telemetry event has these fields:

| Field           | Type   | Required | Description                                                                      |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `id`            | string | auto     | UUID assigned on ingest; never sent by the client                                |
| `timestamp`     | number | yes      | Unix epoch **milliseconds** (e.g. `Date.now()`)                                  |
| `client`        | string | yes\*    | Source system (`ar-cli`, `web`, `slack-bot`, `agent-runtime`, `webhook`, `cron`) |
| `action`        | string | yes      | Operation name (e.g. `agent.deploy`, `llm.call`, `bot.command.run`)              |
| `level`         | string | no       | `info` (default), `warn`, `error`, `debug`                                       |
| `traceId`       | string | no       | Groups related events into a distributed trace                                   |
| `spanId`        | string | no       | Identifies this specific span within a trace                                     |
| `parentSpanId`  | string | no       | Links a child span to its parent span within the trace                           |
| `actor`         | string | no       | User email, or `system` for automated events                                     |
| `session`       | string | no       | Groups events within a single user/session lifetime                              |
| `clientVersion` | string | no       | Version of the emitting client (e.g. CLI `0.3.0`)                                |
| `payload`       | string | no       | **Pre-stringified** JSON (or any string) — the main free-form data slot          |
| `context`       | object | no       | Structured operation context; sent as an **object**, stored as JSON              |
| `environment`   | object | no       | Runtime/environment metadata; sent as an **object**, stored as JSON              |
| `tags`          | object | no       | Flat `string → string` map for filtering; sent as an **object**, stored as JSON  |
| `fingerprint`   | object | no       | Dedup/grouping key; sent as an **object**, stored as JSON                        |

\* `client` is **required in the stored row**, but on key-authenticated ingest it
is supplied by the API key and any value in the request body is ignored (see
[Ingestion](#ingestion)). In-process emitters set it directly.

### JSON handling: `payload` is a string, the rest are objects

This is the most common source of confusion, so be deliberate:

- **`payload` is a string column.** If you want to attach a JSON object, you must
  `JSON.stringify` it yourself before sending. The dashboard parses it back for
  display; if it is not valid JSON it is shown as raw text under a `raw` key.
- **`context`, `environment`, `tags`, and `fingerprint` are objects.** Send them
  as real JSON objects — the ingest layer serializes them to JSON for storage and
  the dashboard parses them back automatically. Do **not** pre-stringify these.
- `tags` must be a flat `string → string` map (used for chip rendering and
  free-text search). Nested structures belong in `context` or `payload`.

## Ingestion

### API Endpoint

```
POST /telemetry
POST /telemetry/t/:tenant
Header: X-Telemetry-Key: artk.live.<tenantId>.<secret>
```

Ingestion is gated by a **telemetry API key** (not identity/session auth). Mint
a key on the telemetry page (see [Managing Clients](#managing-clients)) and send
it in the `X-Telemetry-Key` header (an `Authorization: Bearer artk....` header is
also accepted). The owning tenant is parsed from the key itself, so the bare
`/telemetry` path needs no tenant header; for `/telemetry/t/:tenant` the path
tenant must match the key's tenant or the request is rejected with `403`.

The `client` field on every ingested event is derived from the authenticated key
(the client's name) and cannot be spoofed — any `client` value in the request
body is ignored. `action` and `timestamp` remain required.

Send a single event or a batch:

```json
{
  "timestamp": 1712200000000,
  "client": "ar-cli",
  "action": "agent.deploy",
  "level": "info",
  "traceId": "abc-123",
  "spanId": "span-1",
  "actor": "user@example.com",
  "payload": "{\"agent\":\"hello-world\",\"version\":\"1.0.0\"}"
}
```

Or batch multiple events:

```json
{
  "events": [
    {
      "timestamp": 1712200000000,
      "client": "ar-cli",
      "action": "agent.deploy"
    },
    { "timestamp": 1712200001000, "client": "ar-cli", "action": "gcs.upload" }
  ]
}
```

Required fields per event: `action`, `timestamp`. The `client` is supplied by
the key, not the body.

### Complete example (every field)

A single event exercising all fields. Note `payload` is a **stringified** JSON
value while `context`, `environment`, `tags`, and `fingerprint` are sent as
**objects**:

```json
{
  "timestamp": 1712200000000,
  "action": "agent.invoke",
  "level": "error",
  "traceId": "tr-invoke-42",
  "spanId": "sp-2",
  "parentSpanId": "sp-1",
  "actor": "jane@example.com",
  "session": "sess-9f3c",
  "clientVersion": "0.3.0",
  "payload": "{\"agent\":\"hello-world\",\"durationMs\":520,\"error\":\"timeout\"}",
  "context": { "region": "northamerica-northeast1", "attempt": 2 },
  "environment": { "runtime": "nodejs22", "deployMode": "container" },
  "tags": { "agent": "hello-world", "op": "invoke" },
  "fingerprint": { "agent": "hello-world", "error": "timeout" }
}
```

`client` is intentionally omitted above — it is stamped from the API key.

### Field usage

How each optional field is meant to be used:

- **`level`** — severity. Drives the colored dot/badge in the dashboard and the
  error/warning summary counts. Use `error` for failures, `warn` for degraded or
  retried operations, `debug` for verbose internal detail, `info` otherwise.
- **`traceId` / `spanId` / `parentSpanId`** — distributed tracing. All events
  sharing a `traceId` render as one waterfall; `spanId` identifies a step and
  `parentSpanId` nests it under another step. See
  [Distributed Tracing](#distributed-tracing).
- **`actor`** — who/what caused the event: a user email for human-initiated
  actions, or `system` for automated ones (cron, webhooks).
- **`session`** — correlates events across a single session (e.g. a CLI run or a
  web session) even when they span multiple traces.
- **`clientVersion`** — the emitting client's version, for spotting
  version-specific issues.
- **`payload`** — the primary free-form data slot. Put operation-specific details
  here (durations, counts, error messages). Stringify objects before sending.
- **`context`** — structured context about the operation (region, attempt number,
  request parameters). Sent as an object.
- **`environment`** — runtime/environment metadata (runtime version, deploy mode,
  host). Sent as an object.
- **`tags`** — a flat `key=value` map used for filtering and search; rendered as
  chips. Keep values short and high-cardinality data out of tags.
- **`fingerprint`** — a stable key for grouping/deduplicating "the same" event
  (e.g. the same error on the same agent), independent of timestamp.

### Clients

A **telemetry client** is a named, per-tenant principal that owns one telemetry
API key. Clients exist only to authenticate and label telemetry writes — they
are not `user` rows and have no Google identity. The client's name becomes the
`client` label on every event it ingests.

First-party in-process emitters (the CLI, web client, control plane, Slack bot,
and deployed agents) write through the server-side DB `ingest` layer rather than
`POST /telemetry` over HTTP, so they do not need a key. They continue to use the
fixed source names below:

| Client          | Description                                         |
| --------------- | --------------------------------------------------- |
| `ar-cli`        | CLI operations (deploy, create, destroy, trigger)   |
| `web`           | Web dashboard actions (create agent, switch tenant) |
| `agent-runtime` | Internal runtime (LLM calls, tool invocations)      |
| `webhook`       | Inbound webhook invocations                         |
| `cron`          | Scheduled cron invocations                          |
| `slack-bot`     | Slack bot commands and interactions                 |

External or out-of-process emitters must mint a managed client and post with its
key; the event `client` is then the managed client's name.

### Key Format

```
artk.<env>.<tenantId>.<secret>
```

- `artk` — Agent Runtime telemetry key namespace.
- `<env>` — `live` (a `test` variant is reserved).
- `<tenantId>` — the owning tenant; non-secret routing metadata that lets the
  control plane open the correct tenant DB before looking up the key hash. Tenant
  ids never contain a `.`, so dots are unambiguous delimiters.
- `<secret>` — 32 random bytes, base64url-encoded.

Keys are stored only as SHA-256 hashes (optionally peppered with
`AR_TELEMETRY_KEY_PEPPER`; see [CONFIG.md](../CONFIG.md)). The plaintext key is
returned exactly once at creation or rotation and is never persisted or
recoverable. The UI shows only a non-secret fingerprint
(`artk.live.<tenant>.…a1b2`).

### Managing Clients

Admins manage clients on the **Clients** tab of `/web/telemetry` (admin only).
The tab calls the admin-only management API with the session cookie — no
telemetry key is involved in the web flow.

| Method & path                        | Purpose                               |
| ------------------------------------ | ------------------------------------- |
| `GET /telemetry/clients`             | List clients (fingerprints, no keys)  |
| `POST /telemetry/clients`            | Create a client; returns key **once** |
| `POST /telemetry/clients/:id/rotate` | Rotate the key; returns key **once**  |
| `DELETE /telemetry/clients/:id`      | Revoke a client                       |

- **Create** shows the new key once in a copy-to-clipboard modal with an
  explicit "you will not see this again" warning.
- **Rotate** issues a new key and immediately invalidates the old one.
- **Delete** revokes the client (soft delete) so historical events keep a stable
  reference and the old key hash can never re-authenticate.

Create/rotate/delete are recorded in the audit log as entity type
`telemetry-client`. Telemetry ingest is **not** audited (it would flood the audit
table at ingest volume).

## Querying

Reading telemetry requires **admin identity** (a Google bearer token or an admin
session cookie) — telemetry API keys are write-only and cannot read. Results are
always scoped to the resolved tenant.

### API Endpoint

```
GET /telemetry
GET /telemetry/t/:tenant
```

Query parameters:

| Parameter | Description                          |
| --------- | ------------------------------------ |
| `traceId` | Filter by trace ID (exact match)     |
| `actor`   | Filter by actor email (exact match)  |
| `session` | Filter by session ID (exact match)   |
| `action`  | Filter by action name (exact match)  |
| `client`  | Filter by client name (exact match)  |
| `level`   | Filter by level (exact match)        |
| `from`    | Start timestamp (Unix ms, inclusive) |
| `to`      | End timestamp (Unix ms, inclusive)   |
| `limit`   | Max events to return (default 100)   |
| `offset`  | Pagination offset                    |

### Single Event

```
GET /telemetry/:id
GET /telemetry/t/:tenant/:id
```

Returns the full event (with `context`, `environment`, `tags`, and `fingerprint`
parsed back into objects), or `404` if no event with that id exists in the
tenant.

## Distributed Tracing

Events with the same `traceId` form a distributed trace. Use `spanId` and
`parentSpanId` to build the span hierarchy within a trace.

Example: a deploy operation produces a trace with three spans:

```
trace: tr-deploy-1
  span: sp-d1  action: agent.deploy       (root span)
  span: sp-d2  action: gcs.upload         parent: sp-d1
  span: sp-d3  action: function.create    parent: sp-d1
```

The web dashboard renders these as a waterfall timeline when you click a trace
ID in the event table.

## Web Dashboard

The telemetry page is available at `/web/telemetry` (admin only). Features:

### Summary Cards

Four metric cards at the top show event count, trace count, error count, and
warning count for the selected time range.

### Time Range

Pill buttons select 1 hour, 6 hours, 24 hours, 7 days, or 30 days. The
selected range is sent as the `from` parameter to the API.

### Search

The search bar filters client-side across all fields: action, client, actor,
trace ID, span ID, session, payload content, and tag keys/values. This allows
finding events by any identifying information without knowing which field
contains it.

### Filters

- **Level**: Dropdown filtering by severity (error, warn, info, debug). Applied
  server-side for efficiency.
- **Client**: Dynamic dropdown populated from the current result set. Applied
  server-side.
- **Trace**: Clicking a trace ID badge filters to that trace and switches to
  waterfall view. Clear the chip to return to the event list.

### Event Table

Scrollable table with sticky header showing level indicator, timestamp, action,
client, actor, and trace ID. Clicking a row opens the detail panel. Clicking a
trace badge opens the waterfall.

### Detail Panel

Slides in from the right, showing:

- Structured fields (time, client, actor, session)
- Trace/span IDs as clickable links
- Tags rendered as `key=value` chips
- Payload in a dark JSON viewer
- Context and environment in collapsible sections

### Trace Waterfall

Shows spans as horizontal bars on a timeline, positioned by their start time
relative to the trace start. Child spans are indented under parents. Bars are
color-coded by level. The header shows the total span count and trace duration.

## Action Naming Convention

Use dot-separated hierarchical names:

```
{domain}.{operation}
```

Examples:

- `agent.create`, `agent.deploy`, `agent.invoke`, `agent.destroy`
- `llm.call`, `llm.stream`
- `gcs.upload`, `gcs.download`
- `bot.command.run`, `bot.command.create-agent`
- `demo.deploy`, `demo.stop`
- `tenant.switch`, `user.login`
- `webhook.receive`, `cron.trigger`

## Storage

Telemetry is stored in the `telemetry` table in each tenant's SQLite database.
The schema includes indexes on `tenant_id`, `trace_id`, `actor`, `action`,
`timestamp`, and `session` for efficient querying.

Events are synced to GCS alongside the rest of the tenant database when GCS
sync is configured.

## Access Control

The boundary is **write with a key, read and administer with admin identity**:

- **Ingestion** (`POST /telemetry`, `POST /telemetry/t/:tenant`): Requires a
  valid, non-revoked telemetry API key in the `X-Telemetry-Key` header. Identity
  tokens and session cookies are **not** accepted for ingest. Keys are
  write-only — they cannot read events or manage clients.
- **Querying** (`GET /telemetry`, `GET /telemetry/:id`, and the `/t/:tenant`
  variants): Admin identity only (Google bearer token or admin session). Tightened
  from "any authenticated member" to admin-only. Events are scoped to the tenant.
- **Client management** (`/telemetry/clients` CRUD): Admin identity only.
- **Web dashboard**: Admin only. The telemetry page is hidden from non-admin
  users and the `adminOnly` flag in `pages.ts` prevents navigation.
