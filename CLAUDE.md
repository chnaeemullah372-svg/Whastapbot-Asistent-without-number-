# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a pnpm monorepo (pnpm workspaces, not npm/yarn — `preinstall` actively refuses non-pnpm installs).

```bash
pnpm install                                          # install all workspace deps
pnpm run build                                        # typecheck everything, then build every package
pnpm run typecheck                                    # typecheck only

# Single package (name is the pnpm workspace path or package name):
pnpm --filter "./artifacts/api-server" run build      # esbuild bundle -> dist/index.mjs
pnpm --filter "./artifacts/api-server" run typecheck
pnpm --filter "./artifacts/support-connect" run build # vite build -> dist/public
pnpm --filter "./artifacts/support-connect" run dev   # vite dev server, --host 0.0.0.0

# Database (Drizzle, schema-push workflow — there are NO migration files):
pnpm --filter db run push                             # drizzle-kit push, applies schema/*.ts to DATABASE_URL
pnpm --filter db run push-force                       # same, with --force (skips data-loss confirmation)
```

There is no test suite in this repo (no test runner/framework is configured anywhere).

`artifacts/mockup-sandbox` is a separate, unrelated Replit scaffold app (its own `vite build` requires a `PORT` env var to even load its config) — it is not part of the production system and its build/typecheck can be ignored when working on the WhatsApp product.

## Production deployment (self-hosted, not a platform)

This runs on a single VPS under PM2, defined in `ecosystem.config.cjs` (gitignored, contains live secrets — `DATABASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET`):

- `whatsapp-api` — `artifacts/api-server/dist/index.mjs`, port 3001
- `whatsapp-frontend` — `serve`-static of `artifacts/support-connect/dist`, port 3002

Deploys are triggered by a GitHub webhook, not `git push` from this machine:
`scripts/webhook-server.cjs` (PM2 process `webhook-server`, port 9000) receives the webhook and shells out to `scripts/deploy.sh`, which does `git fetch` + **`git reset --hard origin/main`** (discards any local modifications), reinstalls, rebuilds `api-server` + `support-connect`, and — only if both builds succeed — `pm2 restart`s them. It fetches over SSH using a dedicated deploy key (`/root/.ssh/github_deploy`), separate from whatever credential this machine uses for outbound `git push`.

Because `deploy.sh` hard-resets on every push, any manual local edit made directly on the server (outside of this workflow) will be silently discarded on the next deploy unless it's also committed and pushed.

## Architecture: two WhatsApp integrations riding one Express app

The single biggest thing to understand before touching `artifacts/api-server` is that **two independent products share one Express app and one Baileys connection layer**, layered in over time rather than one replacing the other:

1. **Legacy "support widget" system** — a customer-support chat widget embedded on a website, backed by `chat_sessions`/`chat_messages` (`lib/db/src/schema/chat.ts`) and `admin_users` (`schema/admin.ts`). Each row in `admin_users` is a tenant with their own `whatsappNumber` and a `waMode` of `"number"` (bridge to one number) or `"web"` (full panel). Routes: `routes/admin.ts`, `routes/whatsapp.ts`, `routes/chat.ts`, `routes/userWhatsapp.ts`. WhatsApp connection: `services/whatsapp.ts` (`whatsappService`, one global/legacy session).
2. **Newer "personal WhatsApp Web clone" panel** — a full inbox UI (chats/groups/calls/status/starred, at `support-connect`'s `pages/panel/*`) for **one single self-hosted user**, backed by `wa_chats`/`wa_messages`/`wa_call_logs`/`wa_accounts` (`schema/panel.ts`). Routes: `routes/panel.ts`. WhatsApp connection: `services/multiWhatsapp.ts` (`multiWA`, supports multiple connected numbers per user).

Both connection layers funnel into the same `services/chatPersistence.ts` and both are wired together in `app.ts`, which listens on `multiWA`/`whatsappService` message+status events and bridges *incoming* WhatsApp replies back into the support-widget's `chat_sessions`/`chat_messages` tables (see `routeIncomingWAToBot`). So a change to one integration's message flow can have a visible effect on the other via these bridge listeners — check `app.ts` when touching either.

There's also `routes/adminPanel.ts`, a *third*, separate token-authed surface (`sc_admin_` tokens) for an admin dashboard over the legacy `admin_users`/tenant data — distinct from both `routes/admin.ts` and `routes/panel.ts`. Frontend routing in `support-connect/src/App.tsx` mirrors this split: `/admin*` → `pages/adminpanel/*`, everything else (`/`, `/connect`, `/chats`, etc.) → `pages/panel/*`.

**The panel is single-user despite having `userId` columns.** `wa_chats`/`wa_messages`/`wa_call_logs` all carry a `userId` (default `1`) as if multi-tenant, but every route/service call hardcodes `PANEL_USER_ID` (`chatPersistence.ts`, = `1`). This is a half-migrated-toward-multi-user design, not active multi-tenancy — don't assume a second panel user actually works end-to-end without also auditing auth (`panel_user` table is genuinely single-row: see the comment on `panelUserTable` in `schema/panel.ts`).

**Auth is two parallel, custom, non-JWT HMAC token schemes**, not sessions: `sc_panel_<hmac>` (panel, `routes/panel.ts`) and `sc_admin_<hmac>` (admin dashboard, `routes/adminPanel.ts`), both derived from `HMAC-SHA256(SESSION_SECRET, "<id>:<passwordHash>")`. A token is only invalidated by changing the user's password hash — there's no separate revocation/expiry. `getUserFromToken` intentionally scans *all* panel users rather than trusting `limit(1)`, because a pending signup can leave >1 row (see the comment there).

## Database

Drizzle ORM over Postgres, schema lives entirely in `lib/db/src/schema/*.ts`, re-exported from `schema/index.ts` and from the package root (`@workspace/db`). There is no migrations directory — schema changes are applied straight to the live DB with `drizzle-kit push` (`pnpm --filter db run push`). When you add/rename a column here, it does not exist anywhere until that push is run against the real `DATABASE_URL` — the TypeScript types will happily compile against a schema the database doesn't have yet.

## Other packages

- `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` — an OpenAPI-driven codegen scaffold (`orval`, config in `lib/api-spec/orval.config.ts`) generating a react-query client + zod schemas from `openapi.yaml`. **Currently unused** — `support-connect` talks to the API with hand-written `fetch` calls (`src/lib/panelApi.ts`, `src/lib/auth.ts`), not the generated client. Don't assume wiring changes here affect the running frontend.
