# RFC-004: Configurable Runtime Name (Whitelabeling)

**Status:** Draft
**Authors:** Agent Runtime Team
**Created:** 2026-03-31

## Summary

Allow the runtime's product name, CLI binary name, data directory, environment
variable prefix, and all user-facing strings to be configured through a single
static configuration value. This enables companies to whitelabel the entire
platform under their own brand without forking the codebase.

## Motivation

The strings `ar`, `Agent Runtime`, `@ar/`, `AR_`, `~/.ar/`, and
`agent-runtime` are hardcoded across ~60+ source files, ~20+ documentation
files, build scripts, install scripts, CI workflows, and the web dashboard.
A company wanting to ship this platform under their own name (e.g. `acme`,
`Acme Platform`) currently must find-and-replace across the entire repo — a
brittle process that breaks on every upstream merge.

A centralized branding configuration solves this by making the name a runtime
value derived from a single source of truth.

## Design Principles

1. **Single source of truth** — one config object defines all name variants
2. **Zero-cost default** — the existing `ar` / `Agent Runtime` names remain the
   default; no changes for current users
3. **Build-time resolution where possible** — compiled binaries, install
   scripts, and generated docs resolve names at build time for performance
4. **Runtime resolution for the rest** — CLI help text, control plane strings,
   web dashboard title, and log output resolve names at startup from the loaded
   config
5. **Docs stay name-agnostic** — documentation templates use placeholders; the
   doc build pipeline fills in the configured name

---

## Current State: Where the Name Lives

### Category 1 — CLI Binary & Command Name

| Location | Current Value | Count |
|---|---|---|
| `cli/src/commands/help.ts` | `ar - Agent Runtime CLI`, `ar <command>` | 3 |
| `cli/src/commands/*.ts` (16 files) | `Usage: ar ...`, `Run 'ar help'` | ~80 |
| `cli/scripts/build.ts` | output `ar`, `ar-${suffix}`, `ar-control-plane` | 5 |
| `install.sh` | binary `ar-${os}-${arch}`, installs as `ar` | 7 |
| `deno.jsonc` (root + cli) | task `"ar"`, `--name=ar-cli` | 4 |

### Category 2 — Data Directory

| Location | Current Value |
|---|---|
| `sdk-client-deno/src/config.ts:81` | `join(home, '.ar')` |
| `sdk-client-deno/src/mode.ts:20` | `join(home, '.ar', 'settings.jsonc')` |
| `sdk-client-deno/src/db/mod.ts:29` | `join(registry, '.ar')` |
| `cli/src/settings.ts:67` | `join(homeDir(), '.ar')` |
| All documentation | `~/.ar/` references |

### Category 3 — Environment Variable Prefix `AR_`

| Variable | Files |
|---|---|
| `AR_MODE` | `sdk-client-deno/src/mode.ts`, `cli/scripts/build.ts`, `control-plane` |
| `AR_CONTROL_PLANE_URL` | `sdk-client-deno/src/mode.ts`, `cli/src/commands/agent.ts` |
| `AR_REGISTRY` | `control-plane/src/mod.ts`, `sdk-client-deno/src/config.ts`, `cli/` |
| `AR_DB_PATH` | `control-plane/src/mod.ts`, `sdk-client-deno/src/db/mod.ts` |
| `AR_SESSION_SECRET` | `control-plane/src/session.ts` |
| `AR_ALLOWED_DOMAINS` | `control-plane/src/middleware/auth.ts` |
| `AR_AUTH_METHOD` | `sdk-client-deno/src/platform/mod.ts`, CI workflows |
| `AR_RUNTIME_CONFIG` | `sdk-client-deno/src/runtime.ts` |
| `AR_VERBOSE` | `sdk-client-deno/src/config.ts` |
| `AR_ADMIN_GROUP` | `sdk-client-deno/src/db/users.ts` |
| `AR_BUILD_*` (6 vars) | `sdk-client-deno/src/build.ts`, `cli/scripts/build.ts` |
| `AR_PROJECT`, `AR_REGION`, etc. | `cli/src/settings.ts` |
| `AR_TOKEN`, `AR_AGENT_*`, etc. | `cli/src/commands/agent.ts` |
| `AR_CP_URL` | `web/vite.config.ts`, `deno.jsonc` |

