# Registry

The registry is the local filesystem structure where agents and their
dependencies (tools, skills, rules) are authored and managed before being
deployed to the remote runtime. It serves as the working directory for all
registry entities.

## Structure

```
default-registry/
  agents/                # Agent source code and manifests
  tools/                 # Tool executables, manifests, and install scripts
  skills/                # Skill definitions (DB-only for now)
  rules/                 # Rule definitions (DB-only for now)
```

SQLite databases are stored separately in the `data/` directory at the AR home
root (not inside the registry). See the path resolution table in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Entity Types

| Entity                     | File-Based   | Versioned    | Deployable                                        | Details                                      |
| -------------------------- | ------------ | ------------ | ------------------------------------------------- | -------------------------------------------- |
| [Agents](agents/README.md) | Yes          | Yes (semver) | Cloud Run (container) or Cloud Functions (source) | Full lifecycle: create, deploy, run, destroy |
| [Tools](tools/README.md)   | Yes          | Yes (semver) | DB record (GCS planned)                           | Executables invoked by agents via stdio      |
| [Skills](skills/README.md) | No (planned) | No (planned) | DB record only                                    | Reusable capabilities attached to agents     |
| [Rules](rules/README.md)   | No (planned) | No (planned) | DB record only                                    | Constraints and policies for agents          |

See each entity's README for its folder structure, manifest format, and
available commands.

## How the Registry Is Used

The registry supports three operational contexts. The entity folder structure
and CLI commands are the same across all three — what differs is the registry
path, who runs the commands, and which visibility (public vs private) is
targeted.

### 1. Local Development from Source

When working on the codebase itself using `deno task ar`, the registry path
defaults to `default-registry/` at the repo root.

```bash
cd cli
deno task ar tool create my-tool
deno task ar agent deploy my-agent
```

This is the workflow for contributors developing the runtime, its default
entities, or experimenting with new ones. Changes to tool folders in
`default-registry/tools/` are reflected immediately.

The `default-registry/` folder is the **public registry source of truth** — it
contains the default agents, tools, skills, and rules that ship with the product.
These are checked into git and deployed to every tenant's public registry during
CI release. User-created agents written to `default-registry/agents/` during
local development are gitignored by default; only default agents with explicit
`.gitignore` exceptions (e.g. `!default-registry/agents/demo-agent/`) are tracked.

### 2. Standalone CLI with a Custom Registry

End users with the compiled `ar` binary work against `~/.ar/registry/` by
default (or a custom path via `--registry` or `AR_REGISTRY`). No source code is
needed.

```bash
ar init
ar quickstart
ar tool create my-tool
ar agent deploy my-agent
```

Users author registry entities in their local registry folder, then deploy them.
This is the primary workflow for creating and managing private registry
entities.

### 3. CI Pipeline

The release workflow (`.github/workflows/release.yml`) uses the compiled release
binary to deploy public registry entities from the `default-registry/` folder to the
`production` tenant on every release. CI will:

- Deploy the control plane (update in-place)
- Deploy all tools, skills, and rules from `default-registry/` to the public registry
- Only add new items or new versions — nothing is removed

This enables a contribution workflow where users experiment locally with private
entities, then open a pull request to promote them to the public registry. See
the [main README](../README.md) for more on the contribution model.

## Private vs Public Registries

Every tenant has both a private and public registry. Visibility is controlled
per entity.

|                | Private                                   | Public                                    |
| -------------- | ----------------------------------------- | ----------------------------------------- |
| Default        | Yes — all entities are private by default | No — requires `--public` flag             |
| Who can create | Any authenticated user                    | Admins only (when tenant is protected)    |
| Who can see    | Owner only                                | All users in the tenant                   |
| Typical use    | Personal/experimental entities            | Shared, vetted, production-ready entities |
| CI deploys to  | No — CI skips private registries          | Yes — CI deploys public entities          |

Use `--public` with `create` commands to publish to the public registry:

```bash
ar tool create my-tool --public
```

The `promote` operation (available via the control plane API) can move a private
entity to public without re-creating it.

## Deployment Flow

### Agents

