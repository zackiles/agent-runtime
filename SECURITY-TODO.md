# Security Audit — TODO

Full audit across `control-plane/`, `cli/`, `sdk-client-deno/`, `sdk-agent-nodejs/`,
`web/`, and `default-registry/`.

---

## HIGH

### 1. Agent Deploy Endpoint Missing Authorization Check

**File:** `control-plane/src/api/agents.ts:288-334`

`POST /:id/deploy` never calls `canWriteAgent`. Every other mutation in this
file checks it (`PUT`, `DELETE`, `PUT /version`, `POST /versions`,
`DELETE /versions/:version`), and the equivalent registry deploy in
`registry.ts` checks `canWrite`. This is an inconsistency — an authenticated
tenant user could upload a source archive to another user's agent.

The "create if not exists" behavior (lines 291-299) is intentional for CLI-first
workflows where the agent record may not exist yet, and sets `createdBy` to the
caller, which is fine. The gap is only when the agent **already exists** and
belongs to someone else.

**Fix:** When the agent already exists, check `canWriteAgent(tenantId,
agent.id, email)` before allowing the upload. The create-if-missing path is fine
as-is since it sets `createdBy: email`.

---

### 2. Registry Clone Without Source Authorization

**File:** `control-plane/src/api/registry.ts:125-134`

`cloneEntity` calls `getEntity(table, sourceId, tenantId)` which fetches by
`id + tenant_id` without checking visibility or ownership. If a user knows the
UUID of another user's private tool/skill/rule, they can clone it.

In practice, UUIDs are not exposed to non-owners through the list APIs (which
filter by visibility), so exploitation requires guessing or leaking a UUID. But
the inconsistency with `deploy` and `delete` (which both check `canWrite`) makes
this worth fixing.

**Fix:** Add `canRead(tenantId, table, id, email)` before cloning. This is
consistent with the existing access model — public entities remain freely
clonable, private ones require ownership or admin.

---

### 3. Slack Identity Resolution IDOR

**File:** `control-plane/src/api/bots/slack/identity.ts:8-14`

`/resolve` uses `X-Slack-User-Email || sessionEmail`. On the SA bearer path,
this header is verified against `slack_identity` in `slackBotAuth`, so the
header is trustworthy there. On the cookie fallback path, any authenticated user
can pass an arbitrary email and receive another user's Slack metadata.

The data exposed (`slackUserId`, `slackTeamId`, `displayName`) is low
sensitivity, but it's an unnecessary information leak.

**Fix:** On the cookie-auth path, always use `sessionEmail`. Only honor
`X-Slack-User-Email` when the request came through the SA bearer path. The
middleware already sets different context for each path — use that distinction.

---

## MEDIUM

### 4. OAuth `id_token` Not Verified on Callback

**File:** `control-plane/src/api/auth.ts:55-58`

The `id_token` is decoded with `atob` without signature verification. However,
the token comes directly from Google's token endpoint over a TLS-authenticated
POST that includes the `client_secret`. This is a server-to-server call — not a
client-supplied token. Google's OIDC spec explicitly permits skipping validation
when the token is received directly from the token endpoint over TLS (see
[OpenID Connect Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)).

The risk requires MITM on the TLS connection to `oauth2.googleapis.com`, which
is extremely unlikely in a Cloud Run environment. Still worth adding for defense
in depth, since `verifyJwt()` already exists in the same codebase.

**Fix:** Reuse `verifyJwt()` from `middleware/auth.ts` to validate the
`id_token`. Minimal effort for meaningful defense in depth.

---

### 5. No `state` Parameter on OAuth Login (Login CSRF)

**File:** `control-plane/src/api/auth.ts:16-25`

No `state` parameter in the Google OAuth redirect. The practical impact is
limited: an attacker could force a victim to log in under the attacker's Google
account, but cannot use this to access the victim's data (the session is tied to
whichever Google account completes the flow). The worst case is the victim
unknowingly performing actions under the wrong identity.

The Slack OAuth flow already uses signed `state` via `session.encode()`, so the
pattern exists.

**Fix:** Reuse the same `session.encode()`/`decode()` pattern from Slack OAuth.
Generate a signed state cookie on `/login`, pass it as `state` to Google, and
verify it on `/callback`.

---

### 6. Default Session Secret

**File:** `control-plane/src/session.ts:9`

