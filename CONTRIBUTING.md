# Contributing

Development guide for building, testing, and releasing the Agent Runtime
monorepo.

## Prerequisites

- [Deno 2.7+](https://deno.land/)
  (`curl -fsSL https://deno.land/install.sh | sh`)
- [Node.js 20+](https://nodejs.org/) (for web dashboard and runtime lib builds)
- `gcloud` CLI installed and authenticated (for live testing)

## Running from Source

All CLI commands run from source using `deno task ar` inside `cli/`:

```sh
cd cli
deno task ar help
deno task ar init
deno task ar deploy my-agent
deno task ar status
```

This executes `deno run -A src/cli.ts` with the provided arguments. When running
from source, the default registry path is `default-registry/` at the repo root (not
`~/.ar/`, which is only used by production builds).

> [!NOTE]
> Run `deno task ar init` to configure your GCP project, or set `AR_PROJECT`,
> `AR_REGION`, and `AR_RUNTIME_ACCOUNT` as environment variables. The global
> runtime config is in [`default-settings.jsonc`](default-settings.jsonc) (checked into the
> repo). See [CONFIG.md](CONFIG.md) for the full reference.

## Tasks

All Deno tasks run from `cli/`:

| Task                   | Description                                  |
| ---------------------- | -------------------------------------------- |
| `deno task ar`         | Run the CLI from source                      |
| `deno task run:dev`    | Run with watch + debug logging               |
| `deno task check`      | Format, lint, and type-check                 |
| `deno task test`       | Run tests                                    |
| `deno task build`      | Production build (web + control plane + CLI) |
| `deno task tag`        | Version and release                          |
| `deno task build:docs` | Generate HTML documentation                  |
| `deno task run:docs`   | Serve documentation locally                  |

Web dashboard tasks run from `web/`:

| Task                 | Description                                        |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Vite dev server with mock API (`local` tenant)     |
| `npm run dev:remote` | Vite dev server proxying to a remote control plane |
| `npm run build`      | Production build to `dist/`                        |

## Repository Structure

```
agent-runtime/
├── deno.jsonc                   # Root workspace config
├── sdk-client-deno/             # Shared SDK (@ar/client)
│   └── src/
│       ├── mod.ts               # SDK barrel export
│       ├── config.ts            # Configuration management
│       ├── mode.ts              # Mode detection (local/remote/server)
│       ├── runtime.ts           # default-settings.jsonc loader
│       ├── build.ts             # Build metadata
│       ├── tenant.ts            # Tenant resolution
│       ├── registry.ts          # Registry file operations
│       ├── tool-schema.ts       # Tool manifest validation
│       ├── platform/            # GCP platform adapters
│       ├── db/                  # SQLite database layer
│       ├── defaults/            # Default tool definitions
│       ├── templates/           # Entity scaffolding templates
│       ├── utils/               # Logger, formatting, graceful shutdown
│       └── operations/          # Extracted shared operations (secrets, runtime)
├── cli/                         # CLI entry point and commands
│   ├── src/
│   │   ├── cli.ts               # Entry point, mode detection
│   │   ├── tty.ts               # Interactive prompts
│   │   ├── commands/            # CLI command handlers
│   │   └── utils/               # Command router, gcloud wrapper
│   ├── scripts/                 # Build and dev scripts
│   └── test/                    # Tests
├── control-plane/               # HTTP server (@ar/control-plane)
│   └── src/
│       ├── mod.ts               # Hono app, bootstrap, serve
│       ├── types.ts             # Hono Env type
│       ├── api/                 # JSON API route modules
│       └── middleware/          # Auth, tenant, audit
├── web/                         # Web dashboard (Vite + Preact + TailwindCSS)
│   ├── src/                     # Preact islands, entry point, API client
│   ├── dev/                     # Mock API plugin and fixture data
│   ├── mod.ts                   # Deno module for CP integration (@ar/web)
│   └── index.html               # Standalone dev shell
├── sdk-agent-nodejs/            # Agent runtime library (Node.js)
│   ├── src/                     # TypeScript source
│   └── bin/                     # Built output (git LFS)
├── default-registry/            # Default registry root (development)
│   ├── agents/
│   ├── tools/                   # Default tool definitions and docs
│   ├── rules/                   # Rule definitions
│   └── skills/                  # Skill definitions
└── Dockerfile                   # Production container image
```

## Architecture

The monorepo is split into five Deno workspace packages and two npm packages:

### Client SDK (`sdk-client-deno/`, `@ar/client`)

The polymorphic core. Both the CLI and control plane import shared code from
here. Mode detection (`AR_MODE`) selects the right platform implementation:

- **Local mode** -- SDK uses `gcp.ts` (shells out to `gcloud`/`gsutil`)
- **Remote mode** -- SDK uses `control-plane.ts` (HTTP client to the deployed
  control plane)
- **Server mode** -- SDK uses `gcp-rest.ts` (direct GCP REST API calls)

### CLI (`cli/`)

Thin command handlers that parse arguments, handle TTY interaction, and delegate
to SDK operations. The CLI also conditionally imports the control plane for
`mode === 'server'`.

All CLI-side `gcloud` subprocess calls go through `cli/src/utils/gcloud.ts`,
which enforces a 15 s timeout by default. Pass a longer timeout (in ms) for
known-slow operations like deploys or API enables.

### Control Plane (`control-plane/`, `@ar/control-plane`)

Hono HTTP server that provides JSON API routes. Imports all shared logic from
`@ar/client`. Runs independently in Docker without the CLI.

### Mode Detection

1. `AR_MODE=server` env var -- starts the HTTP server (control plane)
2. `AR_CONTROL_PLANE_URL` env var -- remote mode (CLI forwards to control plane)
3. `controlPlaneUrl` in user `settings.jsonc` -- remote mode via settings file
4. Default -- local mode (CLI shells out to `gcloud`)

### Path Resolution

The CLI resolves three root paths: the home directory (settings, secrets),
the registry (entity folders), and the data directory (SQLite databases).

| Context    | Home      | Registry                   | Data                    |
| ---------- | --------- | -------------------------- | ----------------------- |
| Production | `~/.ar/`  | `~/.ar/registry/`          | `~/.ar/data/`           |
| Dev source | repo root | `<repo>/default-registry/` | `<repo>/data/`          |
| Server     | N/A       | `AR_REGISTRY` or cwd       | `AR_DB_PATH` or `/data` |

Override with `AR_HOME` (moves everything), `AR_REGISTRY` / `--registry`
(registry only), or `AR_DB_PATH` (databases only).

### Storage

- **SQLite** (`@db/sqlite`): agents, tools, configs, teams, departments, skills,
  rules, audit trail. One DB file per tenant in the data directory, synced to
  GCS.
- **GCS**: SQLite backup per tenant, agent source archives, entity archives
  (tools, rules, skills). Bucket name: `{project}-ar-registry`.
- **Filesystem**: user `settings.jsonc` for GCP settings including
  `controlPlaneUrl`. Runtime defaults in repo-root `default-settings.jsonc`.

### Tenants

Tenants are logical environments. `development` and `production` are the default
bootstrapped tenants (configurable in `default-settings.jsonc`). The web mock server uses
`local` as its tenant name to distinguish local development from the remote
`development` tenant. Custom tenants can be created with `--tenant <name>`.

### Platform Interface

All cloud operations flow through a `Platform` interface
(`sdk-client-deno/src/platform/types.ts`). Three adapters implement it:

| Adapter            | Mode   | How it works                               |
| ------------------ | ------ | ------------------------------------------ |
| `gcp.ts`           | Local  | Shells out to `gcloud` and `gsutil`        |
| `gcp-rest.ts`      | Server | Calls GCP REST APIs via `fetch()` with ADC |
| `control-plane.ts` | Remote | Forwards to the control plane HTTP API     |

`sdk-client-deno/src/platform/mod.ts` binds the active adapter at startup based
on the detected mode.

### Server (Hono)

The control plane uses [Hono](https://hono.dev/) for routing:

- `control-plane/src/mod.ts` -- Hono app, middleware, Deno.serve, lazy-loads
  `@ar/web`
- `control-plane/src/middleware/` -- Auth, tenant resolution, audit logging
- `control-plane/src/api/` -- JSON API route modules (agents, configs, teams,
  tools, etc.)

The web dashboard (`web/`) is imported via Deno workspace resolution as
`@ar/web`. The control plane lazy-loads it and serves static assets at
`/web/static/*` and pages at `/web/*`.

### Authentication

There are three distinct auth contexts. Understanding these is critical when
debugging auth issues or modifying the platform adapters.

#### 1. CLI → GCP directly (local mode)

When no control plane is deployed, the CLI talks to GCP APIs directly through
the `Platform` interface. The adapter is chosen at startup in
`sdk-client-deno/src/platform/mod.ts`:

- `AR_AUTH_METHOD=adc` → `gcpRest` adapter (GCP REST APIs with Application
  Default Credentials). Tries the GCE metadata server first, then falls back to
  `gcloud auth application-default print-access-token`.
- Default → `gcp` adapter (shells out to `gcloud` CLI, which uses whatever user
  credential `gcloud auth login` established).

The `gcp` adapter works for humans. The `gcpRest` adapter works for service
principals — CI runners with Workload Identity Federation, VMs with attached
service accounts, or any environment where `GOOGLE_APPLICATION_CREDENTIALS` is
set.

#### 2. CLI → Control Plane (remote mode)

When a control plane is deployed, the `Platform` becomes the `control-plane`
client. The CLI authenticates to the CP by sending a Google identity token as a
`Bearer` header. The CP's `apiAuth` middleware (`control-plane/src/middleware/auth.ts`)
verifies the JWT against Google's public JWKS keys and extracts the caller's
email.

Both user accounts and service accounts produce valid Google-signed JWTs, so
this works for both. The token is obtained via the GCE metadata server (on GCP)
or `gcloud auth print-identity-token` (locally).

#### 3. Control Plane → GCP (server mode)

The CP always uses the `gcpRest` adapter with the Cloud Run service account's
ambient ADC. It never shells out to `gcloud`. This is hardcoded in
`platform/mod.ts` — server mode always selects `gcpRest`.

#### Web dashboard

Browser users authenticate via Google OAuth (`/web/auth/login` → Google consent
→ `/web/auth/callback`). A session cookie (`ar_session`) stores the
authenticated email, validated on each request to `/web/*` routes.

#### Domain restrictions

Both API and web auth paths extract the user's email and resolve it to a user
record via `db/users.ts`. Domain restrictions can be enforced via
`AR_ALLOWED_DOMAINS` (comma-separated list of allowed email domains).

#### CI / service principal setup

CI uses Workload Identity Federation (WIF) to authenticate as a GCP service
account without storing credentials. The `google-github-actions/auth` action
sets up ADC so all subsequent `gcloud` and REST API calls use the service
principal's identity.

Both `AR_AUTH_METHOD=adc` (for the platform adapter) and
`"auth": { "method": "adc" }` (in the settings file) must be set because these
flow through different code paths — the env var controls
`platform/mod.ts` adapter selection, while the settings field controls the
`createSession()` pre-flight check in deploy/destroy commands. CI workflows set
both to ensure end-to-end service principal auth.

See [CONFIG.md](CONFIG.md) for WIF setup instructions and the required GitHub
repository variables.

### Database

`sdk-client-deno/src/db/` manages all SQLite operations:

- `mod.ts` -- open/close, GCS sync hooks, migrations
- `schema.ts` -- SQL migrations, version tracking, seed data
- `agents.ts` -- agent CRUD, edge model, version resolution
- `tools.ts` -- tool CRUD with versioning and GCS paths
- `teams.ts` -- teams and departments with cross-tenant sync
- `configs.ts` -- webhook/cron/event/file config CRUD
- `registry.ts` -- skills, rules CRUD
- `copy.ts` -- cross-tenant copy (agents, tools, configs)
- `audit.ts` -- audit trail writes and queries
- `users.ts` -- user management, admin checks
- `access.ts` -- visibility/permission checks

### Tools

Tools are executable scripts/binaries that agents invoke via stdio. See
[`default-registry/tools/README.md`](default-registry/tools/README.md) for the full
specification covering folder structure, `tool.json` schema, install scripts vs
direct binaries, versioning, and validation rules.

Default tools (`cursor`, `claude`, `github`, `auth0`, `datadog`) are seeded into
every tenant's public registry at control-plane startup. Builtin definitions are
inlined in `sdk-client-deno/src/defaults/tools.ts` so seeding works even when the
filesystem registry is unavailable (e.g. compiled binaries, Docker containers).
Their full definitions and per-tool documentation live in
`default-registry/tools/`.

All default registry entities (tools, skills, rules, agents) can be deployed
to the public registry of every bootstrapped tenant via `ar cp sync`, or by
accepting the prompt at the end of `ar cp deploy`. Both use the same deploy
commands (`ar tool deploy`, `ar agent deploy`, etc.) via child processes
targeting the control plane.

### Agent Functions

Agent functions are **Node.js** (not Deno). In **container mode** (default):

1. A shared base image (`Dockerfile.agent-base`) bundles the runtime lib and
   all tool binaries (cursor, claude, github, auth0, datadog)
2. Per-agent images add only the agent source code (~5KB) as a thin layer
3. `sdk-agent-nodejs/agent-host.js` serves the handler on `$PORT` with Express-like response shims
4. Tools resolve from `/app/tools/{slug}/tool` (baked into the base image)
5. Rules and skills are available at `/registry/` via GCS FUSE volume mount
6. Demo applications use a separate build pipeline (no FUSE) — see RFC-007

In **source mode** (fallback):

1. The CLI wraps the user's handler with the runtime bootstrap
2. The runtime lib (`sdk-agent-nodejs/bin/index.js`) is bundled into the
   function
3. Tools are resolved locally at runtime
4. TypeScript agent files are automatically transpiled during deploy

### Agent Runtime Library

The runtime library (`sdk-agent-nodejs/`) provides classes bootstrapped as
globals in agent functions. See
[`sdk-agent-nodejs/README.md`](sdk-agent-nodejs/README.md) for the full API.

Build it with:

```sh
cd sdk-agent-nodejs
npm install && npm run build
```

Output: `bin/index.js` (ESM), `bin/index.cjs` (CJS), `bin/index.d.ts` (types).

> [!IMPORTANT]
> After modifying `sdk-agent-nodejs/src/`, you must rebuild with
> `npm run build`. The compiled `bin/index.cjs` is baked into the base agent
> image as `_runtime.cjs`. Forgetting to rebuild means deployed agents use
> stale runtime code.

## Slack Bot (`control-plane/src/bots/slack/`)

The Slack bot runs inside the control plane using `npm:@slack/bolt` via Deno's
npm compatibility. No separate service or Node.js build pipeline.

| Component         | Path                                               |
| ----------------- | -------------------------------------------------- |
| Entry + dispatch  | `control-plane/src/bots/slack/mod.ts`              |
| Command handlers  | `control-plane/src/bots/slack/commands/*.ts`       |
| Event handlers    | `control-plane/src/bots/slack/events/*.ts`         |
| Block Kit builder | `control-plane/src/bots/slack/views/component.ts`  |
| Action handlers   | `control-plane/src/bots/slack/actions/handlers.ts` |
| Email resolution  | `control-plane/src/bots/slack/auth.ts`             |
| CP API routes     | `control-plane/src/api/bots/slack.ts`              |

The bot initializes when `SLACK_BOT_TOKEN` is set in the CP environment.
Slack events arrive at `/slack/events` and are verified + dispatched by the
bot module. The `/api/bots/slack/*` routes handle OAuth enrollment, identity,
settings, agent CRUD, and message logging.

### Enabling the bot

```sh
ar bot enable    # prompts for Slack credentials, updates CP env vars
ar bot disable   # removes Slack credentials from CP
ar bot status    # checks if bot is configured
```

### Deployment guide

See [`docs/slack-bot.md`](docs/slack-bot.md) for Slack app creation, credential
management, and troubleshooting.

## Web Dashboard Development

See [`web/README.md`](web/README.md) for architecture, code style, mock API, and
development workflow.

## Building

No build step for development — run directly from source:

```sh
cd cli
deno task ar help
```

For production builds and the full build pipeline, see
[docs/releasing.md](docs/releasing.md#build-pipeline).

## Testing

```sh
cd cli
deno task test
```

Integration testing (build, deploy, health check, destroy) is handled by the
`ci.yml` workflow's `integration` job, which runs on PRs when WIF credentials
are configured. See [docs/releasing.md](docs/releasing.md#ci--github-actions)
for the full CI/CD workflow.

### Local Pub/Sub Emulator

Agent edges that reference Pub/Sub topics can be tested locally using the
official GCP Pub/Sub emulator. Install and start it:

```sh
gcloud components install pubsub-emulator
gcloud beta emulators pubsub start --project=local-test
```

In a separate terminal, export the emulator host before running the control
plane:

```sh
export PUBSUB_EMULATOR_HOST=localhost:8085
deno task ar cp deploy   # or run the control plane from source
```

Google Cloud client libraries will route Pub/Sub traffic to the emulator when
`PUBSUB_EMULATOR_HOST` is set. Note that `gcloud eventarc` commands (used by
`ar trigger create --type pubsub`) target the real GCP API, not the emulator.
Create a topic and subscription to test an agent's `pubsub` ingress edge:

```sh
gcloud beta emulators pubsub env-init
gcloud pubsub topics create orders --project=local-test
gcloud pubsub subscriptions create orders-sub \
  --topic=orders --project=local-test
```

Publish a test message:

```sh
gcloud pubsub topics publish orders \
  --message='{"action":"test"}' --project=local-test
```

## Code Style

- 2 spaces, no semicolons, single quotes, 80 char line width
- Strict TypeScript with `exactOptionalPropertyTypes`
- No inline comments unless they explain a non-obvious "why"
- Run `deno task check` before committing

## Secrets

For local development, copy `secrets.example.jsonc` to `secrets.jsonc` and fill
in your values. This file is in `.gitignore` and must never be committed.

```sh
cp secrets.example.jsonc secrets.jsonc
```

See [Deploying: Secrets](docs/deploying.md#secrets) for the full precedence
rules, CI configuration, and what gets set on Cloud Run.

## GCS Backup and Recovery

The control plane automatically backs up each tenant's SQLite database to GCS on
every mutation (debounced to 500ms) and restores all bootstrapped tenants on
startup. Agent source archives and registry entity archives are also persisted to
GCS during deploy.

### Backup Paths

| Data            | GCS Path                                            |
| --------------- | --------------------------------------------------- |
| Tenant database | `{tenantId}/registry.db`                            |
| Agent source    | `{tenantId}/agents/{slug}/{version}/source.tar.gz`  |
| Tool archive    | `{tenantId}/tools/{slug}/{version}/archive.tar.gz`  |
| Rule archive    | `{tenantId}/rules/{slug}/{version}/archive.tar.gz`  |
| Skill archive   | `{tenantId}/skills/{slug}/{version}/archive.tar.gz` |

All paths are relative to the `{project}-ar-registry` GCS bucket.

### Restoring from Backup

**Database**: Download the tenant DB and place it at the expected path:

```sh
gsutil cp gs://{project}-ar-registry/{tenantId}/registry.db /data/{tenantId}.db
```

**Agent source**: Download and extract the source archive:

```sh
gsutil cp gs://{project}-ar-registry/{tenantId}/agents/{slug}/{version}/source.tar.gz .
tar xzf source.tar.gz -C default-registry/agents/{slug}/{version}/
```

**Entity archives** (tools, rules, skills): Download and extract:

```sh
gsutil cp gs://{project}-ar-registry/{tenantId}/{type}s/{slug}/{version}/archive.tar.gz .
tar xzf archive.tar.gz -C default-registry/{type}s/{slug}/{version}/
```

## Releasing

See [docs/releasing.md](docs/releasing.md) for the full release guide covering
build pipeline, deploy commands, CI workflows, GitHub configuration, and
version bumping.

## Git Workflow

- Detailed commit messages focusing on "why" not "what"
- Run `deno task check && deno task test` before committing
- Runtime lib build artifacts are tracked by git LFS
