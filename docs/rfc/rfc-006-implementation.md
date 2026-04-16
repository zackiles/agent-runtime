# RFC-006 Implementation Plan

**Status:** Not Started
**RFC:** [rfc-006-gemini-subsystem.md](rfc-006-gemini-subsystem.md)
**Created:** 2026-04-08

---

## Overview

This document is the implementation plan for RFC-006. It breaks the work into
four phases ordered by dependency. Phase 1 creates the Gemini tool and wires GCP
provisioning. Phase 2 fixes the tool packaging pipeline so direct executables
and dynamic versions work. Phase 3 centralizes the subsystem abstraction. Phase
4 deploys, verifies, and updates documentation.

Each step lists the exact files to change, the change to make, and any
verification criteria.

---

## Phase 1: Gemini Tool and GCP Provisioning

Create the Gemini tool, register it in the runtime, and wire automatic Vertex AI
provisioning into the CLI deploy flow.

### 1a. Create `default-registry/tools/gemini/0.0.1/tool.js`

**New file:** `default-registry/tools/gemini/0.0.1/tool.js`

Node.js script that reads a prompt from stdin, calls Vertex AI
`generateContent`, and writes the text response to stdout. Model
(`gemini-2.5-pro`) and location (`us-central1`) are hardcoded constants.

Authentication: metadata server in production, `gcloud auth print-access-token`
fallback for local development. Project ID from `GOOGLE_CLOUD_PROJECT` or
`GCP_PROJECT` env vars, then metadata server.

The script uses only Node.js 22 built-ins (`fetch`, `child_process`,
`process.stdin`). No external dependencies.

Must be executable: `chmod +x tool.js` and include `#!/usr/bin/env node`
shebang.

**Verification:** Run locally with `echo "Hello" | node tool.js` after
`gcloud auth application-default login`. Should return a Gemini response.

### 1b. Create `default-registry/tools/gemini/0.0.1/tool.json`

**New file:** `default-registry/tools/gemini/0.0.1/tool.json`

```json
{
  "name": "gemini",
  "slug": "gemini",
  "version": "0.0.1",
  "flags": [],
  "env": {}
}
```

Empty `flags` means `AgentTools.run` uses the `execSync(binary, { input })`
path (stdin), not the `execFileSync(binary, [...flags, input])` path (args).

Empty `env` means the full `process.env` is passed through (the `resolveEnv`
method in `tools.ts` passes all env vars when `tc.env` is empty).

### 1c. Create `default-registry/tools/gemini/0.0.1/README.md`

**New file:** `default-registry/tools/gemini/0.0.1/README.md`

YAML frontmatter with `name: gemini` and `description` (<=250 chars). Body
documents: authentication flow, model, location, stdin/stdout contract, local
development setup, and `AgentTools.instance.run('gemini', prompt)` usage.

### 1d. Add gemini to `BUILTIN` in `sdk-client-deno/src/defaults/tools.ts`

**File:** `sdk-client-deno/src/defaults/tools.ts` (line ~50, after the datadog
entry)

Add to the `BUILTIN` array:

```typescript
{
  name: 'gemini',
  slug: 'gemini',
  version: '0.0.1',
  flags: [],
  env: {},
},
```

This ensures the Gemini tool config is available even when the registry
directory is not accessible (e.g. during local development without a full
checkout).

### 1e. Add gemini to tools list in `default-settings.jsonc`

**File:** `default-settings.jsonc` (line ~83, in the `tools` array)

Add:

```jsonc
{ "slug": "gemini", "version": "0.0.1" }
```

This registers Gemini as a default tool that gets installed when bootstrapping
the control plane and bundled into agent containers.

### 1f. Add `aiplatform.googleapis.com` to `REQUIRED_APIS`

**File:** `cli/src/commands/control-plane.ts` (line ~50, in the `REQUIRED_APIS`
array)

Add `'aiplatform.googleapis.com'` to the array. This ensures the Vertex AI API
is enabled automatically during `ar cp deploy`, matching how all other GCP
services are provisioned.

**Verification:** After deploy, `gcloud services list --enabled --project=$PROJECT`
should include `aiplatform.googleapis.com`.

