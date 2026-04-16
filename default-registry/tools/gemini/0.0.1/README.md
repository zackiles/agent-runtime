---
name: gemini
description: Call Gemini 2.5 Pro on Vertex AI to generate text, code, and structured output using GCP-native authentication with no API key required.
---

# Gemini (`gemini`)

## Why Use This Tool

Gemini is Google's frontier AI model available through Vertex AI. Use it as a
subsystem when your agent needs text generation, code generation, or reasoning
capabilities. Unlike Cursor and Claude, Gemini requires no API key — it
authenticates via the GCP service account that the runtime already uses.

## Authentication

No API key or secret is needed. The tool authenticates using the GCP service
account's access token:

- **Production (Cloud Run / Cloud Functions):** Token obtained from the GCP
  metadata server automatically.
- **Local development:** Falls back to `gcloud auth print-access-token` using
  Application Default Credentials.

### Local Setup

```bash
gcloud auth application-default login
```

Ensure `GOOGLE_CLOUD_PROJECT` or `GCP_PROJECT` is set, or that the metadata
server is reachable.

## Model and Location

| Setting  | Value            |
| -------- | ---------------- |
| Model    | `gemini-2.5-pro` |
| Location | `us-central1`   |

Both are hardcoded in the tool script. To use a different model or location,
publish a new tool version.

## Stdin / Stdout Contract

- **Input:** The prompt is read from stdin as UTF-8 text.
- **Output:** The generated text response is written to stdout.
- **Errors:** Written to stderr with a non-zero exit code.

## Runtime Integration

```js
const result = AgentTools.instance.run('gemini', prompt)
```

The `flags: []` configuration means the prompt is passed via stdin (the
`execSync(binary, { input })` path), not as CLI arguments.

## GCP Provisioning

The Vertex AI API (`aiplatform.googleapis.com`) and IAM role
(`roles/aiplatform.user`) are provisioned automatically during
`ar cp deploy`. No manual setup is needed.
