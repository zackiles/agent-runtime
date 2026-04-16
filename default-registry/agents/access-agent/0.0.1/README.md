---
name: access-agent
description: Access configuration agent for apps, resources, and services.
---

# Access Agent

A function-based default agent that helps users configure access to
company apps, resources, data sources, and third-party services.

## Two-Turn Flow

### Turn 1: Access Request

Send a request describing what you need access to:

```json
{
  "resource": "google-drive",
  "description": "I need my personal Google Drive accessible to agents",
  "scope": "private"
}
```

The agent will:

1. Determine what credentials are needed
2. Build a one-time-use web UI via the Demo Agent
3. Return the UI URL with instructions

### Turn 2: Context Callback

After completing the UI flow, send back the context string:

```json
{
  "context": "<base64-encoded-string-from-ui>"
}
```

The agent will:

1. Decode and validate the context
2. Store credentials as secrets in the appropriate registry
3. Configure any needed runtime settings
4. Return confirmation of what was set up

## Scope

| Scope     | Who Can Use          | Who Can Configure |
| --------- | -------------------- | ----------------- |
| `private` | Current user only    | Any user          |
| `public`  | All users and agents | Admins only       |

## Examples

### OAuth/OIDC Flow (e.g. Google, GitHub, Slack)

```json
{ "resource": "github", "description": "Connect my GitHub account" }
```

The agent builds a UI with the OAuth authorization URL. After the user
authorizes, the UI captures the token and encodes it as a context string.

### API Key Setup

```json
{ "resource": "openai", "description": "Add my OpenAI API key" }
```

The agent builds a simple form to securely enter the API key.

### Multi-Secret Configuration

```json
{
  "resource": "aws",
  "description": "Configure AWS access for S3 data lake",
  "scope": "public"
}
```

The agent builds a wizard collecting access key, secret key, region,
and bucket name. Requires admin privileges for public scope.