### 1g. Add `roles/aiplatform.user` to `runtimeAccountRoles`

**File:** `default-settings.jsonc` (line ~70, in `runtimeAccountRoles`)

Add `"roles/aiplatform.user"` to the array. This grants the runtime service
account permission to call Vertex AI inference endpoints. The role is scoped to
inference only — no model training or management.

**Verification:** After deploy,
`gcloud projects get-iam-policy $PROJECT --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$RUNTIME_SA"`
should include `roles/aiplatform.user`.

---

## Phase 2: Tool Packaging Fixes

Fix the packaging pipeline so direct executables (`tool.js`) and dynamic
versions work correctly in both container and source deploy modes.

### 2a. Update `Dockerfile.agent-base` to handle direct executables

**File:** `Dockerfile.agent-base` (lines 9-18)

Replace the current `RUN` block:

```dockerfile
RUN for d in /tmp/tools/*/0.0.1; do \
      if [ -f "$d/install.sh" ]; then \
        slug="$(basename $(dirname $d))"; \
        export TOOLS_DIR="/app/tools/$slug"; \
        mkdir -p "$TOOLS_DIR"; \
        cp "$d/tool.json" "$TOOLS_DIR/" 2>/dev/null; \
        cp "$d/install.sh" "$TOOLS_DIR/"; \
        (cd "$TOOLS_DIR" && sh install.sh) || echo "WARN: $slug install failed"; \
      fi; \
    done && rm -rf /tmp/tools
```

With:

```dockerfile
RUN for d in /tmp/tools/*/0.0.1; do \
      slug="$(basename $(dirname $d))"; \
      export TOOLS_DIR="/app/tools/$slug"; \
      mkdir -p "$TOOLS_DIR"; \
      cp "$d/tool.json" "$TOOLS_DIR/" 2>/dev/null || true; \
      if [ -f "$d/install.sh" ]; then \
        cp "$d/install.sh" "$TOOLS_DIR/"; \
        (cd "$TOOLS_DIR" && sh install.sh) || echo "WARN: $slug install failed"; \
      else \
        for f in "$d"/tool "$d"/tool.*; do \
          [ -f "$f" ] && [ "$(basename $f)" != "tool.json" ] && \
            cp "$f" "$TOOLS_DIR/" && chmod +x "$TOOLS_DIR/$(basename $f)"; \
        done; \
      fi; \
    done && rm -rf /tmp/tools
```

Logic: For each tool version directory, always copy `tool.json`. If
`install.sh` exists, run it (existing behavior). Otherwise, copy any file named
`tool` or `tool.*` (excluding `tool.json`) and make it executable.

**Verification:** Build the base image locally with
`docker build -f Dockerfile.agent-base -t test-base .` and verify
`/app/tools/gemini/tool.js` exists and is executable inside the container.

### 2b. Remove hardcoded `0.0.1` from `Dockerfile.agent-base`

**File:** `Dockerfile.agent-base` (same `RUN` block as 2a)

Replace the glob `/tmp/tools/*/0.0.1` with a dynamic version resolution that
picks the highest version directory per slug:

```dockerfile
RUN for slug_dir in /tmp/tools/*/; do \
      slug="$(basename $slug_dir)"; \
      version_dir="$(ls -d ${slug_dir}*/ 2>/dev/null | sort -V | tail -1)"; \
      [ -z "$version_dir" ] && continue; \
      export TOOLS_DIR="/app/tools/$slug"; \
      mkdir -p "$TOOLS_DIR"; \
      cp "$version_dir/tool.json" "$TOOLS_DIR/" 2>/dev/null || true; \
      if [ -f "$version_dir/install.sh" ]; then \
        cp "$version_dir/install.sh" "$TOOLS_DIR/"; \
        (cd "$TOOLS_DIR" && sh install.sh) || echo "WARN: $slug install failed"; \
      else \
        for f in "$version_dir"/tool "$version_dir"/tool.*; do \
          [ -f "$f" ] && [ "$(basename $f)" != "tool.json" ] && \
            cp "$f" "$TOOLS_DIR/" && chmod +x "$TOOLS_DIR/$(basename $f)"; \
        done; \
      fi; \
    done && rm -rf /tmp/tools
```

