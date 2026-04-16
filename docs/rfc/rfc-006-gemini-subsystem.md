# RFC-006: Gemini Subsystem and Agent Subsystem Abstraction

**Status:** Draft **Authors:** Agent Runtime Team **Created:** 2026-04-08

---

## Abstract

This RFC adds Gemini (via Vertex AI) as a third agent subsystem alongside Cursor
and Claude, and standardizes the subsystem abstraction across the runtime. Today,
subsystem selection is an opaque string threaded through the codebase with
hardcoded `'cursor'` defaults and a validation message that only names two
options. Adding Gemini exposes the need for a clean registry of valid subsystems,
a consistent tool wrapper pattern, and centralized defaults — so this RFC
addresses both the new subsystem and the abstraction cleanup together.

It also addresses tool packaging gaps uncovered during design: the base image
and deploy paths are biased toward `install.sh`-based tools and hardcode version
`0.0.1`, while the runtime already supports direct executables (including
`tool.js`). This RFC proposes fixes to close those gaps and establish versioning
guidance for tools going forward.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Current State](#2-current-state)
3. [Design: Gemini Tool](#3-design-gemini-tool)
4. [Design: Subsystem Abstraction](#4-design-subsystem-abstraction)
5. [Tool Packaging and Versioning](#5-tool-packaging-and-versioning)
6. [Secrets and Credentials](#6-secrets-and-credentials)
7. [GCP Provisioning: Vertex AI](#7-gcp-provisioning-vertex-ai)
8. [Codebase Changes](#8-codebase-changes)
9. [Implementation Plan](#9-implementation-plan)
10. [Security Considerations](#10-security-considerations)
11. [Open Questions](#11-open-questions)

---

## 1. Motivation

The agent runtime supports **subsystem agents** — external AI coding tools that
agents delegate work to via `AgentTools.instance.run(subsystem, prompt)`. Today
only Cursor and Claude are available. Adding Gemini on Vertex AI is valuable
because:

- **GCP-native authentication**: Gemini on Vertex AI authenticates via the same
  service account the runtime already uses, eliminating the need for external API
  keys in production. Only a GCP project with the Vertex AI API enabled is
  required.
- **Cost and model diversity**: Gemini 2.5 Pro offers competitive reasoning and
  coding capabilities. Having three subsystems gives operators flexibility to
  choose based on cost, latency, and capability per agent.
- **First-party integration**: The runtime already runs on GCP (Cloud Run, Cloud
  Functions, GCS). Gemini on Vertex AI is the natural first-party model choice.

Beyond adding Gemini, the current subsystem wiring has grown organically and
needs cleanup:

- The valid subsystem set is implicit — scattered across validation messages,
  UI `<option>` tags, Slack command defaults, and tool registrations.
- Defaults are hardcoded as `'cursor'` in ~6 places with no single source of
  truth.
- The tool packaging pipeline (`Dockerfile.agent-base`, `runSourceDeploy`) is
  biased toward `install.sh`-based tools and hardcodes version `0.0.1`, while
  the runtime (`AgentTools.resolveBinary`) already supports direct executables
  like `tool.js`. This mismatch means a Node.js-based tool like Gemini would
  not be packaged correctly without fixes.

---

## 2. Current State

### 2.1 Subsystem flow

```
agent.json (subsystem: "cursor")
  → agent-host.js (AgentEnvironment.init({ subsystem }))
    → handler (AgentTools.instance.run(subsystem, prompt))
      → tools.ts (resolveBinary → execFileSync/execSync)
        → /app/tools/cursor/tool -p --force --trust <prompt>
```

### 2.2 Tool structure (cursor example)

```
default-registry/tools/cursor/0.0.1/
├── tool.json       # { slug, flags, env }
├── install.sh      # Downloads cursor-agent binary → produces `tool`
└── README.md       # Frontmatter + usage docs
```

### 2.3 Tool resolution in `AgentTools` (runtime)

`resolveBinary(name)` in `sdk-agent-nodejs/src/tools.ts` supports three cases:

1. **Direct executable**: Looks for a file named `tool` (or `tool.<ext>`,
   excluding `tool.json`) in `/app/tools/<name>` then `<toolsDir>/<name>`.
   This means `tool.js`, `tool.sh`, `tool.py` are all valid.
2. **Install script**: If no `tool` exists, looks for `install` (or
   `install.<ext>`), runs it with `TOOLS_DIR` set, then retries finding `tool`.
3. **PATH fallback**: If neither works, returns the bare slug string (fragile).

The runtime already supports Node.js tool executables (`tool.js` with a
`#!/usr/bin/env node` shebang). The problem is that the **packaging pipeline**
does not handle this case.

### 2.4 Tool packaging gaps

| Layer                   | Behavior                                                                              | Gap                                                      |
| ----------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Dockerfile.agent-base` | Loops over `tools/*/0.0.1`, copies only `tool.json` + `install.sh`, runs `install.sh` | Ignores direct `tool`/`tool.js` files; hardcodes `0.0.1` |
| `runSourceDeploy` (CP)  | Copies `tool.json` + `install.sh` from registry                                       | Same: ignores direct executables                         |
| `bundleTools` (CLI)     | Iterates `rc.tools` from `default-settings.jsonc`                                     | Uses global tool list, not per-agent                     |
| `resolveVersionedDir`   | Sorts version dirs lexicographically                                                  | `0.0.10` sorts before `0.0.2`                            |

### 2.5 Where subsystem appears today

| Location                          | What it does                                       |
| --------------------------------- | -------------------------------------------------- |
| `agent-schema.ts`                 | `AgentManifest.subsystem?: string` — no validation |
| `control-plane/src/api/agents.ts` | Validates: `"claude or cursor"`                    |
| `web/src/islands/demos.tsx`       | `<select>` with hardcoded `cursor`, `claude`       |
| `slack/commands/demo.ts`          | Hardcoded `subsystem: 'cursor'`                    |
| `slack/commands/create-agent.ts`  | Hardcoded `subsystem: 'cursor'`                    |
| `api/demos/routes.ts`             | Default `body.subsystem \|\| 'cursor'`             |
| `templates/agent-prompt.ts`       | `compileDefault` uses `'claude'`                   |
| `templates/agent-demo.ts`         | `compileDefault` uses `'cursor'`                   |
| `defaults/tools.ts`               | `BUILTIN` array (cursor, claude entries)           |
| `demo-agent/0.0.1/agent.json`     | `"subsystem": "cursor"`                            |

---

## 3. Design: Gemini Tool

### 3.1 Node.js tool, not a shell script

The existing tools (Cursor, Claude) download vendor CLI binaries via
`install.sh`. Gemini has no CLI binary — it is a REST API. Rather than wrapping
it in a shell script (which would be inconsistent with the Node.js runtime used
everywhere else), the Gemini tool is a **Node.js script** (`tool.js`) that:

1. Reads the prompt from stdin.
2. Obtains an access token from the GCP metadata server (production) or
   `gcloud` (local development).
3. Calls the Vertex AI `generateContent` endpoint via `fetch`.
4. Extracts the text response and writes it to stdout.

This is consistent with the runtime environment (Node.js 22 is already in the
base image) and requires no external dependencies — `fetch` is built into
Node.js 22, and JSON parsing is native.

### 3.2 Tool file structure

```
default-registry/tools/gemini/0.0.1/
├── tool.json
├── tool.js         # Node.js executable (direct — no install.sh needed)
└── README.md
```

No `install.sh` is needed. The tool is a self-contained script that runs
directly via `node tool.js` (shebang: `#!/usr/bin/env node`). This is the first
tool to use the direct-executable pattern, which the runtime already supports
but the packaging pipeline does not (see [Section 5](#5-tool-packaging-and-versioning)).

### 3.3 `tool.json`

```json
{
  "name": "gemini",
  "slug": "gemini",
  "version": "0.0.1",
  "flags": [],
  "env": {}
}
```

Key differences from cursor/claude:

- **No API key env var**: Authentication uses the GCP service account's access
  token via the metadata server. The runtime service account already has Vertex
  AI permissions after provisioning (see [Section 7](#7-gcp-provisioning-vertex-ai)).
- **`flags: []`**: The prompt is passed via stdin, not as a CLI argument. This
  matches the `execSync(binary, { input })` path in `AgentTools.run`.
- **Empty `env: {}`**: No secrets to inject. The tool resolves credentials
  internally from the GCP environment.

### 3.4 `tool.js` (executable)

The model (`gemini-2.5-pro`) and location (`us-central1`) are hardcoded in the
script. This keeps the tool self-contained with no configuration needed. If a
different model or location is needed in the future, a new tool version can be
published.

```js
#!/usr/bin/env node
'use strict'

const MODEL = 'gemini-2.5-pro'
const LOCATION = 'us-central1'
const METADATA = 'http://metadata.google.internal/computeMetadata/v1'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

async function resolveProject() {
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    return process.env.GOOGLE_CLOUD_PROJECT
  }
  if (process.env.GCP_PROJECT) return process.env.GCP_PROJECT
  const res = await fetch(`${METADATA}/project/project-id`, {
    headers: { 'Metadata-Flavor': 'Google' },
  })
  if (res.ok) return (await res.text()).trim()
  throw new Error('Could not resolve GCP project')
}

async function resolveToken() {
  try {
    const res = await fetch(
      `${METADATA}/instance/service-accounts/default/token`,
      { headers: { 'Metadata-Flavor': 'Google' } },
    )
    if (res.ok) {
      const data = await res.json()
      return data.access_token
    }
  } catch {}
  const { execSync } = require('child_process')
  return execSync('gcloud auth print-access-token', {
    encoding: 'utf-8',
  }).trim()
}

async function main() {
  const prompt = await readStdin()
  if (!prompt.trim()) {
    process.stderr.write('No input provided\n')
    process.exit(1)
  }

  const project = await resolveProject()
  const token = await resolveToken()
  const endpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${project}/locations/${LOCATION}/` +
    `publishers/google/models/${MODEL}:generateContent`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 65536,
        temperature: 0.2,
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    process.stderr.write(`Vertex AI error (${res.status}): ${text}\n`)
    process.exit(1)
  }

  const data = await res.json()
  const parts = data.candidates?.[0]?.content?.parts || []
  const text = parts
    .filter((p) => p.text)
    .map((p) => p.text)
    .join('')
  process.stdout.write(text || JSON.stringify(data))
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
```

### 3.5 Model selection

**Gemini 2.5 Pro** (`gemini-2.5-pro`) is hardcoded as the model. It is the
current best model for complex reasoning and code generation on Vertex AI. If a
different model is needed (e.g. Flash for cost optimization), publish a new tool
version with the updated model constant.

---

## 4. Design: Subsystem Abstraction

### 4.1 Canonical subsystem list

Introduce a single source of truth for valid subsystems in
`sdk-client-deno/src/subsystems.ts`:

```typescript
const SUBSYSTEMS = ['cursor', 'claude', 'gemini'] as const
type Subsystem = typeof SUBSYSTEMS[number]
const DEFAULT_SUBSYSTEM: Subsystem = 'cursor'

function isSubsystem(value: string): value is Subsystem {
  return SUBSYSTEMS.includes(value as Subsystem)
}
```

All validation, UI rendering, and default selection should reference this module
instead of hardcoding strings.

### 4.2 Changes to validation

`control-plane/src/api/agents.ts` currently validates:

```
'Prompt agents require a subsystem (claude or cursor)'
```

This becomes:

```typescript
;`Prompt agents require a subsystem (${SUBSYSTEMS.join(', ')})`
```

### 4.3 Changes to defaults

Every place that hardcodes `'cursor'` as a default should import
`DEFAULT_SUBSYSTEM` instead:

| File                             | Current                        | After                                   |
| -------------------------------- | ------------------------------ | --------------------------------------- |
| `demos/routes.ts`                | `body.subsystem \|\| 'cursor'` | `body.subsystem \|\| DEFAULT_SUBSYSTEM` |
| `slack/commands/demo.ts`         | `subsystem: 'cursor'`          | `subsystem: DEFAULT_SUBSYSTEM`          |
| `slack/commands/create-agent.ts` | `subsystem: 'cursor'`          | `subsystem: DEFAULT_SUBSYSTEM`          |
| `web/src/islands/demos.tsx`      | `subsystem: 'cursor'`          | Import and use `DEFAULT_SUBSYSTEM`      |

### 4.4 UI changes

The web `<select>` in `demos.tsx` currently has two hardcoded `<option>` tags.
Replace with a dynamic list generated from `SUBSYSTEMS`:

```tsx
{
  SUBSYSTEMS.map((s) => (
    <option key={s} value={s}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </option>
  ))
}
```

The same applies to any agent creation UI that offers subsystem selection.

### 4.5 Slack bot changes

The Slack `demo` command currently always sends `subsystem: 'cursor'`. Two
options:

- **Option A (minimal)**: Keep using `DEFAULT_SUBSYSTEM` — users who want Gemini
  use the web UI or API directly.
- **Option B (flag)**: Accept `--gemini` or `--claude` flags in the demo command
  to override the default. Example: `demo --gemini Build a todo app`.

This RFC recommends **Option A** for initial implementation, with Option B as a
follow-up if there is user demand.

---

## 5. Tool Packaging and Versioning

### 5.1 Packaging gap: direct executables

The runtime (`AgentTools.resolveBinary`) already supports tools that ship a
direct executable (`tool`, `tool.js`, `tool.sh`, etc.) without an `install.sh`.
However, the packaging pipeline does not handle this case:

**`Dockerfile.agent-base` (current)**:

```dockerfile
RUN for d in /tmp/tools/*/0.0.1; do \
      if [ -f "$d/install.sh" ]; then \
        ...copy tool.json + install.sh, run install.sh... \
      fi; \
    done
```

This skips any tool that has a direct `tool` or `tool.js` but no `install.sh`.

**Proposed fix**: The Dockerfile loop should handle both cases:

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

The same fix applies to `runSourceDeploy` in
`control-plane/src/api/agents.ts`, which currently only copies `tool.json` and
`install.sh`:

```typescript
for (const file of ['tool.json', 'install.sh']) {
  // ...
}
```

This should be expanded to also copy `tool`, `tool.js`, or any `tool.*` file
(excluding `tool.json`).

### 5.2 Versioning: hardcoded `0.0.1`

The `Dockerfile.agent-base` hardcodes `0.0.1` in the glob pattern
(`/tmp/tools/*/0.0.1`). This means adding a `0.1.0` version of a tool would
require updating the Dockerfile.

**Proposed fix**: The Dockerfile should read tool versions from the same source
of truth as the runtime — `default-settings.jsonc`. During the base image build,
a build arg or a small script can resolve the correct version directory for each
tool slug. For the initial implementation, the simplest approach is to iterate
all version directories and take the highest (matching how `resolveVersionedDir`
works):

```dockerfile
RUN for slug_dir in /tmp/tools/*/; do \
      slug="$(basename $slug_dir)"; \
      version_dir="$(ls -d ${slug_dir}*/ 2>/dev/null | sort -V | tail -1)"; \
      [ -z "$version_dir" ] && continue; \
      ...package from $version_dir... \
    done
```

### 5.3 Versioning: lexicographic sort

`resolveVersionedDir` in `sdk-client-deno/src/registry.ts` uses
`versions.sort().reverse()` which is lexicographic. This means `0.0.10` sorts
before `0.0.2`. This should be fixed to use proper semver comparison. The
standard library `@std/semver` is available in Deno:

```typescript
import { compare } from '@std/semver'
versions.sort(compare).reverse()
```

### 5.4 Versioning: per-agent tool pinning

Today, all agents share the same global tool list from `default-settings.jsonc`.
There is no way for an agent to declare "use `github@0.0.2`" in its manifest.
This is acceptable for now — subsystem tools (cursor, claude, gemini) are
infrastructure-level and should be consistent across all agents in a deployment.

Per-agent tool pinning is out of scope for this RFC but noted as future work.
When needed, the `AgentManifest` type can be extended with an optional `tools`
field that overrides the global list.

### 5.5 Versioning guidance for tool authors

- **Patch versions** (`0.0.x`): Bug fixes, minor behavior changes.
- **Minor versions** (`0.x.0`): New capabilities, model upgrades (e.g. switching
  from `gemini-2.5-pro` to a newer model).
- **Major versions** (`x.0.0`): Breaking changes to the tool's interface (flags,
  env vars, stdin/stdout contract).

Tool versions are immutable once deployed. To change behavior, publish a new
version and update `default-settings.jsonc`.

---

## 6. Secrets and Credentials

### 6.1 Gemini on Vertex AI authentication

Gemini on Vertex AI uses **OAuth 2.0 access tokens** from the GCP service
account — the same authentication the runtime already uses for Cloud Run, GCS,
Secret Manager, and Cloud Build. No separate API key is needed.

For **local development**, the tool script falls back to
`gcloud auth print-access-token`, which uses Application Default Credentials.

### 6.2 No new secrets needed

Unlike Cursor (`CURSOR_API_KEY`) and Claude (`ANTHROPIC_API_KEY`), Gemini
requires no API key or secret. Authentication is handled entirely through GCP
service account credentials that are already available in the runtime
environment. The `tool.json` has `env: {}` — no secret injection needed.

The GCP project ID is already available via `GOOGLE_CLOUD_PROJECT` (set on
Cloud Run) or the metadata server. The model and location are hardcoded in the
tool script.

### 6.3 No changes to `secrets.jsonc` or `secrets.example.jsonc`

No new entries are needed. The Gemini tool is fully self-contained using existing
GCP infrastructure credentials.

---

## 7. GCP Provisioning: Vertex AI

### 7.1 Automatic API enablement

The CLI's `ar cp deploy` command already enables required GCP APIs via
`checkApis()` in `cli/src/commands/control-plane.ts`. The `REQUIRED_APIS` array
currently contains:

```
cloudbuild.googleapis.com
run.googleapis.com
secretmanager.googleapis.com
cloudfunctions.googleapis.com
cloudscheduler.googleapis.com
```

**Add `aiplatform.googleapis.com`** to this list. This ensures the Vertex AI API
is enabled automatically during initial control plane deployment, just like every
other GCP service the runtime depends on. No manual `gcloud services enable`
step is needed.

### 7.2 Automatic IAM role grant

The CLI's `ensureRoles()` function grants IAM roles to the runtime and worker
service accounts from `default-settings.jsonc`. The runtime service account
needs the `roles/aiplatform.user` role to call Vertex AI inference endpoints.

**Add `roles/aiplatform.user`** to `runtimeAccountRoles` in
`default-settings.jsonc`:

```jsonc
"runtimeAccountRoles": [
  "roles/cloudfunctions.developer",
  "roles/run.admin",
  "roles/run.invoker",
  "roles/iam.serviceAccountUser",
  "roles/secretmanager.admin",
  "roles/storage.admin",
  "roles/cloudscheduler.admin",
  "roles/artifactregistry.writer",
  "roles/cloudbuild.builds.editor",
  "roles/iam.serviceAccountTokenCreator",
  "roles/aiplatform.user"
]
```

This role grants inference access only — not model training, deployment, or
management. It is scoped to the runtime service account and follows the
principle of least privilege.

### 7.3 Worker service account

The worker service account does not need `roles/aiplatform.user`. Only the
runtime service account (which runs agent containers) calls Vertex AI. The
worker account's existing `roles/run.invoker` + `roles/storage.objectViewer`
roles are sufficient.

### 7.4 No additional configuration

Unlike Cursor and Claude which require users to obtain and store API keys,
Gemini on Vertex AI works out of the box after `ar cp deploy`. The API is
enabled, the IAM role is granted, and the tool authenticates via the metadata
server. This makes Gemini the zero-configuration subsystem option.

### 7.5 Provisioning flow (updated)

```
ar cp deploy
  → checkApis()
    → enables aiplatform.googleapis.com (NEW)
    → enables cloudbuild, run, secretmanager, etc. (existing)
  → ensureRoles()
    → grants roles/aiplatform.user to runtime SA (NEW)
    → grants existing roles (unchanged)
  → syncSecrets()
    → no new secrets for Gemini (unchanged)
  → buildBaseImage()
    → packages gemini/0.0.1/tool.js into /app/tools/gemini/ (NEW)
  → deploy Cloud Run service
```

---

## 8. Codebase Changes

### 8.1 New files

| Path                                            | Description                                |
| ----------------------------------------------- | ------------------------------------------ |
| `default-registry/tools/gemini/0.0.1/tool.js`   | Node.js script wrapping Vertex AI REST API |
| `default-registry/tools/gemini/0.0.1/tool.json` | Tool manifest                              |
| `default-registry/tools/gemini/0.0.1/README.md` | Tool documentation                         |
| `sdk-client-deno/src/subsystems.ts`             | Canonical subsystem list, types, default   |

### 8.2 Modified files

| Path                                                    | Change                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `Dockerfile.agent-base`                                 | Handle direct `tool`/`tool.js` executables; use version from settings |
| `sdk-client-deno/src/defaults/tools.ts`                 | Add gemini to `BUILTIN` array                                         |
| `sdk-client-deno/src/agent-schema.ts`                   | Import and use `Subsystem` type                                       |
| `sdk-client-deno/src/registry.ts`                       | Fix semver sort in `resolveVersionedDir`                              |
| `control-plane/src/api/agents.ts`                       | Use `SUBSYSTEMS` for validation; fix tool copy in deploy              |
| `control-plane/src/api/demos/routes.ts`                 | Use `DEFAULT_SUBSYSTEM`                                               |
| `control-plane/src/bots/slack/commands/demo.ts`         | Use `DEFAULT_SUBSYSTEM`                                               |
| `control-plane/src/bots/slack/commands/create-agent.ts` | Use `DEFAULT_SUBSYSTEM`                                               |
| `web/src/islands/demos.tsx`                             | Dynamic subsystem `<select>` from `SUBSYSTEMS`                        |
| `default-settings.jsonc`                                | Add gemini to tools list; add `aiplatform.user` to runtime roles      |
| `cli/src/commands/control-plane.ts`                     | Add `aiplatform.googleapis.com` to `REQUIRED_APIS`                    |

---

## 9. Implementation Plan

### Phase 1: Gemini tool and GCP provisioning

1. Create `default-registry/tools/gemini/0.0.1/` with `tool.js`, `tool.json`,
   and `README.md`.
2. Add gemini to `BUILTIN` in `sdk-client-deno/src/defaults/tools.ts`.
3. Add `{ "slug": "gemini", "version": "0.0.1" }` to the tools list in
   `default-settings.jsonc`.
4. Add `aiplatform.googleapis.com` to `REQUIRED_APIS` in
   `cli/src/commands/control-plane.ts`.
5. Add `roles/aiplatform.user` to `runtimeAccountRoles` in
   `default-settings.jsonc`.

### Phase 2: Tool packaging fixes

6. Update `Dockerfile.agent-base` to handle direct executables (`tool`,
   `tool.js`) alongside `install.sh`-based tools.
7. Update `Dockerfile.agent-base` to resolve tool versions dynamically instead
   of hardcoding `0.0.1`.
8. Update `runSourceDeploy` in `control-plane/src/api/agents.ts` to copy
   direct tool executables (not just `tool.json` + `install.sh`).
9. Fix `resolveVersionedDir` in `sdk-client-deno/src/registry.ts` to use
   proper semver comparison instead of lexicographic sort.

### Phase 3: Subsystem abstraction cleanup

10. Create `sdk-client-deno/src/subsystems.ts` with the canonical list.
11. Update `control-plane/src/api/agents.ts` validation to use `SUBSYSTEMS`.
12. Replace hardcoded `'cursor'` defaults with `DEFAULT_SUBSYSTEM` in:
    - `control-plane/src/api/demos/routes.ts`
    - `control-plane/src/bots/slack/commands/demo.ts`
    - `control-plane/src/bots/slack/commands/create-agent.ts`
13. Update `web/src/islands/demos.tsx` to render subsystem options dynamically.

### Phase 4: Deploy and verify

14. Run `deno task check` to verify formatting and types.
15. Deploy control plane with `deno task ar cp deploy --no-input`.
16. Verify `aiplatform.googleapis.com` is enabled and `aiplatform.user` is
    granted automatically.
17. Sync registry with `deno task ar cp sync`.
18. Create a test prompt agent with `subsystem: 'gemini'` via the web UI.
19. Verify the Gemini subsystem produces valid output.

---

## 10. Security Considerations

- **No new API keys**: Gemini on Vertex AI uses the existing GCP service account.
  This is more secure than managing a separate API key — there is no secret to
  rotate or leak.
- **IAM scoping**: `roles/aiplatform.user` is scoped to the runtime service
  account and only grants inference access, not model training or deployment.
- **Token handling**: Access tokens are obtained from the metadata server (in
  production) or `gcloud` (locally) and are short-lived (~1 hour). They are
  never stored on disk.
- **Input sanitization**: The prompt is JSON-serialized via `JSON.stringify`
  before being embedded in the request body, preventing injection.
- **Output handling**: The tool script extracts only the text content from the
  Vertex AI response. The full API response (which may contain metadata) is
  not passed through unless text extraction fails.
- **No network egress to third parties**: Unlike Cursor and Claude which call
  external APIs (Anthropic, Cursor), Gemini calls a Google Cloud endpoint
  within the same cloud environment. This may be preferable for organizations
  with strict network egress policies.

---

## 11. Open Questions

1. **Default subsystem**: Should the default remain `cursor`, or should it
   change to `gemini` given the GCP-native deployment and zero-configuration
   setup? This RFC keeps `cursor` as the default for backward compatibility.

2. **Streaming**: The current `AgentTools.run` is synchronous (`execFileSync`).
   Gemini supports streaming via `streamGenerateContent`. Should we add an
   `AgentTools.stream` method? Out of scope for this RFC but worth noting.

3. **Thinking budget**: Gemini 2.5 Pro supports a `thinkingConfig` with
   `thinkingBudget` to control internal reasoning. Should this be configurable
   per-agent? For now, the tool uses default thinking behavior.

4. **Slack subsystem flag**: Should the Slack `demo` command accept a
   `--gemini`/`--claude` flag? Deferred to a follow-up.

5. **Per-agent tool pinning**: Should agents be able to declare specific tool
   versions in their manifest? Deferred — see Section 5.4.
