---
name: agent-runtime
description: >
  Install, configure, deploy, and manage the Agent Runtime CLI — an
  enterprise-grade AI gateway and headless agent runtime on GCP. Provides
  full knowledge of all CLI commands, architecture, GCP authentication,
  control plane deployment, agent lifecycle, registry entities, tenants,
  and development workflows.
---

# Agent Runtime

You are an expert assistant for the **Agent Runtime** (`ar`) CLI. Agent Runtime
deploys, manages, orchestrates, and observes an enterprise-grade AI gateway and
headless agent runtime on Google Cloud Platform.

## Installation

Before using any `ar` commands, check if the CLI is installed:

```bash
ar version
```

If the command is not found, install it:

```bash
curl -fsSL https://raw.githubusercontent.com/zackiles/agent-runtime/main/install.sh | sh
```

To install to a custom directory:

```bash
curl -fsSL https://raw.githubusercontent.com/zackiles/agent-runtime/main/install.sh | INSTALL_DIR=~/.local/bin sh
```

The installer detects the user's platform (Linux or macOS, x64 or arm64) and
downloads the correct binary from GitHub Releases to `/usr/local/bin/ar`.

On first run, `ar` creates `~/.ar/` with subdirectories for settings
(`settings.jsonc`), registry entities (`registry/`), and databases (`data/`).

## Quickstart

The fastest path from zero to a deployed agent:

```bash
ar quickstart
```

This walks the user through:

1. GCP project configuration (project ID, region, service account, VPC
   connector)
2. Registry initialization
3. Control plane deployment to Cloud Run
4. Scaffolding and deploying their first agent

If the user prefers step-by-step:

```bash
ar init --project <project-id> --region <region> \
  --runtime-account <email>
ar cp deploy
ar deploy my-agent
ar run my-agent --data '{"message": "hello"}'
```

## Architecture

### Overview

Agent Runtime is a monorepo with five packages:

| Package             | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `cli/`              | Deno CLI — the main entry point users interact with     |
| `control-plane/`    | Hono HTTP server deployed to Cloud Run                  |
| `sdk-client-deno/`  | Shared SDK core used by both CLI and control plane      |
| `sdk-agent-nodejs/` | Node.js runtime library injected into agent functions   |
| `web/`              | Preact + Vite web dashboard served by the control plane |

The CLI is the primary interface. Production builds compile everything into a
single binary that embeds a compressed control plane archive.

### Control Plane

The control plane is a Hono HTTP server deployed as a Cloud Run service. It:

- Provides JSON API routes for all agent and registry operations
- Serves the web dashboard at `/web/*`
- Handles authentication (Google OAuth for web, Bearer tokens for API)
- Manages SQLite databases per tenant with automatic GCS backup
- Runs in a `debian:trixie-slim` container with 512Mi memory

Deploy: `ar cp deploy` Destroy: `ar cp destroy`

### Agents

Two types of agents exist:

**Prompt-based agents**: Use a `prompt.md` file with instructions. The runtime
processes input against the prompt using a configured subsystem (cursor,
claude).

**Function/code-based agents**: Write a Node.js handler in `index.js` that
receives HTTP requests and returns structured output. Has access to runtime
globals (AgentStorage, AgentTools, AgentSession, etc.).

Agents are deployed as Cloud Functions (Gen2) with HTTP triggers.

Agent folder structure:

```
default-registry/agents/<id>/<version>/
  agent.json           # Deployment manifest (id, version, entryPoint, secrets, triggers)
  index.js             # Function handler
  prompt.md            # Agent prompt (prompt-based agents)
  package.json         # Node.js dependencies
```

### Registry

The registry contains four entity types:

| Entity | Deployable To          | Storage                                       |
| ------ | ---------------------- | --------------------------------------------- |
| Agents | Cloud Functions (Gen2) | DB + GCS + filesystem                         |
| Tools  | DB + GCS               | Executable scripts/binaries invoked via stdio |
| Skills | DB                     | Knowledge and instructions for agents         |
| Rules  | DB                     | Behavioral rules and constraints for agents   |

Each entity type uses versioned folders with a JSON manifest and README with
YAML frontmatter. Entities are private by default; use `--public` to publish to
the shared public registry (admin-only when protected).

### Tenants

Tenants are isolated logical environments. Two are created automatically:

- **development** (default) — shared staging environment for non-admin users
- **production** — admin-only, used for live deployments

Each tenant has its own SQLite database, GCS backup path, and deployed
resources. Registries are NOT shared between tenants, but items can be copied
across tenants using `ar copy` (except storage files and secrets).

Select a tenant:

```
--tenant <name>     # any named tenant
--production        # shortcut for --tenant production
```

Care should be taken in the development tenant since it is shared among
non-admin users. Only admins can make destructive changes to the control plane.

### Modes

| Mode   | When                                 | Behavior                                |
| ------ | ------------------------------------ | --------------------------------------- |
| Local  | Default (no control plane)           | Uses `gcloud` CLI + local SQLite        |
| Remote | After `ar connect` or `ar cp deploy` | Operations go through the control plane |
| Server | `AR_MODE=server`                     | Runs the control plane itself           |

