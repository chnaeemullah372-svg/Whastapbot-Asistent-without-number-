import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const adminUsersTable = pgTable("admin_users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  whatsappNumber: text("whatsapp_number"),
  /**
   * "number" — single user: chat-bot forwards to/from `whatsappNumber` only.
   * "web"    — complete WhatsApp Web: bot UI mirrors full WA Web after pairing.
   */
  waMode: text("wa_mode").notNull().default("number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAdminUserSchema = createInsertSchema(adminUsersTable).omit({ id: true, createdAt: true });
export type InsertAdminUser = z.infer<typeof insertAdminUserSchema>;
export type AdminUser = typeof adminUsersTable.$inferSelect;

export const mediaFilesTable = pgTable("media_files", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: text("size").notNull(),
  url: text("url").notNull(),
  uploadedBy: serial("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MediaFile = typeof mediaFilesTable.$inferSelect;
