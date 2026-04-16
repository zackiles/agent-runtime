# Tools

Tools are capabilities that agents invoke at runtime to interact with external
systems, manipulate files, run commands, or call APIs. The agent runtime
supports two tool types:

- **CLI / stdio tools**: traditional executables invoked as subprocesses
- **MCP tools**: servers implementing the
  [Model Context Protocol](https://modelcontextprotocol.io), connected via
  stdio or HTTP

---

## Concepts

A tool provides one or more capabilities to an agent. CLI tools expose a
single capability via a `tool` executable. MCP tools can expose multiple
capabilities through the `tools/list` and `tools/call` JSON-RPC protocol.

For detailed authoring guidelines for CLI tools, see
[default-registry/tools/README.md](../default-registry/tools/README.md).

---

## Tool Types

### CLI / stdio (default)

The original tool model. A directory with a `tool` executable that receives
input via stdin or argv and returns output on stdout:

```
my-tool/
  0.0.1/
    README.md         # Frontmatter + description (required)
    tool.json         # Manifest with slug, version, flags, env
    tool              # Executable (any extension, must be named "tool")
    install           # Optional install script (any extension)
```

### MCP Server

An MCP-compatible server that agents communicate with via JSON-RPC 2.0.
MCP tools don't need a `tool` executable -- they have a server process:

```
my-mcp-tool/
  0.0.1/
    README.md         # Frontmatter + description (required)
    tool.json         # Manifest with type: "mcp" and mcp config
    server.js         # MCP server implementation (any language)
```

---

## tool.json Manifest

### CLI Tool

```json
{
  "name": "My Tool",
  "slug": "my-tool",
  "version": "0.0.1",
  "flags": ["--verbose"],
  "env": { "MY_API_KEY": "" }
}
```

### MCP Tool (local stdio)

```json
{
  "name": "My MCP Tool",
  "slug": "my-mcp-tool",
  "version": "0.0.1",
  "type": "mcp",
  "mcp": {
    "transport": "stdio",
    "command": "node",
    "args": ["server.js"]
  },
  "flags": [],
  "env": {}
}
```

### MCP Tool (remote HTTP)

```json
{
  "name": "Remote MCP Tool",
  "slug": "remote-mcp-tool",
  "version": "0.0.1",
  "type": "mcp",
  "mcp": {
    "transport": "http",
    "url": "https://mcp.example.com/sse",
    "headers": { "Authorization": "Bearer ${MCP_TOKEN}" }
  },
  "flags": [],
  "env": { "MCP_TOKEN": "${MCP_TOKEN}" }
}
```

### All Fields

| Field         | Required | Description                            |
| ------------- | -------- | -------------------------------------- |
| `name`        | Yes      | Display name                           |
| `slug`        | Yes      | Unique identifier (lowercase, hyphens) |
| `version`     | Yes      | Semver version                         |
| `description` | No       | What the tool does (max 500 chars)     |
| `type`        | No       | `"stdio"` (default) or `"mcp"`         |
| `mcp`         | MCP only | MCP server configuration (see below)   |
| `flags`       | No       | Default CLI flags (stdio tools only)   |
| `env`         | No       | Environment variables the tool expects |

### MCP Config

| Field       | Required   | Description                                         |
| ----------- | ---------- | --------------------------------------------------- |
| `transport` | Yes        | `"stdio"` for local subprocess, `"http"` for remote |
| `command`   | stdio only | Command to spawn the MCP server                     |
| `args`      | No         | Arguments passed to the command                     |
| `url`       | http only  | URL of the remote MCP server                        |
| `headers`   | No         | HTTP headers for remote connections                 |

---

## CLI Commands

```bash
ar tool create <name> [--public] [--mcp]
ar tool update <slug> [-r <registry>] [--visibility public|private]
ar tool deploy <slug>
ar tool destroy <slug> [--force]
ar tool list [--public]
ar tool show <slug>
ar tool versions <slug>
ar tool clone <slug>
```

| Command    | Description                                           |
| ---------- | ----------------------------------------------------- |
| `create`   | Scaffold a new tool directory and register it         |
| `update`   | Update metadata or visibility from registry directory |
| `deploy`   | Validate, compress, and upload the tool archive       |
| `destroy`  | Remove the tool from the registry (with confirmation) |
| `list`     | List tools visible to you                             |
| `show`     | Display details for a single tool                     |
| `versions` | List all versions of a tool                           |
| `clone`    | Copy a tool to your private registry                  |

Use `--mcp` with `create` to scaffold an MCP tool with a sample `server.js`.

---

## Web UI

In the web client under **Registry > Tools**:

- **Create**: Click "New Tool" to register a tool with name and description
- **Type**: Choose between "CLI / stdio" and "MCP Server"
- **MCP Config**: When MCP is selected, configure the transport (local stdio
  or remote HTTP), command/args for local, or URL for remote
- **Edit**: Expand a tool row and click "Edit" to modify metadata
- **Delete**: Expand a tool row and click "Delete" (with confirmation)
- **Visibility**: Tools default to `private`. Only admins can set `public`.

---

## MCP Protocol

MCP tools implement the
[Model Context Protocol](https://modelcontextprotocol.io/specification)
using JSON-RPC 2.0. The agent runtime acts as an MCP client.

### Lifecycle

1. **Initialization**: the runtime spawns the MCP server (stdio) or connects
   via HTTP, sends `initialize`, receives capabilities
2. **Discovery**: calls `tools/list` to enumerate the server's tools with
   their input schemas
3. **Invocation**: calls `tools/call` with the tool name and arguments
4. **Cleanup**: kills the stdio process or closes the HTTP connection

### Local (stdio) Transport

The runtime spawns the server as a subprocess. Communication happens over
stdin/stdout using newline-delimited JSON-RPC messages. The server must not
write non-JSON-RPC content to stdout (use stderr for logging).

### Remote (HTTP) Transport

The runtime sends JSON-RPC requests via HTTP POST to the server URL.
Responses are returned in the response body. Streaming uses Server-Sent
Events when supported.

### Agent Usage

```javascript
const tools = AgentTools.instance

if (tools.isMcp('my-mcp-tool')) {
  const available = await tools.mcpList('my-mcp-tool')
  const result = await tools.mcpCall('my-mcp-tool', 'hello', {
    name: 'world',
  })
} else {
  const result = tools.run('my-cli-tool', input)
}
```

---

## Versioning

Tools support multiple versions via the `UNIQUE(tenant_id, slug, version)`
constraint:

- Each version is a separate registry row with its own archive in GCS
- The `deploy` command reads the version from `tool.json`
- GCS path: `{tenantId}/tools/{slug}/{version}/archive.tar.gz`

---

## Deploy Pipeline

```
ar tool deploy my-tool
  1. Validate tool directory (README.md, tool.json, executable or MCP config)
  2. Compress directory to tar.gz
  3. Upload archive to GCS
  4. Update gcs_path in registry DB
```

For CLI tools, the archive is extracted into `/app/tools/{slug}/` during agent
deployment. For MCP tools, the server is spawned from the extracted directory
using the configured command.