### Category 4 — Package / Scope Names

| Package | File |
|---|---|
| `@ar/cli` | `cli/deno.jsonc` |
| `@ar/client` | `sdk-client-deno/deno.jsonc` |
| `@ar/control-plane` | `control-plane/deno.jsonc` |
| `@ar/web` | `web/deno.jsonc` |
| `@ar/sdk-agent-nodejs` | `sdk-agent-nodejs/package.json` |
| `ar-runtime-web` | `web/package.json` |

### Category 5 — Infrastructure / Service Names

| Location | Current Value |
|---|---|
| `settings.jsonc` | `"serviceName": "ar-control-plane"` |
| `control-plane/src/mod.ts` | GCS bucket `${project}-ar-registry` |
| `control-plane/src/api/system.ts` | same bucket pattern |
| `control-plane/src/session.ts` | cookie `ar_session`, secret `ar-default-session-key` |
| `control-plane/src/types.ts` | email `system@ar-cli` |
| `web/dev/fixtures/system.json` | `ar-control-plane`, `ar-registry` |
| `web/dev/singleton.ts` | `ar-singleton` |
| CI workflows | `ar-linux-x64` binary references |

### Category 6 — Display / Branding Strings

| Location | Current Value |
|---|---|
| `cli/src/commands/help.ts` | `ar - Agent Runtime CLI` |
| `web/mod.ts` | `<title>Agent Runtime Dashboard</title>`, logo alt |
| `web/index.html` | same |
| `web/mod.ts:129` | `window.__AR__` |
| `sdk-client-deno/src/utils/logger.ts` | `name: '@zackiles/ar-cli'` |
| `sdk-agent-nodejs/src/audit.ts` | `[ar-audit]` prefix |
| `skill/install.sh` | `agent-runtime` skill name |
| `skill/SKILL.md` | `name: agent-runtime` |
| `install.sh` | repo `zackiles/agent-runtime` |
| `settings.jsonc` | comment `Agent Runtime — global configuration` |

### Category 7 — Documentation

| File | References |
|---|---|
| `README.md` | ~50+ `ar` command examples, `~/.ar/`, `AR_*`, `Agent Runtime` |
| `CONTRIBUTING.md` | ~30+ references |
| `CONFIG.md` | ~25+ references |
| `AGENTS.md` | ~10 references |
| `registry/*.md` (6 files) | ~40+ references |
| `sdk-agent-nodejs/README.md` | ~10 references |
| `web/README.md` | ~5 references |
| `docs/rfc/*.md` | ~20 references |
| `skill/SKILL.md` | ~30 references |
| `cli/docs/ar-cli/` (203 files) | generated — rebuilds automatically |

---

## Proposed Solution

### 1. Branding Config in `settings.jsonc`

Add a top-level `"branding"` section to `settings.jsonc`:

```jsonc
{
  "branding": {
    "id": "ar",
    "name": "Agent Runtime",
    "org": "zackiles"
  },
  // ... rest of existing config
}
```

**Derived values** (computed, not configured):

| Derived Name | Formula | Example (default) | Example (custom) |
|---|---|---|---|
| CLI binary | `${id}` | `ar` | `acme` |
| Data directory | `.${id}` | `.ar` | `.acme` |
| Env prefix | `${ID}_` (uppercase) | `AR_` | `ACME_` |
| Package scope | `@${id}/` | `@ar/` | `@acme/` |
| CP service name | `${id}-control-plane` | `ar-control-plane` | `acme-control-plane` |
| GCS bucket suffix | `${id}-registry` | `ar-registry` | `acme-registry` |
| Cookie name | `${id}_session` | `ar_session` | `acme_session` |
| System email | `system@${id}-cli` | `system@ar-cli` | `system@acme-cli` |
| CLI user email | `cli-user@${id}-cli` | `cli-user@ar-cli` | `cli-user@acme-cli` |
| Dashboard title | `${name} Dashboard` | `Agent Runtime Dashboard` | `Acme Platform Dashboard` |
| Help banner | `${id} - ${name} CLI` | `ar - Agent Runtime CLI` | `acme - Acme Platform CLI` |
| Logger name | `@${org}/${id}-cli` | `@zackiles/ar-cli` | `@acmecorp/acme-cli` |
| Repo slug | `${org}/${id}` | `zackiles/agent-runtime` | `acmecorp/acme` |
| Install binary | `${id}-${os}-${arch}` | `ar-linux-x64` | `acme-linux-x64` |
| Window global | `__${ID}__` | `__AR__` | `__ACME__` |
| Audit prefix | `[${id}-audit]` | `[ar-audit]` | `[acme-audit]` |

