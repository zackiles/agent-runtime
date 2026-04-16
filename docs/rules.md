# Rules

Rules are always-on text instructions that provide standing context, coding
standards, and behavioral guidelines to agents. They are loaded at the start
of every agent session and remain active throughout.

---

## Concepts

Unlike skills (which are activated on demand), rules are persistent context.
They tell agents what to always do or never do: coding style, naming
conventions, security policies, response formatting, etc.

Rules can be scoped to specific file patterns using glob matching, so
different rules apply to different parts of a codebase.

---

## Directory Layout

```
my-rule/
  0.0.1/
    README.md         # Frontmatter + description (required)
    rule.json         # Manifest with slug, version, globs
```

The rule content itself can be stored in the `README.md` body or uploaded
as the `content` field via the API/web editor.

---

## rule.json Manifest

```json
{
  "name": "My Rule",
  "slug": "my-rule",
  "version": "0.0.1",
  "description": "Enforce TypeScript naming conventions",
  "globs": ["**/*.ts", "**/*.tsx"]
}
```

| Field         | Required | Description                            |
| ------------- | -------- | -------------------------------------- |
| `name`        | Yes      | Display name                           |
| `slug`        | Yes      | Unique identifier (lowercase, hyphens) |
| `version`     | Yes      | Semver version                         |
| `description` | No       | What the rule enforces (max 250 chars) |
| `globs`       | No       | File patterns the rule applies to      |

### Globs

The `globs` array determines which files the rule is relevant to. When an
agent works on a file matching any glob pattern, the rule is included in its
context. If `globs` is empty or omitted, the rule applies globally.

Examples:

- `["**/*.ts"]` -- TypeScript files only
- `["src/api/**"]` -- API source directory
- `["*.md", "docs/**"]` -- Documentation files

---

## CLI Commands

```bash
ar rule create <name> [--public]
ar rule update <slug> [-r <registry>] [--visibility public|private]
ar rule deploy <slug>
ar rule destroy <slug> [--force]
ar rule list [--public]
ar rule show <slug>
ar rule versions <slug>
ar rule clone <slug>
```

| Command    | Description                                            |
| ---------- | ------------------------------------------------------ |
| `create`   | Scaffold a new rule directory and register it          |
| `update`   | Update metadata, content, and visibility from registry |
| `deploy`   | Validate, compress, and upload the rule archive        |
| `destroy`  | Remove the rule from the registry (with confirmation)  |
| `list`     | List rules visible to you                              |
| `show`     | Display details for a single rule                      |
| `versions` | List all versions of a rule                            |
| `clone`    | Copy a rule to your private registry                   |

---

## Web UI

In the web client under **Registry > Rules**:

- **Create**: Click "New Rule" to open the editor form
- **Edit**: Expand a rule row and click "Edit" to modify content using the
  markdown editor, adjust globs, and change visibility
- **Delete**: Expand a rule row and click "Delete" (with confirmation)
- **Visibility**: Rules default to `private`. Only admins can set `public`.
- **Versioning**: When saving content changes, you'll be prompted to bump the
  version if it hasn't changed.

### Writing Rules

Rules are plain text or markdown. Write them as clear instructions to the
agent:

```markdown
# TypeScript Style

- Use 2-space indentation
- Prefer `const` over `let`
- Use `import type` for type-only imports
- No semicolons
- Single quotes for strings
- Keep files under 250 lines
```

---

## Versioning

Rules support multiple versions (since schema migration v8):

- Each version is a separate row in the registry
- The `active_version` field determines which version is in use
- Versions are forward-only: you cannot create a version lower than the current
- The web UI prompts for a version bump when content changes
- The web UI prevents saving when nothing has changed (dirty tracking)
- Version switching is available via the API: `PUT /:id/version`
- Use `ar rule versions <slug>` to list all versions

---

## API Endpoints

| Method   | Path                       | Description           |
| -------- | -------------------------- | --------------------- |
| `POST`   | `/rules`                   | Create a rule         |
| `GET`    | `/rules`                   | List rules            |
| `GET`    | `/rules/:id`               | Get a single rule     |
| `PUT`    | `/rules/:id`               | Update rule metadata  |
| `DELETE` | `/rules/:id`               | Delete a rule         |
| `GET`    | `/rules/:id/versions`      | List versions         |
| `POST`   | `/rules/:id/versions`      | Create a new version  |
| `PUT`    | `/rules/:id/version`       | Switch active version |
| `DELETE` | `/rules/:id/versions/:ver` | Delete a version      |
| `POST`   | `/rules/:id/deploy`        | Upload rule archive   |