`sort -V` uses GNU coreutils version sort, which handles semver correctly
(`0.0.2` < `0.0.10`). This is available in the `node:22-slim` base image
(Debian).

Steps 2a and 2b can be combined into a single edit since they modify the same
block.

### 2c. Update `runSourceDeploy` to copy direct tool executables

**File:** `control-plane/src/api/agents.ts` (inside `runSourceDeploy`, the loop
that copies tool files from the local registry)

Current code copies only two files:

```typescript
for (const file of ['tool.json', 'install.sh']) {
  try {
    await Deno.copyFile(`${src}/${file}`, `${dest}/${file}`)
  } catch { /* file may not exist for this tool */ }
}
```

Replace with a loop that copies all tool files (excluding `README.md` which is
documentation-only):

```typescript
try {
  for await (const entry of Deno.readDir(src)) {
    if (!entry.isFile) continue
    if (entry.name === 'README.md') continue
    await Deno.copyFile(
      `${src}/${entry.name}`,
      `${dest}/${entry.name}`,
    )
  }
} catch { /* source dir may not exist */ }
```

This handles `tool.json`, `install.sh`, `tool.js`, `tool`, and any other files
a tool may include.

### 2d. Fix semver sort in `resolveVersionedDir`

**File:** `sdk-client-deno/src/registry.ts` (line ~43)

Current code:

```typescript
versions.sort().reverse()
```

Replace with proper semver comparison. Add import at the top of the file:

```typescript
import { compare, parse } from '@std/semver'
```

Replace the sort:

```typescript
versions.sort((a, b) => {
  try {
    return compare(parse(a), parse(b))
  } catch {
    return a.localeCompare(b)
  }
}).reverse()
```

The `try/catch` handles edge cases where a directory name matches the semver
pattern but is not valid semver.

**Verification:** Create test directories `0.0.2/` and `0.0.10/` under a tool
slug and verify `resolveVersionedDir` returns `0.0.10`.

---

## Phase 3: Subsystem Abstraction Cleanup

Centralize the subsystem definition and replace all hardcoded strings.

### 3a. Create `sdk-client-deno/src/subsystems.ts`

**New file:** `sdk-client-deno/src/subsystems.ts`

```typescript
const SUBSYSTEMS = ['cursor', 'claude', 'gemini'] as const

type Subsystem = typeof SUBSYSTEMS[number]

const DEFAULT_SUBSYSTEM: Subsystem = 'cursor'

function isSubsystem(value: string): value is Subsystem {
  return SUBSYSTEMS.includes(value as Subsystem)
}

export { DEFAULT_SUBSYSTEM, isSubsystem, SUBSYSTEMS }
export type { Subsystem }
```

### 3b. Update agent validation in `control-plane/src/api/agents.ts`

**File:** `control-plane/src/api/agents.ts` (line ~99)

Add import:

```typescript
import { SUBSYSTEMS } from '@ar/client/subsystems'
```

Replace:

```typescript
{
  error: 'Prompt agents require a subsystem (claude or cursor)'
}
```

With:

```typescript
{
  error: ;
  ;`Prompt agents require a subsystem (${SUBSYSTEMS.join(', ')})`
}
```

### 3c. Replace hardcoded default in `control-plane/src/api/demos/routes.ts`

**File:** `control-plane/src/api/demos/routes.ts`

Add import:

```typescript
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
```

Replace `body.subsystem || 'cursor'` with `body.subsystem || DEFAULT_SUBSYSTEM`.

### 3d. Replace hardcoded default in `control-plane/src/bots/slack/commands/demo.ts`

**File:** `control-plane/src/bots/slack/commands/demo.ts`

Add import:

```typescript
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
```

Replace `subsystem: 'cursor'` with `subsystem: DEFAULT_SUBSYSTEM` in the
`invokeAgent` call inside `handleCreateOrUpdate`.

### 3e. Replace hardcoded default in `control-plane/src/bots/slack/commands/create-agent.ts`

**File:** `control-plane/src/bots/slack/commands/create-agent.ts`

Add import:

```typescript
import { DEFAULT_SUBSYSTEM } from '@ar/client/subsystems'
```

Replace `subsystem: 'cursor'` with `subsystem: DEFAULT_SUBSYSTEM`.

