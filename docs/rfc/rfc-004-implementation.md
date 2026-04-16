# RFC-004 Implementation Plan

**Status:** Phase 1 Complete
**RFC:** [rfc-004-agent-deploy-modes.md](rfc-004-agent-deploy-modes.md)
**Next:** [rfc-004-implementation-v2.md](rfc-004-implementation-v2.md) (Phases 2-4)
**Created:** 2026-04-05
**Updated:** 2026-04-06

---

## Overview

This document is the implementation plan for RFC-004. It breaks the work into
four phases ordered by dependency and impact. Phase 1 eliminates the OOM
problem and establishes the container-first architecture. Subsequent phases
add signed URL support, source mode server-side assembly, and polish.

---

## Phase 1: Container Images + GCS FUSE

Establish the primary deploy path. Agents deploy as Cloud Run services from
container images. Tool binaries are baked into a shared base image. Rules and
skills are served via GCS FUSE volume mounts. The CLI becomes a thin client.

### 1a. Fix the storage download spread bug

**File:** `control-plane/src/api/storage.ts` (line 65)

The `GET /download` handler uses `btoa(String.fromCharCode(...data))` which
overflows the call stack on any file larger than ~64KB. Replace with a chunked
approach matching the pattern already used in `control-plane.ts`:

```typescript
const chunks: string[] = []
for (let i = 0; i < data.length; i += 0x8000) {
  chunks.push(String.fromCharCode(
    ...data.subarray(i, i + 0x8000),
  ))
}
const encoded = btoa(chunks.join(''))
```

This is a prerequisite bugfix — the JSON+base64 endpoint will be deprecated in
Phase 2 but must not crash in the interim.

### 1b. `Dockerfile.agent-base`

**New file:** `Dockerfile.agent-base` at repo root

```dockerfile
FROM node:22-slim
WORKDIR /app

COPY sdk-agent-nodejs/bin/index.cjs /app/runtime/_runtime.cjs
COPY default-registry/tools/ /tmp/tools/

RUN for d in /tmp/tools/*/0.0.1/; do \
      if [ -f "$d/install.sh" ]; then \
        TOOLS_DIR="/app/tools/$(basename $(dirname $(dirname $d)))" \
        mkdir -p "$TOOLS_DIR" && \
        cp "$d/tool.json" "$TOOLS_DIR/" 2>/dev/null; \
        cp "$d/install.sh" "$TOOLS_DIR/" && \
        cd "$TOOLS_DIR" && sh install.sh && cd /app; \
      fi; \
    done && rm -rf /tmp/tools

COPY sdk-agent-nodejs/agent-host.js /app/runtime/agent-host.js
```

**New file:** `sdk-agent-nodejs/agent-host.js` — a minimal HTTP server that
loads `_runtime.cjs`, wraps the agent handler, and listens on `$PORT`.

The `install.sh` scripts for cursor, claude, github, auth0, and datadog each
download and install their respective binaries into `/app/tools/{slug}/`. The
install scripts already exist in `default-registry/tools/`.

### 1c. Add deploy mode setting

**Files:**

- `cli/src/settings.ts`: add `agentDeployMode?: 'source' | 'container'` to
  `GcpSettings`
- `default-settings.jsonc`: add
  `agents: { deployMode: "container", baseImage: "node:22-slim", artifactRepo: "ar-agents" }`
- `sdk-client-deno/src/runtime.ts`: add `agents` to `RuntimeConfig` type
- Control plane reads mode from runtime config; defaults to `container`

### 1d. Mode prompt in `ar cp deploy`

**File:** `cli/src/commands/control-plane.ts`, `deploy()`, before the deploy
confirmation

- Check if `agentDeployMode` is set in settings
- If not, prompt with two options (container recommended, source fallback)
- Save the choice via `save({ agentDeployMode: choice })`
- `--no-input` defaults to `container` unless `--agent-deploy-mode=source` or
  `AR_AGENT_DEPLOY_MODE=source` is set

### 1e. Base image build in `ar cp deploy`

**File:** `cli/src/commands/control-plane.ts`, `deploy()`, after saving the URL

