import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, chatSessionsTable, chatMessagesTable, adminUsersTable } from "@workspace/db";
import {
  CreateChatSessionBody,
  ListChatMessagesParams,
  SendChatMessageParams,
  SendChatMessageBody,
} from "@workspace/api-zod";
import { randomUUID, createHash } from "crypto";
import { multiWA } from "../services/multiWhatsapp.js";
import { whatsappService } from "../services/whatsapp.js";

function hashPassword(p: string) { return createHash("sha256").update(p).digest("hex"); }

const router: IRouter = Router();

// POST /api/user/login — widget user authentication (preserved for sticky session)
router.post("/user/login", async (req, res): Promise<void> => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) { res.status(400).json({ error: "username aur password zaroor hain" }); return; }
  const [user] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, username));
  if (!user || user.passwordHash !== hashPassword(password)) {
    res.status(401).json({ error: "Galat username ya password" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    whatsappNumber: user.whatsappNumber,
    waMode: (user as any).waMode ?? "number",
  });
});

// Resolve the owner user that "owns" a widget session.
// Priority: explicit ownerUserId on session → first admin user.
// (We do NOT fall back to "first connected WA user" because that would
// cross-wire sessions when multiple users are configured.)
async function resolveOwnerUserId(sessionOwnerId: number | null): Promise<number | null> {
  if (sessionOwnerId) return sessionOwnerId;
  const [first] = await db.select().from(adminUsersTable).orderBy(adminUsersTable.id);
  return first?.id ?? null;
}

router.post("/chat/sessions", async (req, res): Promise<void> => {
  const parsed = CreateChatSessionBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  let ownerUserId: number | null = (req.body as any)?.ownerUserId ?? null;
  const ownerUsername: string | undefined = (req.body as any)?.ownerUsername;
  if (!ownerUserId && ownerUsername) {
    const [owner] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, ownerUsername));
    if (owner) ownerUserId = owner.id;
  }
  ownerUserId = await resolveOwnerUserId(ownerUserId);

  const id = randomUUID();
  const [session] = await db
    .insert(chatSessionsTable)
    .values({
      id,
      userName: parsed.data.userName,
      userPhone: parsed.data.userPhone ?? null,
      status: "open",
      unreadCount: 0,
      ownerUserId: ownerUserId ?? null,
    } as any)
    .returning();

  res.status(201).json({
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  });
});

router.get("/chat/sessions/:sessionId/messages", async (req, res): Promise<void> => {
  const params = ListChatMessagesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, params.data.sessionId))
    .orderBy(chatMessagesTable.createdAt);

  // Return raw rows (with extra wa_status / quoted_* fields the generated
  // zod schema would otherwise strip). Widget tolerates extra fields.
  res.json(messages.map(m => ({
    id: m.id,
    sessionId: m.sessionId,
    content: m.content,
    sender: m.sender,
    createdAt: m.createdAt.toISOString(),
    isRead: m.isRead,
    waStatus: (m as any).waStatus ?? 0,
    quotedMessageId: (m as any).quotedMessageId ?? null,
    quotedText: (m as any).quotedText ?? null,
  })));
});

