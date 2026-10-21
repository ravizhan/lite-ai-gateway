# Repository Guidelines

Guidelines for AI assistants editing `lite-ai-gateway`. Grounded in the current codebase; where this conflicts with older notes or memory, the code wins.

## Project Overview

`lite-ai-gateway` is a lightweight LLM API gateway with a single-tenant admin dashboard. It exposes an OpenAI-compatible relay (`/v1/chat/completions`, `/v1/responses`), a unified MCP endpoint (streamable-HTTP on `/mcp`, legacy SSE on `/sse` + `/messages`), and admin CRUD APIs (`/api/admin/*`).

- **Dual runtime, one codebase**: the same h3 app runs on Node (`server/node.ts`, `node:sqlite`) and Cloudflare Workers (`server/cloudflare.ts`, D1). Runtime is chosen at startup (`createApp('node' | 'workers')`) and per-request via `event.runtime?.cloudflare`.
- **Frontend**: Vue 3 SPA (`src/`) built with Vite 8 + @nuxt/ui v4. No SSR.
- **Auth**: two-key model. Admin = `ADMIN_TOKEN` env var (Bearer). LLM/MCP = rows in `api_keys` (Bearer, `enabled=1`). MCP Keys were removed by decision — do not reintroduce.
- **Scope decisions (locked, do not reopen)**: single key/provider (no key rotation), no Anthropic protocol, no chat↔responses conversion, no multi-tenancy, no migration system, no Nuxt, no external gateway integrations.

## Architecture & Data Flow

```
Request → h3 middleware (auth) → handler → getDb(event) → SQLite (Node) | D1 (Workers)
```

- **Auth first** (`server/app.ts`): `adminMw` on `/api/admin/**` (per-handler `requireAdmin` re-checks anyway); `apiKeyMw` on `/v1/**`, `/mcp`, `/mcp/**`, `/sse`, `/sse/**`, `/messages` (sets `event.context.apiKeyId`).
- **LLM relay** (`server/llm/relay.ts`): reads body once as `arrayBuffer` → `resolveRoute(db, model)` picks candidate providers (`model_routes` by priority, fallback to enabled models) → upstream `fetch` with `Accept-Encoding: identity` → usage normalized + cost computed → `llm_logs` insert. Streaming wraps upstream in `createSseTap` (zero-rewrite TransformStream with a 64KB tail ring buffer; usage parsed from tail after stream ends); `event.waitUntil` finishes logging after the response body completes.
- **Failover invariant (locked)**: only network error/timeout or 5xx with **zero bytes forwarded** retries the next provider; 4xx passes through verbatim; a stream never switches providers once bytes have been sent. Do not "improve" without an explicit ask.
- **MCP streamable-HTTP** (`server/mcp/routes.ts`): per-request stateless `WebStandardStreamableHTTPServerTransport`; `hub.ts` aggregates upstream servers. Tools retain raw names unless they collide within the selected group; `shared/mcp-naming.ts` assigns collision prefixes and is shared with token previews. Tool listing/calling requires a complete paginated inventory; real discovery failures fail closed, unsupported tools count as empty. Prompts keep `${serverName}__` prefixes. Node-only transports (stdio/SSE clients, Node SSE endpoint) go through the injected registry in `server/mcp/node-bindings.ts`, installed by the Node entry before `createApp('node')`.
- **MCP logs** (`server/mcp/transport-log.ts`): observes all authenticated inbound protocol requests/notifications across HTTP and both SSE transports, plus transport rejections. Stores `request_body`; successful `response_body` is NULL, failed responses are retained in full (including `isError` results). Cancellation/disconnect without a response retains input with a failed status and NULL response. Only error summaries are sanitized/truncated; original bodies can contain sensitive data. Existing databases require the two manual ALTER statements documented in README.
- **DB** (`server/db/`): the `Db` interface (`run/get/all/exec`, promise-returning, booleans as 0/1) is the single abstraction; `getDb(event)` is the **only** runtime divergence. Shared idempotent `server/db/schema.sql` for both runtimes. No transaction API by design (D1 has none) — multi-write ops use delete-then-insert.
- **Frontend data flow**: pages call `api<T>(path, {method, body, query})` from `src/lib/api.ts` (same-origin, injects Bearer token, strips empty query values, 401 → logout + redirect `/login`). Mutations re-fetch and toast via auto-imported `useToast()`.