- If `agentDeployMode === 'container'`:
  1. Check if `ar-agents` Artifact Registry repo exists
     (`gcloud artifacts repositories describe`)
  2. If not, create it (`gcloud artifacts repositories create`)
  3. Build the base image:
     `docker build -f Dockerfile.agent-base -t {region}-docker.pkg.dev/{project}/ar-agents/base:{version} .`
  4. Push it:
     `docker push {region}-docker.pkg.dev/{project}/ar-agents/base:{version}`
  5. If Docker is not available, fall back to submitting via Cloud Build API

### 1f. Container deploy path in control plane

**File:** `control-plane/src/api/agents.ts`, `POST /:id/deploy`

- Read `agents.deployMode` from runtime config
- If `container`:
  1. Download agent source from GCS (`source.tar.gz`)
  2. Write an inline Dockerfile:
     `FROM base:{version}\nCOPY source /app/agent/\nENV AR_AGENT_SLUG={slug}`
  3. Submit Cloud Build request (Cloud Build API `projects.builds.create`)
     with the inline Dockerfile + source from GCS
  4. Wait for build completion
  5. Deploy via Cloud Run Admin API:
     `POST run.googleapis.com/v2/.../services` with
     `template.containers[0].image = {per-agent-image}` and GCS FUSE volume
     mount configuration (see 1g)
  6. Wait for service ready
  7. Store URI in DB

### 1g. GCS FUSE volume mount on Cloud Run services

**File:** `control-plane/src/api/agents.ts` (container deploy path) and
`control-plane/src/api/demos/deploy.ts` (demo container deploy)

When creating or updating a Cloud Run service, include GCS FUSE volume
configuration in the service spec:

```typescript
const serviceBody = {
  template: {
    volumes: [{
      name: 'registry',
      gcs: {
        bucket: `${cfg.project}-ar-registry`,
        readOnly: true,
      },
    }],
    containers: [{
      image: perAgentImage,
      volumeMounts: [{
        name: 'registry',
        mountPath: '/registry',
        readOnly: true,
      }],
      // ... ports, env, resources
    }],
  },
}
```

This gives every agent read-only access to the entire registry bucket at
`/registry/`. Rules are at `/registry/{tenantId}/rules/...`, skills at
`/registry/{tenantId}/skills/...`.

### 1h. New CP route: `POST /agents/:id/source`

**File:** `control-plane/src/api/agents.ts`

- Add a new route that accepts a binary body (tar.gz of agent source files)
- Store to GCS at `{tenant}/agents/{slug}/{version}/source.tar.gz`
- Return `{ gcsPath }` on success
- This replaces the client-side `compress(resolvedDir)` + `storageUpload`
  pattern

### 1i. Container deploy in platform adapters

**Files:**

- `sdk-client-deno/src/platform/gcp.ts`: add `containerDeploy` that runs
  `gcloud run deploy --image={image} --port=8080 --no-allow-unauthenticated`
- `sdk-client-deno/src/platform/gcp-rest.ts`: add `containerDeploy` using
  Cloud Run Admin API v2 (`run.googleapis.com`) with FUSE volume configuration
- `sdk-client-deno/src/platform/types.ts`: add
  `containerDeploy(opts: ContainerDeployOptions): Promise<void>` to `Platform`
  interface

### 1j. Make CLI a thin client for agent deploy

**File:** `cli/src/commands/agent.ts` (lines 434-571)

Rewrite `deploy()`:

- Remove `bundleRuntime()` call (line 525)
- Remove `bundleTools()` call (line 526)
- Remove the `platform.functionDeploy()` call (line 549)
- Remove the post-deploy `compress(resolvedDir)` backup (lines 561-568)
- New flow: compress agent source only (index.js, agent.json, package.json,
  prompt.md) -> upload via `POST /agents/:id/source` -> trigger
  `POST /agents/:id/deploy` -> poll for completion -> update local manifest
  with URI

### 1k. Simplify `syncRegistry`

**File:** `cli/src/commands/control-plane.ts` (lines 540-628)

- Replace subprocess spawning with direct HTTP calls to the control plane API
- Tools/skills/rules: `POST /{type}s` with manifest JSON (already works)
- Agents: `POST /api/agents` to create record + upload source via
  `POST /agents/:id/source` + trigger `POST /agents/:id/deploy`
