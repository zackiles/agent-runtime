# RFC-008: Build and Supply Chain Hardening

**Status:** Proposed **Authors:** Agent Runtime Team **Created:** 2026-04-16
**Supersedes:** `SECURITY-TODO.md` items #19 (Docker root + `-A`), #39 (CI
action pinning), and partially #26 (IAM scope)

---

## TL;DR

Agent Runtime's release pipeline ships unsigned CLI binaries and container
images from a GitHub Actions workflow that references six third-party
actions by mutable tag and holds `contents: write` + `id-token: write` at
workflow scope. The base agent image is built from a `Dockerfile.agent-base`
that runs arbitrary `install.sh` scripts as root, and those scripts in turn
`curl` binaries from upstream CDNs without any checksum. The `curl | sh`
install flow on the consumer side has no verification either.

This RFC proposes four phases of hardening, ordered by cost and risk:

| Phase | Theme | Effort | Risk | Ships |
|---|---|---|---|---|
| **1** | Pin everything that references a mutable ref | 1 day | None | Repo/workflow config only |
| **2** | Sign and attest every artifact | 2–3 days | Low | New release artifacts (bundles, provenance, SBOM) |
| **3** | Harden build inputs (install scripts, Cloud Build) | 1 week | Low | CP + base-image changes |
| **4** | Enforce signatures at deploy time | Follow-up | Medium | CLI feature flag, then BinAuthz |

Each phase is independently shippable; nothing in a later phase is required
for an earlier phase to deliver value. Phase 1 alone closes the concrete
attack surface raised by the audit question that triggered this RFC.

---

## Priority Matrix

Every proposal in this RFC with its phase, effort, and the threat (§3) it
addresses. Proposals appear in this order throughout the document so that
reading top-to-bottom is reading priority-first.

