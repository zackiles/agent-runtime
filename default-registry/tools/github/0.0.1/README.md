---
name: github
description: Use GitHub CLI to manage repositories, pull requests, issues, releases, and Actions workflows, or make raw GitHub API calls.
---

# GitHub CLI (`gh`)

## Headless Usage

All commands run non-interactively. The `--no-pager` flag is applied by default
(via tool.json `flags`) to prevent hanging on paged output. Use
`--json <fields>` on supported commands for structured output.

```bash
gh <command> <subcommand> [flags]
```

## Authentication

Authenticates via a personal access token. No interactive browser login is
needed when `GH_TOKEN` is set.

| Variable   | Required | Description                                            |
| ---------- | -------- | ------------------------------------------------------ |
| `GH_TOKEN` | Yes      | GitHub personal access token (classic or fine-grained) |

```bash
ar secret set gh-token <your-pat>
```

The token needs scopes for the operations your agent performs (e.g. `repo`,
`read:org`, `workflow`).

## Key Flags

| Flag                | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `--no-pager`        | Disable paged output (required, applied by default) |
| `--json <fields>`   | Structured JSON output with named fields            |
| `--jq <expr>`       | Filter JSON output with jq syntax (built-in)        |
| `--template <tmpl>` | Format output with Go templates                     |
| `-R, --repo <o/r>`  | Target a specific repo (owner/repo)                 |
| `--paginate`        | Fetch all pages of results (API command)            |
| `--silent`          | Suppress response body                              |

## Querying Repositories

### List repos for the authenticated user

```bash
gh repo list --json name,url,isPrivate --limit 50
```

### List repos for an organization

```bash
gh repo list my-org --json name,url,pushedAt --limit 100
```

### View repo details

```bash
gh repo view my-org/my-app --json name,description,defaultBranchRef,languages
```

## Querying Pull Requests

### List open pull requests

```bash
gh pr list --repo my-org/my-app --state open \
  --json number,title,author,createdAt,labels
```

### View a specific PR with diff stats

```bash
gh pr view 123 --repo my-org/my-app \
  --json number,title,state,additions,deletions,files
```

### List PR review comments

```bash
gh api repos/my-org/my-app/pulls/123/comments --paginate
```

## Querying Issues

### List open issues with labels

```bash
gh issue list --repo my-org/my-app --state open \
  --json number,title,labels,assignees,createdAt
```

### Search issues across the organization

```bash
gh search issues "bug fix" --owner my-org \
  --json repository,title,number,state
```

## Querying Workflows and Runs

### List recent workflow runs

```bash
gh run list --repo my-org/my-app --limit 20 \
  --json databaseId,name,status,conclusion,createdAt
```

### View a specific run with job details

```bash
gh run view 123456789 --repo my-org/my-app \
  --json status,conclusion,jobs
```

### List workflow definitions

```bash
gh workflow list --repo my-org/my-app --json id,name,state
```

### Trigger a workflow dispatch

```bash
gh workflow run deploy.yml --repo my-org/my-app \
  --ref main -f environment=staging
```

## Raw API Access

For any GitHub REST or GraphQL endpoint not covered by built-in commands:

### REST

```bash
gh api repos/my-org/my-app/commits --jq '.[0].sha'
```

### REST with pagination

```bash
gh api repos/my-org/my-app/issues --paginate --jq '.[].title'
```

### GraphQL

```bash
gh api graphql -f query='{ viewer { login } }'
```

## Searching Code

```bash
gh search code "TODO FIXME" --owner my-org \
  --json repository,path,textMatches
```

## Runtime Integration

```js
const { stdout } = await AgentTools.instance.exec('gh', [
  'pr',
  'list',
  '--repo',
  'my-org/my-app',
  '--state',
  'open',
  '--json',
  'number,title,author',
])
const openPRs = JSON.parse(stdout)
```

## Tips

- Always use `--json <fields>` for structured output when parsing results.
- Use `--jq` to filter results in a single command without piping to `jq`.
- Use `gh api` with `--paginate` for any REST endpoint not covered by built-in
  commands.
- Check `gh <command> --help` for the full flag reference of any subcommand.