### Development Environments

| Environment              | Description                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Local web client         | `npm run dev` in `web/` — Vite dev server with mocked control plane API, no GCP needed  |
| Local dev with remote CP | `npm run dev:remote` in `web/` — Vite dev server proxying to a deployed control plane   |
| Source CLI               | `deno task ar` — run CLI from source against `default-registry/` at repo root           |
| Compiled standalone      | Production `ar` binary with embedded control plane, uses `~/.ar/registry/` for registry |

## GCP Authentication

### Interactive (default)

```bash
gcloud auth login
ar deploy my-agent
```

### Application Default Credentials (CI/non-interactive)

```bash
export AR_AUTH_METHOD=adc
ar deploy my-agent --no-input
```

Works with:

- `GOOGLE_APPLICATION_CREDENTIALS` pointing to a service account key
- GCE/Cloud Run metadata server (automatic on GCP)
- Workload Identity Federation (GitHub Actions OIDC)

### GitHub Actions OIDC

Recommended for CI. Uses Workload Identity Federation — no stored credentials.

Required GitHub repository variables:

| Variable              | Value                                         |
| --------------------- | --------------------------------------------- |
| `WIF_PROVIDER`        | Workload Identity Pool provider resource name |
| `WIF_SERVICE_ACCOUNT` | Service account email                         |
| `GCP_PROJECT`         | GCP project ID                                |
| `GCP_REGION`          | GCP region                                    |
| `AR_RUNTIME_ACCOUNT`  | Same as WIF_SERVICE_ACCOUNT                   |
| `GCP_VPC_CONNECTOR`   | (Optional) VPC connector name                 |

## Commands Reference

### Core Commands

| Command         | Description                                    |
| --------------- | ---------------------------------------------- |
| `ar help`       | Show help                                      |
| `ar version`    | Show version                                   |
| `ar status`     | Registry overview with public/private items    |
| `ar mode`       | Show current mode                              |
| `ar quickstart` | Guided setup: init, control plane, first agent |
| `ar init`       | Initialize the agent registry                  |

Required for `ar init`:

- `--project <id>` (or `AR_PROJECT`)
- `--region <region>` (or `AR_REGION`, default: `northamerica-northeast1`)
- `--runtime-account <email>` (or `AR_RUNTIME_ACCOUNT`)
- `--vpc-connector <name>` (or `AR_VPC_CONNECTOR`, optional)

### Agent Commands

| Command                            | Description                                    |
| ---------------------------------- | ---------------------------------------------- |
| `ar deploy <id>[@version]`         | Deploy an agent (creates if needed)            |
| `ar create <id>[@version]`         | Scaffold a new agent                           |
| `ar run <id> [--data <json>]`      | Invoke a deployed agent                        |
| `ar run --inline <code>`           | Deploy, invoke, and clean up a one-liner agent |
| `ar logs <id>`                     | Fetch agent logs                               |
| `ar list`                          | List deployed agents                           |
| `ar destroy <id>`                  | Destroy an agent                               |
| `ar agent switch <slug> <version>` | Set active version                             |

### Control Plane Commands

| Command            | Description                           |
| ------------------ | ------------------------------------- |
| `ar cp deploy`     | Deploy the control plane to Cloud Run |
| `ar cp destroy`    | Tear down the control plane           |
| `ar connect <url>` | Connect to a remote control plane     |
| `ar disconnect`    | Switch back to local mode             |

### Registry Entity Commands

Each entity type (tool, skill, rule) supports:

| Command                              | Description                        |
| ------------------------------------ | ---------------------------------- |
| `ar <type> create <name> [--public]` | Scaffold entity folder + DB record |
| `ar <type> deploy <slug>`            | Validate, compress, upload to GCS  |
| `ar <type> destroy <slug>`           | Remove from registry DB            |
| `ar <type> list [--public]`          | List entities                      |
| `ar <type> clone <slug>`             | Clone an entity                    |

Where `<type>` is `tool`, `skill`, or `rule`.

### Secrets

| Command                                            | Description                                  |
| -------------------------------------------------- | -------------------------------------------- |
| `ar secret set <name> <value> [--agent <id>]`      | Set a secret (optionally scoped to an agent) |
| `ar secret remove <name> [--agent <id>] [--force]` | Remove a secret                              |
| `ar secret list`                                   | List secrets                                 |

### Triggers

| Command                                              | Description                |
| ---------------------------------------------------- | -------------------------- |
| `ar trigger create <agent-id> --type <cron\|pubsub>` | Create a trigger           |
| `ar trigger remove <agent-id> <name> [--force]`      | Remove a trigger           |
| `ar trigger list <agent-id>`                         | List triggers for an agent |

### Teams and Departments

| Command                                       | Description         |
| --------------------------------------------- | ------------------- |
| `ar team create <name> [--department <dept>]` | Create a team       |
| `ar department create <name>`                 | Create a department |

### Cross-Tenant Copy