### 2. Branding Module in `@ar/client`

Create `sdk-client-deno/src/branding.ts` — a new module exporting a `Branding`
object that all other code imports instead of using hardcoded strings:

```typescript
import { load as loadRuntime } from './runtime.ts'

type Branding = {
  id: string
  name: string
  org: string
  ID: string
  dataDir: string
  envPrefix: string
  scope: string
  serviceName: string
  bucketSuffix: string
  cookie: string
  systemEmail: string
  cliUserEmail: string
  dashboardTitle: string
  helpBanner: string
  loggerName: string
  repoSlug: string
  windowGlobal: string
  auditPrefix: string
}

let cached: Branding | null = null

function load(): Branding {
  if (cached) return cached
  const rc = loadRuntime()
  const { id, name, org } = rc.branding
  const ID = id.toUpperCase()
  cached = {
    id,
    name,
    org,
    ID,
    dataDir: `.${id}`,
    envPrefix: `${ID}_`,
    scope: `@${id}`,
    serviceName: `${id}-control-plane`,
    bucketSuffix: `${id}-registry`,
    cookie: `${id}_session`,
    systemEmail: `system@${id}-cli`,
    cliUserEmail: `cli-user@${id}-cli`,
    dashboardTitle: `${name} Dashboard`,
    helpBanner: `${id} - ${name} CLI`,
    loggerName: `@${org}/${id}-cli`,
    repoSlug: `${org}/${id}`,
    windowGlobal: `__${ID}__`,
    auditPrefix: `[${id}-audit]`,
  }
  return cached
}

export { load }
export type { Branding }
```

Add to `sdk-client-deno/deno.jsonc` exports:

```jsonc
"./branding": "./src/branding.ts"
```

### 3. Update `RuntimeConfig` Type

Extend the `RuntimeConfig` type in `sdk-client-deno/src/runtime.ts`:

```typescript
type RuntimeConfig = {
  branding: {
    id: string
    name: string
    org: string
  }
  // ... existing fields
}
```

`load()` should apply defaults so existing `settings.jsonc` files without a
`branding` key still work:

```typescript
const DEFAULTS = {
  branding: { id: 'ar', name: 'Agent Runtime', org: 'zackiles' },
}
```

---

## Implementation Phases

### Phase 1 — Foundation (branding module + runtime config)

**Files to create:**
- `sdk-client-deno/src/branding.ts`

**Files to modify:**
- `sdk-client-deno/src/runtime.ts` — add `branding` to `RuntimeConfig` with
  defaults
- `sdk-client-deno/deno.jsonc` — add `"./branding"` export
- `settings.jsonc` — add `"branding"` section

**Risk:** Low. Additive only — no existing behavior changes.

### Phase 2 — Environment Variable Prefix

Replace every `Deno.env.get('AR_...')` call with a helper that uses the
configured prefix. Create a thin `env` helper in the branding module:

```typescript
function env(suffix: string): string | undefined {
  const { envPrefix } = load()
  return Deno.env.get(`${envPrefix}${suffix}`)
}
```

**Files to modify (env var reads):**
- `sdk-client-deno/src/mode.ts` — `AR_MODE`, `AR_CONTROL_PLANE_URL`,
  `AR_MODE_PRODUCTION`, `AR_TENANT`
- `sdk-client-deno/src/build.ts` — `AR_BUILD_MODE`, `AR_BUILD_VERSION`,
  `AR_BUILD_COMMIT`, `AR_BUILD_AUTHOR`, `AR_BUILD_DATE`, `AR_BUILD_BRANCH`
