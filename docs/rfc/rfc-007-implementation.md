# RFC-007 Implementation Plan

**Status:** Complete
**RFC:** [rfc-007-demo-serve-architecture.md](rfc-007-demo-serve-architecture.md)
**Created:** 2026-04-08

---

## Overview

This document is the execution plan for RFC-007. It breaks the work into five
phases ordered by dependency. Phase 0 fixes pre-existing bugs that would
otherwise cause test failures during implementation. Phase 1 builds the archive
upload and Cloud Build pipeline. Phase 2 adds stack detection and Dockerfile
generation. Phase 3 manages Artifact Registry lifecycle. Phase 4 covers
documentation and tests.

Since the demo system is not yet in production, there is no migration path,
feature flag, or backward-compatibility layer. The old FUSE-based code is
replaced outright.

Each step lists the exact files to change, the change to make, and
verification criteria.

---

## Phase 0: Pre-requisite Bug Fixes

These are existing bugs that should be fixed before the archive path lands.
They can ship as a standalone cleanup PR.

### 0a. Add exclusions to `walkDir`

**File:** `sdk-agent-nodejs/src/storage.ts` (lines 213–224)

Add a skip set to `walkDir` so it never recurses into directories that should
not be uploaded:

```typescript
private static SKIP = new Set([
  'node_modules', '.git', '.env', '.cache', '.next',
])

private walkDir(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (AgentStorage.SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...this.walkDir(full))
    } else {
      results.push(full)
    }
  }
  return results
}
```

**Verification:** Create a sandbox with a `node_modules/` directory containing
a file. Call `pushRaw`. Verify the file inside `node_modules` is not uploaded
(check GCS listing or mock the `writeRaw` call).

### 0b. Fix binary file corruption in `readRaw`/`pullRaw`/`pushRaw`

**File:** `sdk-agent-nodejs/src/storage.ts`

Three changes:

1. `readRaw` (line 166): return `Buffer` instead of string.

```typescript
async readRaw(rawPath: string): Promise<Buffer> {
  const url = await this.sign(rawPath, "GET");
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to read ${rawPath}: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
```

2. `pullRaw` (line 175): write as `Buffer`.

```typescript
async pullRaw(remotePath: string, localDir: string): Promise<void> {
  const files = await this.listRaw(remotePath);
  fs.mkdirSync(localDir, { recursive: true });
  for (const file of files) {
    const relative = file.slice(
      file.indexOf(remotePath) + remotePath.length + 1,
    );
    if (!relative) continue;
    const dest = path.join(localDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const data = await this.readRaw(file);
    fs.writeFileSync(dest, data);
  }
}
```

3. `pushRaw` (line 204): read without encoding, upload as `Buffer`.

```typescript
async pushRaw(localDir: string, remotePath: string): Promise<void> {
  const entries = this.walkDir(localDir);
  for (const filePath of entries) {
    const relative = path.relative(localDir, filePath);
    const data = fs.readFileSync(filePath);
    await this.writeRaw(`${remotePath}/${relative}`, data);
  }
}
```

Update `writeRaw` signature to accept `string | Buffer`.

**Verification:** Create a sandbox with a PNG file. Push via `pushRaw`, pull
via `pullRaw`. Compare the pulled file byte-for-byte with the original
(`Buffer.compare`).

### 0c. Fix shipped demo agent (`index.js`)

**File:** `default-registry/agents/demo-agent/0.0.1/index.js`

Four changes:

1. Replace `AgentStorage.instance.list()` with `listRaw()` (line 24) and
   `AgentStorage.instance.pull()` with `pullRaw()` (line 67).

2. Add `demo.json` write after `pushRaw` (after line 189):

```javascript
try {
  await AgentStorage.instance.writeRaw(
    gcsBase + '/demo.json',
    JSON.stringify(demo, null, 2),
  )
} catch (err) {
  AgentAudit.instance.warn('Meta write failed', {
    error: err.message,
  })
}
```

3. Remove `process.chdir` block (lines 136–153). The subsystem already
   receives `SANDBOX_PATH` in the prompt template, so absolute paths work
   without changing the global cwd.

Replace:

