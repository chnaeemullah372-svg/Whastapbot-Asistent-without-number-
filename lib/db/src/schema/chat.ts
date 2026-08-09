import { pgTable, text, serial, timestamp, integer, boolean, smallint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { adminUsersTable } from "./admin";

export const chatSessionsTable = pgTable("chat_sessions", {
  id: text("id").primaryKey(),
  userName: text("user_name").notNull(),
  userPhone: text("user_phone"),
  status: text("status").notNull().default("open"),
  ownerUserId: integer("owner_user_id").references(() => adminUsersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  lastMessage: text("last_message"),
  unreadCount: integer("unread_count").notNull().default(0),
});

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => chatSessionsTable.id),
  content: text("content").notNull(),
  sender: text("sender").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  isRead: boolean("is_read").notNull().default(false),
  /** Baileys WhatsApp message id — for tick (status) updates round-trip. */
  waMessageId: text("wa_message_id"),
  /** WA status: 0 pending, 1 sent, 2 delivered, 3 read. */
  waStatus: smallint("wa_status").notNull().default(0),
  /** Local chat_messages.id of the message being quoted (if known). */
  quotedMessageId: integer("quoted_message_id"),
  /** Denormalized quoted preview text. */
  quotedText: text("quoted_text"),
  /** WA stanza id of the quoted message, for round-tripping a quote to WA. */
  quotedWaId: text("quoted_wa_id"),
});

export const insertChatSessionSchema = createInsertSchema(chatSessionsTable).omit({ createdAt: true, updatedAt: true });
export type InsertChatSession = z.infer<typeof insertChatSessionSchema>;
export type ChatSession = typeof chatSessionsTable.$inferSelect;

export const insertChatMessageSchema = createInsertSchema(chatMessagesTable).omit({ id: true, createdAt: true });
export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessagesTable.$inferSelect;
