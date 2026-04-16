---
name: auth0
description: Use Auth0 CLI to manage tenants, applications, APIs, users, roles, and logs for identity and access management via machine-to-machine auth.
---

# Auth0 CLI (`auth0`)

## Headless Usage

All commands must include `--no-input` (applied by default via tool.json
`flags`) to prevent interactive prompts. Add `--json` to every command that
supports it for structured output.

```bash
auth0 <command> <subcommand> --no-input --json
```

## Authentication

Authenticates via M2M credentials. Create an M2M application in your Auth0
tenant authorized for the Management API with the scopes your agent requires.

| Variable              | Required | Description                              |
| --------------------- | -------- | ---------------------------------------- |
| `AUTH0_DOMAIN`        | Yes      | Tenant domain (e.g. `acme.us.auth0.com`) |
| `AUTH0_CLIENT_ID`     | Yes      | M2M application client ID                |
| `AUTH0_CLIENT_SECRET` | Yes      | M2M application client secret            |

```bash
ar secret set auth0-domain <domain>
ar secret set auth0-client-id <id>
ar secret set auth0-client-secret <secret>
```

## Key Flags

| Flag               | Purpose                                    |
| ------------------ | ------------------------------------------ |
| `--no-input`       | Disable all interactive prompts (required) |
| `--json`           | Structured JSON output                     |
| `--csv`            | CSV output for tabular data                |
| `-n, --number <n>` | Limit results (1–1000, default 100)        |
| `--filter <query>` | Lucene query syntax filter (logs)          |
| `-q, --query <q>`  | Search query (users)                       |
| `--tenant <name>`  | Target a specific tenant                   |

## Querying Logs and Events

### List recent log entries

```bash
auth0 logs list --no-input --json -n 50
```

### Filter logs by event type

```bash
auth0 logs list --no-input --json --filter "type:f"
```

Common log type codes: `s` (success login), `f` (failed login), `fp` (failed
login incorrect password), `fu` (failed login invalid email), `ss` (success
signup), `fs` (failed signup), `sapi` (success API operation), `fapi` (failed
API operation).

### Filter logs by client

```bash
auth0 logs list --no-input --json --filter "client_id:abc123"
```

### Filter by user

```bash
auth0 logs list --no-input --json --filter "user_id:\"auth0|abc123\""
```

### Tail logs in real time

```bash
auth0 logs tail --no-input --json
```

## Querying Users

### Search users by email domain

```bash
auth0 users search --no-input --json -q "email:*@example.com" -n 50
```

### Search users by metadata

```bash
auth0 users search --no-input --json -q "app_metadata.role:admin"
```

### Get a specific user

```bash
auth0 users show "auth0|abc123" --no-input --json
```

## Reading Applications and APIs

### List applications

```bash
auth0 apps list --no-input --json
```

### Show application details

```bash
auth0 apps show <client-id> --no-input --json
```

### List APIs (resource servers)

```bash
auth0 apis list --no-input --json
```

### Show API details

```bash
auth0 apis show <api-id> --no-input --json
```

## Reading Roles and Actions

### List roles

```bash
auth0 roles list --no-input --json
```

### Show role details

```bash
auth0 roles show <role-id> --no-input --json
```

### List actions

```bash
auth0 actions list --no-input --json
```

## Runtime Integration

```js
const { stdout } = await AgentTools.instance.exec('auth0', [
  'logs',
  'list',
  '--no-input',
  '--json',
  '-n',
  '100',
  '--filter',
  'type:f',
])
const failedLogins = JSON.parse(stdout)
```

## Tips

- Scope your M2M application to the minimum Management API permissions needed.
- Use `--filter` with Lucene syntax on `logs list` for precise event querying.
- Use `-q` with Lucene syntax on `users search` for user attribute querying.
- Use `-n 1000` to fetch the maximum batch when aggregating data.
- Check `auth0 <command> --help --no-input` for the full flag reference.