- `sdk-client-deno/src/config.ts` — `AR_VERBOSE`, `AR_REGISTRY`
- `sdk-client-deno/src/runtime.ts` — `AR_RUNTIME_CONFIG`
- `sdk-client-deno/src/platform/mod.ts` — `AR_AUTH_METHOD`
- `sdk-client-deno/src/db/mod.ts` — `AR_DB_PATH`
- `sdk-client-deno/src/db/users.ts` — `AR_ADMIN_GROUP`
- `control-plane/src/mod.ts` — `AR_MODE`, `AR_REGISTRY`, `AR_DB_PATH`
- `control-plane/src/session.ts` — `AR_SESSION_SECRET`
- `control-plane/src/middleware/auth.ts` — `AR_ALLOWED_DOMAINS`
- `control-plane/src/middleware/tenant.ts` — `AR_REGISTRY`
- `control-plane/src/api/secrets.ts` — `AR_REGISTRY`
- `cli/src/settings.ts` — `ENV_MAP` keys
- `cli/src/commands/agent.ts` — `AR_TOKEN`, `AR_AGENT_*`, `AR_SUBSYSTEM`, etc.
- `cli/src/commands/mode.ts` — `AR_USER`
- `cli/scripts/build.ts` — `AR_BUILD_*`, `AR_MODE`
- `web/vite.config.ts` — `AR_CP_URL`

**Backward compatibility:** The `env()` helper should also check the literal
`AR_` prefixed name as a fallback so existing CI pipelines and user
environments continue to work during migration:

```typescript
function env(suffix: string): string | undefined {
  const { envPrefix } = load()
  return Deno.env.get(`${envPrefix}${suffix}`) ??
    (envPrefix !== 'AR_' ? Deno.env.get(`AR_${suffix}`) : undefined)
}
```

**Risk:** Medium. Env var reads are spread across every package. Each change
is mechanical but the surface area is large. Requires careful testing.

### Phase 3 — Data Directory & Paths

Replace hardcoded `'.ar'` path segments with `branding.dataDir`.

**Files to modify:**
- `sdk-client-deno/src/config.ts` — `join(home, '.ar')` →
  `join(home, branding.dataDir)`
- `sdk-client-deno/src/mode.ts` — same
- `sdk-client-deno/src/db/mod.ts` — same
- `cli/src/settings.ts` — same

**Risk:** Low-medium. Four call sites, well-isolated.

### Phase 4 — CLI Help Text & User-Facing Strings

Replace hardcoded `ar` in help text, usage strings, and prompts.

**Files to modify:**
- `cli/src/commands/help.ts` — banner and all `ar <command>` references
- `cli/src/commands/agent.ts` — ~15 usage/hint strings
- `cli/src/commands/control-plane.ts` — ~5 display strings
- `cli/src/commands/quickstart.ts` — ~4 strings
- `cli/src/commands/tool.ts` — ~5 strings
- `cli/src/commands/trigger.ts` — ~5 strings
- `cli/src/commands/secret.ts` — ~3 strings
- `cli/src/commands/team.ts` — ~3 strings
- `cli/src/commands/department.ts` — ~3 strings
- `cli/src/commands/connect.ts` — ~1 string
- `cli/src/commands/registry.ts` — ~3 strings
- `cli/src/commands/rule.ts` — ~5 strings
- `cli/src/commands/skill.ts` — ~5 strings
- `cli/src/commands/copy.ts` — ~1 string
- `cli/src/commands/mode.ts` — ~2 strings
- `cli/src/commands/runtime.ts` — ~2 strings

**Approach:** Import `branding` at the top of each command file and use
template literals: `` `${b.id} <command> [args]` `` instead of
`'ar <command> [args]'`.

**Risk:** Medium. Many files, but each change is a simple string replacement.

### Phase 5 — Infrastructure Names

Replace hardcoded service names, bucket patterns, cookie names, and identity
strings.

**Files to modify:**
- `settings.jsonc` — `"serviceName"` default becomes
  `"${branding.id}-control-plane"` (resolved at load time)
- `control-plane/src/session.ts` — cookie name and default secret
- `control-plane/src/types.ts` — system email
- `control-plane/src/mod.ts` — bucket pattern
- `control-plane/src/api/system.ts` — bucket pattern
- `control-plane/src/api/registry.ts` — bucket pattern
- `control-plane/src/api/storage.ts` — bucket pattern
- `sdk-client-deno/src/utils/logger.ts` — logger name
- `sdk-agent-nodejs/src/audit.ts` — audit prefix

**Risk:** Medium. Bucket names affect live GCP resources. Migration guidance
needed (see Migration section below).