- No child processes, no `Deno.Command`, no OOM risk

### 1l. Update `AgentTools` for container mode

**File:** `sdk-agent-nodejs/src/tools.ts`

- In `resolveBinary`, check `/app/tools/{slug}/tool` first (container mode
  path) before falling back to the configured `toolsDir`
- The `install.sh` fallback remains but should never trigger in container mode
  since binaries are baked into the image

### 1m. Update runtime to read rules/skills from FUSE mount

**File:** `sdk-agent-nodejs/src/` (new capability)

- If `/registry/` exists and is a directory, read rules from
  `/registry/{tenantId}/rules/{slug}/{version}/` and skills from
  `/registry/{tenantId}/skills/{slug}/{version}/` using filesystem operations
- If `/registry/` does not exist (source mode), fall back to CP API calls
- The tenant ID is available via `process.env.AR_TENANT_ID`

### 1n. IAM updates

**File:** `cli/src/commands/control-plane.ts`, `ensureRoles()`

- Add `roles/artifactregistry.writer` and `roles/cloudbuild.builds.editor` to
  admin SA for container mode
- Add `roles/artifactregistry.reader` and `roles/storage.objectViewer` to
  worker SA for container mode (image pull + FUSE mount)
- Update `default-settings.jsonc` with the full role list

### 1o. Agent destroy for container mode

**Files:** `control-plane/src/api/agents.ts` DELETE handler,
`cli/src/commands/agent.ts` destroy function

- Container mode: `Cloud Run Admin API DELETE /services/{name}` + optionally
  delete the image from Artifact Registry
- Source mode: `Cloud Functions v2 API DELETE /functions/{name}` (existing)
- CLI calls `DELETE /agents/:id`; the control plane dispatches by mode

---

## Phase 2: Signed URLs for Agent Working Storage

Decouple agent working data from the JSON+base64 control plane proxy.

### 2a. `GET /storage/sign` endpoint

**File:** `control-plane/src/api/storage.ts`

- New route that accepts `path`, `method` (GET/PUT), `ttl`, and optional
  `contentType`
- Validates tenant scope using existing `validatePath`
- Generates a signed URL using the IAM `signBlob` API:
  `POST iam.googleapis.com/v1/projects/-/serviceAccounts/{sa}:signBlob`
- Returns `{ url, expires }` as JSON

### 2b. `storageSign` in platform adapters

**Files:**

- `sdk-client-deno/src/platform/types.ts`: add
  `storageSign(bucket, path, method, ttl): Promise<string>` to `Platform`
- `sdk-client-deno/src/platform/gcp-rest.ts`: implement using IAM
  `signBlob` API
- `sdk-client-deno/src/platform/gcp.ts`: implement using
  `gsutil signurl`
- `sdk-client-deno/src/platform/control-plane.ts`: implement using
  `GET /storage/sign` on the CP

### 2c. Update `AgentStorage` to use signed URLs

**File:** `sdk-agent-nodejs/src/storage.ts`

- `read(path)`: call CP `GET /storage/sign?method=GET`, then `fetch(signedUrl)`
  to get raw bytes
- `write(path, data)`: call CP `GET /storage/sign?method=PUT`, then
  `fetch(signedUrl, { method: 'PUT', body: data })`
- `push(localDir, remotePath)`: iterate files, sign + upload each
- `pull(remotePath, localDir)`: list, sign + download each
- `list`, `exists`, `remove`: unchanged (thin CP API calls, no bytes)

### 2d. IAM for signed URLs

**File:** `cli/src/commands/control-plane.ts`, `ensureRoles()`

- Add `roles/iam.serviceAccountTokenCreator` to admin SA (needed for
  `signBlob` API)

### 2e. Deprecate JSON+base64 storage endpoints

- Mark `POST /storage/upload` and `GET /storage/download` as deprecated in
  code comments
- They remain functional for backward compatibility with older agent runtimes
  but are no longer used by new deploys

---

## Phase 3: Source Mode Server-Side Assembly