```javascript
const previousCwd = process.cwd()
let result
try {
  process.chdir(sandboxPath)
  result = AgentTools.instance.run(
    subsystem,
    compiled,
    { timeout: 300000 },
  )
} catch (err) {
  // ...
} finally {
  try {
    process.chdir(previousCwd)
  } catch {}
}
```

With:

```javascript
let result
try {
  result = AgentTools.instance.run(
    subsystem,
    compiled,
    { timeout: 300000 },
  )
} catch (err) {
  // ...
}
```

4. Fix the deploy callback (lines 191–214). Change `deployAction` from
   `mode === 'update' ? 'update' : 'deploy'` to always use `'deploy'`. The
   `/update` route expects a `prompt` field and re-invokes the agent — the
   agent should only trigger a redeploy of already-uploaded source.

**Verification:** Deploy the demo agent. Create a demo, then update it.
Verify `demo.json` exists in GCS. Verify the deploy callback returns 200
(not 400).

### 0d. Fix `version` ReferenceError in handler template

**File:** `sdk-client-deno/src/templates/agent-demo.ts` (line 222)

Remove `version: version,` from the audit log object in `HANDLER_TEMPLATE`:

```javascript
AgentAudit.instance.info('Demo archived to storage', {
  slug: demoSlug,
})
```

**Verification:** `deno task check` passes. Deploy a scaffolded demo agent
and verify the archive audit log does not throw.

---

## Phase 1: Archive Upload + Build Pipeline

Replace per-file upload with tarball archive, and add Cloud Build between
upload and Cloud Run deploy. Remove the old FUSE-based serve path entirely.

### 1a. Add `pushArchive` and `pullArchive` to `AgentStorage`

**File:** `sdk-agent-nodejs/src/storage.ts`

Add two new methods. Both use `child_process.spawn` for `tar` to avoid holding
the project tree in Node memory.

```typescript
async pushArchive(localDir: string, remotePath: string): Promise<void> {
  const tmp = path.join(os.tmpdir(), `ar-${Date.now()}.tar.gz`);
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("tar", [
        "-czf", tmp,
        "--exclude", "node_modules",
        "--exclude", ".git",
        "--exclude", ".env",
        "-C", localDir, ".",
      ]);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
      );
      proc.on("error", reject);
    });

    const url = await this.sign(remotePath, "PUT", "application/gzip");
    const stat = fs.statSync(tmp);
    const body = fs.createReadStream(tmp);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(stat.size),
      },
      body,
      duplex: "half",
    } as RequestInit);
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async pullArchive(remotePath: string, localDir: string): Promise<void> {
  const { pipeline } = await import("stream/promises");
  const { Readable } = await import("stream");
  const url = await this.sign(remotePath, "GET");
  fs.mkdirSync(localDir, { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const proc = spawn("tar", ["-xzf", "-", "-C", localDir], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  await pipeline(Readable.fromWeb(res.body as any), proc.stdin);
  await new Promise<void>((resolve, reject) => {
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))
    );
    proc.on("error", reject);
  });
}
```

Add `import * as os from "os"` and `import { spawn } from "child_process"` at
the top of the file.

**Verification:** Unit test: create a temp directory with mixed text and binary
files, call `pushArchive`, then `pullArchive` to a new directory. Compare
file-by-file with `Buffer.compare`. Verify `node_modules` is excluded.

### 1b. Update demo agent to use archive methods

**File:** `default-registry/agents/demo-agent/0.0.1/index.js`

Replace:

```javascript
await AgentStorage.instance.pushRaw(sandboxPath, gcsBase + '/source')
```

With:

```javascript
await AgentStorage.instance.pushArchive(
  sandboxPath,
  gcsBase + '/source.tar.gz',
)
```

Replace the staging pull (inside the `if (existing)` block):

```javascript
await AgentStorage.instance.pullRaw(remoteSrc, sandboxPath)
```

With:

```javascript
await AgentStorage.instance.pullArchive(
  remoteSrc.replace(/\/source$/, '/source.tar.gz'),
  sandboxPath,
)
```

**Verification:** Create a new demo — verify `source.tar.gz` appears in GCS
(not individual files under `source/`). Update an existing demo — verify
archive is downloaded and extracted.

### 1c. Sync handler template

**File:** `sdk-client-deno/src/templates/agent-demo.ts`