### Phase 6 — Web Dashboard

Replace hardcoded display strings in the web shell and dev fixtures.

**Files to modify:**
- `web/mod.ts` — title, logo alt text, `window.__AR__` global name
- `web/index.html` — same (for Vite dev)
- `web/src/entry.ts` — `__AR__` references
- `web/src/context.ts` — `__AR__` references
- `web/dev/fixtures/system.json` — mock service names
- `web/dev/singleton.ts` — mock name
- `web/dev/mock.ts` — mock name

**Approach for `window.__AR__`:** The global name becomes
`window[branding.windowGlobal]`. The control plane injects the branding config
into the HTML shell so client JS can read it. For the Vite dev server, the
global name is set via `vite.config.ts` define.

**Risk:** Low-medium. Web is self-contained; changes are cosmetic.

### Phase 7 — Build Scripts & Install Script

**Files to modify:**
- `cli/scripts/build.ts` — binary output names (`ar` → `branding.id`,
  `ar-control-plane` → `branding.serviceName`)
- `install.sh` — `REPO`, binary name, install messages
- `skill/install.sh` — skill name, repo slug
- `.github/workflows/release.yml` — artifact names
- `.github/workflows/ci.yml` — binary path references

**Approach for `install.sh`:** The install script must be self-contained (no
Deno runtime). Two options:

- **Option A (recommended):** The build pipeline generates an `install.sh` from
  a template, injecting the branding values at build time.
- **Option B:** `install.sh` accepts `RUNTIME_ID` and `RUNTIME_REPO` env vars
  with defaults:

```sh
RUNTIME_ID="${RUNTIME_ID:-ar}"
REPO="${RUNTIME_REPO:-zackiles/agent-runtime}"
binary="${RUNTIME_ID}-${os}-${arch}"
```

**Risk:** Medium. CI workflows and release pipelines need coordinated updates.

### Phase 8 — Documentation

**Strategy:** Docs become name-agnostic using placeholder tokens that the doc
build replaces. This keeps markdown files readable while allowing the final
rendered docs to show the correct product name.

**Placeholder tokens:**

| Token | Replaced With | Example |
|---|---|---|
| `{{id}}` | `branding.id` | `ar` |
| `{{name}}` | `branding.name` | `Agent Runtime` |
| `{{dataDir}}` | `branding.dataDir` | `.ar` |
| `{{envPrefix}}` | `branding.envPrefix` | `AR_` |
| `{{scope}}` | `branding.scope` | `@ar` |
| `{{org}}` | `branding.org` | `zackiles` |

**Files to modify:**
- `README.md`
- `CONTRIBUTING.md`
- `CONFIG.md`
- `AGENTS.md`
- `TODO.md`
- `registry/*.md` (6 files)
- `sdk-agent-nodejs/README.md`
- `web/README.md`
- `skill/SKILL.md`
- `docs/rfc/*.md` (2 existing RFCs)

**Doc build pipeline:** Add a `deno task docs:render` step that reads each
`.md` file, replaces `{{tokens}}`, and writes to a `docs/rendered/` output
directory. The raw source files keep the tokens; rendered output (or the
GitHub-facing README) uses the resolved names.

**Alternative (simpler):** For the default `ar` branding, keep docs as-is with
literal `ar` values. Provide a `scripts/rebrand.ts` script that performs a
full find-and-replace across docs when whitelabeling. This avoids the
complexity of a template pipeline at the cost of requiring the script to run
after branding changes.

**Recommendation:** Start with the simpler alternative (literal values +
rebrand script) for Phase 8. Move to the template pipeline only if multiple
whitelabel deployments need to coexist in the same repo.

**Risk:** Low. Documentation changes are non-breaking.

### Phase 9 — Package Names (Optional / Advanced)

Deno workspace package names (`@ar/client`, `@ar/cli`, etc.) are internal
workspace identifiers. Changing them requires updating every `import` statement
across the codebase. This is high-effort and provides minimal user-facing value
since end users interact with the compiled binary, not the source packages.

**Recommendation:** Defer this phase. Package names are an internal
implementation detail. If a whitelabel customer needs different package names
(e.g., for publishing to a private registry), provide it as a
`scripts/rebrand.ts` batch operation rather than runtime configuration.

