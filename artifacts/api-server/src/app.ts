import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { multiWA, type IncomingWAMsg, type StatusUpdate } from "./services/multiWhatsapp";
import { whatsappService } from "./services/whatsapp";
import { startPersistence } from "./services/chatPersistence";
import { db, chatSessionsTable, chatMessagesTable, adminUsersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Only auto-reconnect WA on production. In development both dev and prod
// share the same phone credentials, causing 440 "Connection Replaced" fights.
// Dev admin can manually reconnect via the WA panel's "Fix" button.
// Wire the WA engine to the DB and load saved chat history on boot.
void startPersistence();

if (process.env.NODE_ENV === "production") {
  setTimeout(() => multiWA.autoReconnectSaved(), 3000);
  setTimeout(() => whatsappService.autoReconnectSaved(), 4000);
}

// ── DIRECT BRIDGE (incoming): WhatsApp reply → bot widget ──
async function routeIncomingWAToBot(ownerUserId: number, senderPhone: string, msg: IncomingWAMsg) {
  try {
    const normalizedPhone = senderPhone.replace(/^\+/, "");

    const candidates = await db
      .select()
      .from(chatSessionsTable)
      .where(eq(chatSessionsTable.ownerUserId as any, ownerUserId));

    let target = candidates.find(s => s.status === "open" && (s.userPhone === senderPhone || s.userPhone === normalizedPhone));
    if (!target) target = candidates.filter(s => s.status === "open").sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];

    if (!target) return; // No cross-wiring: only route to this owner's sessions

    // If the WA reply quotes one of our previously-sent bot→WA messages, link it.
    let quotedMessageId: number | null = null;
    let quotedTextFromLocal: string | null = null;
    if (msg.quotedWaId) {
      const [match] = await db
        .select()
        .from(chatMessagesTable)
        .where(and(eq(chatMessagesTable.sessionId, target.id), eq(chatMessagesTable.waMessageId as any, msg.quotedWaId)));
      if (match) {
        quotedMessageId = match.id;
        quotedTextFromLocal = match.content;
      }
    }

    await db.insert(chatMessagesTable).values({
      sessionId: target.id,
      content: msg.text,
      sender: "admin", // widget renders "admin" sender as the bot's reply
      isRead: false,
      waMessageId: msg.waMessageId,
      waStatus: 2, // we just auto-sent a "delivered" receipt
      quotedMessageId,
      quotedText: quotedTextFromLocal ?? msg.quotedText ?? null,
      quotedWaId: msg.quotedWaId ?? null,
    } as any);

    await db
      .update(chatSessionsTable)
      .set({ lastMessage: msg.text })
      .where(eq(chatSessionsTable.id, target.id));
  } catch (err) {
    logger.error({ err }, "Failed to route incoming WA → bot");
  }
}

multiWA.addMsgListener((userId, senderPhone, msg) => {
  routeIncomingWAToBot(userId, senderPhone, msg);
});

// ── DIRECT BRIDGE (status): WA tick updates → bot widget bubble ──
multiWA.addStatusListener(async (_userId, update: StatusUpdate) => {
  try {
    const [row] = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.waMessageId as any, update.waMessageId));
    if (!row) return;
    // Only ratchet status forward.
    const current = (row as any).waStatus ?? 0;
    if (update.status <= current) return;
    await db
      .update(chatMessagesTable)
      .set({ waStatus: update.status, isRead: update.status >= 3 ? true : row.isRead } as any)
      .where(eq(chatMessagesTable.id, row.id));
  } catch (err) {
    logger.error({ err }, "Failed to apply WA status update");
  }
});

// Legacy single-bot whatsappService — route to the admin whose whatsappNumber matches sender.
// If no match, fall back to first admin.
whatsappService.addMessageListener(async (msg) => {
  try {
    const senderClean = msg.senderPhone.replace(/^\+/, "");
    const allAdmins = await db.select().from(adminUsersTable).orderBy(adminUsersTable.id);
    const matchingAdmin = allAdmins.find(a =>
      a.whatsappNumber && (a.whatsappNumber === senderClean || a.whatsappNumber === msg.senderPhone)
    );
    const targetAdmin = matchingAdmin ?? allAdmins[0];
    if (targetAdmin) {
      await routeIncomingWAToBot(targetAdmin.id, msg.senderPhone, {
        waMessageId: msg.waMessageId,
        text: msg.text,
        ts: msg.ts,
        quotedWaId: msg.quotedWaId,
        quotedText: msg.quotedText,
      });
    }
  } catch (err) {
    logger.error({ err }, "legacy WA listener failed");
  }
});

// Legacy tick/status updates → update DB waStatus for bot-sent messages.
whatsappService.addStatusListener(async (update) => {
  try {
    const [row] = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.waMessageId as any, update.waMessageId));
    if (!row) return;
    const current = (row as any).waStatus ?? 0;
    if (update.status <= current) return;
    await db
      .update(chatMessagesTable)
      .set({ waStatus: update.status, isRead: update.status >= 3 ? true : row.isRead } as any)
      .where(eq(chatMessagesTable.id, row.id));
  } catch (err) {
    logger.error({ err }, "legacy WA status update failed");
  }
});

export default app;