### 3f. Update web UI subsystem select in `web/src/islands/demos.tsx`

**File:** `web/src/islands/demos.tsx`

The web package uses npm/Vite (not Deno), so it cannot import from
`@ar/client/subsystems` directly. Instead, define the subsystem list as a
constant at the top of the file:

```typescript
const SUBSYSTEMS = ['cursor', 'claude', 'gemini'] as const
const DEFAULT_SUBSYSTEM = 'cursor'
```

Replace the hardcoded `EMPTY_FORM` default:

```typescript
subsystem: DEFAULT_SUBSYSTEM,
```

Replace the `startFeedback` default:

```typescript
subsystem: DEFAULT_SUBSYSTEM,
```

Replace the hardcoded `<option>` tags (lines ~932-934):

```tsx
<select ...>
  {SUBSYSTEMS.map((s) => (
    <option key={s} value={s}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </option>
  ))}
</select>
```

**Verification:** Run `npm run dev` in `web/` and verify the subsystem dropdown
shows three options: Cursor, Claude, Gemini.

### 3g. Update `agent-schema.ts` subsystem type

**File:** `sdk-client-deno/src/agent-schema.ts` (line ~17)

Add import:

```typescript
import type { Subsystem } from './subsystems.ts'
```

Change:

```typescript
subsystem?: string
```

To:

```typescript
subsystem?: Subsystem
```

This provides type safety at the manifest level. The `validate` function does
not need changes since it reads from JSON and the type is only used for
TypeScript checking.

### 3h. Export subsystems from `@ar/client`

**File:** `sdk-client-deno/deno.jsonc` (exports map)

Add an export entry so control plane code can import via `@ar/client/subsystems`:

```jsonc
"./subsystems": "./src/subsystems.ts"
```

---

## Phase 4: Deploy, Verify, and Document

### 4a. Run `deno task check`

**Working directory:** `cli/`

Run `deno task check` to verify formatting, linting, and type-checking pass
across all packages. Fix any issues introduced by the changes.

### 4b. Rebuild `sdk-agent-nodejs`

**Working directory:** `sdk-agent-nodejs/`

Run `npm run build` to regenerate `bin/index.cjs`. This is required because the
base image copies this file. No source changes are needed in `sdk-agent-nodejs`
for this RFC, but the build must be current.

### 4c. Deploy control plane

```bash
deno task ar cp deploy --no-input
```

This triggers the full provisioning flow:

- `checkApis()` enables `aiplatform.googleapis.com`
- `ensureRoles()` grants `roles/aiplatform.user` to runtime SA
- `buildBaseImage()` packages `gemini/0.0.1/tool.js` into `/app/tools/gemini/`
- Deploys the updated Cloud Run service

### 4d. Verify GCP provisioning

```bash
gcloud services list --enabled --project=$PROJECT | grep aiplatform
gcloud projects get-iam-policy $PROJECT \
  --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$RUNTIME_SA AND bindings.role:roles/aiplatform.user" \
  --format='value(bindings.role)'
```

Both should return results.

### 4e. Sync registry

```bash
deno task ar cp sync
```

This registers the Gemini tool in the control plane database.

### 4f. Verify Gemini subsystem

Create a test prompt agent via the web UI or API:

```bash
curl -X POST https://$CP_URL/api/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "test-gemini",
    "sourceType": "prompt",
    "subsystem": "gemini",
    "prompt": "You are a helpful assistant. Respond to the request in JSON format with a result field."
  }'
```

Verify the agent is created with `subsystem: 'gemini'`. If deployed, invoke it
and confirm the response comes from Gemini.

### 4g. Verify web UI

Open the web dashboard demos page. Verify the subsystem dropdown shows three
options: Cursor, Claude, Gemini. Create a demo with Gemini selected and confirm
the subsystem is passed through to the agent.

### 4h. Update `AGENTS.md`

**File:** `AGENTS.md`

Add a reference to RFC-006 in the Deploy Architecture section. Add Gemini to
any subsystem references.

### 4i. Update `default-registry/tools/README.md`

**File:** `default-registry/tools/README.md`

