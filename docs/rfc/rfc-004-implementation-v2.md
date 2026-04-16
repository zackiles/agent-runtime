# RFC-004 Implementation Plan — v2

**Status:** Draft
**RFC:** [rfc-004-agent-deploy-modes.md](rfc-004-agent-deploy-modes.md)
**Predecessor:** [rfc-004-implementation.md](rfc-004-implementation.md) (Phase 1 Complete)
**Created:** 2026-04-06

---

## Overview

This plan covers everything remaining from RFC-004 after Phase 1 completion.
Phase 1 established the container-first deploy path, GCS FUSE mounts, async
deploy with polling, automated bucket/AR repo creation, and the thin CLI
client. This plan covers three areas:

1. **Signed URLs** — replace the JSON+base64 storage proxy with direct GCS
   access via time-limited signed URLs
2. **Source mode server-side assembly** — make the source-mode fallback work
   end-to-end via the control plane (currently `storageSource: {}` placeholder)
3. **Cleanup and polish** — strip vendored binaries, update CI/CD, update all
   remaining documentation, display deploy mode in the web dashboard

---

## Phase 2: Signed URLs for Agent Working Storage

Decouple agent working data from the JSON+base64 control plane proxy. Agents
access GCS directly via signed URLs — binary, streaming, no intermediary.

### 2a. `GET /storage/sign` endpoint

**File:** `control-plane/src/api/storage.ts`

Add a new route after the existing `GET /exists`:

```typescript
app.get('/sign', async (c) => {
  const { tenantId } = context(c)
  const bucket = tenantBucket()
  if (!bucket) return c.json({ error: 'Storage not configured' }, 500)

  const path = c.req.query('path')
  const method = c.req.query('method') || 'GET'
  const ttl = Math.min(parseInt(c.req.query('ttl') || '300'), 3600)
  const contentType = c.req.query('contentType') || ''

  if (!path) return c.json({ error: 'path required' }, 400)
  if (method !== 'GET' && method !== 'PUT') {
    return c.json({ error: 'method must be GET or PUT' }, 400)
  }

  const check = validatePath(tenantId, path)
  if (!check.ok) return c.json({ error: check.error }, 403)

  const url = await platform.storageSign(bucket, path, method, ttl, contentType)
  const expires = new Date(Date.now() + ttl * 1000).toISOString()
  return c.json({ url, expires })
})
```

### 2b. `storageSign` in platform adapters

**File:** `sdk-client-deno/src/platform/types.ts`

Add to the `Platform` interface:

```typescript
storageSign(
  bucket: string,
  path: string,
  method: string,
  ttl: number,
  contentType?: string,
): Promise<string>
```

**File:** `sdk-client-deno/src/platform/gcp-rest.ts`

Implement using the IAM `signBlob` API to construct a V4 signed URL:

1. Get the service account email from the metadata server
2. Build the canonical request string per the GCS V4 signing spec
3. Call `POST iam.googleapis.com/v1/projects/-/serviceAccounts/{sa}:signBlob`
   with the string-to-sign
4. Construct the signed URL from the signature

**File:** `sdk-client-deno/src/platform/gcp.ts`

Implement using `gcloud storage sign-url`:

```
gcloud storage sign-url gs://{bucket}/{path} --duration={ttl}s
  --http-verb={method} --headers=Content-Type={contentType}
```

Parse the signed URL from stdout.

**File:** `sdk-client-deno/src/platform/control-plane.ts`

Implement as a thin proxy to the CP:

```typescript
async storageSign(
  _bucket: string,
  path: string,
  method: string,
  ttl: number,
  contentType?: string,
): Promise<string> {
  const params = new URLSearchParams({ path, method, ttl: String(ttl) })
  if (contentType) params.set('contentType', contentType)
  const data = await cpFetch<{ url: string }>(
    `/storage/sign?${params}`,
  )
  return data.url
}
```

### 2c. Update `AgentStorage` to use signed URLs

**File:** `sdk-agent-nodejs/src/storage.ts`

Replace the JSON+base64 `read`/`write`/`readRaw`/`writeRaw`/`push`/`pull`
methods with signed URL flows:

- `read(path)` and `readRaw(path)`: call CP
  `GET /storage/sign?path={fullPath}&method=GET`, then `fetch(signedUrl)` to
  get raw bytes
- `write(path, data)` and `writeRaw(path, data)`: call CP
  `GET /storage/sign?path={fullPath}&method=PUT&contentType=application/octet-stream`,
  then `fetch(signedUrl, { method: 'PUT', body: data })`
- `push(localDir, remotePath)`: iterate files, sign + upload each as binary
- `pull(remotePath, localDir)`: list paths, sign + download each as binary
- `list`, `exists`, `remove`: unchanged (thin CP API calls, no bytes)

