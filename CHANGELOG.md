# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

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
