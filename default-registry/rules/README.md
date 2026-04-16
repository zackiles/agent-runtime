# Registry Rules

Rules define constraints, policies, or behavioral guidelines that can be
attached to agents. They are currently stored as database records with a JSON
config blob.

## Current State

Rules have no file-based specification or folder structure yet. They are
created, listed, and cloned entirely through the CLI and stored in the registry
database.

```bash
ar rule create <name> [--public]
ar rule list [--public]
ar rule clone <slug>
```

| Field        | Description                           |
| ------------ | ------------------------------------- |
| `name`       | Display name                          |
| `slug`       | Unique identifier (derived from name) |
| `visibility` | `private` (default) or `public`       |
| `config`     | Free-form JSON configuration          |

Rules are scoped by tenant and identified by slug (`UNIQUE(tenant_id, slug)`).
They do not have versioning.

## Planned

A file-based specification with manifests, versioned folders, and deployment to
GCS is planned. See `TODO.md` for details.