## Key Directories

| Path | Purpose |
|---|---|
| `server/` | h3 backend, shared by both runtimes |
| `server/admin/` | Admin CRUD modules (one file per resource: providers, models, prices, routes, keys, logs, stats, info, mcp) |
| `server/llm/` | Relay, routing, SSE tap, usage/billing, `/v1` routes |
| `server/mcp/` | MCP hub, upstream clients, streamable-HTTP + SSE routes (Node and Workers variants), `node-bindings.ts` / `bindings-node.ts` Node transport injection |
| `server/db/` | `Db` interface + Node SQLite / D1 adapters + `schema.sql` |
| `server/lib/` | `sanitize.ts`, `keys.ts`, `timeout.ts`, `version.ts` |
| `src/` | Vue 3 SPA: `pages/`, `components/`, `layouts/`, `lib/`, `stores/`, `composables/`, `locales/`, `router/` |
| `shared/` | `api.ts`: row/response types + `gatewayError()` factory (imported by both sides) |
| `data/` | Local SQLite state (`gateway.db`) — gitignored, not source |

## Development Commands

Package manager is **pnpm**. Quality gates (must all pass before finishing work):

```bash
pnpm typecheck   # vue-tsc -p tsconfig.json && tsc -p tsconfig.server.json
pnpm lint        # eslint .
pnpm build       # vite build → dist/
```

Package the standalone server executable:

```bash
pnpm build:server # tsdown → dist-bundle/server/ (single-file bundle + linux-x64/win-x64/darwin-arm64 SEA executables)
```

