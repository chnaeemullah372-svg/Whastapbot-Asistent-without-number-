-- Bot ↔ WhatsApp direct bridge + user-create modes.
-- Apply with: psql $DATABASE_URL -f lib/db/migrations/2026_06_09_bot_direct_wa.sql
-- (or via `pnpm db:push` if drizzle-kit is wired up).

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS wa_mode text NOT NULL DEFAULT 'number';

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES admin_users(id);
