# Registry Tools

Tools are executable scripts or binaries that agents invoke at runtime via
stdio. Each tool lives in a versioned folder, is registered in the control plane
database, and can be installed into agent containers on demand.

## Folder Structure

```
default-registry/tools/<slug>/<version>/
  tool.json        # Required — runtime manifest
  README.md        # Required — must include YAML frontmatter
  tool             # Executable (any extension: tool, tool.sh, tool.py)
  install.sh       # Fallback install script (any extension: install, install.sh)
```

A tool is uniquely identified by its **slug** and **version**. Slugs must be
lowercase alphanumeric with hyphens, starting with a letter (e.g. `my-tool`,
`claude`, `github`). Versions follow semver (e.g. `0.0.1`).

## Executable Discovery

The runtime discovers tool executables by convention — no path configuration is
needed in `tool.json`.

**Step 1: Look for `tool`**. The first file named `tool` (with or without any
extension) in the tool's versioned directory is used as the executable. Files
named `tool.json` are excluded from this search.

**Step 2: Fall back to `install`**. If no `tool` executable is found, the
runtime looks for a file named `install` (with or without any extension). If
found, it is executed with `TOOLS_DIR` set to the tool directory. The install
script is expected to produce a `tool` executable in that directory.

If neither a `tool` executable nor an `install` script is found, validation will
fail.

## Files

### tool.json (required)

The runtime manifest that declares the tool's identity, default flags, and
environment variable requirements. Executable paths are discovered automatically
and are not configured here.

```json
{
  "name": "my-tool",
  "slug": "my-tool",
  "version": "0.0.1",
  "flags": ["--output-format", "json"],
  "env": {
    "MY_API_KEY": "${MY_API_KEY}"
  }
}
```

| Field     | Type     | Required | Description                                                                                                                                                                                                              |
| --------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`    | string   | Yes      | Display name. Must match `slug` and the README frontmatter `name`.                                                                                                                                                       |
| `slug`    | string   | Yes      | Unique identifier. Must match the tool folder name.                                                                                                                                                                      |
| `version` | string   | Yes      | Semver version. Must match the version folder name.                                                                                                                                                                      |
| `flags`   | string[] | Yes      | Default CLI flags appended to every invocation.                                                                                                                                                                          |
| `env`     | object   | Yes      | Environment variable mapping using `${VAR}` template syntax. At runtime, templates are resolved from `process.env` and only the declared variables are passed to the tool subprocess, isolating each tool's credentials. |

### README.md (required)

Documentation for the tool. Must begin with YAML frontmatter:

```yaml
---
name: my-tool
description: Brief explanation of what the tool does and when an agent should use it.
---
```

| Field         | Required | Rules                                                                                             |
| ------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | Must match `slug` in tool.json and the tool folder name.                                          |
| `description` | Yes      | 250 characters max. Used by agents at runtime to decide whether a tool is appropriate for a task. |

The body of the README should document authentication, key flags, common usage
patterns, and runtime integration examples. See the existing tool READMEs in
this directory for the expected format.

### tool (executable)

The executable that the runtime invokes. Must be named `tool` with an optional
file extension (e.g. `tool`, `tool.sh`, `tool.py`). The file must be executable
(`chmod +x`).

For compiled binaries targeting the agent container platform (linux x86_64),
place the binary directly as `tool`. For interpreted scripts, use the
appropriate extension and include a shebang line.

### install (fallback script)

An optional script that downloads or bootstraps the `tool` executable. Must be
named `install` with an optional extension (e.g. `install`, `install.sh`,
`install.py`). Executed when no `tool` file exists in the tool directory.

The script receives `TOOLS_DIR` as an environment variable pointing to the
tool's installation directory. The script must produce a file named `tool` in
that directory.

```sh
#!/bin/sh
set -e
TOOLS_DIR="${TOOLS_DIR:-$(dirname "$0")}"
curl -sL "https://example.com/my-tool-linux-x64" \
  -o "${TOOLS_DIR}/tool" && chmod +x "${TOOLS_DIR}/tool"
