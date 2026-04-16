# Telemetry

Agent Runtime includes a built-in telemetry system for tracking operations
across the CLI, web client, control plane, Slack bot, and deployed agents.
Events are stored per-tenant in SQLite and are queryable through the API and
the web dashboard.

## Data Model

Every telemetry event has these fields:

| Field           | Type   | Required | Description                                                                      |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `id`            | string | auto     | UUID assigned on ingest                                                          |
| `timestamp`     | number | yes      | Unix epoch milliseconds                                                          |
| `client`        | string | yes      | Source system (`ar-cli`, `web`, `slack-bot`, `agent-runtime`, `webhook`, `cron`) |
| `action`        | string | yes      | Operation name (e.g. `agent.deploy`, `llm.call`, `bot.command.run`)              |
| `level`         | string | no       | `info` (default), `warn`, `error`, `debug`                                       |
| `traceId`       | string | no       | Groups related events into a distributed trace                                   |
| `spanId`        | string | no       | Identifies this specific span within a trace                                     |
| `parentSpanId`  | string | no       | Links child spans to their parent                                                |
| `actor`         | string | no       | User email or `system` for automated events                                      |
| `session`       | string | no       | Groups events within a user session                                              |
| `clientVersion` | string | no       | Version of the emitting client                                                   |
| `payload`       | string | no       | JSON-encoded event data                                                          |
| `context`       | object | no       | Structured context (parsed as JSON)                                              |
| `environment`   | object | no       | Runtime environment metadata                                                     |
| `tags`          | object | no       | Key-value pairs for filtering                                                    |
| `fingerprint`   | object | no       | Deduplication fingerprint                                                        |

## Ingestion

### API Endpoint

```
POST /telemetry
```

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

Required fields per event: `client`, `action`, `timestamp`.

### Clients

| Client          | Description                                         |
| --------------- | --------------------------------------------------- |
| `ar-cli`        | CLI operations (deploy, create, destroy, trigger)   |
| `web`           | Web dashboard actions (create agent, switch tenant) |
| `agent-runtime` | Internal runtime (LLM calls, tool invocations)      |
| `webhook`       | Inbound webhook invocations                         |
| `cron`          | Scheduled cron invocations                          |
| `slack-bot`     | Slack bot commands and interactions                 |

## Querying

### API Endpoint

```
GET /telemetry
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
```

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

- **Ingestion** (`POST /telemetry`): Requires API authentication (bearer token
  or session cookie). Any authenticated user can ingest events.
- **Querying** (`GET /telemetry`, `GET /telemetry/:id`): Requires API
  authentication. Events are scoped to the current tenant.
- **Web dashboard**: Admin only. The telemetry page is hidden from non-admin
  users and the `adminOnly` flag in `pages.ts` prevents navigation.
