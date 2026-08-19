import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  smallint,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * A panel account. Multiple can exist (self-hosted multi-tenant): each one
 * gets its own WhatsApp connection and its own isolated chats/messages/calls,
 * scoped everywhere by `userId`. New signups start unapproved; an admin
 * approves (or creates) accounts from the admin panel. The admin must be
 * able to *see* the account's username + password, so the plaintext password
 * is stored alongside the hash (self-hosted tool — the admin owns the data).
 */
export const panelUserTable = pgTable("panel_user", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordPlain: text("password_plain").notNull(),
  approved: boolean("approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});
export type PanelUser = typeof panelUserTable.$inferSelect;

/** One row per WhatsApp contact/chat (1:1 chats only), scoped to the owning
 *  panel account — `jid` alone is NOT globally unique across accounts (two
 *  different users' WhatsApp connections can both have a contact with the
 *  same jid), so the natural key is the (userId, jid) pair. */
export const waChatsTable = pgTable(
  "wa_chats",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().default(1),
    jid: text("jid").notNull(),
    phone: text("phone").notNull(),
    name: text("name"),
    // Cached WhatsApp profile photo URL (contact or group icon).
    avatarUrl: text("avatar_url"),
    lastMsg: text("last_msg").notNull().default(""),
    lastMsgTs: bigint("last_msg_ts", { mode: "number" }).notNull().default(0),
    unread: integer("unread").notNull().default(0),
    // Lets the admin browse each connected number's chats separately over time.
    accountPhone: text("account_phone"),
    // Chat-list organization, same as real WhatsApp: pin to top, mute
    // notifications, archive out of the main list.
    pinned: boolean("pinned").notNull().default(false),
    muted: boolean("muted").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    // "Delete chat" (WhatsApp Web): a local-only hide, same anti-delete
    // philosophy as message-level hideForMe — messages stay in the DB for
    // monitoring, the chat just drops out of the list. Cleared automatically
    // the next time this chat sees a live message (see persistMessage).
    deletedForMe: boolean("deleted_for_me").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chatUnique: uniqueIndex("wa_chats_user_jid_uq").on(t.userId, t.jid),
  }),
);
export type WaChat = typeof waChatsTable.$inferSelect;

/**
 * Registry of every WhatsApp number that has ever connected for a given panel
 * account, with the first + latest connect date. Drives the admin "Connected
 * Numbers" view: each row's chats are filtered via wa_chats.account_phone.
 */
export const waAccountsTable = pgTable(
  "wa_accounts",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().default(1),
    phone: text("phone").notNull(),
    name: text("name"),
    firstConnectedAt: timestamp("first_connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }).notNull().defaultNow(),
    connectCount: integer("connect_count").notNull().default(1),
  },
  (t) => ({
    accountUnique: uniqueIndex("wa_accounts_user_phone_uq").on(t.userId, t.phone),
  }),
);
export type WaAccount = typeof waAccountsTable.$inferSelect;

/**
 * One row per connect→disconnect cycle of a WhatsApp number. This is the
 * admin-only "backup" boundary the owner asked for: everything that happens
 * while `disconnectedAt` is still null belongs to this session; once a number
 * disconnects the session is closed and a later reconnect always opens a
 * fresh one. Messages/calls captured during a session are tagged with its id
 * (see `wa_messages.session_id` / `wa_call_logs.session_id`) so the admin
 * panel can replay exactly what existed during that specific connected
 * window, even if the panel user later hides/deletes something on their own
 * side (which only ever flags rows — see the anti-delete design on
 * `wa_messages` — never actually erases them).
 */
export const waSessionsTable = pgTable("wa_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  phone: text("phone").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
});
export type WaSession = typeof waSessionsTable.$inferSelect;

