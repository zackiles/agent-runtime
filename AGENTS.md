# Agent Runtime — Development Guide

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture and development
workflows. See [README.md](README.md) for CLI usage. See [CONFIG.md](CONFIG.md)
for settings and authentication. See [docs/releasing.md](docs/releasing.md) for
build pipeline, deploy commands, and CI/CD.

> **When stuck, hitting repeated failures, or working on large cross-cutting
> changes:** step back and diagnose against the live remote control plane before
> continuing to iterate locally. The
> [Debugging the Remote Control Plane](#debugging-the-remote-control-plane)
> section below lists every tool and strategy available — `gcloud` logs, CP API
> endpoints, CLI commands, Slack webhooks, Cloud Build/Artifact Registry
> inspection, and more. Using these to confirm what the remote system actually
> sees is almost always faster than guessing from source alone.

## Documentation Perspectives

- **README.md** is written for users of the production-released standalone CLI
  binary. Paths default to `~/.ar/` (home), `~/.ar/registry/` (entities), and
  `~/.ar/data/` (databases). Instructions assume a compiled build.
- **CONTRIBUTING.md** is written for developers working from source or
  configuring CI. Paths default to the repo root, and instructions use
  `deno task`.
- Both must be reviewed after major codebase changes to ensure they still
  accurately describe the system.

## Tasks

Deno tasks run from `cli/`. Web tasks run from `web/`.

- `deno task ar [command]`: Run CLI from source
- `deno task check`: Format, lint, type-check
- `deno task test`: Run tests
- `deno task build`: Production build
- `npm run dev` (web/): Vite dev with mock API

## Packages

| Folder              | Package                | Runtime                             |
| ------------------- | ---------------------- | ----------------------------------- |
| `cli/`              | `@ar/cli`              | Deno                                |
| `control-plane/`    | `@ar/control-plane`    | Deno (Hono)                         |
| `sdk-client-deno/`  | `@ar/client`           | Deno                                |
| `web/`              | `@ar/web`              | npm (Vite + Preact)                 |
| `sdk-agent-nodejs/` | `@ar/sdk-agent-nodejs` | Node.js                             |
| `default-registry/` | —                      | Data (agents, tools, rules, skills) |

`@ar/client` is the shared core. Both `cli/` and `control-plane/` import from it
via workspace subpath exports (e.g. `@ar/client/db/agents`,
`@ar/client/platform`). Mode detection (`AR_MODE`) selects the platform adapter.

## Code Style

- 2 spaces, 80 char line width, single quotes, no semicolons
- `import type` for type-only imports
- No inline comments unless they explain a non-obvious "why"
- kebab-case files, PascalCase types, camelCase functions, UPPER_SNAKE_CASE
  constants
- Use `deno add` for dependencies, `deno task` for commands

## Conventions

- Keep files under 250 lines
- In documentation use mermaid for flow charts
- Avoid single-caller extractions; inline when it aids readability
- Prefer simple, high-order names over compound or overly-specific ones
- Tool executables must be named `tool` (any extension); install scripts must be
  named `install` (any extension). See
  [default-registry/tools/README.md](default-registry/tools/README.md).

## Deploy Architecture

Agents deploy as container images by default (RFC-004). A shared base image
(`Dockerfile.agent-base`) contains the runtime lib and all tool binaries.
Per-agent images add only source code. Rules and skills are served via GCS FUSE
volume mounts. Demo applications use a separate build pipeline (Cloud Build →
Artifact Registry → Cloud Run) with no FUSE mounts — see
[docs/rfc/rfc-007-demo-serve-architecture.md](docs/rfc/rfc-007-demo-serve-architecture.md).
See [docs/rfc/rfc-004-agent-deploy-modes.md](docs/rfc/rfc-004-agent-deploy-modes.md)
for the agent deploy design and [docs/rfc/rfc-004-implementation.md](docs/rfc/rfc-004-implementation.md)
for the implementation plan.

After modifying `sdk-agent-nodejs/src/`, rebuild with `cd sdk-agent-nodejs && npm run build`.
The compiled `bin/index.cjs` is baked into the base image — stale builds mean
deployed agents use old runtime code.

## Deploy Commands and Timeouts

All deploy CLI commands block until completion — no separate polling step is
needed. Set shell timeouts accordingly:

| Command                             | Typical duration | Blocks via                                                                         |
| ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `deno task ar cp deploy --no-input` | 3–6 min          | `gcloud run deploy` subprocess (300s cap) + Cloud Build (600s cap) + registry sync |
| `deno task ar cp sync`              | 30–60s           | HTTP POST per entity, sequential                                                   |
| `deno task ar agent deploy <slug>`  | ~60s             | Polls `GET /agents/:id/deploy/status` every 3s (up to 6 min)                       |

Under the hood, `gcp-rest.ts` polls GCP long-running operations
(`run.googleapis.com`, `cloudfunctions.googleapis.com`, `eventarc.googleapis.com`)
via `waitForOperation` every 5s. The control plane polls Cloud Build status at
`cloudbuild.googleapis.com` every 5s. These are internal — callers just await
the CLI command.

After a deploy, `GET /health` on the control plane URL returns `{ status: 'ok' }`
and can be used to verify the new revision is serving.

## Slack Bot

The Slack bot runs inside the control plane process
(`control-plane/src/bots/slack/`). Commands live in `commands/`, event handlers
in `events/`, and Block Kit button handlers in `actions/handlers.ts`.

Adding a new command:

1. Create `commands/{name}.ts` exporting `handle(client, channel, email, slackUserId, tenantId, ...)`
2. Add entry to `COMMANDS` map and `dispatch` switch in `dispatch.ts`
3. Update `commands/help.ts` with the new command description
4. Add structural tests to `cli/test/slack-demo.test.ts` (or a new file)

The bot imports internal functions directly (e.g. `invokeAgent`, `listDemos`)
rather than making HTTP calls to itself. File attachments from Slack are
threaded as `SlackFile[]` through `routeCommand` -> `dispatch` -> handler.

See [docs/rfc/rfc-002-slackbot.md](docs/rfc/rfc-002-slackbot.md) for the
original bot architecture and
[docs/rfc/rfc-005-slack-demo-command.md](docs/rfc/rfc-005-slack-demo-command.md)
for the demo command design.

### Manifest and Scope Changes

The Slack app manifest is generated by `cli/src/commands/bot.ts`. When
`SLACK_CONFIG_TOKEN` and `SLACK_CONFIG_REFRESH_TOKEN` are set in `secrets.jsonc`,
the CLI pushes manifest updates automatically via the Slack API (auto-refreshing
the config token before each use). The config token is generated once during
initial setup and the refresh chain is indefinite.

Scope changes still require the human to **Reinstall to Workspace** at
`https://api.slack.com/apps/{APP_ID}/install-on-team` to activate new
permissions on the bot token. The bot token itself (`xoxb-...`) does not change
on reinstall. When working on features that add scopes, surface the reinstall
link to the user and guide them through it.

### Credentials

| Credential                        | Where to find                                      | Stored in                               |
| --------------------------------- | -------------------------------------------------- | --------------------------------------- |
| Bot Token (`xoxb-...`)            | Slack app → OAuth & Permissions → Bot User Token   | `secrets.jsonc`                         |
| Signing Secret                    | Slack app → Basic Information → App Credentials    | `secrets.jsonc`                         |
| Client ID                         | Slack app → Basic Information → App Credentials    | `secrets.jsonc`                         |
| Client Secret                     | Slack app → Basic Information → App Credentials    | `secrets.jsonc`                         |
| App Token (`xapp-...`)            | Slack app → Basic Information → App-Level Tokens   | `secrets.jsonc`                         |
| Config Token (`xoxe.xoxp-...`)    | api.slack.com/apps → Your App Configuration Tokens | `secrets.jsonc`                         |
| Config Refresh Token (`xoxe-...`) | Returned with config token; auto-rotated by CLI    | `secrets.jsonc`                         |
| App ID                            | Slack app → Basic Information (top of page)        | `secrets.jsonc`                         |
| incident.io API token (`inc_...`) | incident.io → Settings → API keys                  | `secrets.jsonc` (`INCIDENT_IO_API_KEY`) |

See [docs/slack-bot.md](docs/slack-bot.md) for full setup instructions.

## Secrets

In local development, secrets live in `secrets.jsonc` at the repo root. In
CI and cloud environments (including remote AI agents working on this
codebase), `secrets.jsonc` will not exist — secrets are provided as
environment variables instead. The mapping between Secret Manager names and
environment variable names is defined in the `"secrets"` object in
[`default-settings.jsonc`](default-settings.jsonc).

**Resolution order** (stop at the first hit):

1. `secrets.jsonc` (local development only)
2. Environment variable with the matching name from `default-settings.jsonc`
3. If neither source has the value, **stop and ask a human** to provide the
   secret before continuing — do not guess, fabricate, or skip it.

When adding a new secret, add an entry to both `secrets.jsonc` (with the
value) and `secrets.example.jsonc` (with an empty value and descriptive
comment) so other developers know the key exists.

## Debugging the Remote Control Plane

When something breaks after a deploy — or you need to verify remote state
without redeploying — these are the tools and strategies available.

### Cloud Run Logs (primary)

```sh
gcloud run services logs read ar-control-plane \
  --project=<project> --region=<region> --limit=100
```

- Shows CP stdout/stderr: request handling, Slack bot dispatch, DB sync errors,
  unhandled exceptions
- Add `--log-filter='severity>=ERROR'` to narrow to failures
- Tail live: `gcloud beta run services logs tail ar-control-plane --project=<project>`

### Cloud Build Logs

```sh
gcloud builds list --project=<project> --limit=10
gcloud builds log <build-id> --project=<project>
```

- Useful when `ar cp deploy` or `ar agent deploy` fails during the image build
  phase
- The CP also proxies build data: `GET /api/artifacts/builds` and
  `GET /api/artifacts/builds/:id/logs`

### Artifact Registry

```sh
gcloud artifacts repositories describe ar-registry \
  --project=<project> --location=<region>
gcloud artifacts docker images list \
  <region>-docker.pkg.dev/<project>/ar-registry
```

- Verify images were pushed after a build
- The CP exposes `GET /api/artifacts` and
  `GET /api/artifacts/packages/:name/versions` for the same data
- `DELETE /api/artifacts/packages/:name/builds` clears old builds, keeping
  only the latest deployed version

### Cloud Run Service State

```sh
gcloud run services describe ar-control-plane \
  --project=<project> --region=<region> --format=json
```

- Check current revision, env vars, scaling, IAM policy, service URL
- `GET /system` (admin) returns build metadata, GCP project info, Cloud Run
  service details, and storage stats in one call

### GCS / Storage

```sh
gsutil ls gs://<project>-ar-registry/<tenantId>/
gsutil cat gs://<project>-ar-registry/<tenantId>/registry.db | wc -c
```

- Verify tenant DB backups, agent source archives, entity archives exist
- The CP exposes `GET /storage/list`, `GET /storage/exists`, and
  `GET /storage/sign` for programmatic access

### Control Plane API (curl)

Authenticate with a Google identity token, then hit any CP endpoint:

```sh
TOKEN=$(gcloud auth print-identity-token)
curl -H "Authorization: Bearer $TOKEN" https://<cp-url>/health
curl -H "Authorization: Bearer $TOKEN" https://<cp-url>/api/agents
curl -H "Authorization: Bearer $TOKEN" https://<cp-url>/system
curl -H "Authorization: Bearer $TOKEN" https://<cp-url>/api/registry/status
curl -H "Authorization: Bearer $TOKEN" https://<cp-url>/audit
```

Key diagnostic endpoints:

| Endpoint                                      | Auth  | Returns                                                   |
| --------------------------------------------- | ----- | --------------------------------------------------------- |
| `GET /health`                                 | None  | `{ status: 'ok' }` — liveness check                       |
| `GET /system`                                 | Admin | Build info, GCP project, Cloud Run service, storage stats |
| `GET /api/registry/status`                    | Yes   | Registry sync state                                       |
| `GET /runtime/status`                         | Yes   | Runtime config and mode                                   |
| `GET /audit`                                  | Yes   | Audit trail of mutations                                  |
| `GET /telemetry`                              | Admin | Telemetry records                                         |
| `GET /agents/:id/deploy/status`               | Yes   | Agent deploy progress                                     |
| `GET /api/artifacts/builds`                   | Yes   | Recent Cloud Build jobs                                   |
| `DELETE /api/artifacts/packages/:name/builds` | Admin | Clear old builds, keep latest deployed                    |

### CLI Commands

These work in remote mode (after `ar connect <cp-url>`):

- `deno task ar status` — current mode, CP URL, project
- `deno task ar agent list` — all agents in the tenant
- `deno task ar agent logs <slug>` — Cloud Function logs for an agent
- `deno task ar secret list` — secrets synced to Secret Manager
- `deno task ar trigger list` — event triggers (Pub/Sub, Scheduler, Eventarc)
- `deno task ar bot status` — Slack bot config and env vars on Cloud Run
- `deno task ar runtime status` — runtime settings and deploy mode
- `deno task ar agent clear-builds [slug]` — remove old builds (one or all)

### Slack Bot

- Inbound webhook: `POST https://<cp-url>/slack/events` (Slack sends events
  and interactivity payloads here)
- Test dispatch locally by sending a Slack-shaped payload to the endpoint
  (requires a valid signing secret)
- Bot HTTP API lives under `/api/bots/slack/` — identity resolution, OAuth,
  settings, agent CRUD, message logs
- When the bot stops responding, check Cloud Run logs first — the bot runs
  in-process with the CP

### Slack API (external)

```sh
curl -H "Authorization: Bearer xoxb-..." \
  https://slack.com/api/auth.test
curl -H "Authorization: Bearer xoxb-..." \
  "https://slack.com/api/conversations.history?channel=<id>&limit=5"
```

- `auth.test` confirms the bot token is valid and shows the bot's identity
- `conversations.history` shows recent messages in a channel
- Useful when debugging whether Slack delivered events vs whether the CP
  processed them

### Secrets

```sh
gcloud secrets list --project=<project>
gcloud secrets versions access latest --secret=<name> --project=<project>
```

- Verify secrets exist and have the expected values
- `deno task ar secret list` shows the same data via the CP

### General Strategy

1. **Start with `GET /health`** to confirm the CP is reachable
2. **Check Cloud Run logs** for errors around the time of the failure
3. **Check Cloud Build logs** if the failure was during a deploy
4. **Hit the relevant API endpoint** with curl to see what the CP returns
5. **Compare remote state** (GCS, Secret Manager, Artifact Registry) against
   what you expect from the code
6. **Use the CLI** (`ar agent list`, `ar agent logs`, `ar status`) for a
   higher-level view before diving into raw `gcloud` output

## Git

- Semantic commits focusing on "why"
- Run `deno task check` before committing
- `sdk-agent-nodejs/bin/` and `default-registry/tools/*/[0-9]*/tool` tracked by git LFS
- When bumping the version in `cli/deno.jsonc`, add a matching entry to
  `CHANGELOG.md` summarising what changed in that release