Deployment is **container-first**: `ar agent deploy` uses container mode unless
you opt into source mode.

**Container mode (default):** The CLI uploads only agent source (on the order of
~5KB) to the control plane. The shared **base image** already includes the Node
runtime, HTTP bootstrap (`sdk-agent-nodejs/agent-host.js`), and **all tool binaries**. Those
binaries are installed by each tool's `install.sh` when the base image is built;
they are not vendored in the registry next to agents. The CP builds a thin
image on that base and deploys a **Cloud Run** service. Rules and skills are
available at runtime via **GCS FUSE**; secrets come from Secret Manager. Deploys
complete in roughly ~30 seconds.

**Source mode (fallback):** The control plane assembles the full deployment
package server-side (runtime, tools, and agent source) and deploys it as a
**Cloud Function** (Gen2). This path is slower (on the order of minutes).

See [agents/README.md](agents/README.md) and
[docs/container-builds.md](../docs/container-builds.md) for details.

```bash
ar agent deploy my-agent
```

### Tools, Skills, and Rules

Currently, `ar tool create` (and `ar skill create`, `ar rule create`) writes a
database record only. If a tool folder exists in the registry, its manifest is
validated and stored in the record's `config` field.

A unified deployment mechanism that compresses entity folders, uploads them to
GCS via the control plane, and makes them available to agents at runtime is
planned. See `TODO.md` #4.

## The Control Plane

The registry requires a deployed control plane for remote operations. The
control plane is a Hono HTTP server deployed to Cloud Run that provides the JSON
API backing all registry operations.

```bash
ar cp deploy       # deploy the control plane
ar connect <url>   # connect CLI to an existing control plane
ar disconnect      # switch back to local mode
```

Without a control plane, the CLI operates in **local mode** — shelling out to
`gcloud` directly and using a local SQLite database. After deploying or
connecting to a control plane, the CLI operates in **remote mode** — routing
operations through the control plane API.

See the [main README](../README.md) for the full command reference and
[CONTRIBUTING.md](../CONTRIBUTING.md) for architecture details on modes and
platform adapters.

## Quickstart

The fastest path from zero to a running agent:

```bash
ar quickstart
```

This interactively walks through: GCP project configuration, control plane
deployment, and creating + deploying your first agent. Equivalent to:

```bash
ar init                    # configure GCP project
ar cp deploy               # deploy the control plane
ar agent deploy my-agent   # scaffold and deploy an agent
```

`ar deploy <name>` is also a shortcut that runs the full setup if no registry
exists yet.

## Gotchas

- **User agent folders are gitignored; default agents are not.**
  `default-registry/agents/*/` is gitignored so user-created agents stay local. Default
  agents (demo-agent, access-agent) have explicit `.gitignore` exceptions and
  ARE checked into version control. If you delete a user agent's local folder,
  the deployed service (Cloud Run in container mode, or a Cloud Function in
  source mode) still exists but the local source is not recoverable from GCP
  (the staging bucket is ephemeral). Default agent source
  is always recoverable from git.

- **Tool binaries are not bundled inside agent folders.** In container mode,
  executables live in the shared base image (`install.sh` at image build time).
  Registry `tools/` still holds manifests and install scripts for authoring and
  for building that image; `ar tool create` records tool metadata in the
  database so the system can resolve and invoke tools by name.

- **Skills and rules are DB-only.** They have no filesystem representation yet.
  The `default-registry/skills/` and `default-registry/rules/` folders exist as placeholders for
  the planned file-based specification.

- **Local and remote DBs can diverge.** In remote mode, some operations still
  write to the local SQLite database. The DB sync mechanism exists in code but
  is not yet active. Treat the remote control plane as the source of truth when
  connected.

- **`--public` requires admin on protected tenants.** If the tenant's
  `registry_protected` flag is set, only admins (via `is_admin` in the DB or
  `AR_ADMIN_GROUP` env var) can publish to the public registry. On unprotected
  tenants, anyone can publish.

- **Default tools are seeded automatically.** Five tools (cursor, claude,
  github, auth0, datadog) are inserted into every tenant's public registry on
  first database initialization. Their definitions live in
  [tools/](tools/README.md).