/** Every incoming/outgoing WhatsApp message, persisted for history + backup. */
export const waMessagesTable = pgTable(
  "wa_messages",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().default(1),
    waMessageId: text("wa_message_id").notNull(),
    jid: text("jid").notNull(),
    text: text("text").notNull().default(""),
    fromMe: boolean("from_me").notNull().default(false),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    status: smallint("status").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    quotedText: text("quoted_text"),
    quotedId: text("quoted_id"),
    // Which connect→disconnect session (wa_sessions.id) this message arrived
    // during — null for messages persisted before this feature existed.
    sessionId: integer("session_id"),
    media: text("media"),
    mediaMime: text("media_mime"),
    mediaKind: text("media_kind"),
    fileName: text("file_name"),
    participant: text("participant"),
    // "Delete for me": a purely local hide (never a WhatsApp protocol call,
    // never touches the other party's copy) — distinct from `deleted`, which
    // is a real delete-for-everyone revoke. Hidden rows are simply excluded
    // from the chat's message list.
    hiddenForMe: boolean("hidden_for_me").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    // Was a WhatsApp "View once" / disappearing-timer message. The content is
    // still saved (this app's anti-delete/monitoring design keeps everything
    // by design), but the UI labels it honestly instead of hiding the fact.
    viewOnce: boolean("view_once").notNull().default(false),
    ephemeral: boolean("ephemeral").notNull().default(false),
    // Set when a later `editedMessage` update replaced this row's text.
    edited: boolean("edited").notNull().default(false),
    // Link-preview metadata WhatsApp attaches to a text message containing a
    // URL (title/description/site + a small thumbnail — not the full page).
    linkPreviewUrl: text("link_preview_url"),
    linkPreviewTitle: text("link_preview_title"),
    linkPreviewDescription: text("link_preview_description"),
    linkPreviewThumb: text("link_preview_thumb"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    waMsgUnique: uniqueIndex("wa_messages_user_msgid_uq").on(t.userId, t.waMessageId),
  }),
);
export type WaMessage = typeof waMessagesTable.$inferSelect;

/**
 * WhatsApp call log.
 */
export const waCallLogsTable = pgTable(
  "wa_call_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().default(1),
    callId: text("call_id").notNull(),
    jid: text("jid").notNull(),
    phone: text("phone").notNull(),
    name: text("name"),
    accountPhone: text("account_phone"),
    sessionId: integer("session_id"),
    outgoing: boolean("outgoing").notNull().default(false),
    isVideo: boolean("is_video").notNull().default(false),
    isGroup: boolean("is_group").notNull().default(false),
    outcome: text("outcome").notNull().default("incoming"),
    rawStatus: text("raw_status"),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    durationSec: integer("duration_sec"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    callUnique: uniqueIndex("wa_call_logs_user_call_id_uq").on(t.userId, t.callId),
  }),
);
export type WaCallLog = typeof waCallLogsTable.$inferSelect;

/** Application + connection logs. */
export const appLogsTable = pgTable("app_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"),
  source: text("source").notNull().default("system"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppLog = typeof appLogsTable.$inferSelect;

/** Backups (full JSON snapshot). */
export const appBackupsTable = pgTable("app_backups", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  chatCount: integer("chat_count").notNull().default(0),
  messageCount: integer("message_count").notNull().default(0),
  payload: text("payload").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppBackup = typeof appBackupsTable.$inferSelect;

/** Singleton settings row (id = 1). */
export const appSettingsTable = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  notifications: boolean("notifications").notNull().default(true),
  autoBackup: boolean("auto_backup").notNull().default(false),
  backupSchedule: text("backup_schedule").notNull().default("daily"),
  theme: text("theme").notNull().default("dark"),
  language: text("language").notNull().default("English"),
  pairingBrandCode: text("pairing_brand_code").notNull().default("HASANALI"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppSettings = typeof appSettingsTable.$inferSelect;

/** Emoji reactions on a message. One row per (message, reactor) — a reactor
 *  changing/removing their reaction updates or deletes their own row, exactly
 *  like WhatsApp (one active reaction per person per message). */
export const waMessageReactionsTable = pgTable(
  "wa_message_reactions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    waMessageId: text("wa_message_id").notNull(),
    reactorJid: text("reactor_jid").notNull(),
    emoji: text("emoji").notNull().default(""),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    reactionUnique: uniqueIndex("wa_msg_reaction_uq").on(t.userId, t.waMessageId, t.reactorJid),
  }),
);
export type WaMessageReaction = typeof waMessageReactionsTable.$inferSelect;
