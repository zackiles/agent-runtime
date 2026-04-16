# Releasing

How to build, deploy, and release Agent Runtime — from local development
through CI/CD to production.

---

## What Gets Deployed

A release touches up to four layers. Each can be deployed independently, but
`ar cp deploy` handles all of them in one command.

| Layer             | Artifact                                 | Where it runs      |
| ----------------- | ---------------------------------------- | ------------------ |
| Control plane     | Compiled Deno binary (embeds web + SDK)  | Cloud Run (single) |
| Web dashboard     | Vite build (`web/dist/`) baked into CP   | Served by CP       |
| Base agent image  | `Dockerfile.agent-base` + tool binaries  | Artifact Registry  |
| Registry entities | Agents, tools, skills, rules from source | Cloud Run / GCS    |

---

## Deploy Commands

### Everything at once

```bash
ar cp deploy          # interactive
ar cp deploy --no-input   # CI / non-interactive
```

This single command:

1. Verifies GCP APIs and IAM roles
2. Syncs secrets from `secrets.jsonc` to Secret Manager
3. Builds web assets (Vite) and compiles the CP binary (linux x86_64)
4. Deploys the CP to Cloud Run via `gcloud run deploy --source`
5. Builds and pushes the base agent image to Artifact Registry
6. Syncs all `default-registry/` entities to every bootstrapped tenant

After deploy, the CLI switches to **remote mode** — all subsequent commands
route through the deployed control plane.

### Registry only (no CP redeploy)

```bash
ar cp sync
```

Re-syncs `default-registry/` entities (tools, skills, rules, agents) to all
tenants. Use this when you've changed registry contents but not the CP code,
SDK, or web dashboard.

### Single agent

```bash
ar agent deploy <slug>          # deploy latest version
ar agent deploy <slug>@0.2.0   # deploy specific version
```

Compresses the agent source, uploads it, and triggers a container build +
Cloud Run deploy. Takes ~60s in container mode.

### Single registry entity

```bash
ar tool deploy <slug>
ar skill deploy <slug>
ar rule deploy <slug>
```

Validates, compresses, and uploads the entity archive to GCS.

### Destroy

```bash
ar cp destroy          # remove Cloud Run service only
ar cp destroy --all    # full teardown (functions, triggers, secrets, bucket, IAM)
ar cp reset            # delete tenant data, keep infrastructure
```

---

## Build Pipeline

### Development (from source)

No build step required. Run directly:

```bash
cd cli
deno task ar help
deno task ar cp deploy
```

When `ar cp deploy` runs from source, it:

1. Builds `web/dist/` via Vite (always rebuilds to avoid stale assets)
2. Compiles `control-plane/src/mod.ts` to a linux x86_64 binary with
   `--include` for web assets and `default-settings.jsonc`
3. Deploys the binary to Cloud Run

### Production (compiled binary)

```bash
cd cli
deno task build 0.1.0
```

This runs `scripts/build.ts` which:

1. Builds web assets via Vite (`web/`)
2. Cross-compiles the control plane to a linux x86_64 binary with `--include`
   for web assets
3. Compresses the CP binary into a `.tar.gz` archive (~56% size reduction)
4. Compiles the CLI for the host platform, embedding the compressed archive
5. Stamps `AR_BUILD_VERSION` and `AR_BUILD_MODE=production` into both binaries

Output:

```
cli/dist/
  ar                       # CLI binary (host platform, ~118MB)
  ar-control-plane.tar.gz  # Compressed control plane (linux x86_64, ~40MB)
```

Add `--cross` for all platforms (used by CI):

```bash
deno task build 0.1.0 --cross
```

```
cli/dist/
  ar-linux-x64             # Linux x64
  ar-linux-arm64           # Linux arm64
  ar-darwin-x64            # macOS Intel
  ar-darwin-arm64          # macOS Apple Silicon
  ar-control-plane.tar.gz  # Compressed control plane (linux x86_64)
```

When the production binary runs `ar cp deploy`, it extracts the embedded
CP archive instead of compiling from source.

---

## CI / GitHub Actions