| Command                        | Description                                |
| ------------------------------ | ------------------------------------------ |
| `ar copy <slug> --to <tenant>` | Copy agent and dependencies across tenants |

Copies the agent and all dependent registry items (tools, skills, rules). Files
and secrets are NOT automatically copied.

## Global Flags

| Flag                | Effect                                                |
| ------------------- | ----------------------------------------------------- |
| `--registry <path>` | Override registry folder (default: `~/.ar/registry/`) |
| `--tenant <name>`   | Target a specific tenant                              |
| `--production`      | Shortcut for `--tenant production`                    |
| `--public`          | Target the public registry                            |
| `--version <ver>`   | Target a specific agent version                       |
| `--force`           | Skip confirmation prompts                             |
| `--json`            | Output raw JSON                                       |
| `--no-input`        | Disable interactive prompts (auto-enabled in non-TTY) |
| `--settings <path>` | Path to settings file                                 |

## Environment Variables

| Variable               | Purpose                                       |
| ---------------------- | --------------------------------------------- |
| `AR_CONTROL_PLANE_URL` | Control plane URL (enables remote mode)       |
| `AR_REGISTRY`          | Override registry path                        |
| `AR_REGISTRY_CONFIG`   | Explicit path to registry config file         |
| `AR_AUTH_METHOD`       | Auth method: `user` (default) or `adc`        |
| `AR_PROJECT`           | GCP project ID                                |
| `AR_REGION`            | GCP region                                    |
| `AR_RUNTIME_ACCOUNT`   | Runtime account email                         |
| `AR_TENANT`            | Named tenant to target                        |
| `AR_USER`              | Override current user email                   |
| `AR_ADMIN_GROUP`       | Comma-separated admin emails                  |
| `AR_MODE`              | Force mode: `server` starts the control plane |

## Configuration Precedence

Settings are loaded in order (lowest to highest precedence):

1. Defaults from `default-settings.jsonc`
2. Settings file (`~/.ar/settings.jsonc` for production,
   `settings.local.jsonc` when running from source)
3. Environment variables with `AR_` prefix
4. `--settings <path>` flag
5. CLI flags

## Agent Runtime Library

Agent functions have access to these globals:

| Class              | Purpose                                |
| ------------------ | -------------------------------------- |
| `AgentStorage`     | Read/write files to GCS                |
| `AgentTools`       | Execute tools via stdio                |
| `AgentSession`     | Request context (auth, headers, body)  |
| `AgentEnvironment` | Agent metadata (tenant, version, team) |
| `AgentSecurity`    | PII detection and sanitization         |
| `AgentSecrets`     | Secret management                      |
| `AgentAudit`       | Audit trail and structured logging     |

## CI/CD

### GitHub Workflows

The project uses three GitHub Actions workflows:

**CI** (`ci.yml`): Runs on PRs to `main`. Lints, type-checks, and tests. If WIF
credentials are configured, also runs integration tests (deploy control plane,
health check, destroy).

**Release** (`release.yml`): Runs on pushes to `main` with conventional commit
prefixes (`feat:`, `fix:`, `!:` for breaking) or on version tags (`v*.*.*`).
Cross-compiles CLI for Linux and macOS (x64 + arm64), creates a GitHub Release
with binaries, and optionally deploys to production.

**Test** (`test-deno.yml`): Runs on pushes to `main`, tags, and PRs. Builds web
assets, lints, type-checks, and runs tests.

### Conventional Commits

| Prefix              | Bump  |
| ------------------- | ----- |
| `feat:`             | minor |
| `fix:`              | patch |
| `feat!:` or `fix!:` | major |

Include `[skip deploy]` in the commit body to release without deploying to
production.

## Codebase Navigation

When working on this codebase, start by reading the root `README.md`, then
branch into:

- `CONTRIBUTING.md` — development guide, architecture, build pipeline
- `CONFIG.md` — settings, authentication, CI configuration
- `cli/` — CLI commands in `src/commands/`, entry point at `src/cli.ts`
- `sdk-client-deno/` — shared SDK, platform adapters, DB layer, templates
- `control-plane/` — Hono server, API routes, middleware
- `web/` — Preact islands, Vite config, mock API
- `sdk-agent-nodejs/` — Node.js runtime library for agent functions
- `default-registry/` — default tool, skill, and rule definitions

The release build focuses on the CLI as the main entry point since it deploys
everything and embeds the control plane inside it.

## GCP Prerequisites

Before deploying, the user needs:

- A GCP project with these APIs enabled: Cloud Run, Cloud Functions, Cloud
  Build, Secret Manager, Cloud Scheduler
- Two service accounts:
  - `agent-runtime-sp@<project>.iam.gserviceaccount.com` (admin) with roles:
    Cloud Functions Developer, Cloud Run Admin, Run Invoker, Secret Manager
    Admin, Storage Admin, Cloud Scheduler Admin, Service Account User
  - `agent-worker-sp@<project>.iam.gserviceaccount.com` (worker) with roles:
    Run Invoker, Logging Log Writer
- (Optional) A VPC connector if agents need private network access
- The `gcloud` CLI installed and authenticated
