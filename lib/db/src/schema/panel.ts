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
 * Single panel user. The whole app is built around ONE user account that the
 * admin oversees. The admin must be able to *see* the username + password, so
 * the plaintext password is stored alongside the hash (self-hosted personal
 * tool — the admin owns the data).
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

/** One row per WhatsApp contact/chat (1:1 chats only). */
export const waChatsTable = pgTable(
  "wa_chats",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().default(1),
    jid: text("jid").notNull(),
    phone: text("phone").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    lastMsg: text("last_msg").notNull().default(""),
    lastMsgTs: bigint("last_msg_ts", { mode: "number" }).notNull().default(0),
    unread: integer("unread").notNull().default(0),
    // Which connected WhatsApp account (our own number) this chat belongs to.
    accountPhone: text("account_phone"),
    pinned: boolean("pinned").notNull().default(false),
    muted: boolean("muted").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    chatUnique: uniqueIndex("wa_chats_user_jid_uq").on(t.userId, t.jid),
  }),
);
export type WaChat = typeof waChatsTable.$inferSelect;

/**
 * Registry of every WhatsApp number that has ever connected.
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
    edited: boolean("edited").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    hiddenForMe: boolean("hidden_for_me").notNull().default(false),
    viewOnce: boolean("view_once").notNull().default(false),
    ephemeral: boolean("ephemeral").notNull().default(false),
    quotedText: text("quoted_text"),
    quotedId: text("quoted_id"),
    media: text("media"),
    mediaMime: text("media_mime"),
    mediaKind: text("media_kind"),
    fileName: text("file_name"),
    linkPreviewUrl: text("link_preview_url"),
    linkPreviewTitle: text("link_preview_title"),
    linkPreviewDescription: text("link_preview_description"),
    linkPreviewThumb: text("link_preview_thumb"),
    participant: text("participant"),
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

/** Per-message emoji reactions from contacts. */
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