```

## Versioning

Each version of a tool lives in its own subfolder:

```
default-registry/tools/my-tool/
  0.0.1/
    tool.json
    README.md
    install.sh
  0.1.0/
    tool.json
    README.md
    tool           # binary included directly
```

When multiple versions exist, the CLI resolves the latest by sorting version
folders in descending semver order. A specific version can be targeted with
`--version`.

## Creating a Tool

### From the CLI

```bash
ar tool create my-tool
```

This scaffolds a versioned folder at `default-registry/tools/my-tool/0.0.1/` with a
`tool.json` manifest, `README.md` with frontmatter, and a stub `install.sh`. It
also registers the tool in the database.

To publish to the shared public registry (admin-only when protected):

```bash
ar tool create my-tool --public
```

### Deploying a Tool

After editing the scaffolded files, deploy the tool to GCS:

```bash
ar tool deploy my-tool
```

This validates the tool folder, compresses it into an archive, uploads it to GCS
at `{tenantId}/tools/{slug}/{version}/archive.tar.gz`, and updates the database
with the `gcs_path`.

### Destroying a Tool

```bash
ar tool destroy my-tool
```

Removes the tool record from the registry database. Local files are not deleted.

### Manually

Create the folder structure, add `tool.json` and `README.md`, and include either
a `tool` executable or an `install` script. Then register and deploy it with
`ar tool create` and `ar tool deploy`.

## Development vs Production

**Running from source** (`deno task ar` in the monorepo): Tools are read from
`default-registry/tools/` at the repo root. Default tools (`cursor`, `claude`, `github`,
`auth0`, `datadog`) live here with their manifests, READMEs, and executables or
install scripts. Changes to tool folders are reflected immediately.

**Production CLI** (compiled `ar` binary): The standalone binary defaults to
`~/.ar/registry/` as the registry root. Default tools are seeded into the control plane
database on first provisioning from the manifests and README frontmatter
embedded in the build. Tool archives will be stored in GCS per tenant at
`{tenantId}/tools/{slug}/{version}/` and extracted into agent containers at
deploy time (not yet implemented — see `TODO.md` #4).

## Default Tools

The following tools are seeded into every tenant's public registry when the
control plane is provisioned. They are declared in `default-settings.jsonc` and their
full definitions live in this directory:

| Tool                      | Executable         | Install      | Env                                                      |
| ------------------------- | ------------------ | ------------ | -------------------------------------------------------- |
| [cursor](cursor/0.0.1/)   | `install.sh`       | `install.sh` | `CURSOR_API_KEY`                                         |
| [claude](claude/0.0.1/)   | `install.sh`       | `install.sh` | `ANTHROPIC_API_KEY`                                      |
| [github](github/0.0.1/)   | `tool` (pre-built) | `install.sh` | `GH_TOKEN`                                               |
| [auth0](auth0/0.0.1/)     | `tool` (pre-built) | `install.sh` | `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` |
| [datadog](datadog/0.0.1/) | `tool` (pre-built) | `install.sh` | `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE`                    |
| [gemini](gemini/0.0.1/)   | `tool.js` (direct) | —            | _(none — uses GCP service account)_                      |

## Runtime Integration

At runtime inside an agent function, tools are accessed via the `AgentTools`
global. See [`sdk-agent-nodejs/README.md`](../../sdk-agent-nodejs/README.md) for
the full API.

```js
const result = AgentTools.instance.run('my-tool', input)

const { stdout } = await AgentTools.instance.exec('my-tool', ['--flag'], input)

const config = AgentTools.instance.config('my-tool')
```

The runtime resolves `env` templates from `process.env` and passes only the
declared variables to the tool subprocess. This isolates each tool's credentials
from other tools running in the same container.

## Validation

Tool validation (`sdk-client-deno/src/tool-schema.ts`) enforces:

1. `README.md` exists and has valid YAML frontmatter with `name` and
   `description`
2. `name` in frontmatter matches the folder name and `tool.json` slug
3. `description` is present and 250 characters or fewer
4. `tool.json` exists with required fields (`name`, `slug`, `version`, `flags`,
   `env`)
5. Either a `tool` executable or `install` script exists in the tool directory
