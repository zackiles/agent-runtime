# sdk-agent-nodejs

Runtime library for ar agent functions. Provides classes that are automatically
bootstrapped as globals within agent function containers.

## Classes

### `AgentStorage`

Read/write files to the agent's GCS storage folder via the control plane.

```js
await AgentStorage.instance.write("output/result.json", JSON.stringify(data));
const content = await AgentStorage.instance.read("output/result.json");
const files = await AgentStorage.instance.list("output/");
```

### `AgentTools`

Execute tools installed in the agent's container. Tools are stdio-based
executables.

```js
const result = AgentTools.instance.run("my-tool", inputString);
const { stdout, stderr, code } = await AgentTools.instance.exec("my-tool", [
  "--flag",
], input);
```

Read a tool's static configuration (derived from tool.json, read-only):

```js
const cfg = AgentTools.instance.config("claude");
// { name, slug, version, description, flags, env }
```

The `description` field (sourced from README.md frontmatter, ≤ 250 chars) is
available for agents to decide whether a tool is appropriate for a task.

Tool executables are discovered by convention: the runtime looks for a file
named `tool` (any extension, excluding `tool.json`) in each tool's directory. If
not found, it falls back to an `install` script that bootstraps the executable.

When a tool declares `env` templates in its configuration (e.g.
`"ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"`), the runtime resolves templates
from `process.env` and passes only the declared variables (plus essential system
variables like `PATH` and `HOME`) to the tool subprocess. This isolates each
tool's credentials from other tools.

### `AgentSession`

Access the current request context including auth, headers, and body.

```js
const email = AgentSession.instance.email;
const body = AgentSession.instance.current.body;
const isSubAgent = AgentSession.instance.isSubAgent;
```

### `AgentEnvironment`

Access agent metadata: tenant, version, team, department, owners, visibility,
and registry type.

```js
const tenant = AgentEnvironment.instance.tenant;
const version = AgentEnvironment.instance.agentVersion;
const isDev = AgentEnvironment.instance.isDevelopment;
const isPublic = AgentEnvironment.instance.isPublicRegistry;
const visibility = AgentEnvironment.instance.visibility;
```

Agents in both private and public registries can access all public registry
entities and runtime files. Only agents in the same private user registry can
access that user's private entities (tools, rules, skills, sub-agents).

### `AgentSecurity`

Sanitize inputs/outputs by detecting and redacting PII and sensitive data.

```js
const safe = AgentSecurity.instance.sanitize(inputObj, "input");
const clean = AgentSecurity.instance.isSanitized(data, "output");

// Add custom sanitizer
AgentSecurity.instance.add({
  name: "custom-token",
  match: { key: /token/i },
  replace: "[TOKEN_REDACTED]",
  direction: "both",
});
```

#### Sanitizer Configuration

Sanitizers use a unified notation with a required `match` and optional
`replace`:

| Field       | Type                                    | Description                         |
| ----------- | --------------------------------------- | ----------------------------------- |
| `name`      | string                                  | Human-readable name                 |
| `match`     | string, RegExp, or `{ key?, value? }`   | Pattern to detect sensitive data    |
| `replace`   | string, function, or `{ key?, value? }` | Replacement (default: `[REDACTED]`) |
| `direction` | `input`, `output`, or `both`            | When to apply (default: `both`)     |
| `priority`  | number                                  | Order of execution (lower = first)  |

### `AgentSecrets`

Access and manage secrets through the control plane.

```js
const apiKey = await AgentSecrets.instance.get("MY_API_KEY");
await AgentSecrets.instance.set("NEW_SECRET", "value");
const names = await AgentSecrets.instance.list();
```

### `AgentAudit`

Create audit trail entries and structured log output for Cloud Run tracing.

```js
await AgentAudit.instance.log("processed", { items: 42 });
AgentAudit.instance.info("Processing started");
AgentAudit.instance.error("Failed to process", { reason: "timeout" });
```

## Bootstrap

The `bootstrap` function wraps a handler, initializing all globals
transparently:

```js
import { bootstrap } from "@ar/runtime-lib";

export const handler = bootstrap({
  controlPlaneUrl: "...",
  token: "...",
  // ... other config fields ...
  tools: [
    {
      name: "claude",
      slug: "claude",
      version: "0.0.1",
      flags: ["--output-format", "json"],
      env: { ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}" },
    },
  ],
}, async (request) => {
  // All globals are available here
  const input = await request.json();
  const sanitized = AgentSecurity.instance.sanitize(input, "input");
  // ... process ...
  return new Response(JSON.stringify(result));
});
```

The optional `tools` array in the bootstrap config registers tool
configurations. When provided, `AgentTools.instance.config(name)` returns the
config for the named tool, and `run()`/`exec()` resolve env templates and
isolate the subprocess environment to only the declared variables.

## Registry Access

- All agents (public and private) have access to public registry entities and
  runtime files.
- Only agents in the same private user registry can access private entities
  (tools, rules, skills, sub-agents).
- An entity record cannot exist in both public and private registries
  simultaneously with the same version. Public takes precedence.

## Build

```sh
npm install && npm run build
```

Output: `bin/index.js` (ESM bundle) + `bin/index.d.ts` (types) + source maps.
