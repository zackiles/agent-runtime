# Web Dashboard

Preact islands architecture with Vite and Tailwind CSS v4. Runs as a standalone
dev server or embedded in the control plane via `@ar/web`.

## Quick Start

```sh
npm install
npm run dev          # mock API at http://localhost:5173
npm run dev:remote   # proxy to AR_CP_URL (default http://localhost:8080)
npm run build        # production build to dist/
```

## Architecture

The dashboard uses an **islands** pattern — each page is an independent Preact
component hydrated into a `data-island` placeholder. Islands share no state
through imports; all shared context flows through `window.__AR__` and the
`useApp()` hook.

| File                  | Purpose                                                  |
| --------------------- | -------------------------------------------------------- |
| `mod.ts`              | Deno module consumed by the control plane for SSR        |
| `index.html`          | Standalone dev shell with mock user context              |
| `src/entry.ts`        | Client entry — routing, tenant selector, island hydration|
| `src/pages.ts`        | Page registry — routes, groups, admin flags              |
| `src/context.ts`      | `useApp()` hook — user context and tenant switching      |
| `src/api.ts`          | Fetch wrapper with credentials                           |
| `src/islands/*.tsx`   | Island components (one per page)                         |
| `dev/mock.ts`         | Vite plugin mocking control plane API routes             |
| `dev/fixtures/*.json` | Static JSON responses for mock API                       |

### Page Registry

`src/pages.ts` defines every page's id, label, path, island, group, and
admin-only flag. All routing in `entry.ts`, nav rendering in `mod.ts`, and
admin gating derive from this single array.

### Tenants

The navbar contains a tenant selector dropdown. Switching tenants posts to
`/api/user/tenant` (sets the `ar_tenant` cookie) and reloads the page. The
`window.__AR__` object includes the tenant list and active tenant ID.

### Islands

Each island is self-contained. Shared logic lives in `pages.ts` or
`context.ts`. The registry island (`registry-status.tsx`) embeds the agents
island for the Agents tab, and the agents island embeds the copy workflow.
These are the only cross-island imports.

## Code Style

All source files are formatted by `deno fmt` (the monorepo root `deno.jsonc`
includes `web/` in the workspace). The formatter enforces:

- **2 spaces** indentation
- **No semicolons**
- **Double quotes** (deno fmt default for `.ts`/`.tsx`)
- **80 character** line width
- **Trailing commas** in multi-line constructs

Run `deno fmt` from the repo root or `deno fmt web/` to format. Run `deno lint`
for lint checks.

Additional conventions from `AGENTS.md`:

- `import type` for type-only imports
- kebab-case files, PascalCase types, camelCase functions
- No inline comments unless they explain a non-obvious "why"
- Keep files under 250 lines
- Avoid single-caller extractions; inline when it aids readability

### JSX / Preact

- Preact with `jsxImportSource: preact` (no explicit `h` import needed in JSX)
- `class` not `className` (Preact supports both; prefer `class`)
- Event handlers use `onInput`, `onChange`, `onClick` (Preact conventions)
- Use `type="button"` on all non-submit buttons

### Tailwind CSS

Tailwind v4 with `@tailwindcss/vite` plugin. Utility classes only — no custom
CSS beyond the two-line `src/tailwind.css` entry. The design uses a neutral gray
palette with blue accents and follows the spacing/sizing scale from Tailwind
defaults.

## Mock API

When `VITE_MOCK=true` (the default for `npm run dev`), the Vite plugin in
`dev/mock.ts` intercepts API requests and returns fixture data. Fixtures live in
`dev/fixtures/` as static JSON files.

The mock respects query parameters:

- `GET /api/agents?visibility=private` returns `agents-private.json`
- `GET /api/agents?visibility=public` returns `agents-public.json`
- `GET /api/agents` (no filter) returns `agents.json`
- `GET /api/registry/status?scope=public` omits private items and promotable

## Production Integration

The control plane imports `@ar/web` and calls `create()` to get a `WebModule`
with `serveStatic()` and `renderPage()`. The SSR shell renders the navbar with
the tenant selector and admin-gated nav links. The client hydrates the matching
island and initializes the tenant selector change handler.