The `Raw` variants become aliases since all I/O is now binary. Keep them for
backward compatibility but have them delegate to the same signed URL path.

### 2d. IAM for signed URLs

**File:** `default-settings.jsonc`

`roles/iam.serviceAccountTokenCreator` is already in `runtimeAccountRoles`
(added in Phase 1). No additional IAM changes needed.

### 2e. Deprecate JSON+base64 storage endpoints

**File:** `control-plane/src/api/storage.ts`

Add deprecation comments to `POST /upload` and `GET /download`. They remain
functional for backward compatibility with older agent runtimes but are no
longer used by new deploys.

---

## Phase 3: Source Mode Server-Side Assembly

For teams that choose source mode, move assembly off the client to the control
plane. This makes the source-mode `functionDeploy` in `gcp-rest.ts` actually
work (currently a placeholder).

### 3a. Implement real `functionDeploy` in `gcp-rest.ts`

**File:** `sdk-client-deno/src/platform/gcp-rest.ts`

The current `functionDeploy` has `source: { storageSource: {} }` — an empty
placeholder. Replace with:

1. Compress the assembled source directory into a zip
2. Upload the zip to the GCS bucket
   `gcf-v2-sources-{projectNumber}-{region}` using `storageUpload`
3. Reference it in the Cloud Functions v2 API call:
   `storageSource: { bucket, object, generation }`

The project number is needed (not project ID). Obtain it from the
`cloudresourcemanager.googleapis.com/v1/projects/{projectId}` API.

### 3b. Server-side agent assembly in CP deploy handler

**File:** `control-plane/src/api/agents.ts`, source mode path in
`POST /:id/deploy`

When `deployMode === 'source'`, the deploy handler currently just uploads the
raw source to GCS. It needs to assemble the full deployment package:

1. Download agent source from GCS (`source.tar.gz`)
2. Extract to temp directory
3. Copy runtime lib (`_runtime.cjs`) from the base image or a stored copy in
   GCS at `{bucket}/runtime/_runtime.cjs`
4. Write tool configs (`tool.json`) for each tool from `rc.tools`
5. Copy `install.sh` scripts for each tool
6. Apply the bootstrap wrapper if not already applied (check for
   `const _rt = require` at the start of `index.js`)
7. Compress the assembled package into a zip
8. Upload to the GCS source bucket
9. Call `platform.functionDeploy` with real `storageSource`
10. Wait for operation, store URI in DB

This should also be async (fire-and-forget with status polling) using the
same `DeployStatus` pattern from Phase 1.

---

## Phase 4: Registry Cleanup + Polish

### 4a. Strip binaries from default-registry

**Files to delete:**

- `default-registry/agents/demo-agent/0.0.1/tools/` (vendored tool
  directories — cursor, claude, github, auth0, datadog)
- `default-registry/agents/demo-agent/0.0.1/_runtime.cjs` (pre-bundled
  runtime — now lives in the base image)
- `default-registry/agents/access-agent/0.0.1/tools/` if present

**Files to keep in `default-registry/tools/`:**

- `install.sh` — downloads binary at image build time
- `tool.json` — manifest
- `README.md` — documentation

**LFS cleanup:**

- `default-registry/tools/*/0.0.1/tool` binaries are already absent from the
  tree (LFS pointers only). Remove the LFS tracking rules from
  `.gitattributes` for `default-registry/tools/*/[0-9]*/tool`.
- Keep `sdk-agent-nodejs/bin/*` in LFS (the compiled SDK bundle).
- Run `git lfs untrack 'default-registry/tools/*/[0-9]*/tool'`

### 4b. Embed default-registry in CLI compile

**File:** `cli/scripts/build.ts`, `compileCli()` and `compileControlPlane()`

Add `--include=${REGISTRY_DIR}` alongside the existing `--include` flags.
With binaries stripped (4a), `default-registry/` is <1MB. This allows the
standalone compiled CLI to deploy default agents without a repo checkout.

The `REGISTRY_DIR` path should be resolved from `configDir()` / `registryDir()`
to ensure the embedded path matches what `runtime.ts` resolves at runtime.

### 4c. Web dashboard: deploy mode on System page

**File:** `web/src/islands/system.tsx`

The `/system` API already returns `agents: { deployMode }` (added in Phase 1).
Add a row to the System page that displays it:

- Add `agents` to the `SystemData` type
- Add a row in the GCP or Cloud Run section: "Agent deploy mode: container"
- Style consistently with existing key-value rows

### 4d. `ar registry set agent-deploy-mode`

**Already done in Phase 1.** `agent-deploy-mode` was added to `FIELD_MAP` and
`VALID_SET_OPTIONS` in `cli/src/settings.ts`. No additional work needed.

