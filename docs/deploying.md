# Deploying

This document covers deploying the control plane and agents to GCP. For
local development without GCP, see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Prerequisites

- A GCP project with the following APIs enabled: Cloud Run, Cloud Functions,
  Cloud Build, Secret Manager, Cloud Scheduler
- A service account (e.g. `agent-runtime-sp@<project>.iam.gserviceaccount.com`)
- The `gcloud` CLI installed and authenticated
- (Optional) A VPC connector for private network access

The CLI handles API enablement and IAM role grants interactively during
`ar cp deploy`. If you prefer to provision manually, see
[Manual GCP Setup](#manual-gcp-setup).

---

## Quick Start

The fastest path is `ar quickstart`, which walks through project setup, control
plane deployment, and first agent deploy in one interactive flow:

```bash
ar quickstart
```

Or use `ar deploy <agent>` directly — it will prompt for setup if no registry
exists.

---

## Control Plane

The control plane is a single Cloud Run service that hosts the API, web
dashboard, and Slack bot. It uses SQLite (backed up to GCS) so it is limited
to **one instance** — do not increase `maxInstances` past 1 until a distributed
database replaces SQLite.

### Deploy

```bash
ar cp deploy
```

This is interactive by default. It will:

1. Authenticate via `gcloud` (or ADC if `AR_AUTH_METHOD=adc`)
2. Prompt for GCP project, region, and service accounts if not already
   configured in `settings.jsonc`
3. Enable required GCP APIs if missing
4. Create service accounts and grant IAM roles from
   [`default-settings.jsonc`](../default-settings.jsonc)
5. Sync secrets from `secrets.jsonc` to GCP Secret Manager
6. Build the control plane binary (from the embedded archive in production,
   or compiled from source in development)
7. Write a Dockerfile and deploy to Cloud Run via `gcloud run deploy --source`
   (which uses Cloud Build)
8. Set `AR_AUDIENCE` on the deployed service to the Cloud Run URL
9. Save the URL to `settings.jsonc` — the CLI switches to **remote mode**
   automatically
10. Sync the default registry — deploy all tools, skills, rules, and agents
    from `default-registry/` as public items to every bootstrapped tenant

After deploy, all CLI operations go through the control plane instead of
calling GCP directly.

### Non-Interactive Deploy

Use `--no-input` to skip all prompts. Required values must come from
`settings.jsonc`, environment variables, or CLI flags:

```bash
ar cp deploy --no-input
```

### Destroy

Remove the Cloud Run service:

```bash
ar cp destroy
```

Full teardown of all Agent Runtime resources (functions, triggers, scheduler
jobs, secrets, bucket, Cloud Run service):

```bash
ar cp destroy --all
```

Both accept `--force` to skip confirmation prompts.

### Sync

Deploy all default registry entities (agents, tools, skills, rules) to every
bootstrapped tenant without redeploying the control plane itself:

```bash
ar cp sync
```

This is the same operation that `ar cp deploy` offers at the end of a
successful deploy. Use it to re-sync after updating registry contents.

### Reset

Delete tenant data while keeping infrastructure:

```bash
ar cp reset                    # reset default tenant
ar cp reset --tenant production # reset a specific tenant
ar cp reset --all              # reset all tenants
```

---

## Settings

The CLI merges settings from multiple sources (highest priority first):

1. Environment variables (`AR_PROJECT`, `AR_REGION`, etc.)
2. `--settings <path>` flag (explicit settings file)
3. `settings.local.jsonc` (dev only, gitignored)
4. `settings.jsonc` in `~/.ar/` (production) or repo root (dev)
5. `default-settings.jsonc` (checked-in defaults)

Key fields for deployment:

| Field             | Env Var              | Purpose                        |
| ----------------- | -------------------- | ------------------------------ |
| `project`         | `AR_PROJECT`         | GCP project ID                 |
| `region`          | `AR_REGION`          | GCP region                     |
| `runtimeAccount`  | `AR_RUNTIME_ACCOUNT` | Runtime account email          |
| `workerAccount`   | `AR_WORKER_ACCOUNT`  | Worker service account email   |
| `vpcConnector`    | `AR_VPC_CONNECTOR`   | VPC connector name (optional)  |
| `controlPlaneUrl` | —                    | Set automatically after deploy |

See [CONFIG.md](../CONFIG.md) for the full settings reference.

---

## Secrets

Secrets are synced to GCP Secret Manager during `ar cp deploy`. The mapping
of Secret Manager names to environment variables is defined in
[`default-settings.jsonc`](../default-settings.jsonc) under the `secrets` key.

### Where Values Come From

| Context        | Source                                |
| -------------- | ------------------------------------- |
| Local dev      | `secrets.jsonc` in repo root          |
| Production CLI | `~/.ar/secrets.jsonc`                 |
| CI             | GitHub repository secrets as env vars |

Copy `secrets.example.jsonc` and fill in your values:

```bash
cp secrets.example.jsonc secrets.jsonc
```

### Precedence

1. Environment variable (highest — overrides file values)
2. `secrets.jsonc` file
3. Skipped if neither is set (secret not synced)

### What Gets Set on Cloud Run

All resolved secrets are written into the Cloud Run service as environment
variables. The Slack client secrets are additionally mirrored as
`AR_BOT_SLACK_CLIENT_ID` and `AR_BOT_SLACK_CLIENT_SECRET`.

Non-secret environment variables set on the service include GCP project/region,
service accounts, build metadata (`AR_BUILD_VERSION`, `AR_BUILD_COMMIT`, etc.),
and `AR_MODE=server`.

---

## Agents

### Container Mode (default)

Agents deploy as Cloud Run services from container images:

```bash
ar agent deploy my-agent           # deploy latest version
ar agent deploy my-agent@0.2.0     # deploy specific version
```

The deploy flow:

1. CLI compresses agent source (index.js, agent.json, ~5KB) and uploads to
   the control plane via `POST /agents/:id/source`
2. Control plane triggers Cloud Build to create a per-agent image (thin layer
   on the shared base image, ~30s)
3. Control plane deploys a Cloud Run service with GCS FUSE volume mount,
   secrets from Secret Manager, and environment variables

Each agent service gets:

| Variable               | Value                   | Purpose                        |
| ---------------------- | ----------------------- | ------------------------------ |
| `AR_CONTROL_PLANE_URL` | Cloud Run URL           | Storage and deploy callbacks   |
| `AR_BUCKET`            | `{project}-ar-registry` | GCS bucket for agent storage   |
| `AR_TENANT_ID`         | Default tenant          | Tenant scope for storage paths |
| `AR_AGENT_SLUG`        | Agent slug              | Agent identity                 |
| `AR_TOOLS_DIR`         | `/app/tools`            | Tool binary location           |

Tool binaries are pre-installed in the base image at `/app/tools/{slug}/tool`.
Rules and skills are available at `/registry/` via GCS FUSE read-only mount.
Secrets from Secret Manager are mounted as environment variables.

### Source Mode (fallback)

Agents deploy as Cloud Functions (Gen2). Each deploy triggers Cloud Build
(2-5 minutes). Tool binaries install at build time. No GCS FUSE support.

```bash
ar agent deploy my-agent --agent-deploy-mode source
```

### Switching Modes

Set the mode during first `ar cp deploy` or change it later:

```bash
ar registry set agent-deploy-mode container
ar registry set agent-deploy-mode source
```

Or via environment variable: `AR_AGENT_DEPLOY_MODE=container`.

---

## Authentication

### Control Plane (Cloud Run)

Deployed with `--allow-unauthenticated`. Cloud Run's IAM invoker check is
bypassed intentionally — authentication is handled at the application layer
via JWT verification. This is required for the OAuth login page, Slack
webhooks, and the callback flow.

`AR_AUDIENCE` is set to the Cloud Run URL after deploy. API requests are
verified against Google's JWKS endpoint with two allowed audiences: the
service URL (for service account tokens) and the gcloud CLI's OAuth client
ID (for user tokens from `gcloud auth print-identity-token`).

Domain restrictions can be applied via `AR_ALLOWED_DOMAINS`.

For full details, see [Identity & Access Management](iam.md).

### CLI → GCP (Local Mode)

Without a control plane, the CLI calls GCP APIs directly via `gcloud` (user
auth) or the REST API (ADC). Set `AR_AUTH_METHOD=adc` for service principals
and CI environments.

### CLI → Control Plane (Remote Mode)

After `ar cp deploy` or `ar connect <url>`, the CLI sends a Google identity
token as a Bearer header. The control plane verifies it.

---

## CI / GitHub Actions

See [releasing.md](releasing.md) for the full CI/CD guide covering release
workflows, integration testing, required GitHub configuration (repository
variables and secrets), and OIDC setup.

---

## Tenants

Tenants are logical environments — each gets its own SQLite database and GCS
path prefix. The defaults are `development` and `production` (configured in
`default-settings.jsonc` under `tenants.bootstrapped`).

There is **one control plane** that serves all tenants. The active tenant is
determined per-request via the `X-Tenant` header, `?tenant=` query parameter,
or `ar_tenant` cookie. There is no per-tenant authorization gate — any
authenticated user can access any tenant.

The CLI targets a tenant via `--tenant <name>` or `AR_TENANT` (defaults to
`development`). The web dashboard lets users switch tenants from the navbar.

---

## Manual GCP Setup

If you prefer to provision infrastructure manually instead of letting
`ar cp deploy` handle it:

### APIs

```bash
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  --project=<project>
```

### Service Accounts

Create the admin and worker accounts, then grant the roles listed in
[`default-settings.jsonc`](../default-settings.jsonc) under
`runtimeAccountRoles` and `workerAccountRoles`.

### Cloud Run Limits

The control plane defaults are in `default-settings.jsonc` under
`controlPlane`:

| Setting           | Default | Note                                     |
| ----------------- | ------- | ---------------------------------------- |
| `memory`          | 1Gi     |                                          |
| `cpu`             | 1       |                                          |
| `timeout`         | 60s     |                                          |
| `concurrency`     | 80      |                                          |
| `minInstances`    | 0       | Set to 1 to avoid cold starts            |
| `maxInstances`    | 1       | Do not increase until SQLite is replaced |
| `cpuThrottling`   | false   | CPU is never throttled between requests  |
| `startupCpuBoost` | true    | Extra CPU during container startup       |

---

## Troubleshooting

### "No control plane URL configured"

Run `ar cp deploy` to deploy, or `ar connect <url>` to connect to an existing
one.

### Deploy fails at Cloud Build

Check `gcloud builds list --project=<project>` for build logs. Common causes:
missing APIs, insufficient IAM permissions on the Cloud Build service account,
or quota limits.

### Secrets not appearing on Cloud Run

Verify `secrets.jsonc` has the values, or set them as environment variables
before running `ar cp deploy`. Check `gcloud secrets list --project=<project>`
to see what was synced.

### Agent function can't reach the control plane

Ensure the agent function's service account has `roles/run.invoker` on the
control plane service, and that `AR_CONTROL_PLANE_URL` is set on the function.
Both are handled automatically by `ar agent deploy` when a control plane URL
is configured.