Update `HANDLER_TEMPLATE` to mirror the `index.js` changes from 0c, 0d, and
1b. The template generates the handler for newly scaffolded demo agents, so it
must stay in sync with the shipped agent.

Key changes in the template string:

- `pushRaw` → `pushArchive` with `source.tar.gz` path
- `pullRaw` → `pullArchive` with `source.tar.gz` path
- Remove `version: version` from audit log
- Add `writeRaw` for `demo.json`
- Fix deploy callback to always use `/deploy`

**Verification:** `deno task check` passes. Scaffold a new demo agent via the
API and verify the generated `index.js` matches the expected output.

### 1d. Add `cloudBuildSubmit` and `waitForBuild` to platform

**File:** `sdk-client-deno/src/platform/gcp-rest.ts`

Add two functions. These follow the same pattern as the existing inline Cloud
Build logic in `control-plane/src/api/agents.ts` (`runContainerDeploy`) but
extracted as reusable platform methods.

```typescript
async cloudBuildSubmit(opts: {
  project: string
  source: { bucket: string; object: string }
  steps: Array<{
    name: string
    entrypoint?: string
    args: string[]
  }>
  images: string[]
  timeout?: string
}): Promise<string> {
  const token = await this.getAccessToken()
  const url =
    `https://cloudbuild.googleapis.com/v1/projects/${opts.project}/builds`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: { storageSource: opts.source },
      steps: opts.steps,
      images: opts.images,
      timeout: opts.timeout || '300s',
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloud Build submit failed: ${text}`)
  }
  const data = await res.json() as {
    metadata?: { build?: { id?: string } }
  }
  const buildId = data.metadata?.build?.id
  if (!buildId) throw new Error('Cloud Build returned no build ID')
  return buildId
}

async waitForBuild(
  project: string,
  buildId: string,
  timeoutMs = 300_000,
): Promise<{ status: string; logUrl?: string }> {
  const token = await this.getAccessToken()
  const url =
    `https://cloudbuild.googleapis.com/v1/projects/${project}/builds/${buildId}`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (!res.ok) continue
    const data = await res.json() as {
      status?: string
      logUrl?: string
    }
    if (data.status === 'SUCCESS') {
      return { status: 'SUCCESS', logUrl: data.logUrl }
    }
    if (['FAILURE', 'TIMEOUT', 'CANCELLED'].includes(data.status || '')) {
      throw new Error(
        `Cloud Build ${data.status?.toLowerCase()}: ${data.logUrl || ''}`,
      )
    }
  }
  throw new Error('Cloud Build timed out')
}
```

Add these to the `Platform` interface in `types.ts` and to the `gcp.ts` CLI
adapter (can delegate to `gcloud builds submit` or throw "not supported in CLI
mode").

**Verification:** `deno task check` passes. Integration test: submit a trivial
build (echo step) and verify `waitForBuild` returns `SUCCESS`.

### 1e. Rewrite `deployContainer` in control plane

**File:** `control-plane/src/api/demos/deploy.ts`

This is the largest single change. Replace the FUSE-based deploy with a
two-phase build-then-deploy flow. Remove the old FUSE code entirely.

1. Update `serviceName` to include a userId hash:

```typescript
function serviceName(
  tenantId: string,
  userId: string,
  name: string,
): string {
  const hash = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `demo-${tenantId}-${hash}-${name}`
    .slice(0, 63)
    .replace(/-+$/, '')
}
```

2. Add `demoImage` helper:

```typescript
function demoImage(
  cfg: GcpConfig,
  tenantId: string,
  userId: string,
  slug: string,
): string {
  const hash = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8)
  return `${cfg.region}-docker.pkg.dev/${cfg.project}/ar-demos/${tenantId}/${hash}/${slug}:latest`
}
```

3. Add `buildDemo` function that submits Cloud Build with the detect +
   generate + docker build steps from the RFC.

4. Rewrite `deployContainer` to call `buildDemo` first, then deploy the
   resulting image to Cloud Run. Remove FUSE volume mounts, `NODE_PATH` env
   var, and the stock `node:22-slim`/`denoland/deno` image selection. Wait for
   the Cloud Run LRO using `waitForOperation` (already exists in
   `gcp-rest.ts`) instead of polling for URI.

5. Update all callers of `serviceName` and `deployContainer` to pass
   `userId`.

**Verification:** Deploy a demo. Verify:

- `source.tar.gz` is fetched by Cloud Build (check build logs)
- Image appears in `ar-demos` repository in Artifact Registry
- Cloud Run service has no FUSE volume mount
- Cloud Run service uses the built image (not `node:22-slim`)
- Demo is accessible at the returned URL

### 1f. Update `downloadSource` and remove dead code

**File:** `sdk-client-deno/src/operations/demos.ts`

Rewrite `downloadSource` to download `source.tar.gz` and extract it (using
`@std/tar` TarStream) instead of listing per-file objects.

Remove the dead `storeFiles` export.

**File:** `control-plane/src/api/demos/routes.ts`

Update `GET /:name/archive` to stream the `source.tar.gz` directly from GCS
via signed URL redirect instead of downloading individual files and repacking.

Update `GET /:name/download` to extract from the archive.

**Verification:** Download source for a demo via both endpoints. Verify
correct content.

### 1g. Rebuild `sdk-agent-nodejs`

**Working directory:** `sdk-agent-nodejs/`

Run `npm run build` to regenerate `bin/index.cjs` with the new `pushArchive`,
`pullArchive`, and binary-safe `readRaw` methods. This compiled file is baked
into the base image.

**Verification:** `bin/index.cjs` exists and is newer than the source files.

---

## Phase 2: Stack Detection + Dockerfile Generation

### 2a. Create `build.ts` with detection logic

**New file:** `control-plane/src/api/demos/build.ts`

Export a `detectScript()` function that returns the shell script for the first
Cloud Build step (extract tarball, read `ar-build.json` or run heuristic
detection, write `build-config.json`).

Export a `generateDockerfileScript()` function that returns the shell script
for the second Cloud Build step (read `build-config.json`, write the
appropriate `Dockerfile` into `/workspace/source/`).

Export Dockerfile template strings as constants:

- `NODE_DOCKERFILE` — multi-stage Node build (npm ci, optional tsc, optional
  build script, prune production)
- `STATIC_DOCKERFILE` — Node build stage + nginx:alpine serve stage
- `DENO_DOCKERFILE` — deno cache + deno run
- `VANILLA_NODE_DOCKERFILE` — copy to node image, run directly

Each template accepts parameters (entrypoint, output dir) via shell variable
substitution in the generate script.

**Verification:** Unit test each Dockerfile template: given a mock
`build-config.json`, verify the generated Dockerfile matches expected output.

### 2b. Update prompt template

**File:** `default-registry/agents/demo-agent/0.0.1/prompt-template.md`

Add the `<deploy_model>` section and expanded `<constraints>` from the RFC
(section 9). Add guidance for `ar-build.json`.

**Verification:** Read the compiled prompt for a new demo and verify the deploy
model and constraints are present.

### 2c. Update routes with build phase and bug fixes

**File:** `control-plane/src/api/demos/routes.ts`

1. Add `phase: 'building'` SSE emission in the deploy flow (after agent
   returns, before `deployContainer`).

2. Fix `POST /:name/update` `invokeAgent` call — add `storagePrefix` and
   `subsystem` to match the `POST /` path.

3. Fix auto-redeploy visibility — pass `current.visibility || 'private'` to
   `deployContainer`.

4. Remove redundant `meta!` assertion (line 310) — replace with `meta`.

5. Surface build logs in SSE when `buildDemo` fails (emit `phase: 'error'`
   with the truncated build log).

**Verification:** Create a demo via SSE (`Accept: text/event-stream`). Verify
the stream includes `building` and `deploying` phases. Update a public demo
and verify it remains public after redeploy.

### 2d. Fix Slack bot deploy error handling

**File:** `control-plane/src/bots/slack/commands/demo.ts`

Replace the empty `catch` block in `handleCreateOrUpdate` (line 356) with a
warning in the Slack card:

```typescript
} catch (err) {
  result.demo.status = 'created'
  const msg = err instanceof Error ? err.message : 'Deploy failed'
  result.demo.summary =
    (result.demo.summary || '') +
    `\n:warning: Deploy failed: ${msg}. Use \`demo deploy ${demoSlug}\` to retry.`
}
```

**File:** `control-plane/src/bots/slack/actions/handlers.ts`

Pass `meta.visibility || 'private'` to `deployContainer` in the
`demo_deploy` action handler (line 186).

**Verification:** Trigger a demo create where deploy fails (e.g., invalid
service account). Verify the Slack card shows a warning. Deploy a public demo
via the button and verify it stays public.

---

## Phase 3: Artifact Registry + Image Lifecycle

### 3a. Create `ar-demos` repository on first build

**File:** `control-plane/src/api/demos/deploy.ts`

In `buildDemo`, before submitting Cloud Build, ensure the `ar-demos`
repository exists:

```typescript
async function ensureDemoRepo(cfg: GcpConfig): Promise<void> {
  const token = await platform.getAccessToken()
  const url =
    `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories/ar-demos`
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (res.ok) return
  if (res.status !== 404) return

  await fetch(
    `https://artifactregistry.googleapis.com/v1/projects/${cfg.project}/locations/${cfg.region}/repositories?repositoryId=ar-demos`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ format: 'DOCKER' }),
    },
  )
}
```

Cache the result in-process to avoid checking on every build.

**Verification:** Delete `ar-demos` repo. Deploy a demo. Verify the repo is
created automatically.

### 3b. Delete images on demo delete

**File:** `control-plane/src/api/demos/routes.ts`

In the `DELETE /:name` handler, after destroying the Cloud Run service, also
delete the image from Artifact Registry:

```typescript
try {
  await deleteImage(cfg, tenantId, email, name)
} catch {
  logger.warn(`Failed to delete image for demo ${name}`)
}
```

The `deleteImage` helper calls the Artifact Registry API to delete the image
tag.

**Verification:** Delete a demo. Verify the image is removed from Artifact
Registry.

### 3c. Document IAM roles

**File:** `docs/iam.md`

Add `roles/artifactregistry.writer` for the Cloud Build service account (or
the runtime account if Cloud Build uses it). Document that this is required for
demo builds to push images.

**Verification:** Review the IAM doc for accuracy.

---

## Phase 4: Documentation + Tests

### 4a. Update `docs/storage.md`

Document the new demo GCS layout (`source.tar.gz` alongside `demo.json`).
Remove references to per-file `source/` prefix.

### 4b. Update `docs/container-builds.md`

Add a section on demo builds: how Cloud Build is used, the detection script,
Dockerfile templates, and the `ar-build.json` manifest.

### 4c. Add tests

**Directory:** `cli/test/`

1. `demo-archive.test.ts` — test `pushArchive`/`pullArchive` round-trip with
   binary files, verify `node_modules` exclusion, verify backpressure handling.

2. `demo-build.test.ts` — test `detectScript` and `generateDockerfileScript`
   with various `ar-build.json` inputs and heuristic detection scenarios.

3. `demo-deploy.test.ts` — test `serviceName` with userId, `demoImage` tag
   format, `buildDemo` Cloud Build submission (mock platform).

4. Update `cli/test/slack-demo.test.ts` — add test for deploy error surfacing
   in Slack cards, visibility passthrough.

### 4d. Update `AGENTS.md` and `CONTRIBUTING.md`

Remove references to FUSE mounts for demos. Add reference to RFC-007. Update
the deploy architecture section to mention demo builds.

---

## File Change Inventory

### Phase 0 — Bug Fixes

| File                                                | Change                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `sdk-agent-nodejs/src/storage.ts`                   | Add `SKIP` set to `walkDir`; fix `readRaw` to return `Buffer`; fix `pullRaw` to use binary writes; fix `pushRaw` to use binary reads |
| `default-registry/agents/demo-agent/0.0.1/index.js` | Switch to `listRaw`/`pullRaw`; add `writeRaw` for `demo.json`; remove `process.chdir`; fix deploy callback                           |
| `sdk-client-deno/src/templates/agent-demo.ts`       | Remove `version` reference in audit log                                                                                              |

### Phase 1 — Archive Upload + Build Pipeline

| File                                                | Change                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk-agent-nodejs/src/storage.ts`                   | Add `pushArchive`, `pullArchive`                                                                                                                           |
| `default-registry/agents/demo-agent/0.0.1/index.js` | Use `pushArchive`/`pullArchive`                                                                                                                            |
| `sdk-client-deno/src/templates/agent-demo.ts`       | Sync `HANDLER_TEMPLATE` with `index.js`                                                                                                                    |
| `sdk-client-deno/src/platform/gcp-rest.ts`          | Add `cloudBuildSubmit`, `waitForBuild`                                                                                                                     |
| `sdk-client-deno/src/platform/types.ts`             | Add method signatures to `Platform` interface                                                                                                              |
| `control-plane/src/api/demos/deploy.ts`             | Replace `deployContainer`: `buildDemo` + image deploy; update `serviceName`; add `demoImage`; remove FUSE volumes, `NODE_PATH`, stock images; wait for LRO |
| `sdk-client-deno/src/operations/demos.ts`           | Rewrite `downloadSource` for archive layout; remove `storeFiles`                                                                                           |
| `control-plane/src/api/demos/routes.ts`             | Update `/download` and `/archive` endpoints for archive layout                                                                                             |
| `sdk-agent-nodejs/bin/index.cjs`                    | Rebuild                                                                                                                                                    |