### 4e. CI matrix for both modes

**File:** `.github/workflows/ci.yml`

Add a matrix strategy to the `integration` job:

```yaml
strategy:
  matrix:
    deploy-mode: [source, container]
```

Pass `AR_AGENT_DEPLOY_MODE=${{ matrix.deploy-mode }}` to the deploy commands.
This ensures both paths are tested on every PR.

### 4f. Release workflow: base image build

**File:** `.github/workflows/release.yml`

Add a step after CLI cross-compilation and before CP deploy:

```yaml
- name: Build and push base agent image
  run: |
    docker build -f Dockerfile.agent-base \
      -t $REGION-docker.pkg.dev/$PROJECT/ar-agents/base:$VERSION .
    docker push $REGION-docker.pkg.dev/$PROJECT/ar-agents/base:$VERSION
```

Remove the manual `Sync registry items to production` loop — `syncRegistry`
inside `ar cp deploy` now handles this via direct HTTP calls.

### 4g. Remaining documentation

The following docs were updated in Phase 1: `README.md`, `CONTRIBUTING.md`,
`CONFIG.md`, `docs/deploying.md`, `AGENTS.md`. The following still need
updates:

**`docs/iam.md`** — Add a "Container Mode IAM" section documenting:

| Role                                   | SA     | Purpose              |
| -------------------------------------- | ------ | -------------------- |
| `roles/artifactregistry.writer`        | Admin  | Push images          |
| `roles/artifactregistry.reader`        | Worker | Pull images          |
| `roles/cloudbuild.builds.editor`       | Admin  | Submit builds        |
| `roles/storage.objectViewer`           | Worker | GCS FUSE read        |
| `roles/secretmanager.secretAccessor`   | Worker | Read mounted secrets |
| `roles/iam.serviceAccountTokenCreator` | Admin  | Sign URLs (Phase 2)  |

**`default-registry/README.md`** — Rewrite the deploy flow section to describe
container-first architecture. Tool binaries are installed via `install.sh` at
base image build time, not vendored in the registry. Agent source is uploaded
to the CP, not assembled locally.

**`default-registry/agents/README.md`** — Update the agent structure section.
Agents no longer bundle `tools/` or `_runtime.cjs`. The handler is wrapped by
the bootstrap at deploy time (or pre-wrapped in the registry). Container mode
uses `agent-host.js` from the base image.

---

## File Change Inventory

### Phase 2

| File                                            | Change                                                |
| ----------------------------------------------- | ----------------------------------------------------- |
| `control-plane/src/api/storage.ts`              | New `GET /sign` endpoint                              |
| `sdk-client-deno/src/platform/types.ts`         | Add `storageSign` to `Platform`                       |
| `sdk-client-deno/src/platform/gcp-rest.ts`      | Implement `storageSign` via IAM `signBlob`            |
| `sdk-client-deno/src/platform/gcp.ts`           | Implement `storageSign` via `gcloud storage sign-url` |
| `sdk-client-deno/src/platform/control-plane.ts` | Implement `storageSign` via CP `GET /storage/sign`    |
| `sdk-agent-nodejs/src/storage.ts`               | Use signed URLs for read/write; deprecate base64      |
| `control-plane/src/api/storage.ts`              | Deprecation comments on upload/download               |

### Phase 3

| File                                       | Change                                            |
| ------------------------------------------ | ------------------------------------------------- |
| `sdk-client-deno/src/platform/gcp-rest.ts` | Implement real `functionDeploy` with GCS upload   |
| `control-plane/src/api/agents.ts`          | Source mode: async server-side assembly in deploy |

### Phase 4

| File                                                    | Change                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `default-registry/agents/demo-agent/0.0.1/tools/`       | Delete vendored tools                                       |
| `default-registry/agents/demo-agent/0.0.1/_runtime.cjs` | Delete pre-bundled runtime                                  |
| `default-registry/agents/access-agent/0.0.1/tools/`     | Delete vendored tools                                       |
| `.gitattributes`                                        | Remove LFS rules for `default-registry/tools/*/[0-9]*/tool` |
| `cli/scripts/build.ts`                                  | Add `--include=${REGISTRY_DIR}` to compile                  |
| `web/src/islands/system.tsx`                            | Display `agents.deployMode`                                 |
| `.github/workflows/ci.yml`                              | Test matrix for both deploy modes                           |
| `.github/workflows/release.yml`                         | Base image build + push step                                |
| `docs/iam.md`                                           | Add container mode IAM roles section                        |
| `default-registry/README.md`                            | Rewrite for container-first deploy                          |
| `default-registry/agents/README.md`                     | Update agent structure for both modes                       |
