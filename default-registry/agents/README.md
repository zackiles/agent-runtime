# Registry Agents

Agents are the primary deployable unit in the runtime. Each agent is a Node.js
HTTP handler that receives requests, processes input using a prompt and optional
subsystem (cursor, claude), and returns structured output. In **container mode**
(default), agents run as Cloud Run services from container images. In **source
mode**, agents run as Cloud Functions Gen2.

## Source Types

Agents have two source types that determine how they are created and deployed.

### Function Agents (`sourceType: null`)

Code-based agents with a full Node.js handler. Created via CLI
(`ar agent
create`), deployed by uploading a tarball to GCS. Function agents can
reference other agents as outputs in their config and have full control over
their execution pipeline.

### Prompt Agents (`sourceType: 'prompt'`)

Prompt-based agents created through the web client or any client that sends a
`POST /api/agents` request to the control plane. The control plane compiles the
prompt into a deployable handler using templates. Only **private registry**
agents can be created as prompt agents.

**Required fields for prompt agent creation:**

| Field        | Type   | Required | Description                                 |
| ------------ | ------ | -------- | ------------------------------------------- |
| `name`       | string | Yes      | Agent display name                          |
| `subsystem`  | string | Yes      | Tool/subagent system: `claude` or `cursor`  |
| `prompt`     | string | Yes      | Prompt content (plain text or Markdown)     |
| `version`    | string | No       | Semver version (defaults to `0.0.1`)        |
| `team`       | string | No       | Team name (created if it doesn't exist)     |
| `department` | string | No       | Department name for organizational grouping |

The control plane handles compilation via `compileForDeploy(prompt, subsystem)`
which produces `prompt.compiled.md` and `index.js`. The compiled handler
resolves template variables (`{{request.body.x}}`, `{{request.headers.x}}`) at
runtime and delegates to the subsystem.

## Folder Structure

An agent version directory contains only source and metadata. There is no
`tools/` directory and no `_runtime.cjs`; tool binaries and runtime bootstrap
come from the **base container image**. At deploy time the handler in
`index.js` is wrapped by the platform bootstrap. Container mode runs
`agent-host.js` from that base image as the process entrypoint.

```
default-registry/agents/<id>/<version>/
  agent.json           # Required — deployment manifest
  index.js             # Required — function handler
  prompt.md            # Agent prompt (prompt agents)
  prompt-template.md   # Runtime-compiled prompt template (function agents)
  package.json         # Node.js dependencies
  README.md            # Documentation
```

Function agents that use a subsystem can include a `prompt-template.md` with
template variables (e.g. `{{REQUEST}}`, `{{DEMOS}}`). The handler reads this
file at runtime, compiles it with context, and sends the result to the
subsystem. This separates deterministic orchestration logic in the handler from
the subsystem prompt, and allows the prompt to be edited without recompiling the
handler.

An agent is uniquely identified by its **id** and **version**. IDs must be
lowercase alphanumeric with hyphens, starting with a letter. Versions follow
semver (e.g. `0.0.1`).

## agent.json

The deployment manifest that declares the agent's identity, entry point,
secrets, and triggers.

```json
{
  "version": "0.0.1",
  "id": "my-agent",
  "entryPoint": "handler",
  "secrets": [],
  "triggers": []
}
```

| Field            | Type     | Required | Description                                    |
| ---------------- | -------- | -------- | ---------------------------------------------- |
| `id`             | string   | Yes      | Agent identifier. Must match the folder name.  |
| `version`        | string   | Yes      | Semver version. Must match the version folder. |
| `entryPoint`     | string   | Yes      | Exported function name in `index.js`.          |
| `secrets`        | string[] | Yes      | Secret names to inject from Secret Manager.    |
| `runtimeAccount` | string   | No       | GCP service account email for this agent.      |
| `triggers`       | array    | Yes      | Cron or Pub/Sub trigger descriptors.           |

## Lead Agents and Sub-agents

Agents form chains through the **agent edge** system. Each agent has edges that
describe what it consumes from and what it publishes to.

### Lead Agents

A **lead agent** is any agent that does not consume from another agent. Lead
agents are entry points — they receive external input (webhooks, cron, events)
and can invoke sub-agents as part of their execution. In the web client, the
"Lead Agent" checkbox controls this designation.

Lead agents:

- Receive input from external sources (webhooks, cron, Pub/Sub)
- Can invoke sub-agents through their output configuration
- Are the only agents that can be copied across tenants (`ar copy`)
- When copied, the entire chain of sub-agents is copied with them

### Sub-agents

A **sub-agent** is any agent that consumes from another agent. Sub-agents always
have at least one `publishes` edge pointing to another agent in their parent's
configuration. They are invoked by their lead agent (or another sub-agent in the
chain) and return their output upstream.

### Edge Model

| Direction   | ref_type  | Meaning                                        |
| ----------- | --------- | ---------------------------------------------- |
| `consumes`  | `webhook` | Agent receives input from a webhook            |
| `consumes`  | `agent`   | Agent receives input from another agent        |
| `publishes` | `webhook` | Agent sends output to a webhook                |
| `publishes` | `agent`   | Agent sends output to another agent (chaining) |
| `publishes` | `gcs`     | Agent writes output to GCS                     |
| `publishes` | `pubsub`  | Agent publishes output to Pub/Sub              |

### Determining Lead vs Sub-agent

An agent is a lead if it has **no** `consumes` edge with `refType === 'agent'`.
This is computed automatically from the edge configuration:

```ts
function isLead(edges: AgentEdge[]): boolean {
  return !edges.some((e) => e.direction === 'consumes' && e.refType === 'agent')
}
```

### Output Configuration

Agent outputs determine where an agent's results are sent. Outputs are modeled
as `publishes` edges. When a `publishes` edge points to another agent, it
creates a natural lead-to-sub-agent relationship and chain.

Currently, only **function-based agents** can have agent output references or
triggers configured directly. Prompt agents created through the web client are
always created as lead agents with default webhook edges. To chain prompt
agents, use the control plane API to add `publishes` → `agent` edges after
creation.

## Lifecycle

```bash
ar agent create <id>[@version]       # scaffold locally + create DB record
ar agent deploy <id>[@version]       # deploy agent (container or source mode)
ar agent run <id> [--data <json>]    # invoke deployed agent
ar agent logs <id>                   # fetch logs
ar agent list                        # list deployed agents
ar agent destroy <id>                # remove service, triggers, secrets
ar agent switch <slug> <version>     # set active version
```

`ar agent create` scaffolds the folder structure using the `agent-default`
template and creates a record in the registry database.

**Container mode (default):** `ar agent deploy` uploads only the agent source
(on the order of ~5KB) via `POST /agents/:id/source`, then triggers
`POST /agents/:id/deploy`. The CP builds a thin image on the shared base image
and deploys a Cloud Run service. The deploy is asynchronous — the CLI polls a
status endpoint until completion.

**Source mode:** The control plane assembles the full package server-side and
deploys it as a Cloud Function (Gen2).

If the agent folder doesn't exist when `deploy` is called, it runs `create`
first automatically. See [docs/container-builds.md](../../docs/container-builds.md)
for details on the container build pipeline.

## Teams and Departments

Agents belong to **teams**, which belong to **departments**. This hierarchy
provides organizational grouping:

```
Tenant → Department → Team → Agent
```

When creating an agent through the web client or API, specifying a `team` name
that doesn't exist will automatically create the team. Teams are tenant-scoped
and unique by name within a tenant.

## Agents vs Other Registry Entities

Agents have capabilities that other entities do not:

- **Deployment to compute** (Cloud Functions) with HTTP triggers
- **Runtime invocation** (`ar agent run`)
- **Logs** (`ar agent logs`)
- **Triggers** (cron via Cloud Scheduler, Pub/Sub via Eventarc)
- **Secrets** (GCP Secret Manager integration)
- **Relationships** (edges to tools, skills, rules, sub-agents)
- **Cross-tenant copy** (`ar copy`) with all dependencies
- **Teams and departments** for organizational grouping
- **Subsystems** (cursor/claude) for delegating to AI tool backends
- **Lead/sub-agent chains** for multi-agent orchestration

## Client Creation Flow

Any client (web, CLI, Slack bot, etc.) creating a prompt agent sends the same
unified request to the control plane:

```
POST /api/agents
Content-Type: application/json

{
  "name": "My Agent",
  "sourceType": "prompt",
  "subsystem": "claude",
  "prompt": "# My Agent\n\nYou are an agent that...",
  "version": "0.0.1",
  "team": "platform",
  "department": "Engineering"
}
```

The control plane:

1. Validates required fields (`name`, `subsystem`, `prompt` for prompt agents)
2. Enforces `visibility: 'private'` for prompt agents
3. Resolves the team by name (creates it if it doesn't exist)
4. Creates the agent record with default webhook edges
5. Returns the agent with `isLead` computed from edges

On deploy (`POST /api/agents/:id/deploy`), the control plane compiles the prompt
into a deployable handler using `compileForDeploy(prompt, subsystem)`.

## Registry Folder: Default vs User Agents

The `default-registry/` folder in this repo is the **public registry source of truth**.
It contains the default agents, tools, skills, and rules that ship with the
product and are deployed to every tenant's public registry during CI release.
These files are checked into git and should be treated as production artifacts.

Default agents live at `default-registry/agents/<slug>/<version>/` and are explicitly
included in `.gitignore` via `!default-registry/agents/<slug>/` exceptions. Some
are generated from templates at deploy time (`index.js`, `package.json`); what
is checked in is typically `agent.json` and `prompt-template.md` (and related
prompt files), not per-agent tool trees or `_runtime.cjs`.

User-created agents are **never** stored in this repo. When using the compiled
`ar` binary, agents are scaffolded in `~/.ar/registry/agents/` (or a custom
path via `--registry` / `AR_REGISTRY`). When developing from source, user agents created
via `deno task ar agent create` are written to `default-registry/agents/` but are
gitignored by the `default-registry/agents/*/` rule. Only default agents with explicit
`.gitignore` exceptions are tracked.

To add a new default agent to the public registry, create its folder under
`default-registry/agents/<slug>/<version>/` with an `agent.json` manifest, add a
`!default-registry/agents/<slug>/` exception to `.gitignore`, and ensure the CI release
workflow deploys it.

## Default Agents

### demo-agent

The **demo-agent** is a function-based default agent that builds fullstack demo
applications from natural language prompts. It is deployed to every tenant's
public registry during CI.

**Function vs subsystem responsibilities:**

The function handler is a deterministic orchestrator. It owns sandbox setup,
version resolution, GCS archival, and Cloud Run deployment. The subsystem agent
(cursor or claude) only generates or edits code in the sandbox directory it is
given. The subsystem prompt lives in a separate `prompt-template.md` file that
the function compiles at **runtime** with mode-specific task instructions and
sandbox context before sending to the subsystem.

**How it works:**

1. Receives a request with a prompt and optional demo `name` / `version`
2. If `name` is provided, queries GCS to resolve the demo and its versions
3. Determines the mode: `create` (new demo), `update` (existing version), or
   `new-version` (new version of existing demo)
4. For `update` or `new-version`: pulls existing source from GCS to the sandbox
5. Compiles `prompt-template.md` with mode-specific task text and sandbox paths
6. Invokes the subsystem to generate or edit code in the sandbox
7. Archives the sandbox source to versioned GCS storage
8. Calls the control plane to deploy the demo to Cloud Run
9. Returns the demo metadata including name, version, and public URL

**Request format:**

```json
{
  "prompt": "Build a todo app with drag-and-drop",
  "name": "my-todo-app",
  "version": "0.0.1",
  "files": [{ "name": "logo.png", "content": "<base64>" }]
}
```

- `prompt` (required) -- what to build or change
- `name` (optional) -- slug of an existing demo to update or version
- `version` (optional) -- specific version; requires `name`
- `files` (optional) -- file overrides included in the request

**Version resolution:**

| `name` provided | `version` provided | Version exists | Mode                                 |
| --------------- | ------------------ | -------------- | ------------------------------------ |
| No              | --                 | --             | `create` (new demo, version `0.0.1`) |
| Yes             | No                 | --             | `update` (latest version)            |
| Yes             | Yes                | Yes            | `update` (that version)              |
| Yes             | Yes                | No             | `new-version` (create that version)  |

**Response format:**

```json
{
  "demo": {
    "name": "my-todo-app",
    "version": "0.0.1",
    "url": "https://demo-dev-my-todo-app.run.app",
    "summary": "A drag-and-drop todo application..."
  }
}
```

**GCS storage layout:**

```
{tenantId}/demos/{userId}/{demoSlug}/{version}/
  demo.json          # Demo metadata (name, version, summary, timestamps)
  source/            # Full demo source code
    index.html
    main.js
    ...
```

**Demo lifecycle:**

| Action   | Endpoint                        | Description                   |
| -------- | ------------------------------- | ----------------------------- |
| Create   | `POST /api/demos`               | Create a new demo from prompt |
| List     | `GET /api/demos`                | List all demos for the user   |
| Deploy   | `POST /api/demos/:name/deploy`  | Deploy to Cloud Run           |
| Stop     | `POST /api/demos/:name/stop`    | Stop the Cloud Run service    |
| Update   | `POST /api/demos/:name/update`  | Send feedback to update       |
| Download | `GET /api/demos/:name/download` | Download source files         |
| Delete   | `DELETE /api/demos/:name`       | Delete demo and container     |
| Cleanup  | `POST /api/demos/cleanup`       | Admin: expire old demos       |

**Container isolation:**

Each demo runs in its own Cloud Run service with:

- No access to other Cloud Run services in the project
- No access to GCS or other GCP resources (worker SA has no storage roles)
- Authenticated by default (`allAuthenticatedUsers` Cloud Run IAM policy)
- The demo agent can set `"visibility": "public"` in its response when the
  user's prompt explicitly requests public access, which grants `allUsers`
- Auto-expiry after 7 days (configurable, enforced by cleanup endpoint)

**Prerequisites:**

The following GCP APIs must be enabled for demo container deployment:

- Cloud Run Admin API (`run.googleapis.com`)
- IAM API (`iam.googleapis.com`)

The `agent-runtime-sp` service account must have `roles/run.admin` to create and
manage demo Cloud Run services.

### access-agent

The **access-agent** is a function-based default agent that helps users
configure access to company apps, resources, data sources, and third-party
services. It operates in a two-turn flow and is deployed to every tenant's
public registry during CI.

**How it works:**

1. **Turn 1 (access request):** The user describes what resource they need
   access to. The agent analyzes the request, determines what credentials are
   needed (OAuth tokens, API keys, service account files, etc.), and invokes the
   Demo Agent to build a one-time-use web UI tailored to the specific access
   type. The UI guides the user through the credential collection process and
   encodes all collected data into a base64 JSON context string.

2. **Turn 2 (context callback):** The user sends back the base64 context string
   from the UI. The agent decodes it, validates the structure, and stores the
   credentials as secrets in GCP Secret Manager via the runtime. It then updates
   any needed runtime or control plane configuration.

**Turn 1 request format:**

```json
{
  "resource": "google-drive",
  "description": "Connect my personal Google Drive to agents",
  "scope": "private"
}
```

**Turn 2 callback format:**

```json
{
  "context": "<base64-encoded-string-from-access-ui>"
}
```

The base64 payload decodes to:

```json
{
  "type": "oauth",
  "resource": "google-drive",
  "data": { "token": "...", "refresh_token": "..." },
  "scope": "private",
  "grantId": "google-drive-1717200000000",
  "timestamp": "2025-06-01T10:00:00Z"
}
```

**Scope:**

| Scope     | Who Can Use          | Who Can Configure |
| --------- | -------------------- | ----------------- |
| `private` | Current user only    | Any user          |
| `public`  | All users and agents | Admins only       |

Private access setup stores secrets scoped to the requesting user's private
registry. Public scope stores secrets and config in the public registry visible
to all users and their agents, and requires admin privileges.

**Supported access patterns:**

| Pattern         | Example                     | UI Generated                            |
| --------------- | --------------------------- | --------------------------------------- |
| OAuth/OIDC      | Google, GitHub, Slack SSO   | Authorization URL + callback capture    |
| API Key         | OpenAI, Stripe, Datadog     | Secure key input form                   |
| Service Account | GCP, AWS IAM                | JSON/credential file upload             |
| Multi-Secret    | AWS (key + secret + region) | Multi-step wizard                       |
| Personal Data   | GSuite Drive, Calendar      | User-scoped OAuth with personal consent |

**GCS storage layout:**

```
{tenantId}/access/{userId}/{grantId}/
  grant.json         # Access grant metadata and status
```

**Access lifecycle:**

| Action   | Endpoint                    | Description                        |
| -------- | --------------------------- | ---------------------------------- |
| Request  | `POST /api/access`          | Initiate access request            |
| Callback | `POST /api/access/callback` | Complete setup with context string |
| List     | `GET /api/access`           | List access grants for user        |
| Get      | `GET /api/access/:id`       | Get specific grant                 |
| Delete   | `DELETE /api/access/:id`    | Remove grant                       |

**Prerequisites:**

The following GCP APIs must be enabled:

- Secret Manager API (`secretmanager.googleapis.com`) — for storing credentials
- Cloud Run Admin API (`run.googleapis.com`) — for the Demo Agent's access UIs

The service account must have:

| Role                        | Purpose                                       |
| --------------------------- | --------------------------------------------- |
| `roles/secretmanager.admin` | Create and manage secrets                     |
| `roles/run.admin`           | Deploy one-time-use access UIs via Demo Agent |
