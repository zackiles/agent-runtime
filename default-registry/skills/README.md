# Registry Skills

Skills are reusable capabilities that can be attached to agents. They are
currently stored as database records with a JSON config blob.

## Current State

Skills have no file-based specification or folder structure yet. They are
created, listed, and cloned entirely through the CLI and stored in the registry
database.

```bash
ar skill create <name> [--public]
ar skill list [--public]
ar skill clone <slug>
```

| Field        | Description                           |
| ------------ | ------------------------------------- |
| `name`       | Display name                          |
| `slug`       | Unique identifier (derived from name) |
| `visibility` | `private` (default) or `public`       |
| `config`     | Free-form JSON configuration          |

Skills are scoped by tenant and identified by slug (`UNIQUE(tenant_id, slug)`).
They do not have versioning.

## Planned

A file-based specification with manifests, versioned folders, and deployment to
GCS is planned. See `TODO.md` for details.
