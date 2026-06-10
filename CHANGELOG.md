# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

- Add telemetry clients and API keys (RFC-008). Telemetry ingest is now gated by
  a write-only, per-client API key instead of a Google identity, while reading
  telemetry and managing clients require admin identity.
  - Data: new per-tenant `telemetry_client` table (schema v9); keys stored only
    as SHA-256 hashes (optional `AR_TELEMETRY_KEY_PEPPER`), plaintext shown once.
  - Control plane: `telemetryKeyAuth` middleware (`X-Telemetry-Key` header) for
    `POST /telemetry`; admin-only client CRUD under `/telemetry/clients`; reads
    tightened to admin-only; the bound client name is stamped on ingested events.
  - Web: a Clients tab on the telemetry page to create, rotate, and revoke keys
    with a one-time key reveal modal.
  - Audit: create/rotate/revoke logged as `telemetry-client`; ingest excluded
    from middleware auditing.

- Add clear-builds: remove old Artifact Registry images and GCS source
  archives per agent, keeping only the latest deployed version. Reduces GCP
  storage costs without affecting audit logs or the running service.
  - Control plane: `DELETE /api/artifacts/packages/:name/builds` (admin-only)
  - CLI: `ar agent clear-builds [slug]` — clears one agent or all when no
    slug is given. Supports `--force` to skip confirmation (required in
    non-interactive mode when no slug is provided).
  - Web: "Clear Builds" button on each package card in the Artifacts page
  - Audit: `builds_cleared` event with full list of deleted builds

## 0.0.1

### Features

- Initial release
