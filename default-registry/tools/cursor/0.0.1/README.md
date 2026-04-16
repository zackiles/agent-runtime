---
name: cursor
description: Use Cursor CLI to read, write, refactor, and analyze code across a project in non-interactive headless mode with optional file modification.
---

# Cursor (`cursor`)

## Why Use This Tool

Cursor is an AI-powered coding agent that can read, write, and refactor code
across a project. Use it as a subsystem when your agent needs complex code
generation, editing, or analysis tasks. In this runtime all invocations use
headless mode (`-p`) so the CLI runs non-interactively without a TTY.

## Authentication

| Variable         | Required | Description           |
| ---------------- | -------- | --------------------- |
| `CURSOR_API_KEY` | Yes      | API key for Cursor AI |

### Option 1: Environment Variable

Set `CURSOR_API_KEY` on the agent host or in the control-plane `.env` file.

### Option 2: Runtime Secrets (CLI)

```bash
ar secret set cursor-api-key <your-key>
```

Read at runtime in agent code:

```js
const key = await AgentSecrets.instance.get('cursor-api-key')
const { CURSOR_API_KEY } = await AgentTools.instance.credentials(
  'CURSOR_API_KEY',
)
```

## Headless Mode (`-p` / `--print`)

The `-p` flag is the only supported invocation mode in this runtime. It runs the
CLI non-interactively and prints results to stdout.

```bash
agent -p "What does this codebase do?"
```

All standard CLI options work alongside `-p`:

| Flag                      | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `--force` / `--yolo`      | Allow file modifications (without it changes are proposed only) |
| `--output-format <fmt>`   | `text` (default), `json`, or `stream-json`                      |
| `--stream-partial-output` | Incremental streaming of deltas with `stream-json`              |
| `--model <model>`         | Specify a particular model                                      |
| `--workspace <dir>`       | Set the working directory                                       |
| `--trust`                 | Trust the workspace without prompting (headless)                |

## File Modifications

By default `-p` mode only proposes changes. Combine with `--force` to apply
edits directly:

```bash
agent -p --force "Refactor this code to use async/await"
```

Without `--force` the CLI outputs what it would change but does not write files.

## Output Formats

### Plain text (default)

```bash
agent -p "Summarize this project"
```

### JSON (structured result)

```bash
agent -p --output-format json "Analyze the auth module"
```

### Streaming JSON (real-time progress)

```bash
agent -p --force \
  --output-format stream-json \
  --stream-partial-output \
  "Analyze this project structure" | jq '.type'
```

## Common Usage Examples

### Generate code with file writes

```bash
agent -p --force "Add comprehensive JSDoc comments to src/auth.ts"
```

### Batch processing

```bash
find src/ -name "*.js" | while read file; do
  agent -p --force "Add JSDoc comments to $file"
done
```

### Code review (read-only)

```bash
agent -p --output-format json \
  "Review recent code changes and report bugs, security issues, and style problems"
```

### Real-time streaming

```bash
agent -p --force \
  --output-format stream-json \
  --stream-partial-output \
  "Refactor the database layer" | \
  while IFS= read -r line; do
    type=$(echo "$line" | jq -r '.type // empty')
    case "$type" in
      assistant) echo "Thinking..." ;;
      tool_call) echo "Using tool..." ;;
      result) echo "Done." ;;
    esac
  done
```

### Set a specific workspace

```bash
agent -p --force --workspace /app/src --trust \
  "Fix all TypeScript errors in this directory"
```

## Runtime Integration

When called through the agent runtime:

```js
const result = AgentTools.instance.run('cursor', prompt)
```

For async invocation with explicit args:

```js
const { stdout } = await AgentTools.instance.exec('cursor', [
  '-p',
  '--force',
  '--output-format',
  'json',
], prompt)
```

Access the tool's static configuration at runtime:

```js
const config = AgentTools.instance.config('cursor')
```

## Tips

- Always pass `--force` when the agent needs to write files; without it nothing
  is modified.
- Use `--trust` in headless environments to skip the workspace trust prompt.
- The default timeout is 120 seconds; pass `{ timeout: 300000 }` for large
  refactors.
- Include file paths directly in the prompt to reference images or binary files;
  the agent reads them through tool calls.
- Provide clear, scoped prompts — broad instructions increase latency and cost.
