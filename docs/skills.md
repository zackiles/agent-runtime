# Skills

Skills are modular, load-on-use instruction sets that teach agents how to
perform specific tasks. They follow the
[Agent Skills](https://agentskills.io/specification) open standard, compatible
with Cursor, Claude Code, and other AI coding tools.

---

## Concepts

A skill is a directory containing a `SKILL.md` file (the primary content).
Optionally, a `skill.json` manifest can provide version and slug metadata, but
it is not required -- the spec only mandates `SKILL.md`. Skills are registered
in the agent runtime registry and can be attached to agents as edges, or loaded
dynamically at runtime.

Unlike rules (always-on context), skills are activated only when relevant to
the current task. The agent decides when to invoke a skill based on the
`description` field in the frontmatter.

---

## Directory Layout

```
my-skill/
  0.0.1/
    SKILL.md          # Primary content (required, Agent Skills spec)
    skill.json        # Optional manifest (slug, version)
    README.md         # Optional (used as fallback if no SKILL.md)
    scripts/          # Optional helper scripts
    references/       # Optional reference files
    assets/           # Optional static assets
```

---

## SKILL.md Format (Agent Skills Spec)

The `SKILL.md` file uses YAML frontmatter followed by a markdown body:

```markdown
---
name: my-skill
description: Helps the agent do X when the user asks for Y.
license: MIT
compatibility: requires Node.js 18+
metadata:
  author: team-name
  category: devops
disable-model-invocation: false
---

# My Skill

Step-by-step instructions for the agent go here.

## When to Use

Describe the situations where this skill applies.

## Instructions

1. First do this
2. Then do that
3. Finally verify the result
```

### Required Frontmatter Fields

| Field         | Constraints                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Max 64 chars. Lowercase alphanumeric with hyphens, no consecutive hyphens, must not start/end with hyphen, must match folder name |
| `description` | Max 1024 chars. What the skill does and when to use it                                                                            |

### Optional Frontmatter Fields

| Field                      | Constraints                                       |
| -------------------------- | ------------------------------------------------- |
| `license`                  | License name or pointer to bundled license        |
| `compatibility`            | Max 500 chars. Environment requirements           |
| `metadata`                 | Arbitrary key-value map (string to string)        |
| `allowed-tools`            | Space-separated pre-approved tools (experimental) |
| `disable-model-invocation` | If `true`, skill is only invoked explicitly       |

---

## skill.json Manifest (Optional)

If present, `skill.json` provides version and slug metadata:

```json
{
  "name": "My Skill",
  "slug": "my-skill",
  "version": "0.0.1"
}
```

The `slug` must match the `name` field in the SKILL.md frontmatter. When
`skill.json` is absent, the version defaults to `metadata.version` from the
SKILL.md frontmatter, or `0.0.1`.

---

## CLI Commands

```bash
ar skill create <name> [--public]
ar skill import <github-url|owner/repo> [skill-name]
ar skill update <slug> [-r <registry>] [--visibility public|private]
ar skill deploy <slug>
ar skill destroy <slug> [--force]
ar skill list [--public]
ar skill show <slug>
ar skill versions <slug>
ar skill clone <slug>
```

| Command    | Description                                            |
| ---------- | ------------------------------------------------------ |
| `create`   | Scaffold a new skill directory and register it         |
| `import`   | Import a skill from a GitHub repository                |
| `update`   | Update metadata, content, and visibility from registry |
| `deploy`   | Validate, compress, and upload the skill archive       |
| `destroy`  | Remove the skill from the registry (with confirmation) |
| `list`     | List skills visible to you                             |
| `show`     | Display details for a single skill                     |
| `versions` | List all versions of a skill                           |
| `clone`    | Copy a skill to your private registry                  |

### Importing Skills

You can import skills from any public GitHub repository that follows the
Agent Skills spec:

```bash
ar skill import owner/repo
ar skill import https://github.com/owner/repo
ar skill import owner/repo my-skill-name
```

The import command clones the repository, looks for `SKILL.md` (checking the
root, `skills/`, `.claude/skills/`, and `.agents/skills/` directories),
validates it against the spec, copies it to your local registry, and registers
it. If the repo contains multiple skills, pass the skill name as the second
argument.

In the web UI, click **Import** on the Skills tab and enter a GitHub URL or
`owner/repo` shorthand.

---

## Web UI

In the web client under **Registry > Skills**:

- **Create**: Click "New Skill" to open the editor form
- **Edit**: Expand a skill row and click "Edit" to modify content, metadata,
  and visibility using the markdown editor
- **Delete**: Expand a skill row and click "Delete" (with confirmation)
- **Visibility**: Skills default to `private`. Only admins can set `public`.
- **Versioning**: When saving changes, if the content changed but the version
  hasn't been bumped, you'll be prompted to bump to the next patch version.

---

## Versioning

Skills support multiple versions. Each version is a separate row in the
registry with its own content and configuration. The `active_version` field
determines which version is currently in use.

- Versions follow semver (e.g. `0.0.1`, `0.1.0`, `1.0.0`)
- Versions are forward-only: you cannot create a version lower than the current
- Bumping the version creates a new version row
- The web UI prompts for a version bump when content changes
- The web UI prevents saving when nothing has changed (dirty tracking)
- The CLI `deploy` command reads the version from `skill.json`
- Use `ar skill versions <slug>` to list all versions

---

## Compatibility

The Agent Skills spec is supported by:

- **Cursor**: `.cursor/skills/` and `.agents/skills/` directories
- **Claude Code**: `.claude/skills/` directory
- **Agent Runtime**: Registered in the control plane, deployed to GCS