router.post("/chat/sessions/:sessionId/messages", async (req, res): Promise<void> => {
  const params = SendChatMessageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const parsed = SendChatMessageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const quotedMessageId: number | null = (req.body as any)?.quotedMessageId ?? null;

  const [session] = await db
    .select()
    .from(chatSessionsTable)
    .where(eq(chatSessionsTable.id, params.data.sessionId));

  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  // Resolve quoted message (for both DB record and WA quoted payload).
  let quotedRow: typeof chatMessagesTable.$inferSelect | undefined;
  if (quotedMessageId) {
    [quotedRow] = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, quotedMessageId));
  }

  // Persist the visitor's outbound message.
  const [message] = await db
    .insert(chatMessagesTable)
    .values({
      sessionId: params.data.sessionId,
      content: parsed.data.content,
      sender: "user",
      isRead: false,
      waStatus: 0,
      quotedMessageId: quotedRow?.id ?? null,
      quotedText: quotedRow?.content ?? null,
      quotedWaId: (quotedRow as any)?.waMessageId ?? null,
    } as any)
    .returning();

  await db
    .update(chatSessionsTable)
    .set({ lastMessage: parsed.data.content, unreadCount: session.unreadCount + 1 })
    .where(eq(chatSessionsTable.id, params.data.sessionId));

  // ── DIRECT BRIDGE: forward to the owner user's WhatsApp number ──
  const ownerUserId = await resolveOwnerUserId((session as any).ownerUserId ?? null);
  let forwarded = false;
  let forwardError: string | null = null;
  let waMessageId: string | null = null;

  // The quoted message on WA side: if the original was a WA-inbound message,
  // it has fromMe=false from the owner's perspective; if it was a user→WA
  // message we sent, fromMe=true.
  const quotedForWA = quotedRow && (quotedRow as any).waMessageId
    ? {
        waMessageId: (quotedRow as any).waMessageId as string,
        // sender "user" means we sent it (fromMe true from owner's POV);
        // sender "admin" means it came from WA (fromMe false).
        fromMe: quotedRow.sender === "user",
        text: quotedRow.content,
      }
    : undefined;

  if (ownerUserId) {
    const [owner] = await db.select().from(adminUsersTable).where(eq(adminUsersTable.id, ownerUserId));
    const ownerState = multiWA.getState(ownerUserId);
    const waMode: string = (owner as any)?.waMode ?? "number";

    // Determine forwarding target:
    // • number mode → owner's configured whatsappNumber (a SEPARATE personal number)
    //   DO NOT fall back to ownerState.phoneNumber — that is the bot's own number → sends to self
    // • web mode → visitor's phone if known (session.userPhone), otherwise skip forward
    let target: string | null = null;
    if (waMode === "number") {
      target = owner?.whatsappNumber || null;
    } else {
      target = (session as any).userPhone || null;
    }

    if (target && ownerState.status === "connected") {
      try {
        waMessageId = await multiWA.sendMessage(ownerUserId, target, `[${session.userName}] ${parsed.data.content}`, quotedForWA);
        forwarded = true;
      } catch (e: any) {
        forwardError = e?.message ?? "send failed";
      }
    } else if (target) {
      // Try any connected multiWA session first
      try {
        const r = await multiWA.sendFromAnyConnected(target, `[${session.userName}] ${parsed.data.content}`);
        forwarded = r.ok;
        waMessageId = r.waMessageId ?? null;
        if (!r.ok) forwardError = "multiWA: no connected session";
      } catch (e: any) {
        forwardError = e?.message ?? "send failed";
      }
    } else {
      forwardError = waMode === "number"
        ? "Admin ka WhatsApp number set nahi hai — Admin panel mein number update karein"
        : "Visitor ka phone number maujood nahi";
    }

    // ── FINAL FALLBACK: use the bot's legacy WA (923186959638) to forward ──
    // This fires whenever multiWA has no connected sessions.
    if (!forwarded && target) {
      try {
        waMessageId = await whatsappService.sendMessage(target, `[${session.userName}] ${parsed.data.content}`, quotedForWA);
        forwarded = true;
        forwardError = null;
      } catch (e: any) {
        forwardError = `Legacy WA: ${e?.message ?? "send failed"}`;
      }
    }
  } else {
    forwardError = "No owner user configured";
  }

  if (waMessageId) {
    await db
      .update(chatMessagesTable)
      .set({ waMessageId, waStatus: forwarded ? 1 : 0 } as any)
      .where(eq(chatMessagesTable.id, message.id));
  }

  res.status(201).json({
    ...message,
    waMessageId,
    waStatus: forwarded ? 1 : 0,
    quotedMessageId: quotedRow?.id ?? null,
    quotedText: quotedRow?.content ?? null,
    createdAt: message.createdAt.toISOString(),
    forwarded,
    forwardError,
  });
});

// POST /chat/sessions/:sessionId/read
// Widget calls this when inbound (admin-sender) messages become visible.
// We mark the local rows as read AND fire a WA "read" receipt on the owner's
// socket so the original sender sees blue ticks.
router.post("/chat/sessions/:sessionId/read", async (req, res): Promise<void> => {
  const params = SendChatMessageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }

  const ids: number[] = Array.isArray((req.body as any)?.messageIds) ? (req.body as any).messageIds : [];

  const where = ids.length > 0
    ? and(eq(chatMessagesTable.sessionId, params.data.sessionId), inArray(chatMessagesTable.id, ids), eq(chatMessagesTable.sender, "admin"))
    : and(eq(chatMessagesTable.sessionId, params.data.sessionId), eq(chatMessagesTable.sender, "admin"));

  const rows = await db.select().from(chatMessagesTable).where(where);
  if (rows.length === 0) { res.json({ ok: true, marked: 0 }); return; }

  await db.update(chatMessagesTable).set({ isRead: true }).where(where);

  // Fire WA "read" receipt grouped by owner.
  const [session] = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.id, params.data.sessionId));
  const ownerUserId = session ? await resolveOwnerUserId((session as any).ownerUserId ?? null) : null;
  if (ownerUserId) {
    const waIds = rows.map(r => (r as any).waMessageId).filter(Boolean) as string[];
    if (waIds.length > 0) {
      try { await multiWA.markIncomingRead(ownerUserId, waIds); } catch {}
    }
  }

  res.json({ ok: true, marked: rows.length });
});

export default router;