Add Gemini to the Default Tools table. Update any text that implies tools must
use `install.sh` to clarify that direct executables are also supported.

---

## File Change Inventory

### Phase 1 — Gemini Tool and GCP Provisioning

| File                                                  | Change                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| `default-registry/tools/gemini/0.0.1/tool.js` (new)   | Node.js Vertex AI wrapper script                                                 |
| `default-registry/tools/gemini/0.0.1/tool.json` (new) | Tool manifest with empty flags and env                                           |
| `default-registry/tools/gemini/0.0.1/README.md` (new) | Tool documentation with frontmatter                                              |
| `sdk-client-deno/src/defaults/tools.ts`               | Add gemini entry to `BUILTIN` array                                              |
| `default-settings.jsonc`                              | Add gemini to `tools` list; add `roles/aiplatform.user` to `runtimeAccountRoles` |
| `cli/src/commands/control-plane.ts`                   | Add `aiplatform.googleapis.com` to `REQUIRED_APIS`                               |

### Phase 2 — Tool Packaging Fixes

| File                              | Change                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `Dockerfile.agent-base`           | Handle direct executables; remove hardcoded `0.0.1`; use `sort -V` for version resolution |
| `control-plane/src/api/agents.ts` | Copy all tool files in `runSourceDeploy` (not just `tool.json` + `install.sh`)            |
| `sdk-client-deno/src/registry.ts` | Fix `resolveVersionedDir` to use `@std/semver` comparison                                 |

### Phase 3 — Subsystem Abstraction

| File                                                    | Change                                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `sdk-client-deno/src/subsystems.ts` (new)               | Canonical `SUBSYSTEMS` list, `Subsystem` type, `DEFAULT_SUBSYSTEM`, `isSubsystem` |
| `sdk-client-deno/deno.jsonc`                            | Add `./subsystems` export entry                                                   |
| `sdk-client-deno/src/agent-schema.ts`                   | Use `Subsystem` type for `subsystem` field                                        |
| `control-plane/src/api/agents.ts`                       | Import `SUBSYSTEMS` for validation message                                        |
| `control-plane/src/api/demos/routes.ts`                 | Import and use `DEFAULT_SUBSYSTEM`                                                |
| `control-plane/src/bots/slack/commands/demo.ts`         | Import and use `DEFAULT_SUBSYSTEM`                                                |
| `control-plane/src/bots/slack/commands/create-agent.ts` | Import and use `DEFAULT_SUBSYSTEM`                                                |
| `web/src/islands/demos.tsx`                             | Define `SUBSYSTEMS` constant; dynamic `<select>` rendering                        |

### Phase 4 — Deploy, Verify, Document

| File                               | Change                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| `AGENTS.md`                        | Reference RFC-006; add Gemini to subsystem references                |
| `default-registry/tools/README.md` | Add Gemini to Default Tools table; clarify direct executable support |

---

## Dependency Graph

```
Phase 1 (tool + GCP)
  ├── 1a tool.js
  ├── 1b tool.json
  ├── 1c README.md
  ├── 1d BUILTIN entry
  ├── 1e default-settings tools
  ├── 1f REQUIRED_APIS
  └── 1g runtimeAccountRoles
        │
Phase 2 (packaging)          Phase 3 (abstraction)
  ├── 2a Dockerfile direct     ├── 3a subsystems.ts
  ├── 2b Dockerfile versions   ├── 3b agents.ts validation
  ├── 2c source deploy copy    ├── 3c demos/routes.ts
  └── 2d semver sort           ├── 3d slack demo.ts
                               ├── 3e slack create-agent.ts
                               ├── 3f demos.tsx
                               ├── 3g agent-schema.ts
                               └── 3h deno.jsonc export
        │                              │
        └──────────┬───────────────────┘
                   │
             Phase 4 (deploy + verify)
               ├── 4a deno task check
               ├── 4b rebuild sdk-agent-nodejs
               ├── 4c ar cp deploy
               ├── 4d verify GCP
               ├── 4e ar cp sync
               ├── 4f verify gemini
               ├── 4g verify web UI
               ├── 4h AGENTS.md
               └── 4i tools README.md
```

Phases 2 and 3 are independent and can be worked in parallel. Phase 4 depends
on both.
