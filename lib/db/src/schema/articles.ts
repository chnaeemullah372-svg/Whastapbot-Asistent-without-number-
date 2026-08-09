import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const articlesTable = pgTable("articles", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  content: text("content"),
  category: text("category").notNull(),
  imageUrl: text("image_url"),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
  isFeatured: boolean("is_featured").notNull().default(false),
  isTrending: boolean("is_trending").notNull().default(false),
  viewCount: integer("view_count").notNull().default(0),
});

export const insertArticleSchema = createInsertSchema(articlesTable).omit({ id: true });
export type InsertArticle = z.infer<typeof insertArticleSchema>;
export type Article = typeof articlesTable.$inferSelect;