`pnpm build:server` requires Node 26: SEA blobs must use the same Node version as the target executable, taken from the local `process.versions.node` (the release workflow's `exe` job pins Node 26). It emits only the executables plus the intermediate `node.mjs`; copy `server/db/schema.sql` and `dist/` next to the binary to run it locally.

Run/dev:

```bash
pnpm dev         # concurrently: vite --port 5173 + node --watch server/node.ts
pnpm dev:cf      # wrangler dev (Workers runtime)
pnpm start       # node server/node.ts (serves dist/ + API on PORT, default 8788)
pnpm deploy      # vite build && wrangler deploy
pnpm db:init:local / db:init:remote   # apply schema.sql to D1
```

- Node dev runs TypeScript directly via native type-stripping (no build step, no `--experimental` flags). `.env` is loaded with `process.loadEnvFile()`.
- Vite dev proxy sends `/v1`, `/api`, `/mcp`, `/sse`, `/messages` to `http://localhost:8788`; `/mcp` GET with `Accept: text/html` bypasses to `index.html` (SPA routing vs MCP protocol).
- Node serves the SPA: `app.all('/**')` catch-all with `serveStatic` in `node.ts` (must stay a route, never a `/**` middleware — see conventions).

## Code Conventions & Common Patterns

### TypeScript / imports
- **Every relative import in `server/` must carry the `.ts` suffix** (e.g. `import { gatewayError } from '../../shared/api.ts'`) — enabled by `allowImportingTsExtensions` in `tsconfig.server.json`; forgetting it breaks typecheck and Node resolution.
- `src/` uses the `@/` alias (`@/lib/api`).
- TypeScript is pinned `^6.0.3`. **Do not bump to TS 7** — `vue-tsc` and `typescript-eslint` reject it.
- Shared pure types + `gatewayError(status, message, type)` live in `shared/api.ts`.

### Dual-runtime rules (Node + Workers)
- **Never statically import Node-only modules** (`node:sqlite`, `node:child_process`, `eventsource`, `SSEServerTransport`) into the shared graph — they would drag into the Workers bundle, and `import.meta.resolve`-based dynamic `import()` breaks once the server is bundled into a single file/SEA. Inject them through a registry instead, following the `setNodeDb` pattern: `server/mcp/node-bindings.ts` holds the interface and accessor (no `node:` deps, safe for the Workers bundle), `server/mcp/bindings-node.ts` statically imports the implementations, and `server/node.ts` calls `installNodeMcpBindings()` before `createApp('node')`. Shared code (`server/mcp/upstream.ts`, `server/mcp/routes.ts`) only calls `getNodeMcpBindings()`. Keep genuinely entry-only code in Node-only entry files (`server/db/bootstrap.ts`).
- Runtime detection: `event.runtime?.cloudflare` (env at `event.runtime.cloudflare.env`) for Workers; `event.runtime.name === 'node'` for Node. Env types come from generated `worker-configuration.d.ts` (regenerate with `wrangler types` after binding changes — never hand-write).
- `VERSION` is hardcoded in `server/lib/version.ts` (Workers can't read package.json).

### Error handling
- Handlers throw h3 `createError`/`HTTPError`; LLM relay returns `gatewayError()` Responses directly.
- **Every error string persisted (`llm_logs.error`, `mcp_logs.error`) or echoed in admin summaries must pass `sanitizeError`** (`server/lib/sanitize.ts`) — it masks `Authorization`/`X-Api-Key` header values and query keys. Mandatory, non-negotiable.
- Admin handlers use `parseBody<T>(schema, body)` (zod → HTTP 400 with issues) and `routeId(event)` for `getRouterParam('id')`.
- Keep DB writes to single statements (D1 subrequest budget); no synchronous transactions.

### h3 (v2.0.1-rc.26, rou3 engine)
- Path middleware needs explicit `/**` wildcards: `app.use('/api/admin/**', adminMw)`. Exact-match paths (`/mcp`, `/sse`, `/messages`) are registered separately from their `/**` forms.
- **Never** use a global `app.use('/**')` middleware — it runs before routes and intercepts the API. Static SPA serving is an `app.all('/**')` **route** (lowest precedence).
- Streaming responses: never set `content-length` (delete it); send `Accept-Encoding: identity` upstream so bytes pass through unchanged.
- MCP `Server`/transport instances are **per-request** (`Protocol.connect` throws "Already connected" on reuse); close the server only when the response body ends.

### Frontend
- Auto-imports: `@nuxt/ui/vite` auto-imports vue (`ref`, `computed`, ...), vue-router, pinia, and @nuxt/ui composables (`useToast`) — do **not** import them manually. Components auto-register PascalCase (`src/components.d.ts`).
- Data fetching: **only** `/api/admin/logs` and `/api/admin/mcp/logs` are paged (`usePagedList`). All other list endpoints return plain arrays — fetch directly with `api<T[]>` + `onMounted` (using `usePagedList` on them yields empty tables).
- **USelect "all"/placeholder options must use `value: null`** — an empty-string value throws a pageerror.
- No `v-if`/`v-for` on the same element — wrap with `<template v-for>`.
- i18n: `src/locales/en.json` + `zh-CN.json` **must keep identical key trees** (namespaces: common, nav, ..., cols shared headers, validation); ICU `{var}` interpolation; `setLocale()` persists to localStorage `lite-ai-gateway:locale`.
- Styling: Tailwind v4 + @nuxt/ui semantic CSS variables (`text-(--ui-success)`, `bg-(--ui-bg-muted)`, `border-(--ui-border)`) — never hardcode colors; light/dark must both work. Icons: local `i-lucide-*` via `@iconify-json/lucide` `clientBundle.scan` (offline, 0 external requests).
- Charts: the single chart component is `src/components/ModelSeriesChart.vue` (echarts). No hand-written SVG chart components remain.
- Shared page furniture: `PageHeader` (title/description/action slot), `ConfirmModal` (delete confirm, emits `confirm`), `CopyButton`, `StatCard`, `RuntimeBadge`, form modals emitting `saved` and using `defineModel('open')`.

## Important Files

| File | Why it matters |
|---|---|
| `server/app.ts` | `createApp(runtime)` — middleware mounting + route registration, the only place all routes are wired |
| `server/node.ts` / `server/cloudflare.ts` | Runtime entries (env loading, db injection, SPA serving / `h3/cloudflare` `serve`) |
| `server/auth.ts` | `requireAdmin` / `requireApiKey`, middleware factories |
| `server/llm/relay.ts` | Relay + locked failover semantics |
| `server/llm/sse-tap.ts` | Streaming passthrough + tail usage parsing |
| `server/mcp/routes.ts` | Streamable-HTTP + runtime branch for SSE variants |
| `server/mcp/node-bindings.ts` | Workers-safe registry for Node-only MCP transports; injected by the Node entry |
| `server/mcp/hub.ts` | Group-scoped tool naming/routing; prompts retain server prefixes |
| `server/mcp/transport-log.ts` | Request inputs and failure-only response logging across MCP transports |
| `shared/mcp-naming.ts` | Collision-only tool names shared by hub and token previews |
| `server/db/schema.sql` | Single shared schema, idempotent, no migrations |
| `shared/api.ts` | Shared row types + `gatewayError()` |
| `src/lib/api.ts` | Frontend fetch wrapper (auth injection, 401 handling) |
| `src/router/index.ts` | Routes + auth guard (`/login` is `meta.public`) |
| `src/layouts/admin.vue` | Shell: nav, locale switcher, theme toggle, logout |
| `vite.config.ts` | Vite 8 + @nuxt/ui plugin, dev proxy with `/mcp` SPA bypass |
| `tsdown.config.ts` | `pnpm build:server`: single-file server bundle (`alwaysBundle`) + SEA targets pinned to `versions.node` |
| `wrangler.jsonc` | Workers config: D1 `DB`, assets with `run_worker_first`, zero compatibility flags |
| `worker-configuration.d.ts` | Generated by `wrangler types` (global `DB`, `ASSETS`, `ADMIN_TOKEN`) |

## Runtime/Tooling Preferences

- **pnpm** (workspace root, no `packageManager`/`engines` field; lockfile v9). IDE configured for pnpm.
- **Node runtime** for dev/start; Node version must support native TS type-stripping (TS 6.x era Node). Workers via `wrangler dev`. `pnpm build:server` additionally needs Node 26 (SEA blob version = local `versions.node`).
- **Version pins that must not move**: `typescript ^6.0.3` (TS7 rejected by toolchain), `@modelcontextprotocol/sdk ^1.x`, `h3 2.0.1-rc.26` (rou3 engine — the middleware/route rules above depend on it).
- `wrangler.jsonc` constraints: zero `compatibility_flags`, `compatibility_date 2026-09-01`, no `nodejs_compat`, `run_worker_first` inside the `assets` block.
- `.env` / `.dev.vars` (gitignored): `ADMIN_TOKEN` (required), `DATABASE_PATH` (default `./data/gateway.db`), `PORT` (default 8788). Workers gets `ADMIN_TOKEN` via `wrangler.jsonc` var / `.dev.vars`.

## Working Practices (AI Assistants)

- **Third-party libraries**: before adding a new dependency or changing usage of an existing one, query the latest official documentation (context7 docs, library source, official site) — never assume API facts from memory. Version pins in this repo are locked (see Runtime/Tooling Preferences); verify any new dependency against both runtimes before introducing it.
- **Subagents**: use `task` subagents (read-only `scout` for investigation) for independent work slices — multi-file changes, refactors, research — to keep the main agent's context concise. Own the decomposition and cross-task contracts; don't delegate the top-level plan.
- **Memory**: before writing code, `recall`/`reflect` to quickly load current codebase state and conventions; after finishing work, `retain` durable facts (decisions, changes, pitfalls) so future sessions stay current.

## Testing & QA

- **There is no automated test suite** (no vitest/jest/playwright; no test files). Do not look for one.
- Verification is: (1) the three gates — `pnpm typecheck`, `pnpm lint`, `pnpm build`; (2) manual/browser testing of the UI (desktop 1440×900 and mobile 390×844, light + dark mode, all routes free of console errors). Browser-driven verification is the accepted method; one-off verification scripts have been used before but were removed to keep the repo clean — prefer the browser tool and clean up any temporary artifacts (files, deps, eslint config entries) before finishing.
- Seed data for UI scenarios was previously injected by a temporary script (env-gated `ALLOW_SEED=1`); that script no longer exists — recreate only if needed for verification, then remove.
- **CI exists**: `.github/workflows/ci.yml` runs the three gates (`pnpm install --frozen-lockfile` + typecheck/lint/build) on `main` pushes and PRs (Node 24, pnpm 12.3.4). `.github/workflows/release.yml` runs on `v*` tags: publishes `ghcr.io/ravizhan/lite-ai-gateway` (linux/amd64, tag + `latest`) and uploads three SEA executable tarballs as artifact `lite-ai-gateway-exe-${tag}` (30-day retention). No GitHub Release and no versioning/changelog process. Gates green + browser verification = done.
