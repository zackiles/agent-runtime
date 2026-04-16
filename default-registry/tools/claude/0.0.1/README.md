---
name: claude
description: Use Claude CLI for general-purpose reasoning, text generation, code review, analysis, and summarization in non-interactive headless mode.
---

# Claude (`claude`)

## Why Use This Tool

Claude is Anthropic's AI assistant accessible via the Claude CLI (also called
the Agent SDK CLI). Use it as a subsystem when your agent needs general-purpose
reasoning, text generation, analysis, summarization, or code assistance. In this
runtime all invocations use headless mode (`-p`) so the CLI runs
non-interactively without a TTY.

## Authentication

| Variable            | Required | Description                  |
| ------------------- | -------- | ---------------------------- |
| `ANTHROPIC_API_KEY` | Yes      | API key for Anthropic Claude |

### Option 1: Environment Variable

Set `ANTHROPIC_API_KEY` on the agent host or in the control-plane `.env` file.

### Option 2: Runtime Secrets (CLI)

```bash
ar secret set anthropic-api-key <your-key>
```

Read at runtime in agent code:

```js
const key = await AgentSecrets.instance.get('anthropic-api-key')
const { ANTHROPIC_API_KEY } = await AgentTools.instance.credentials(
  'ANTHROPIC_API_KEY',
)
```

## Headless Mode (`-p` / `--print`)

The `-p` flag is the only supported invocation mode in this runtime. It runs the
CLI non-interactively and prints results to stdout.

```bash
claude -p "What does the auth module do?"
```

All standard CLI options work alongside `-p`:

| Flag                     | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `--output-format <fmt>`  | `text` (default), `json`, or `stream-json`       |
| `--allowedTools <tools>` | Auto-approve named tools without prompting       |
| `--max-turns <n>`        | Limit the number of agent iterations             |
| `-m <model>`             | Specify a model                                  |
| `--continue`             | Continue the most recent conversation            |
| `--resume <session_id>`  | Continue a specific conversation                 |
| `--append-system-prompt` | Add instructions while keeping default behaviour |
| `--system-prompt`        | Fully replace the default system prompt          |
| `--json-schema <schema>` | Constrain JSON output to a schema                |
| `--verbose`              | Debug-level output                               |

## Output Formats

### Plain text (default)

```bash
claude -p "Summarize the auth module"
```

### JSON (structured result with metadata)

```bash
claude -p "Summarize this project" --output-format json
```

Extract the text result with `jq`:

```bash
claude -p "Summarize this project" --output-format json | jq -r '.result'
```

### Streaming JSON (newline-delimited events)

```bash
claude -p "Explain recursion" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages
```

Filter for streaming text deltas:

```bash
claude -p "Write a poem" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages | \
  jq -rj 'select(.type == "stream_event" and .event.delta.type? == "text_delta") | .event.delta.text'
```

### Structured output (JSON Schema)

Force the response to conform to a specific shape:

```bash
claude -p "Extract function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  | jq '.structured_output'
```

## Common Usage Examples

### Code review

```bash
claude -p "Review this function for bugs and security issues" \
  --allowedTools "Read" \
  --output-format json
```

### Auto-approve tools

```bash
claude -p "Run the test suite and fix any failures" \
  --allowedTools "Bash,Read,Edit"
```

### Create a commit from staged changes

```bash
claude -p "Look at my staged changes and create an appropriate commit" \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"
```

### Multi-turn conversation

```bash
session=$(claude -p "Start reviewing this codebase" --output-format json | jq -r '.session_id')
claude -p "Now focus on database queries" --resume "$session"
claude -p "Generate a summary of all issues" --resume "$session"
```

### Custom system prompt

```bash
gh pr diff "$PR" | claude -p \
  --append-system-prompt "You are a security engineer. Review for vulnerabilities." \
  --output-format json
```

## Runtime Integration

When called through the agent runtime the `--output-format json` flag is applied
by default (see tool.json `flags`).

```js
const result = AgentTools.instance.run('claude', prompt)
const parsed = JSON.parse(result)
```

For async invocation with explicit args:

```js
const { stdout } = await AgentTools.instance.exec('claude', [
  '-p',
  '--output-format',
  'json',
  '--allowedTools',
  'Read,Edit',
], prompt)
```

Access the tool's static configuration at runtime:

```js
const config = AgentTools.instance.config('claude')
```

## Tips

- `--output-format json` (applied by default) returns
  `{ result, session_id, ... }`.
- Use `--allowedTools` liberally to avoid hanging on approval prompts.
- The default timeout is 120 seconds; pass `{ timeout: 300000 }` for long tasks.
- In `-p` mode, skills and slash commands are not available; describe the task
  directly in the prompt instead.
- If the CLI encounters a clarification question it cannot render without a TTY
  the process may hang. Keep prompts specific to avoid this.