### Release Workflow (`release.yml`)

Triggers on pushes to `main` with conventional commit prefixes (`feat:`,
`fix:`, `!:`) or on version tags (`v*.*.*`).

It does three things:

1. Cross-compiles the CLI for Linux and macOS (x64 + arm64)
2. Creates a GitHub Release with all platform binaries
3. If `vars.WIF_PROVIDER` is set, deploys the control plane and syncs
   registry items to production

The deploy step authenticates via Workload Identity Federation (OIDC), writes
a temporary `settings.jsonc` from repository variables, and runs:

```bash
ar init --no-input ...
ar cp deploy --no-input ...
```

`ar cp deploy --no-input` automatically syncs the default registry to all
bootstrapped tenants. Include `[skip deploy]` in the commit body to publish a
release without deploying.

### Integration Workflow (`ci.yml`)

Runs on pull requests. Two phases:

1. **Check** — lint, type-check, unit tests (always runs)
2. **Integration** — full deploy/health-check/destroy cycle in both `source`
   and `container` modes (only runs when `vars.WIF_PROVIDER` is set)

### Required GitHub Configuration

**Repository variables** (non-secret):

| Variable              | Example                               |
| --------------------- | ------------------------------------- |
| `GCP_PROJECT`         | `my-project`                          |
| `GCP_REGION`          | `northamerica-northeast1`             |
| `AR_RUNTIME_ACCOUNT`  | `agent-runtime-sp@my-project.iam...`  |
| `AR_WORKER_ACCOUNT`   | `agent-worker-sp@my-project.iam...`   |
| `WIF_PROVIDER`        | `projects/.../providers/github`       |
| `WIF_SERVICE_ACCOUNT` | `github-actions@my-project.iam...`    |
| `GOOGLE_CLIENT_ID`    | OAuth client ID for web login         |
| `SLACK_CLIENT_ID`     | Slack app client ID                   |
| `AR_ADMIN_GROUP`      | Comma-separated admin emails          |
| `AR_ALLOWED_DOMAINS`  | Comma-separated allowed email domains |

**Repository secrets**:

| Secret                 | Purpose                                 |
| ---------------------- | --------------------------------------- |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret for web login       |
| `SLACK_BOT_TOKEN`      | Slack bot token                         |
| `SLACK_SIGNING_SECRET` | Slack request signing                   |
| `SLACK_CLIENT_SECRET`  | Slack OAuth client secret               |
| `SLACK_APP_TOKEN`      | Slack app-level token for manifest mgmt |
| `INCIDENT_IO_API_KEY`  | incident.io API token (`inc_...`)       |
| `AR_SESSION_SECRET`    | Session cookie signing key              |

### OIDC / Workload Identity Federation

CI authenticates to GCP using Workload Identity Federation. See
[CONFIG.md — GitHub Actions OIDC](../CONFIG.md#github-actions-oidc--workload-identity-federation)
for the WIF pool, provider, and service account binding setup.

---

## Version Bumping

Versions are determined automatically by commit message prefix:

| Prefix   | Bump  | Example                        |
| -------- | ----- | ------------------------------ |
| `feat:`  | minor | `feat: add cron edge support`  |
| `fix:`   | patch | `fix: webhook URL generation`  |
| `feat!:` | major | `feat!: redesign agent schema` |
| `fix!:`  | major | `fix!: breaking API change`    |

Pushing a tag (`v1.2.3`) directly also triggers a release at that version.
Commits without a recognized prefix (e.g. `chore:`, `docs:`) do not trigger
a release.

When bumping the version in `cli/deno.jsonc`, add a matching entry to
`CHANGELOG.md` summarising what changed.

---

## Decision Tree

```
Changed CP code, SDK, or web dashboard?
  └─ Yes → ar cp deploy
Changed only default-registry/ entities?
  └─ Yes → ar cp sync
Changed a single agent's source?
  └─ Yes → ar agent deploy <slug>
Changed a tool/skill/rule?
  └─ Yes → ar <type> deploy <slug>
Full teardown needed?
  └─ Yes → ar cp destroy --all
```