For teams that choose source mode, move assembly off the client to the control
plane.

### 3a. Implement real `functionDeploy` in `gcp-rest.ts`

**File:** `sdk-client-deno/src/platform/gcp-rest.ts` (line 267 has
`storageSource: {}`)

- Upload the assembled source zip to the GCS bucket
  `gcf-v2-sources-{projectNumber}-{region}`
- Reference it in the Cloud Functions v2 API call:
  `storageSource: { bucket, object, generation }`

### 3b. Server-side agent assembly in CP deploy handler

**File:** `control-plane/src/api/agents.ts`, source mode path in
`POST /:id/deploy`

- Download agent source from GCS (`source.tar.gz`)
- Extract to temp directory
- Copy runtime lib (`_runtime.cjs`) from a stored copy in GCS
- Write tool configs (tool.json) for each tool
- Copy `install.sh` scripts for each tool (they run during Cloud Build)
- Apply the bootstrap wrapper if not already applied
- Compress the assembled package
- Upload to GCS source bucket
- Call `platform.functionDeploy` with real `storageSource`
- Wait for operation, store URI in DB

---

## Phase 4: Registry Cleanup + Polish

### 4a. Strip binaries from default-registry

- Delete `default-registry/agents/demo-agent/0.0.1/tools/` (vendored tools)
- Delete `default-registry/agents/demo-agent/0.0.1/_runtime.cjs`
- Delete `default-registry/agents/access-agent/0.0.1/tools/` if present
- Delete LFS-tracked `default-registry/tools/*/0.0.1/tool` binaries (keep
  `install.sh`, `tool.json`, `README.md`)
- Run `git lfs untrack` on the patterns in `.gitattributes`

### 4b. Embed default-registry in CLI compile

**File:** `cli/scripts/build.ts`, `compileCli()`

- Add `--include=${REGISTRY_DIR}` alongside `--include=${CP_ARCHIVE}` and
  `--include=${RUNTIME_CONFIG}`
- With binaries stripped, `default-registry/` is <1MB

### 4c. Web dashboard: deploy mode on System page

**Files:**

- `web/src/islands/system.tsx`: show `agentDeployMode` from the `/system` API
  response
- `control-plane/src/api/system/routes.ts`: `GET /system/` includes
  `agents: { deployMode }` in the response

### 4d. `ar registry set agent-deploy-mode`

**File:** `cli/src/commands/registry.ts`

Add `agent-deploy-mode` to `VALID_SET_OPTIONS` and `FIELD_MAP`. Changing the
mode triggers a re-deploy of all agents on the next `ar cp deploy`.

### 4e. CI matrix for both modes

**File:** `.github/workflows/ci.yml`

```yaml
strategy:
  matrix:
    deploy-mode: [source, container]
```

### 4f. Release workflow: base image build

**File:** `.github/workflows/release.yml`

- Add a step that builds and pushes the base agent image on every release
- Remove the manual `Sync registry items to production` loop (now handled by
  `syncRegistry` inside `ar cp deploy`)

### 4g. Update documentation

All files listed in RFC section 17 "Documentation":

- `README.md`: update deploy commands, add mode documentation
- `CONTRIBUTING.md`: update Agent Functions section, remove LFS instructions
- `CONFIG.md`: add deploy mode settings, update IAM roles
- `docs/deploying.md`: document both modes
- `docs/iam.md`: add container mode roles, FUSE roles, signed URL roles
- `default-registry/README.md`: update deploy flow
- `default-registry/agents/README.md`: update for both modes
- `AGENTS.md`: reference this RFC

---

## File Change Inventory

### Phase 1