### Phase 2 — Stack Detection + Dockerfile Generation

| File                                                          | Change                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `control-plane/src/api/demos/build.ts` (new)                  | `detectScript`, `generateDockerfileScript`, Dockerfile templates               |
| `default-registry/agents/demo-agent/0.0.1/prompt-template.md` | Add deploy model, constraints, `ar-build.json` guidance                        |
| `control-plane/src/api/demos/routes.ts`                       | SSE `building` phase; fix update route payload; fix visibility; remove `meta!` |
| `control-plane/src/bots/slack/commands/demo.ts`               | Surface deploy errors; pass visibility                                         |
| `control-plane/src/bots/slack/actions/handlers.ts`            | Pass `meta.visibility` in `demo_deploy`                                        |

### Phase 3 — Artifact Registry + Image Lifecycle

| File                                    | Change                                     |
| --------------------------------------- | ------------------------------------------ |
| `control-plane/src/api/demos/deploy.ts` | Add `ensureDemoRepo`; cache repo existence |
| `control-plane/src/api/demos/routes.ts` | Delete image on demo delete                |
| `docs/iam.md`                           | Document `artifactregistry.writer` role    |

### Phase 4 — Documentation + Tests

| File                                  | Change                                             |
| ------------------------------------- | -------------------------------------------------- |
| `docs/storage.md`                     | Update demo GCS layout                             |
| `docs/container-builds.md`            | Add demo build section                             |
| `cli/test/demo-archive.test.ts` (new) | Archive round-trip tests                           |
| `cli/test/demo-build.test.ts` (new)   | Detection + Dockerfile generation tests            |
| `cli/test/demo-deploy.test.ts` (new)  | Service naming, image tags, build submission tests |
| `cli/test/slack-demo.test.ts`         | Deploy error surfacing, visibility tests           |
| `AGENTS.md`                           | Remove FUSE references for demos; add RFC-007      |
| `CONTRIBUTING.md`                     | Update demo deploy references                      |