| # | Proposal | Phase | Effort | Threat |
|---|---|---|---|---|
| 4.1 | SHA-pin all GitHub Actions | 1 | 1 hour | T1 |
| 4.2 | Digest-pin every base image (consolidated) | 1 | 1 hour | T2 |
| 4.3 | Scope `GITHUB_TOKEN` per job | 1 | 15 min | T1 blast radius |
| 4.4 | Dependabot for Actions and base images | 1 | 10 min | Pin hygiene |
| 4.5 | Branch protection on `main` | 1 | 5 min | Direct-push |
| 4.6 | Sign release binaries and images with cosign | 2 | 2 hours | T3, T4 |
| 4.7 | SLSA build provenance attestations | 2 | 1 hour | Audit |
| 4.8 | Generate and attach SBOMs | 2 | 1 hour | CVE response |
| 4.9 | Verified `curl \| sh` install | 2 | 2 hours | T3 on install |
| 4.10 | Contain `install.sh` execution in the base image | 3 | 2 hours | Tool compromise → root |
| 4.11 | Pin external binaries fetched by tool `install.sh` | 3 | 3 hours | T5 |
| 4.12 | Harden the Cloud Build input path | 3 | 4 hours | T4 |
| 4.13 | Verify signatures at deploy time (client + BinAuthz) | 4 | 1 day | T4 |
| 4.14 | SSH-agent forwarding (considered, rejected) | — | — | — |

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Current State](#2-current-state)
3. [Threat Model](#3-threat-model)
4. [Proposals](#4-proposals) — in priority order
5. [Implementation Plan](#5-implementation-plan)
6. [Verification Runbook](#6-verification-runbook)
7. [Open Questions](#7-open-questions)
8. [Appendix: Snippets](#8-appendix-snippets)

---

## 1. Motivation

Supply chain attacks in 2024–2026 (tj-actions, XZ, reviewdog, changed-files
token exfiltration) have repeatedly exploited exactly the shape of our
release pipeline: a privileged GitHub Actions job that references
third-party actions by floating tag and produces unsigned artifacts that
downstream consumers trust by convention.

Agent Runtime's blast radius is notable even though tenants share a single
GCP project (tenant isolation is **logical, not physical** — see
`docs/iam.md` and `SECURITY-TODO.md` #13):

- The CLI is installed with `curl ... | sh` on developer and CI machines,
  and then executes privileged `gcloud` commands against whichever project
  the user is authenticated to.
- The base agent image lives in Artifact Registry and is the parent image
  for every per-agent Cloud Run service. A compromised base image runs on
  every agent invocation under the worker SA.
- The control-plane runs under the Admin service account
  (`agent-runtime-sp@...`) holding `roles/run.admin`,
  `roles/secretmanager.admin`, `roles/storage.admin`,
  `roles/artifactregistry.repoAdmin`, and `roles/cloudbuild.builds.editor`
  across the project (`default-settings.jsonc:48-60`). Anything in that
  container can read any secret, overwrite any tenant's SQLite backup in
  GCS, and push arbitrary images.

A single poisoned release propagates to every agent and every tenant within
the next `ar cp deploy` cycle. This RFC establishes the baseline controls
required before we onboard external tenants or publish the CLI to Homebrew.

---

## 2. Current State

Agent Runtime produces four classes of build artifact, each through a
different pipeline. Understanding which pipeline builds what is a
prerequisite for deciding where to sign:

| Artifact | Built by | Uses |
|---|---|---|
| CLI binaries (`ar-{linux,darwin}-{x64,arm64}`) | `.github/workflows/release.yml` via `deno task build --cross` | GitHub Releases → `install.sh` |
| Base agent image (`ar-agents/base:<ver>`) | `release.yml` **or** `ar cp deploy` (via `gcloud builds submit`), built from `Dockerfile.agent-base` | Parent for per-agent images |
| Per-agent images (`ar-agents/<slug>:<ver>`) | Cloud Build, inline Dockerfile from `control-plane/src/api/agents.ts:550-578` | Each tenant's Cloud Run agents |
| Control-plane image | Cloud Build via `gcloud run deploy --source=` (`cli/src/commands/control-plane.ts:144-155`, `FROM debian:trixie-slim`) | Cloud Run control plane |

The top-level `Dockerfile` in the repo is **not used by any workflow or CLI
command** (verified by repo-wide search). It runs as root with
`deno run -A` and is the subject of `SECURITY-TODO.md` #19. This RFC
recommends deleting it rather than maintaining it (§4.2).

### Gaps found in the audit

| Area | Current state | Gap |
|---|---|---|
| GitHub Actions refs | 14 `uses:` lines pinned to major tags (`@v4`, `@v3`, `@v2`) | Tags are mutable |
| Base image refs | `node:22-slim`, `denoland/deno:2.1.4`, `debian:trixie-slim`, and **`denoland/deno:latest`** in `control-plane/src/api/demos/build.ts:38` | Tag substitution; `:latest` is the worst case |
| Binary / image signing | None | Consumers cannot verify our artifacts |
| Provenance, SBOM | None | No SLSA attestation, no CVE index |
| `install.sh` (consumer-side) | `curl -fsSL $url -o $tmp && mv $tmp /usr/local/bin/ar` | No checksum, no signature verification |
| `GITHUB_TOKEN` scope | `contents: write` + `id-token: write` at workflow level | `deploy` job inherits `contents: write` it doesn't need |
| Third-party actions | 6 distinct; `softprops/action-gh-release` is the riskiest (single maintainer) | Compromise propagates on next run |
| Cloud Build input | CP uploads tarball to GCS; Cloud Build pulls by path | No digest pinning of the upload |
| Cloud Build builders | `gcr.io/cloud-builders/docker`, `ubuntu` referenced by tag | Not digest-pinned |
| `install.sh` execution in base image | Runs every tool's script as root | Any compromised tool gets root |
| `install.sh` external fetches | `curl` to `downloads.cursor.com` etc. with no checksum | CDN/DNS compromise → base image |
| Unused top-level `Dockerfile` | Exists, pins `denoland/deno:2.1.4` by tag, runs as root with `-A` | Developer-bait for a future production build path |

---

## 3. Threat Model

Five attack paths, ordered by likelihood.

**T1 — Compromised third-party Action.** Attacker gains push to
`softprops/action-gh-release` (single maintainer, 9M+ weekly installs) and
force-pushes to the `v2` tag. Our next release runs attacker code with
`contents: write` and our WIF-minted GCP token. → §4.1, §4.3, §4.4.

**T2 — Tag substitution on a base image.** Attacker with access to the
Docker Hub org for `denoland` or `library/node` pushes a new image under an
existing tag. Our next build (`Dockerfile.agent-base`, any demo build using
`denoland/deno:latest`, or any per-agent build deriving from our base)
pulls a trojaned layer. → §4.2.

**T3 — Release artifact replacement.** Attacker with write access to our
GitHub releases (via T1, leaked PAT, or GitHub infra compromise) replaces
`ar-linux-x64` after publication. Users running `curl | sh` receive the
replacement. → §4.6, §4.9.

**T4 — Malicious base or agent image.** Attacker replaces
`ar-agents/base:x.y.z` in Artifact Registry, either by direct push or by
poisoning a tool `install.sh` upstream (see T5). Next `ar agent deploy`
bases the per-agent image on the trojan. → §4.6, §4.12, §4.13.

**T5 — Poisoned tool-upstream CDN.** The agent base image runs
`curl -fsSL https://cursor.com/install | ...` (and similar for other tools)
during `docker build`. An attacker who compromises that CDN, hijacks DNS,
or MITMs the TLS connection inserts code into every tool binary baked into
our base image. No verification exists today. → §4.10, §4.11.

We explicitly **do not** model: Google Cloud Build infrastructure
compromise, GitHub Actions runner compromise, side channels in the
compiled Deno binary, or insider with merge rights. Branch protection
(§4.5) is the partial control for the last one.

---

## 4. Proposals

Proposals are in phase order; the first five are the highest-impact,
lowest-risk fixes and can ship as a single PR.

---

### Phase 1 — Pin everything (1 day, zero runtime risk)

#### 4.1 SHA-pin all GitHub Actions

**Threat:** T1. **Effort:** ~1 hour.

Replace every `uses: owner/action@vN` with `uses: owner/action@<40-char SHA>`
and a trailing comment noting the human-readable version. Affected files:
`.github/workflows/{release,ci,test-deno}.yml` — 14 `uses:` lines total.

```yaml
- uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
- uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8 # v4.0.2
- uses: denoland/setup-deno@041b854f97b325bd60e53e9dc2de9cb9f9ac0cba # v2.0.0
- uses: softprops/action-gh-release@69320dbe05506a9a39fc8ae11030b214ec2d1f87 # v2.0.5
- uses: google-github-actions/auth@71f986410dfbc7added4569d411d040a91dc6935 # v3.0.0
- uses: google-github-actions/setup-gcloud@77e7a554d41e2ee56fc945c52dfd3f33d12def9a # v2.1.1
```

SHAs must be verified against each action's release notes at pinning time.
Dependabot (§4.4) keeps them current with a PR per bump, which we review
rather than trusting the tag.

#### 4.2 Digest-pin every base image

**Threat:** T2. **Effort:** ~1 hour.

Fix every base-image reference in the repo in one pass. Base images live in
five categories:

| Location | Current | Notes |
|---|---|---|
| `Dockerfile.agent-base` | `FROM node:22-slim` | Built by `release.yml` and `ar cp deploy` |
| `.devcontainer/Dockerfile` | `FROM denoland/deno:2.1.4` | Developer machines, lower risk |
| `default-settings.jsonc` (`agents.baseImage`, `controlPlane.baseImage`) | `"node:22-slim"`, `"debian:trixie-slim"` | Parameterises the CLI-generated CP Dockerfile |
| `control-plane/src/api/demos/build.ts` (`NODE_`, `STATIC_`, `VANILLA_NODE_`, `DENO_DOCKERFILE`) | `node:22-slim`, `denoland/deno:latest` | `:latest` must be fixed; this is the worst pin in the repo |
| Top-level `Dockerfile` | `denoland/deno:2.1.4` | **Delete** — unused, vulnerable, misleading |

Change every `FROM owner/image:tag` to `FROM owner/image:tag@sha256:<digest>`.
Delete the unused top-level `Dockerfile` as part of the same PR — it's
subject to `SECURITY-TODO.md` #19 and confusing to new contributors who
assume production uses it.

The TS string-literal Dockerfiles (`demos/build.ts`, `control-plane.ts`
`DOCKERFILE` const) are invisible to Dependabot's `docker` ecosystem. Two
options:

- Extract each to a real `*.Dockerfile` template committed to the repo
  and read at runtime. Dependabot then sees them.
- Add a lint rule that rejects `FROM [^@]+:[^@]+` in any `.ts` source
  and update string literals by hand on Deno/Node bumps.

Choose the first. Extracting demo templates also lets us test them against
real Dockerfile linters.

#### 4.3 Scope `GITHUB_TOKEN` per job

**Threat:** T1 blast radius. **Effort:** 15 min.

Today:

```8:10:.github/workflows/release.yml
permissions:
  contents: write
  id-token: write
```

Every job inherits both. The `deploy` job doesn't need `contents: write`;
the `check` job in `ci.yml` doesn't need `id-token: write`. Split per job:

```yaml
permissions: {}   # workflow default: none

jobs:
  release:
    permissions:
      contents: write
      id-token: write
      attestations: write   # enables §4.7
  deploy:
    permissions:
      contents: read
      id-token: write
```

Apply the same shape to `ci.yml` and `test-deno.yml`.

#### 4.4 Dependabot for Actions and base images

**Threat:** T1 / T2 pin rot. **Effort:** 10 min.

SHA pins (§4.1, §4.2) are worthless without automated bumps. Add
`.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: '/'
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    groups:
      actions: { patterns: ['*'] }
  - package-ecosystem: docker
    directory: '/'
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: '/.devcontainer'
    schedule: { interval: weekly }
```

Weekly cadence matches the rate at which upstreams rotate images. Each PR
surfaces the new SHA and changelog for review.

#### 4.5 Branch protection on `main`

**Threat:** Malicious or accidental direct push. **Effort:** 5 min.

Enable on `main`:

- Require PR before merge
- Require `CI / check` and `Test Deno / test` to pass
- Restrict push of `v[0-9]+.[0-9]+.[0-9]+` tags to Release Managers
  (pushing a tag triggers `release.yml`)
- Dismiss stale reviews on new commits

We **do not** require signed commits: it conflicts with
`github-actions[bot]` creating tags in `release.yml` and with AI-agent
workflows. Revisit when the release flow moves to a signing-capable bot
identity.

These are GitHub repo settings, not code. Documented here so the
protection survives admin turnover.

---

### Phase 2 — Sign and attest (2–3 days)

#### 4.6 Sign release binaries and images with cosign

**Threat:** T3, T4. **Effort:** ~2 hours.

Use keyless sigstore signing driven by the workflow's OIDC identity — no
long-lived keys. Signatures are stored in the public Rekor transparency
log and verifiable with the workflow identity
`https://github.com/zackiles/agent-runtime/.github/workflows/release.yml@refs/tags/vX.Y.Z`.

For **CLI binaries**, after `Prepare release artifacts`:

```yaml
- uses: sigstore/cosign-installer@<sha> # v3.5.0
- name: Sign CLI binaries
  run: |
    for bin in release/${{ steps.version.outputs.version }}/ar-*; do
      cosign sign-blob --yes "$bin" --bundle "${bin}.cosign.bundle"
    done
```

Bundles upload alongside the binaries via the existing
`softprops/action-gh-release` `files:` glob.

For **container images**, after each `docker push`:

```yaml
- name: Sign image
  run: |
    DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" | cut -d@ -f2)
    cosign sign --yes "$IMAGE@$DIGEST"
```

Signatures land in Artifact Registry as adjacent `.sig` tags.

#### 4.7 SLSA build provenance attestations

**Threat:** T3, T4; audit. **Effort:** ~1 hour.

Provenance ties an artifact's digest to its source commit, workflow, and
runner. GitHub provides first-party support:

```yaml
- uses: actions/attest-build-provenance@<sha> # v1.4.1
  with:
    subject-path: 'release/${{ steps.version.outputs.version }}/ar-*'

- uses: actions/attest-build-provenance@<sha> # v1.4.1
  with:
    subject-name: ${{ steps.image.outputs.image }}
    subject-digest: ${{ steps.image.outputs.digest }}
    push-to-registry: true
```

Verification: `gh attestation verify` and `cosign verify-attestation`. Cost
is near-zero; this is the single most valuable audit artifact per release.

#### 4.8 Generate and attach SBOMs

**Threat:** Post-disclosure CVE response. **Effort:** ~1 hour.

Run `anchore/sbom-action` over the binary directory and each pushed image;
attach CycloneDX JSON to the GitHub Release and to the image as an OCI
artifact. When a downstream CVE drops, `grype` queries the SBOM of every
released version without a rebuild.

```yaml
- uses: anchore/sbom-action@<sha> # v0.17.2
  with:
    path: ./release/${{ steps.version.outputs.version }}
    artifact-name: ar-cli-${{ steps.version.outputs.version }}.cdx.json
    output-file: release/${{ steps.version.outputs.version }}/sbom.cdx.json
```

#### 4.9 Verified `curl | sh` install

**Threat:** T3 on the install path. **Effort:** ~2 hours.

Update `install.sh` to verify a cosign signature before moving the binary
into place:

```sh
# after download
cosign_bundle="${url}.cosign.bundle"
curl -fsSL "$cosign_bundle" -o "${tmp}.bundle"
cosign verify-blob \
  --certificate-identity-regexp='^https://github.com/zackiles/agent-runtime/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  --bundle "${tmp}.bundle" "$tmp" || {
    printf 'Signature verification failed; refusing to install.\n' >&2
    exit 1
  }
```

This introduces a bootstrap problem: users need `cosign` before they can
verify. Two-tier plan:

1. Ship a `SHA256SUMS` file signed with cosign alongside the release.
   `install.sh` verifies one cosign signature on the sums file, then
   verifies the binary with `sha256sum -c`. Users only need `cosign` +
   `sha256sum`.
2. Add an opt-out `AR_VERIFY=0` for air-gapped users; default `AR_VERIFY=1`
   after two weeks of bake.

Apply the same treatment to `skill/install.sh`. Release notes document the
manual verification command.

---

### Phase 3 — Harden build inputs (1 week)

#### 4.10 Contain `install.sh` execution in the base image

**Threat:** Compromised tool → root in every agent. **Effort:** ~2 hours.

`Dockerfile.agent-base:19-27` runs every tool's `install.sh` as root. Five
tools ship install scripts today (`cursor`, `claude`, `github`, `datadog`,
`auth0`). Mitigations:

1. Multi-stage: run installs as non-root in a dedicated stage, then
   `COPY --from=installer /app/tools/ /app/tools/` into the final image.
2. Extend `tool.json` with `installSha256`. Enforce in the base image's
   shell loop before executing the script.
3. Longer term: drop `install.sh` entirely for pre-built binaries
   committed via Git LFS — the existing pattern for most tools
   (`AGENTS.md` "default-registry/tools/*/[0-9]*/tool tracked by git LFS").
   This also eliminates the network dependency at image-build time, which
   is what §4.11 addresses.

#### 4.11 Pin external binaries fetched by tool `install.sh`

**Threat:** T5 — upstream CDN / DNS compromise. **Effort:** ~3 hours.

Even with §4.10 containment, `install.sh` scripts `curl` upstream binaries
with no verification. From
`default-registry/tools/cursor/0.0.1/install.sh`:

```sh
VERSION=$(curl -fsSL https://cursor.com/install | grep -o 'lab/[^/"]*' | head -1 | cut -d'/' -f2)
URL="https://downloads.cursor.com/lab/${VERSION}/${OS}/${ARCH}/agent-cli-package.tar.gz"
curl -fsSL "$URL" -o "$TEMP_DIR/package.tar.gz"
tar xzf "$TEMP_DIR/package.tar.gz" ...
```

The other four install scripts follow the same pattern. Options:

1. **Pin version + SHA-256 per platform in `tool.json`.** A shared
   `verify.sh` in `default-registry/tools/` avoids per-tool duplication:

   ```jsonc
   {
     "slug": "cursor",
     "version": "0.0.1",
     "upstream": {
       "version": "2025.12.17",
       "urlTemplate": "https://downloads.cursor.com/lab/{version}/{os}/{arch}/agent-cli-package.tar.gz",
       "sha256": {
         "linux/x64": "…", "linux/arm64": "…",
         "darwin/x64": "…", "darwin/arm64": "…"
       }
     }
   }
   ```

2. **Use upstream-signed verification** where available (e.g. `cosign
   verify-blob` against upstream keys). Falls back to SHA-256 where not.

3. **Mirror binaries to our own GCS and cosign-sign them.** Heaviest;
   revisit only if an upstream refuses to publish stable checksums.

A scheduled workflow detects new upstream versions and opens a PR with
`sha256` pre-filled; the PR is the human-review gate.

#### 4.12 Harden the Cloud Build input path

**Threat:** T4 via any of the three Cloud Build flows. **Effort:** ~4 hours.

Three flows need hardening:

- **Per-agent builds** (`control-plane/src/api/agents.ts:559-581`) from a
  GCS tarball on `<project>-ar-registry`.
- **Demo builds** (`control-plane/src/api/demos/deploy.ts:267`).
- **CP deploys** via `gcloud run deploy --source=<staging>`
  (`cli/src/commands/control-plane.ts:1055-1080`).

Common hardening:

1. **Record the upload SHA-256** in the build step before upload; Cloud
   Build verifies it matches the pulled object. Closes a narrow TOCTOU.
2. **Constrain the Cloud Build default SA** so it cannot push outside
   `ar-agents/*` and `ar-demos/*` and cannot read unrelated secrets. Audit
   via `gcloud asset search-all-iam-policies`. Tightens `SECURITY-TODO.md`
   #26.
3. **Sign from within Cloud Build** via a `sigstore/cosign` step, keyless
   against the Cloud Build SA identity. Signatures feed §4.13's
   verification.
4. **Digest-pin Cloud Build builder images** (`gcr.io/cloud-builders/docker`,
   `ubuntu`) in every `steps[].name` emitted by the CP. Same change as
   §4.2 for base images, different files.

---

### Phase 4 — Enforce signatures at deploy time (follow-up)

#### 4.13 Verify signatures at deploy time

**Threat:** T4. **Effort:** ~1 day.

Cosign signing (§4.6) is only useful if something verifies. Two enforcement
layers, rolled out in order:

**Layer 1 — Client-side verify in the CLI.** Before each `ar cp deploy`
and `ar agent deploy`, run `cosign verify` against the target image digest
with the expected workflow identity; refuse to proceed on failure.
Feature-flagged by `AR_REQUIRE_SIGNED_IMAGES` (default off → on). Ships in
the CLI we already control — no GCP configuration required.

Implement in the existing paths:

- `cli/src/commands/control-plane.ts` — `buildBaseImage` and
  `deployControlPlane`
- `control-plane/src/api/agents.ts` — before Cloud Run deploy

**Layer 2 — Binary Authorization admission.** Enforce at the Cloud Run
admission layer using a **sigstore / Fulcio attestor** (not PGP):

```sh
gcloud container binauthz attestors create ar-release \
  --attestation-authority-note=projects/<project>/notes/ar-release-note

gcloud container binauthz policy import <(cat <<'EOF'
defaultAdmissionRule:
  evaluationMode: ALWAYS_DENY
  enforcementMode: ENFORCED_BLOCK_AND_AUDIT_LOG
admissionWhitelistPatterns:
  - namePattern: gcr.io/cloud-builders/*
EOF
)
```

Bind the attestor to the sigstore Fulcio root via a Container Analysis
note referencing the workflow identity as the accepted subject. See
[BinAuthz sigstore signing](https://cloud.google.com/binary-authorization/docs/key-concepts#sigstore_signatures).

Ship Layer 1 first because a broken BinAuthz policy blocks every deploy
in the project. Burn in for a week in the CI tenant, then enable Layer 2.

**BinAuthz scope caveat.** The policy applies project-wide. Because
tenant isolation here is logical (single project, single Artifact
Registry), enabling BinAuthz in a project that also hosts non-AR workloads
affects them too. Ship BinAuthz only in projects dedicated to AR.

---

### 4.14 SSH-agent forwarding for developer-signed builds (considered, rejected)

A previous audit question asked whether we forward `$SSH_AUTH_SOCK` into
`docker build` for developer signing. We do not. Rejected in favour of
keyless sigstore (§4.6) because:

- No developer-key enrollment / rotation to manage.
- Signatures tie to the release workflow identity, which is what
  downstream consumers actually care about.
- Keyless signing works identically on GitHub runners, Cloud Build, and
  developer machines, so there's one verification path.

If a future scenario requires developer-authenticated builds (e.g. a
sealed-build workflow for regulated customers), BuildKit
`--mount=type=ssh` is trivial to add then. For now, no change.

---

## 5. Implementation Plan

Three shippable PRs plus one follow-up. Phase numbers match the Priority
Matrix above.

| Phase | Contents | PR cost | Runtime impact |
|---|---|---|---|
| **1** | §4.1–§4.5 | 1 day | None — repo/workflow config |
| **2** | §4.6–§4.9 | 2–3 days | New release artifacts; `AR_VERIFY=0` opt-out |
| **3** | §4.10–§4.12 | 1 week | Base image + CP changes; backwards-compatible |
| **4** | §4.13 | 1 week, gated | Feature-flagged; opt-in for CI tenant first |

Phase 1 alone is the single most valuable PR in this RFC and should ship
first. It closes the concrete attack surface raised by the original audit
(T1 and T2) and unblocks every later phase.

### Cleanup after landing

Once Phase 1 ships, remove from `SECURITY-TODO.md`:

- #19 (resolved by deleting the top-level `Dockerfile` in §4.2)
- #39 (resolved by §4.1)
- Partially address #26 in §4.12; close only when that phase lands.

---

## 6. Verification Runbook

### After Phase 1

```sh
# No floating tags in workflows
rg '^\s*uses: [^@]+@v[0-9]+\s*$' .github/workflows/
# Expected: no matches

# No unpinned base images in Dockerfiles
rg '^FROM [^@]+:[^@]+$' Dockerfile.agent-base .devcontainer/Dockerfile
# Expected: no matches

# No unpinned base images in TS-generated Dockerfiles
rg '^FROM [^@]+:[^@]+' control-plane/src/api/demos/build.ts cli/src/commands/control-plane.ts
# Expected: no matches

# Settings-file pins contain digests
rg '"baseImage"' default-settings.jsonc
# Expected: each value contains '@sha256:'

# Dead Dockerfile is gone
test ! -f Dockerfile && echo ok
```

### After Phase 2

```sh
# Verify a released binary
cosign verify-blob \
  --certificate-identity-regexp='^https://github.com/zackiles/agent-runtime/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  --bundle ar-linux-x64.cosign.bundle ar-linux-x64

# Verify the agent-base image
cosign verify \
  --certificate-identity-regexp='^https://github.com/zackiles/agent-runtime/.*' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  <region>-docker.pkg.dev/<project>/ar-agents/base:<version>

# Check SLSA provenance
gh attestation verify ./ar-linux-x64 --owner zackiles
```

### After Phase 4

```sh
# Client-side verify rejects unsigned
AR_REQUIRE_SIGNED_IMAGES=1 deno task ar cp deploy --image=<unsigned>
# Expected: exit 1, signature verification error

# BinAuthz rejects unsigned (once Layer 2 lands)
gcloud run deploy test --image=busybox --project=<project>
# Expected: VIOLATES_POLICY
```

---

## 7. Open Questions

- **Fulcio outage behaviour.** Releases block until Fulcio recovers.
  Acceptable given Fulcio's SLA and our release cadence.
- **Tool binary pin cadence (§4.11).** Who owns refreshing `sha256` +
  version when upstream releases? Proposal: scheduled workflow auto-opens
  a PR with the new checksum; human reviews.
- **Reproducible builds.** `deno compile` is close but not bit-reproducible
  across runner kernels. Out of scope; revisit if a customer asks.
- **Homebrew formula verification.** A formula embeds a SHA-256
  automatically. Cosign in the formula is possible but uncommon; defer.
- **BinAuthz scope.** Project-wide. Only enable in projects dedicated to
  AR (see §4.13 caveat).

---

## 8. Appendix: Snippets

### Current workflow permissions

```8:10:.github/workflows/release.yml
permissions:
  contents: write
  id-token: write
```

```226:234:.github/workflows/release.yml
      - name: Build and push base agent image
        run: |
          VERSION="${{ needs.release.outputs.version }}"
          REGION="${{ vars.GCP_REGION }}"
          PROJECT="${{ vars.GCP_PROJECT }}"
          IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ar-agents/base:${VERSION}"
          docker build -f Dockerfile.agent-base -t "$IMAGE" .
          gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
          docker push "$IMAGE"
```

### Proposed post-hardening build-and-sign block

```yaml
- name: Build and push base agent image
  id: image
  run: |
    IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/ar-agents/base:${VERSION}"
    docker build -f Dockerfile.agent-base -t "$IMAGE" .
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
    docker push "$IMAGE"
    DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" | cut -d@ -f2)
    echo "digest=$DIGEST" >> "$GITHUB_OUTPUT"
    echo "image=$IMAGE" >> "$GITHUB_OUTPUT"

- uses: sigstore/cosign-installer@<sha> # v3.5.0

- name: Sign image
  run: cosign sign --yes "${{ steps.image.outputs.image }}@${{ steps.image.outputs.digest }}"

- uses: actions/attest-build-provenance@<sha> # v1.4.1
  with:
    subject-name: ${{ steps.image.outputs.image }}
    subject-digest: ${{ steps.image.outputs.digest }}
    push-to-registry: true
```
