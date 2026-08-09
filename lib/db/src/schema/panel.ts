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
export const waChatsTable = pgTable("wa_chats", {
  jid: text("jid").primaryKey(),
  phone: text("phone").notNull(),
  name: text("name"),
  lastMsg: text("last_msg").notNull().default(""),
  lastMsgTs: bigint("last_msg_ts", { mode: "number" }).notNull().default(0),
  unread: integer("unread").notNull().default(0),
  // Which connected WhatsApp account (our own number) this chat belongs to.
  // Lets the admin browse each connected number's chats separately over time.
  accountPhone: text("account_phone"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type WaChat = typeof waChatsTable.$inferSelect;

/**
 * Registry of every WhatsApp number that has ever connected, with the first +
 * latest connect date. Drives the admin "Connected Numbers" view: each row's
 * chats are filtered via wa_chats.account_phone.
 */
export const waAccountsTable = pgTable("wa_accounts", {
  phone: text("phone").primaryKey(),
  name: text("name"),
  firstConnectedAt: timestamp("first_connected_at", { withTimezone: true }).notNull().defaultNow(),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }).notNull().defaultNow(),
  connectCount: integer("connect_count").notNull().default(1),
});
export type WaAccount = typeof waAccountsTable.$inferSelect;

/** Every incoming/outgoing WhatsApp message, persisted for history + backup. */
export const waMessagesTable = pgTable(
  "wa_messages",
  {
    id: serial("id").primaryKey(),
    waMessageId: text("wa_message_id").notNull(),
    jid: text("jid").notNull(),
    text: text("text").notNull().default(""),
    fromMe: boolean("from_me").notNull().default(false),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    status: smallint("status").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    // When a delete-for-everyone happened. We KEEP the original text/media for
    // monitoring (anti-delete) and only flag the row + record when it happened.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    quotedText: text("quoted_text"),
    quotedId: text("quoted_id"),
    // Media payload (base64) for photos/voice/video/documents/stickers. Kept
    // out of the chat-list query; served on demand via the media endpoint.
    media: text("media"),
    mediaMime: text("media_mime"),
    mediaKind: text("media_kind"), // image | video | audio | sticker | document
    fileName: text("file_name"),
    // For status@broadcast (stories) and groups: the JID of the contact who
    // actually POSTED/sent this message, so the Status view can group updates by
    // poster. Null for ordinary 1:1 chats.
    participant: text("participant"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    waMsgUnique: uniqueIndex("wa_messages_wa_message_id_uq").on(t.waMessageId),
  }),
);
export type WaMessage = typeof waMessagesTable.$inferSelect;

/**
 * WhatsApp call log. A linked/companion device only receives call
 * NOTIFICATIONS (an "offer" and a terminal state) — NOT a full telephony
 * record. We persist what is reliably available: who called, voice/video,
 * and the outcome (incoming/missed/rejected/accepted). The talk DURATION of a
 * call answered on the phone is generally NOT delivered to a linked device, so
 * `durationSec` is usually null (surfaced honestly in the UI).
 */
export const waCallLogsTable = pgTable(
  "wa_call_logs",
  {
    id: serial("id").primaryKey(),
    callId: text("call_id").notNull(),
    jid: text("jid").notNull(),
    phone: text("phone").notNull(),
    name: text("name"),
    accountPhone: text("account_phone"),
    outgoing: boolean("outgoing").notNull().default(false),
    isVideo: boolean("is_video").notNull().default(false),
    isGroup: boolean("is_group").notNull().default(false),
    // incoming | missed | rejected | accepted | ongoing | unknown
    outcome: text("outcome").notNull().default("incoming"),
    rawStatus: text("raw_status"),
    ts: bigint("ts", { mode: "number" }).notNull().default(0),
    // Usually null — WhatsApp does not reliably expose answered-call duration to
    // a linked device.
    durationSec: integer("duration_sec"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    callUnique: uniqueIndex("wa_call_logs_call_id_uq").on(t.callId),
  }),
);
export type WaCallLog = typeof waCallLogsTable.$inferSelect;

/** Application + connection logs (visible in User Logs + Admin Logs). */
export const appLogsTable = pgTable("app_logs", {
  id: serial("id").primaryKey(),
  level: text("level").notNull().default("info"),
  source: text("source").notNull().default("system"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type AppLog = typeof appLogsTable.$inferSelect;

/** Backups (full JSON snapshot of chats + messages + settings). */
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
