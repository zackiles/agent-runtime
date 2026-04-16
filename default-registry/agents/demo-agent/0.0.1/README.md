---
name: demo-agent
description: Demo builder agent that scaffolds fullstack apps from prompts.
---

# Demo Agent

A function-based agent that creates, updates, and versions demo applications.
Powered by the **cursor** subsystem.

## How It Works

The function handler orchestrates the full lifecycle. The subsystem agent only
generates or edits code in a sandbox directory.

1. Receives a request with a prompt and optional demo name/version
2. Resolves whether this is a new demo, an update, or a new version
3. Stages existing code from GCS to the sandbox if updating
4. Compiles the prompt template with mode-specific context
5. Invokes the subsystem to generate or edit code in the sandbox
6. Archives the sandbox to versioned GCS storage
7. Deploys to Cloud Run via the control plane
8. Returns the demo metadata with a public URL

## Request Format

```json
{
  "prompt": "Build a todo app with drag-and-drop",
  "name": "my-todo-app",
  "version": "0.0.1",
  "files": [{ "name": "logo.png", "content": "<base64>" }]
}
```

- `prompt` (required) -- what to build or change
- `name` (optional) -- slug of an existing demo to update
- `version` (optional) -- specific version to update (requires name)
- `files` (optional) -- file overrides to include in the request

## Response Format

```json
{
  "demo": {
    "name": "my-todo-app",
    "version": "0.0.1",
    "url": "https://demo-dev-my-todo-app.run.app",
    "summary": "A drag-and-drop todo application..."
  }
}
```