---

## Dependency Graph

```
Phase 0 (bug fixes)
  ├── 0a walkDir exclusions
  ├── 0b binary I/O fix
  ├── 0c index.js fixes
  └── 0d template version fix
        │
Phase 1 (archive + build)
  ├── 1a pushArchive / pullArchive
  ├── 1b index.js archive switch
  ├── 1c template sync
  ├── 1d cloudBuildSubmit / waitForBuild
  ├── 1e deployContainer rewrite
  ├── 1f downloadSource + endpoints
  └── 1g rebuild sdk-agent-nodejs
        │
        ├──────────────────────────────┐
        │                              │
Phase 2 (detection + Dockerfiles)   Phase 3 (AR lifecycle)
  ├── 2a build.ts                     ├── 3a ensureDemoRepo
  ├── 2b prompt-template.md           ├── 3b delete images
  ├── 2c routes.ts fixes              └── 3c IAM docs
  └── 2d Slack fixes
        │                              │
        └──────────┬───────────────────┘
                   │
             Phase 4 (docs + tests)
               ├── 4a storage.md
               ├── 4b container-builds.md
               ├── 4c tests
               └── 4d AGENTS.md + CONTRIBUTING.md
```

Phases 2 and 3 are independent and can be worked in parallel. Phase 4 depends
on both.