| File                                            | Change                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `control-plane/src/api/storage.ts`              | Fix spread bug on line 65                                                |
| `Dockerfile.agent-base` (new)                   | Base agent image with runtime + tool binaries                            |
| `sdk-agent-nodejs/agent-host.js` (new)          | Agent HTTP host for container mode                                       |
| `cli/src/settings.ts`                           | Add `agentDeployMode` to `Settings` and `GcpSettings`                    |
| `default-settings.jsonc`                        | Add `agents` config block with container as default                      |
| `sdk-client-deno/src/runtime.ts`                | Add `agents` to `RuntimeConfig` type                                     |
| `cli/src/commands/control-plane.ts`             | Mode prompt; base image build; AR repo creation; simplify `syncRegistry` |
| `control-plane/src/api/agents.ts`               | New `POST /:id/source`; rewrite `POST /:id/deploy` with container path   |
| `control-plane/src/api/demos/deploy.ts`         | Add GCS FUSE volume mount to demo container service spec                 |
| `sdk-client-deno/src/platform/types.ts`         | Add `ContainerDeployOptions` and `containerDeploy` to `Platform`         |
| `sdk-client-deno/src/platform/gcp.ts`           | Add `containerDeploy` (`gcloud run deploy --image`)                      |
| `sdk-client-deno/src/platform/gcp-rest.ts`      | Add `containerDeploy` (Cloud Run Admin API with FUSE config)             |
| `sdk-client-deno/src/platform/control-plane.ts` | `functionDeploy` -> upload source + trigger CP deploy                    |
| `cli/src/commands/agent.ts`                     | Remove `bundleRuntime`/`bundleTools`; thin client flow                   |
| `sdk-agent-nodejs/src/tools.ts`                 | Resolve from `/app/tools/` in container mode                             |
| `sdk-agent-nodejs/src/` (new)                   | Rules/skills filesystem reader with FUSE fallback                        |

### Phase 2

| File                                            | Change                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| `control-plane/src/api/storage.ts`              | New `GET /sign` endpoint for signed URLs                  |
| `sdk-client-deno/src/platform/types.ts`         | Add `storageSign` to `Platform`                           |
| `sdk-client-deno/src/platform/gcp-rest.ts`      | Implement `storageSign` via IAM `signBlob`                |
| `sdk-client-deno/src/platform/gcp.ts`           | Implement `storageSign` via `gsutil signurl`              |
| `sdk-client-deno/src/platform/control-plane.ts` | Implement `storageSign` via CP `GET /storage/sign`        |
| `sdk-agent-nodejs/src/storage.ts`               | Use signed URLs for read/write; deprecate base64 path     |
| `cli/src/commands/control-plane.ts`             | Add `serviceAccountTokenCreator` role to IAM provisioning |

### Phase 3

| File                                       | Change                                                            |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `sdk-client-deno/src/platform/gcp-rest.ts` | Implement real `functionDeploy` (GCS upload + Cloud Functions v2) |
| `control-plane/src/api/agents.ts`          | Source mode: server-side assembly in deploy handler               |

### Phase 4

| File                                           | Change                                            |
| ---------------------------------------------- | ------------------------------------------------- |
| `default-registry/agents/*/0.0.1/tools/`       | Delete vendored tool directories                  |
| `default-registry/agents/*/0.0.1/_runtime.cjs` | Delete pre-bundled runtime                        |
| `default-registry/tools/*/0.0.1/tool`          | Delete LFS-tracked binaries                       |
| `.gitattributes`                               | Remove LFS tracking rules                         |
| `cli/scripts/build.ts`                         | Add `--include=${REGISTRY_DIR}` to CLI compile    |
| `web/src/islands/system.tsx`                   | Display deploy mode                               |
| `control-plane/src/api/system/routes.ts`       | Include `agents.deployMode` in `/system` response |
| `cli/src/commands/registry.ts`                 | Add `agent-deploy-mode` to `VALID_SET_OPTIONS`    |
| `.github/workflows/ci.yml`                     | Test matrix for both modes                        |
| `.github/workflows/release.yml`                | Base image build + push; simplify sync step       |
| `README.md`                                    | Update deploy commands, add mode docs             |
| `CONTRIBUTING.md`                              | Remove LFS instructions, update deploy flow       |
| `CONFIG.md`                                    | Add deploy mode settings, update IAM roles        |
| `docs/deploying.md`                            | Document both modes                               |
| `docs/iam.md`                                  | Add container, FUSE, and signed URL roles         |
| `default-registry/README.md`                   | Update deploy flow                                |
| `default-registry/agents/README.md`            | Update for both modes                             |
| `AGENTS.md`                                    | Reference this RFC                                |