`AR_SESSION_SECRET` falls back to `'ar-default-session-key'` when unset. This is
documented in `docs/iam.md` as a known insecure default that must be set in
production. The deploy pipeline (`ar cp deploy`) always syncs secrets from
`secrets.jsonc` to Secret Manager and sets them as env vars on Cloud Run, so
production deployments should always have this set.

The risk is a misconfigured deployment where the secret is accidentally omitted.

**Fix:** At startup, when the process detects it is running on Cloud Run (check
for `K_SERVICE` env var, which Cloud Run always sets), refuse to start if
`AR_SESSION_SECRET` is not set. This is more reliable than checking `AR_MODE`
since `K_SERVICE` is set by the platform itself and cannot be accidentally
omitted.

---

### 7. JWT Audience Not Enforced When `AR_AUDIENCE` Unset

**File:** `control-plane/src/middleware/auth.ts:109-116`

When `AR_AUDIENCE` is not set, any valid Google-signed JWT is accepted. In
practice, the CLI sends identity tokens with the Cloud Run URL as audience
(when using `--audiences`), and user-mode `gcloud` sends tokens with the gcloud
client ID. The `AR_ALLOWED_DOMAINS` check still restricts which email domains
are accepted.

The audience check adds defense against token reuse from other services in the
same org. Worth enforcing.

**Fix:** Same approach as the session secret — when `K_SERVICE` is set (Cloud
Run), derive the default audience from `K_SERVICE` + `K_REVISION` or the Cloud
Run URL rather than silently skipping the check. For local development, audience
enforcement can remain optional.

---

### 8. Path Traversal on Static File Serving

**File:** `control-plane/src/api/web.ts:20-24`, `web/mod.ts:267-279`

The original assessment overstated this. HTTP clients and `new URL()` normalize
`../` sequences **before** the request reaches the handler. A request like
`GET /web/static/../../etc/passwd` is normalized to `GET /etc/passwd` by the
HTTP layer, which no longer matches the `/web/static/*` route pattern, so the
handler never runs.

The remaining vector is percent-encoded dots (`%2e%2e/%2e%2e/`), which `new
URL()` also resolves. Double-encoded slashes (`..%2F..%2F`) stay encoded but
are treated as literal characters by the filesystem — `Deno.readFile` would look
for a file literally named `..%2F..%2F...` inside `dist/`, which doesn't exist.

The residual risk is low, but adding a `startsWith(dist)` check is trivial and
eliminates any edge cases.

**Fix:** After computing the full path, resolve it and verify
`resolved.startsWith(dist)`. Return 403 if not. Trivial defense in depth.

---

### 9. Unauthenticated Webhook Endpoint

**File:** `control-plane/src/mod.ts:88-116`

`POST /webhook/:id` is intentionally unauthenticated — webhooks from external
systems (GitHub, Stripe, etc.) need to POST without a Google JWT. Security is
based on the UUID being unguessable (UUID v4 = 122 bits of entropy).

The response leaks `agentId` and `webhookId`, but these are already known to the
webhook creator. The larger concern is that the handler currently doesn't
actually invoke the agent — it just acknowledges receipt. When invocation is
added, HMAC verification should be considered.