**If pursued:**
- Update all 5 `deno.jsonc` / `package.json` files with new names
- Update all ~50+ files with `@ar/` import paths
- Update `sdk-agent-nodejs/package.json` and its `package-lock.json`

**Risk:** High. Touches every source file. Recommend deferring.

---

## Migration & Backward Compatibility

### Environment Variables

When a custom branding `id` is configured, the `env()` helper checks both the
new prefix and the legacy `AR_` prefix. This allows existing CI pipelines and
user configs to continue working. A deprecation warning is logged when a legacy
variable is used:

```
[WARN] Environment variable AR_MODE is deprecated.
       Use ACME_MODE instead (branding.id = "acme").
```

### Data Directory

When a user changes their branding `id`, their existing `~/.ar/` directory is
not automatically renamed. The CLI `init` command should detect and offer to
migrate:

```
Found existing data at ~/.ar/ but branding.id is "acme".
Migrate data to ~/.acme/? [Y/n]
```

### GCS Buckets

Existing GCS buckets follow the `${project}-ar-registry` pattern. Changing the
branding `id` creates new bucket names. The `cp deploy` command should document
that existing data must be migrated manually or via `gsutil`.

### Cookie Name

Changing the cookie name logs out all existing web dashboard sessions. This is
acceptable for a branding change (one-time event).

---

## File Change Summary

| Phase | Files Created | Files Modified | Risk |
|---|---|---|---|
| 1 — Foundation | 1 | 3 | Low |
| 2 — Env Prefix | 0 | ~18 | Medium |
| 3 — Data Dir | 0 | 4 | Low-Medium |
| 4 — CLI Strings | 0 | ~16 | Medium |
| 5 — Infra Names | 0 | ~9 | Medium |
| 6 — Web Dashboard | 0 | ~7 | Low-Medium |
| 7 — Build/Install | 0 | ~5 | Medium |
| 8 — Documentation | 1 script | ~15 | Low |
| 9 — Package Names | 0 | ~55 | High (defer) |
| **Total** | **2** | **~77** (excl. phase 9) | |

---

## Testing Strategy

1. **Unit tests** — new `branding.ts` module: verify all derived values for
   default and custom configs
2. **Integration test** — set `branding.id` to a test value, run the CLI, and
   verify:
   - Help text uses the custom name
   - Data directory resolves to `~/.${testId}/`
   - Env vars with the custom prefix are read correctly
   - Legacy `AR_` prefix env vars still work with deprecation warning
3. **Build test** — run `deno task build` with custom branding and verify
   output binary names match the configured `id`
4. **Web test** — verify dashboard title and `window.__X__` global use the
   configured name
5. **Smoke test** — the existing `smoke-demo-agent.test.ts` should pass
   unmodified with default branding

---

## Open Questions

1. **Should env var prefix be configurable at all?** Changing `AR_` to
   `ACME_` is powerful but adds migration complexity. An alternative is to
   keep `AR_` as a permanent internal prefix and only whitelabel user-facing
   strings. This significantly reduces scope (eliminates Phase 2) at the cost
   of exposing the `AR_` origin to ops teams.

2. **Should `install.sh` be templated or parameterized?** Templating produces
   a cleaner script but requires a build step. Parameterization with env var
   defaults is simpler but less elegant.

3. **Should generated HTML docs (`cli/docs/ar-cli/`) be committed?** They are
   currently tracked. With whitelabeling, the doc output directory name
   changes. Consider gitignoring them and generating on demand.

4. **Should the `window.__AR__` global be renamed at all?** It is an internal
   API between the server-rendered shell and client JS. Renaming it adds
   complexity for minimal user-facing benefit. Consider keeping `__AR__` as
   the permanent internal name regardless of branding.

---

## Recommended Implementation Order

```
Phase 1 (Foundation) ──→ Phase 3 (Data Dir) ──→ Phase 4 (CLI Strings)
                    └──→ Phase 2 (Env Prefix)
                                                  ↓
Phase 5 (Infra Names) ──→ Phase 6 (Web) ──→ Phase 7 (Build/Install)
                                                  ↓
                                           Phase 8 (Docs)
```

Phases 1–4 can be shipped as a first milestone. Phases 5–8 follow as a second.
Phase 9 is deferred indefinitely unless a concrete need arises.
