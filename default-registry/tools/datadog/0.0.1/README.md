---
name: datadog
description: Use Datadog CI CLI to upload test results, track deployments, manage source maps, run synthetic tests, and send CI/CD traces.
---

# Datadog CI CLI (`datadog-ci`)

## Headless Usage

All commands run non-interactively. The CLI is designed for CI/CD pipelines and
requires no TTY. Authentication is via environment variables only.

```bash
datadog-ci <command> [subcommand] [flags]
```

## Authentication

| Variable     | Required    | Description                                                   |
| ------------ | ----------- | ------------------------------------------------------------- |
| `DD_API_KEY` | Yes         | Datadog API key (Organization Settings > API Keys)            |
| `DD_APP_KEY` | Conditional | Application key (required for synthetics and read operations) |
| `DD_SITE`    | No          | Site region (default `datadoghq.com`; set for EU/US3/etc.)    |

```bash
ar secret set dd-api-key <key>
ar secret set dd-app-key <key>
ar secret set dd-site datadoghq.com
```

## Investigating Service Health with Synthetics

Run existing synthetic tests to validate service health from CI or on demand.
This is the primary investigation tool — tests can probe HTTP endpoints, API
contracts, browser flows, and multi-step transactions.

### Run specific tests by public ID

```bash
datadog-ci synthetics run-tests \
  --public-id abc-123-xyz \
  --public-id def-456-uvw
```

### Run tests matching a search query

```bash
datadog-ci synthetics run-tests \
  --search "tag:service:auth-api"
```

### Run tests from a config file

```bash
datadog-ci synthetics run-tests \
  --config datadog-ci.synthetics.json
```

### Override test variables for environment targeting

```bash
datadog-ci synthetics run-tests \
  --public-id abc-123-xyz \
  --override "startUrl=https://staging.example.com"
```

Key flags for synthetics:

| Flag                     | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `--public-id <id>`       | Run a specific test (repeatable)           |
| `--search <query>`       | Run tests matching a Datadog search query  |
| `--config <path>`        | Path to config file with test list         |
| `--override <k=v>`       | Override test configuration variables      |
| `--tunnel`               | Test internal endpoints via secure tunnel  |
| `--failOnCriticalErrors` | Fail only on critical errors, not warnings |
| `--failOnMissingTests`   | Fail if referenced tests are not found     |

## Uploading Test Results

### Upload JUnit XML reports

```bash
datadog-ci junit upload --service my-api ./test-results/
```

Key flags:

| Flag               | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `--service <name>` | Service name to associate results with     |
| `--env <env>`      | Environment (e.g. `staging`, `production`) |
| `--tags <k:v>`     | Additional tags (repeatable)               |

## Tagging Deployments and CI Traces

### Tag a CI pipeline trace

```bash
datadog-ci tag --level pipeline \
  --tags env:production,version:1.2.3,service:auth-api
```

### Mark a deployment for DORA metrics

```bash
datadog-ci dora deployment \
  --service auth-api \
  --env production \
  --started-at 2026-03-09T10:00:00Z \
  --finished-at 2026-03-09T10:05:00Z \
  --git-repository-url https://github.com/org/auth-api \
  --git-commit-sha abc123
```

### Add measures to a CI pipeline

```bash
datadog-ci measure --level pipeline \
  --measures build_time:42.5,test_count:128
```

## Uploading Source Maps

```bash
datadog-ci sourcemaps upload ./dist \
  --service my-frontend \
  --release-version 1.2.3 \
  --minified-path-prefix https://app.example.com/
```

## Runtime Integration

```js
const { stdout, code } = await AgentTools.instance.exec('datadog-ci', [
  'synthetics',
  'run-tests',
  '--search',
  'tag:service:auth-api',
])
```

## Tips

- `DD_API_KEY` is required for all commands. `DD_APP_KEY` is additionally
  required for synthetics and any read operation.
- Set `DD_SITE` if your account is not on the default US1 region.
- Use `--search` with Datadog tag queries to target specific services or
  environments when running synthetics (e.g. `tag:service:payments`).
- Upload commands are idempotent and safe to retry on transient failures.
- For querying metrics, logs, or monitors directly, use the Datadog REST API via
  `curl` or an HTTP client — `datadog-ci` is focused on CI operations.