**Fix:** Remove `agentId` from the response (the caller doesn't need it). When
agent invocation is added, implement optional per-webhook HMAC verification
(configurable since not all webhook providers support signing). Consider rate
limiting by webhook ID.

---

### 10. Session Payload Not Encrypted

**File:** `control-plane/src/session.ts:34-42`

The session cookie contains the user's email in base64. The email is readable
from browser DevTools. However, the user already knows their own email, and the
`Secure` + `HttpOnly` flags prevent access from JavaScript and non-HTTPS
contexts. A CDN or proxy intermediary could read it, but in the Cloud Run model,
TLS terminates at the Google front-end — there are no intermediaries.

Encryption adds complexity (key management, IV generation, increased cookie
size) with limited practical benefit in this deployment model.

**Fix:** LOW priority. If needed in the future, use AES-GCM with a key derived
from `AR_SESSION_SECRET`. For now, the HMAC integrity guarantee is sufficient
given the `Secure`/`HttpOnly`/`SameSite=Lax` flags and the Cloud Run TLS model.

---

### 11. Markdown Preview XSS via Code Fence Content

**File:** `web/src/islands/agents.tsx:1422-1479`

The `renderMarkdown` function escapes `<`, `>`, `&` globally **first** (lines
1423-1426), then the code-fence regex captures from the already-escaped string.
Because `<` is already `&lt;` before the regex runs, a code fence containing
`</code><img onerror=...>` would actually be captured as
`&lt;/code&gt;&lt;img...` — which renders as harmless text, not executable HTML.

The `lang` capture is restricted to `\w*` (alphanumeric + underscore only), so
injection through the language tag is not possible either.

The escape-first approach is unconventional but effectively prevents XSS in this
specific implementation. The risk is in future modifications that change the
replacement order.

**Fix:** LOW priority. The current code is safe but fragile. If this component
is modified, consider switching to a proper markdown library (marked +
DOMPurify) to make the safety guarantees explicit and maintainable.

---

### 12. Tar Extraction Path Traversal in CLI Deploy

**File:** `cli/src/commands/control-plane.ts:181-220`

The tar archive is extracted from a **self-embedded binary** — it's the
compiled control plane packed into the CLI release artifact. The archive content
is built by the project's own CI pipeline (`release.yml`), not from user input.
An attacker cannot supply a crafted archive unless they compromise the CI
pipeline or the release binary.

This is not a practical vulnerability in the current workflow. However, if the
extraction function is ever reused for user-supplied archives, it would become
one.

**Fix:** LOW priority. Add a defensive check (`resolved.startsWith(destDir)`)
as a safeguard against future reuse. No urgency since the input is self-authored.

---

### 13. Tenant Not Bound to User Identity

**File:** `control-plane/src/middleware/tenant.ts:11-16`

This is by design. `docs/iam.md` explicitly states: "There is no per-tenant
authorization gate — any authenticated user can access any tenant by setting the
header. Isolation is by database separation, not per-tenant authorization."

The system uses `AR_ALLOWED_DOMAINS` to restrict which email domains can
authenticate at all. Within an allowed domain, all users can access all tenants.
This is appropriate for an internal-org tool where tenants represent
environments (dev, staging, prod) rather than separate customers.

If multi-org tenancy is needed in the future, this becomes a genuine requirement.

**Fix:** No action needed for current use case. If multi-org tenancy is added,
implement a `tenant_member` table and check membership in `resolveTenant`.

---

### 14. Cross-Tenant Copy Without Target Authorization

**File:** `control-plane/src/api/copy.ts:48-69`

By design — consistent with the documented tenant model. Any authenticated user
can already access any tenant's data directly by switching `X-Tenant`. A
cross-tenant copy does not grant additional capabilities beyond what the tenant
model already allows. A code comment has been added to the file.

See `docs/iam.md` for the tenant isolation design.

**Fix:** No action needed. Revisit if the tenant model changes.

---

### 15. Access Callback Trusts Unsigned Client Context

**File:** `control-plane/src/api/access/routes.ts:125-195`

`POST /callback` is behind `apiAuth` (caller must be authenticated), but the
`context` field is a base64-decoded JSON blob from the client with no signature
or server-issued nonce. There is no check that it originated from a prior grant
step. An authenticated user can craft arbitrary context with `data` key/value
pairs to trigger `secretCreate` / `secretAddVersion` for names under the
`access-{resource}-*` prefix, and update grant status for any `grantId` they
own.

This is the most impactful remaining MEDIUM because it enables Secret Manager
writes driven by user-crafted input.

**Fix:** Sign the context server-side when issuing it (e.g., HMAC over the
JSON payload with `AR_SESSION_SECRET`), or look up the grant from server-side
storage and only allow callback data that matches a pending grant's expected
resource/scope.

---

### 16. Secrets Exposed in Cloud Run Env Vars and CLI Args

**Files:** `cli/src/commands/control-plane.ts:663-669`,
`cli/src/commands/bot.ts:214-226`

`syncSecrets` correctly uses `gcloud secrets versions add --data-file=-` with
stdin — secret values never appear in argv there. However, the deploy step
writes all resolved secrets into `env.yaml` and uses `--env-vars-file`, so the
control plane receives secrets as plain env vars (visible in GCP Console and
`gcloud` output). The agent deploy path uses `--set-secrets` (Secret Manager
refs) — the control plane path is weaker than that.

`bot.ts` is worse: it passes Slack tokens directly in `--update-env-vars=...`
CLI arguments, exposing them in process listings and shell history.

**Fix:** For `bot.ts`, use `--set-secrets` or `--update-secrets` with Secret
Manager references instead of `--update-env-vars` with raw values. For the
control plane, consider migrating to `--set-secrets` for sensitive values
(OAuth secrets, session secret, Slack credentials) while keeping non-sensitive
config in env vars.

---

### 17. No CSP or Security Headers

**File:** `web/mod.ts:115-259`

The HTML shell has no `Content-Security-Policy`, `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` headers.
Cloud Run does not add these automatically. The server-rendered HTML does use
`escScript` and `escAttr` for user data, which reduces XSS risk, but CSP
provides defense in depth against script injection from other sources.

**Fix:** Add security headers in the `renderPage` response. At minimum:
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`. A `Content-Security-Policy`
with `default-src 'self'` can be added when the inline script in the shell is
moved to a nonce or external file.

---

### 18. System Reset Has No Confirmation

**File:** `control-plane/src/api/system/routes.ts:108-180`

`POST /reset` is admin-only and behind `apiAuth`. For cookie-authenticated
requests, `SameSite=Lax` prevents cross-site POST from sending the session
cookie, which mitigates classical CSRF. The remaining risk is a same-site
attacker, a leaked Bearer token, or a compromised admin account.

Given the destructive nature (deletes all GCS objects, demos, and the SQLite
database), a confirmation body adds meaningful protection against accidental or
scripted misuse.

**Fix:** Require a confirmation body: `{"confirm": "RESET-<tenantId>"}`. This
prevents accidental invocation and scripted attacks that don't know the tenant
ID in advance.

---

### 19. Docker Runs as Root with `-A` Permissions

**File:** `Dockerfile:43`

No `USER` directive. `-A` grants all Deno permissions. `--unstable-ffi` is
required for the SQLite FFI binding (`@db/sqlite`).

Cloud Run runs containers in a gVisor sandbox, which limits host impact compared
to bare metal. Root inside the container is not equivalent to root on the host.
However, least-privilege inside the container still reduces blast radius if the
app or a dependency is compromised.

**Fix:** Add a non-root user (`adduser --disabled-password app && USER app`).
Replace `-A` with explicit permissions: `--allow-net --allow-read=/app,/data
--allow-write=/data --allow-env --unstable-ffi`. The FFI flag is unavoidable
for SQLite.

---

### 20. Error Messages Leak Internal Details

**Files:** `control-plane/src/api/access/routes.ts`,
`control-plane/src/api/demos/routes.ts`, and others

Catch blocks return `err.message` to the client. These errors often come from
GCP API calls and can include resource names, API reasons, and internal paths.
They are not full stack traces, but expose more than a user needs to see.

**Fix:** Map 5xx errors to a generic `"Internal error"` response. Log the
original `err.message` server-side for debugging. Let 4xx validation errors
remain user-facing since they describe client mistakes.

---

### 21. Tool Execution: Environment & PATH Handling

**File:** `sdk-agent-nodejs/src/tools.ts:78-90`

When `tc.env` has entries, `resolveEnv` correctly uses `PASSTHROUGH_VARS` and
only exposes configured env vars. The full `process.env` inheritance only
happens when `tc.env` is empty/missing — which is the "trust the tool" case for
tools that don't declare env restrictions.

The `install` path (line 78-85) always inherits full `process.env` regardless
of config. The `name` fallback in `resolveBinary` returns the tool slug (from
curated config, not user HTTP input), which would be looked up on PATH — a
misconfiguration issue, not an injection vector.

**Fix:** Use `PASSTHROUGH_VARS` for install scripts too. Throw an error instead
of falling back to `name` when the binary is not found — a clear error is better
than an unexpected PATH resolution.

---

### 22. No CORS Policy

**File:** `control-plane/src/mod.ts`

Hono does not enable CORS by default. Without `Access-Control-Allow-*` headers,
browsers enforce same-origin policy — which is **more restrictive** than an
explicit CORS policy. The web client uses relative URLs (`BASE = ''`), so all
API requests are same-origin by default. Same-origin requests bypass CORS
entirely.

This is only a gap if someone configures `VITE_API_URL` to point to a different
origin, which would require explicit CORS headers to work.

**Fix:** LOW priority. If split-origin deployment is supported in the future,
add Hono CORS middleware with an origin allowlist. For same-origin deployment,
the current behavior is correct and restrictive.

---

### 23. Demo Services Visibility Naming

**File:** `control-plane/src/api/demos/deploy.ts:91-124`

"Private" demos get `allAuthenticatedUsers` (any Google account), "public" gets
`allUsers`. This is by design — demos are meant to be preview environments with
broad access. The word "private" is misleading but the behavior matches the
demo use case (semi-public preview, not tenant-private isolation).

**Fix:** LOW priority. Consider renaming "private" to "authenticated" in the UI
and API to set correct expectations. The current IAM behavior is intentional
for the demo feature.

---

### 24. Config Defaults Override Environment Variables

**File:** `sdk-client-deno/src/config.ts:426-431`

`DEFAULT_VALUES` spread last overrides env vars for matching keys. Later merge
steps (`.env` files, `--config`) do override defaults, so the issue is limited
to keys that are set in the OS environment but not in any config file. In
practice, this affects edge cases like `DENO_ENV` but not security-critical
runtime secrets (which are set via config files or Cloud Run env, not bare OS
env).

**Fix:** LOW priority. Reverse the merge so env vars win over defaults. This is
a correctness/surprise issue rather than a security exploit.

---

### 25. Webhook URL Stored Without Validation

**File:** `sdk-client-deno/src/db/configs.ts:36-55`

The webhook system is **inbound** — external services POST to
`/webhook/:id`. The stored URL is metadata, not a target for server-side fetch.
No code in the current codebase reads the stored `url` and makes outbound
requests to it. The SSRF label does not match the actual behavior.

**Fix:** LOW priority. Validate URL format for product/UX reasons if desired.
The SSRF concern is theoretical — there is no outbound fetch path for these
URLs.

---

### 26. Overly Broad GCP IAM Roles

**File:** `default-settings.jsonc:42-55`

The broad roles (`secretmanager.admin`, `storage.admin`) apply to the **admin
SA** (`agent-runtime-sp`) used for provisioning only. The **worker SA**
(`agent-worker-sp`) has only `run.invoker` + `logging.logWriter`, with
per-secret `secretAccessor` granted individually. This separation is documented
in `docs/iam.md`.

For the admin SA's provisioning role, `secretmanager.admin` and `storage.admin`
are the most practical choices — narrower roles would require custom role
management per project.

**Fix:** LOW priority. Acceptable for a provisioning identity. If the GCP
project hosts other workloads, consider IAM conditions to scope to specific
resource prefixes.

---

### 27. No Input Schema Validation on API Endpoints

**Files:** `control-plane/src/api/secrets.ts`, `configs.ts`, `agents.ts`

TypeScript `as` assertions are not runtime checks, but the downstream functions
(`secretSet`, `createWebhook`, `create`) only read known fields — extra
properties are silently ignored, not stored. Missing required fields cause
clear runtime errors (e.g., "name required" from validation in the operation
layer).

This is a code quality issue, not a mass-assignment or injection vulnerability.

**Fix:** LOW priority. Add Zod/Valibot for better error messages and to reject
unknown fields. Not urgent since downstream functions already filter to known
properties.

---

### 28. `agent_edge.ref_type` Used as Table Name in SQL

**File:** `sdk-client-deno/src/db/copy.ts:134-136`

The dynamic SQL only runs for `ref_type` values of `skill` or `rule` (lines
126-131 branch on known types). Other `ref_type` values hit a generic branch
that does not use dynamic table names. Inserts into `agent_edge` come from
controlled code paths in `agents.ts`, not raw HTTP input.

An invalid table name would cause a SQLite error, not data leakage. This is
a defense-in-depth concern, not an exploitable injection.

**Fix:** LOW priority. Add an allowlist check before the dynamic query for
clarity, but the current branching logic already limits which values reach the
dynamic SQL.

---

### 29. Registry Owner List Exposed

**File:** `control-plane/src/api/registry.ts` — `GET /:id/owners`

Returns owner email addresses for any entity to any authenticated tenant member.
In a single-org internal tool where all users share the same domain and Slack
workspace, owner visibility is generally expected — you need to know who to
contact about a tool or agent.

**Fix:** LOW priority. Gate behind `canRead` if private entity owner lists
should be hidden. For most internal-org deployments, this is informational and
expected.

---

### 30. Slack Timestamp NaN Edge Case

**File:** `control-plane/src/bots/slack/mod.ts:20-21`

The HMAC check is the actual authentication mechanism. A missing/invalid
timestamp only weakens replay protection — and replaying a message still
requires a valid HMAC, which requires `SLACK_SIGNING_SECRET`. Slack always sends
the timestamp header, so a missing one means the request is not from Slack (and
will fail HMAC).

**Fix:** LOW priority. Add `if (isNaN(ts)) return false` for spec compliance
with Slack's reference implementation. Not exploitable in practice.

---

### 31. Slack `/verify` User Enumeration

**File:** `control-plane/src/api/bots/slack/identity.ts:40-112`

Behind `slackBotAuth`. On the cookie path, an authenticated internal user can
probe whether other org emails are enrolled in Slack integration. In an org
where everyone shares the same Slack workspace, enrollment status is not
meaningfully sensitive.

**Fix:** LOW priority. If enrollment status is sensitive, restrict
`X-Slack-User-Email` to the SA bearer path only. For most internal deployments,
this is not a meaningful information leak.

---

## LOW

### 32. Agent SDK Uses `x-user-email` / `x-user-id` Headers for Session

**File:** `sdk-agent-nodejs/src/bootstrap.ts:91-94`

These headers populate `AgentSession` but are not set by the control plane when
invoking agents — the CP puts user identity in the JSON body instead. The
headers default to `"unknown"` in practice. Agent Cloud Functions are deployed
with `--no-allow-unauthenticated`, so only IAM-authorized invokers can call
them. Spoofing these headers requires being an authorized invoker already.

**Fix:** If agent logic ever uses `AgentSession.email` for authorization
decisions, derive identity from the verified OIDC token instead.

---

### 33. No Rate Limiting on Auth Endpoints

OAuth login redirects to Google (which has its own rate limiting). The callback
exchanges a one-time code. Bearer token verification runs Google JWKS
validation (CPU cost, not credential brute-force). Cloud Run has concurrency
and instance limits. For an internal-org tool behind `AR_ALLOWED_DOMAINS`, the
realistic threat is DoS, not auth bypass.

**Fix:** Consider Cloud Armor or API Gateway rate limiting for public-facing
deployments. Not urgent for internal-org use.

---

### 34. `innerHTML` in Generated CLI Docs

**File:** `cli/docs/ar-cli/search.js:110-136`

The search index is generated by `deno doc --html` from the project's own
TypeScript source — not from user input. An XSS vector would require malicious
content in the project's own type definitions, which is a supply-chain concern,
not a runtime vulnerability.

**Fix:** Informational. Use `textContent` if you want to harden the generated
docs as a general practice.

---

### 35. No Payload Size Limits

**Files:** `control-plane/src/api/storage.ts`,
`control-plane/src/api/telemetry.ts`

Cloud Run enforces a 32MB default request body limit at the platform level.
Application-level limits would only be needed for tighter per-route constraints
(e.g., limiting telemetry payloads to 1MB for fairness).

**Fix:** Optional. Add per-route limits if specific endpoints need tighter
constraints than Cloud Run's 32MB default.

---

### 36. Redaction Patterns Are Best-Effort

**File:** `sdk-agent-nodejs/src/security.ts`

`AgentSecurity` is a best-effort log sanitizer, not a security boundary. Secrets
are delivered to agents via env vars and Secret Manager (`AgentSecrets`), not
through request bodies that pass through redaction. The redaction layer catches
accidental leakage in tool I/O — it was never designed to be a comprehensive
secret detection engine.

**Fix:** Informational. Expand patterns as needed for new integrations. Document
as best-effort in the SDK README.

---

### 37. Audit Log Has No Tamper Protection

**File:** `sdk-client-deno/src/db/audit.ts`

The audit database is SQLite on the Cloud Run container filesystem, accessible
only to the control plane process. Modifying audit entries requires the same
level of access as modifying any other application data — at which point all
bets are off regardless of audit protections.

**Fix:** Only relevant if compliance requirements demand non-repudiation. For
that, ship audit logs to an external append-only store (e.g., Cloud Logging,
BigQuery).

---

### 38. First-User Admin Race Condition

**File:** `sdk-client-deno/src/db/users.ts:25-36`

`ensure()` is fully synchronous (no `await`), so on a single Deno worker, two
requests cannot interleave the SELECT/COUNT/INSERT sequence. The documented
`maxInstances: 1` in `default-settings.jsonc` prevents multiple Cloud Run
instances with separate DB files. SQLite serializes writes within a process.

**Fix:** Only relevant if `maxInstances` is raised above 1 or `ensure()` becomes
async. Under the current deployment model, this race cannot occur.

---

### 39. CI Actions Pinned to Major Version Tags

**Files:** `.github/workflows/ci.yml`, `release.yml`, `test-deno.yml`

All actions used are first-party (GitHub `actions/*`), Google-maintained
(`google-github-actions/*`), or official org (`denoland/*`). The only
third-party action is `softprops/action-gh-release@v2`. SHA pinning is best
practice per OpenSSF guidelines, but major-version tags on first-party actions
are common industry practice.

**Fix:** Consider SHA pinning `softprops/action-gh-release` specifically. For
first-party/Google actions, major version tags are a reasonable tradeoff.

---

### 40. `CURSOR_API_KEY` Stored as GitHub Variable

**File:** `.github/workflows/ci.yml`

Used for the smoke test demo agent. GitHub Variables are not masked in logs the
way Secrets are. The key grants access to Cursor API usage/billing, not to GCP
resources.

**Fix:** Move to GitHub Secrets for log masking. Low urgency since the key
scope is limited.

---

### 41. Silent Fetch Helpers Mask Error Types

**Files:** `sdk-client-deno/src/platform/gcp-rest.ts`,
`sdk-client-deno/src/platform/control-plane.ts`

`gcpFetchSilent` and `cpFetchSilent` are used for idempotent "exists / create"
patterns (e.g., "does this secret exist before creating it?"). They are not used
for security-gating decisions. The trade-off is cleaner orchestration code at
the cost of masking transient auth errors, which would surface as "resource not
found" rather than failing loudly.

**Fix:** Optional. Log the error type in silent helpers for debuggability. Not a
security-gating concern in the current usage patterns.

---

### 42. DB Sync Uploads Entire SQLite File

**File:** `sdk-client-deno/src/db/sync.ts:21-34`

Cross-tenant copy inserts rows with `tenant_id = targetTenant` into the source
tenant's SQLite file. When that file is synced to GCS, it contains both tenants'
data. This is consistent with the documented tenant model (see `docs/iam.md`)
where tenant isolation is logical, not physical.

**Fix:** Only relevant if the tenant model changes to require strict physical
isolation. Under the current model, this is expected behavior.

---

## INFO / BY DESIGN

### 43. `secrets.jsonc` on Disk

Your workspace contains `secrets.jsonc` with real credential values. It is
gitignored but should be rotated if ever committed, shared, or backed up to an
untrusted location.

---

### 44. Tenant Not Bound to User Identity

Documented in `docs/iam.md`. Tenants represent environments, not customer
isolation boundaries. `AR_ALLOWED_DOMAINS` restricts which domains can
authenticate. No action needed unless multi-org tenancy is added.

---

### 45. Cross-Tenant Copy Without Target Authorization

Consistent with the tenant model above. A code comment has been added to
`control-plane/src/api/copy.ts`. No action needed unless the tenant model
changes.

---

## Priority Order

**Before next deploy:**

- [ ] Add `canWriteAgent` to deploy endpoint (#1)
- [ ] Fix registry clone auth (#2)
- [ ] Fix Slack identity IDOR (#3)
- [ ] Sign access callback context (#15)
- [ ] Verify `id_token` on OAuth callback (#4)
- [ ] Add `state` to OAuth login (#5)
- [ ] Guard session secret on Cloud Run via `K_SERVICE` (#6)
- [ ] Guard audience on Cloud Run via `K_SERVICE` (#7)

**Short-term:**

- [ ] Migrate bot secrets to `--set-secrets` (#16)
- [ ] Add CSP + security headers (#17)
- [ ] Add system reset confirmation body (#18)
- [ ] Non-root Docker + explicit permissions (#19)
- [ ] Sanitize 5xx error responses (#20)
- [ ] Use `PASSTHROUGH_VARS` for tool install scripts (#21)

**When convenient:**

- [ ] All LOW items (#22–31, #32–42) — code quality, defense in depth,
      and future-proofing improvements. None are actively exploitable in the
      current deployment model.
