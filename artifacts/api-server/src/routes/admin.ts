import { Router, type IRouter } from "express";
import { eq, count, and } from "drizzle-orm";
import { db, chatSessionsTable, chatMessagesTable, adminUsersTable, mediaFilesTable } from "@workspace/db";
import {
  AdminLoginBody,
  DeleteAdminSessionParams,
  CloseAdminSessionParams,
  ListAdminSessionMessagesParams,
  SendAdminMessageParams,
  SendAdminMessageBody,
  ListAdminSessionsResponse,
  ListAdminSessionMessagesResponse,
  GetAdminStatsResponse,
  GetAdminMeResponse,
  AdminLoginResponse,
} from "@workspace/api-zod";
import { createHash, createHmac } from "crypto";
import { whatsappService } from "../services/whatsapp.js";
import { multiWA } from "../services/multiWhatsapp.js";

const router: IRouter = Router();

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

// Stable secret — falls back to a fixed string if env not set.
// Token is deterministic: survives server restarts without a DB store.
const TOKEN_SECRET = process.env.SESSION_SECRET ?? "hamarinews_admin_secret_fallback";
const ADMIN_TOKEN_PREFIX = "sc_admin_";

function generateToken(adminId: number, passwordHash: string): string {
  const hmac = createHmac("sha256", TOKEN_SECRET)
    .update(`${adminId}:${passwordHash}`)
    .digest("hex");
  return ADMIN_TOKEN_PREFIX + hmac;
}

async function getAdminIdFromToken(token: string): Promise<number | null> {
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) return null;
  // Look up all admins and verify the HMAC matches
  const admins = await db.select().from(adminUsersTable);
  for (const admin of admins) {
    if (generateToken(admin.id, admin.passwordHash) === token) return admin.id;
  }
  return null;
}

async function requireAdmin(req: any, res: any): Promise<number | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const token = auth.slice(7);
  const adminId = await getAdminIdFromToken(token);
  if (!adminId) {
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
  return adminId;
}

router.post("/admin/login", async (req, res): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { username, password } = parsed.data;
  const passwordHash = hashPassword(password);

  const [admin] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.username, username));

  if (!admin || admin.passwordHash !== passwordHash) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const token = generateToken(admin.id, admin.passwordHash);
  res.json(AdminLoginResponse.parse({
    success: true,
    token,
    admin: { id: admin.id, username: admin.username },
  }));
});

router.post("/admin/logout", async (req, res): Promise<void> => {
  if (false) { // token is stateless HMAC — nothing to delete
  }
  res.json({ success: true, message: "Logged out" });
});

router.get("/admin/me", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const [admin] = await db
    .select()
    .from(adminUsersTable)
    .where(eq(adminUsersTable.id, adminId));

  if (!admin) {
    res.status(401).json({ error: "Admin not found" });
    return;
  }

  res.json({
    ...GetAdminMeResponse.parse({ id: admin.id, username: admin.username }),
    waMode: (admin as any).waMode ?? "number",
    whatsappNumber: admin.whatsappNumber ?? null,
  });
});

router.get("/admin/sessions", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const sessions = await db
    .select()
    .from(chatSessionsTable)
    .orderBy(chatSessionsTable.updatedAt);

  res.json(ListAdminSessionsResponse.parse(sessions.map(s => ({
    ...s,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }))));
});

router.delete("/admin/sessions/:sessionId", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const params = DeleteAdminSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(chatMessagesTable).where(eq(chatMessagesTable.sessionId, params.data.sessionId));
  await db.delete(chatSessionsTable).where(eq(chatSessionsTable.id, params.data.sessionId));

  res.json({ success: true, message: "Session deleted" });
});

router.post("/admin/sessions/:sessionId/close", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const params = CloseAdminSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db
    .update(chatSessionsTable)
    .set({ status: "closed", unreadCount: 0 })
    .where(eq(chatSessionsTable.id, params.data.sessionId))
    .returning();

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  });
});

router.get("/admin/sessions/:sessionId/messages", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const params = ListAdminSessionMessagesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db
    .update(chatMessagesTable)
    .set({ isRead: true })
    .where(and(
      eq(chatMessagesTable.sessionId, params.data.sessionId),
      eq(chatMessagesTable.sender, "user")
    ));

  await db
    .update(chatSessionsTable)
    .set({ unreadCount: 0 })
    .where(eq(chatSessionsTable.id, params.data.sessionId));

  const messages = await db
    .select()
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.sessionId, params.data.sessionId))
    .orderBy(chatMessagesTable.createdAt);

  res.json(ListAdminSessionMessagesResponse.parse(messages.map(m => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
  }))));
});

router.post("/admin/sessions/:sessionId/messages", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const params = SendAdminMessageParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const parsed = SendAdminMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db
    .select()
    .from(chatSessionsTable)
    .where(eq(chatSessionsTable.id, params.data.sessionId));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const [message] = await db
    .insert(chatMessagesTable)
    .values({
      sessionId: params.data.sessionId,
      content: parsed.data.content,
      sender: "admin",
      isRead: true,
    })
    .returning();

  await db
    .update(chatSessionsTable)
    .set({ lastMessage: parsed.data.content })
    .where(eq(chatSessionsTable.id, params.data.sessionId));

  // Also send via WhatsApp if session has a phone number
  if (session.userPhone) {
    try {
      if (whatsappService.getState().status === "connected") {
        await whatsappService.sendMessage(session.userPhone, parsed.data.content);
      } else {
        // Try any connected user session
        await multiWA.sendFromAnyConnected(session.userPhone, parsed.data.content);
      }
    } catch {
      // WA send failed — DB save still succeeded, that's fine
    }
  }

  res.status(201).json({ ...message, createdAt: message.createdAt.toISOString() });
});

router.get("/admin/stats", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const allSessions = await db.select().from(chatSessionsTable);
  const totalMessages = await db.select({ count: count() }).from(chatMessagesTable);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todaySessions = allSessions.filter(s => s.createdAt >= today).length;
  const openSessions = allSessions.filter(s => s.status === "open").length;
  const closedSessions = allSessions.filter(s => s.status === "closed").length;

  res.json(GetAdminStatsResponse.parse({
    totalSessions: allSessions.length,
    openSessions,
    closedSessions,
    totalMessages: totalMessages[0]?.count ?? 0,
    todaySessions,
  }));
});

router.get("/admin/users", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const users = await db
    .select({ id: adminUsersTable.id, username: adminUsersTable.username, whatsappNumber: adminUsersTable.whatsappNumber, waMode: (adminUsersTable as any).waMode, createdAt: adminUsersTable.createdAt })
    .from(adminUsersTable)
    .orderBy(adminUsersTable.createdAt);

  res.json(users.map(u => ({ ...u, createdAt: u.createdAt.toISOString() })));
});

router.post("/admin/users", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const { username, password, whatsappNumber, mode } = req.body ?? {};
  const waMode: "number" | "web" = mode === "web" ? "web" : "number";

  if (!username || !password) { res.status(400).json({ error: "Username aur password zaruri hain" }); return; }
  if (typeof username !== "string" || username.length < 3) { res.status(400).json({ error: "Username kam az kam 3 harf ka hona chahiye" }); return; }
  if (typeof password !== "string" || password.length < 6) { res.status(400).json({ error: "Password kam az kam 6 harf ka hona chahiye" }); return; }

  let cleanNumber: string | null = null;
  if (waMode === "number") {
    cleanNumber = whatsappNumber ? String(whatsappNumber).replace(/\D/g, "") : "";
    if (!cleanNumber || cleanNumber.length < 8 || cleanNumber.length > 15) {
      res.status(400).json({ error: "Sahi WhatsApp number daalein (8–15 digits)" });
      return;
    }
  }

  const existing = await db.select().from(adminUsersTable).where(eq(adminUsersTable.username, username));
  if (existing.length > 0) { res.status(409).json({ error: "Yeh username pehle se maujood hai" }); return; }

  const [user] = await db
    .insert(adminUsersTable)
    .values({
      username,
      passwordHash: hashPassword(password),
      whatsappNumber: cleanNumber,
      waMode,
    } as any)
    .returning();

  res.status(201).json({
    id: user.id,
    username: user.username,
    whatsappNumber: user.whatsappNumber,
    waMode: (user as any).waMode ?? waMode,
    createdAt: user.createdAt.toISOString(),
  });
});

router.delete("/admin/users/:userId", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  if (userId === adminId) {
    res.status(403).json({ error: "Aap apna khud ka account delete nahi kar sakte" });
    return;
  }

  const deleted = await db.delete(adminUsersTable).where(eq(adminUsersTable.id, userId)).returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "User nahi mila" });
    return;
  }

  res.json({ success: true });
});

router.patch("/admin/users/:userId/password", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const { newPassword, password } = req.body ?? {};
  const pw = newPassword ?? password;
  if (!pw || typeof pw !== "string" || pw.length < 6) {
    res.status(400).json({ error: "Password kam az kam 6 harf ka hona chahiye" });
    return;
  }

  const updated = await db
    .update(adminUsersTable)
    .set({ passwordHash: hashPassword(pw) })
    .where(eq(adminUsersTable.id, userId))
    .returning();

  if (updated.length === 0) {
    res.status(404).json({ error: "User nahi mila" });
    return;
  }

  res.json({ success: true });
});

// PATCH /api/admin/users/:userId/number — update whatsappNumber for number-mode users
router.patch("/admin/users/:userId/number", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }

  const { whatsappNumber } = req.body ?? {};
  if (whatsappNumber === undefined) { res.status(400).json({ error: "whatsappNumber required" }); return; }

  const cleanNumber = whatsappNumber ? String(whatsappNumber).replace(/\D/g, "") : null;
  if (cleanNumber !== null && (cleanNumber.length < 8 || cleanNumber.length > 15)) {
    res.status(400).json({ error: "Sahi WhatsApp number daalein (8–15 digits)" });
    return;
  }

  const updated = await db
    .update(adminUsersTable)
    .set({ whatsappNumber: cleanNumber } as any)
    .where(eq(adminUsersTable.id, userId))
    .returning();

  if (updated.length === 0) { res.status(404).json({ error: "User nahi mila" }); return; }
  res.json({ success: true, whatsappNumber: cleanNumber });
});

// ─── WhatsApp Web inbox routes ─────────────────────────────────────────────

router.get("/admin/users/:userId/wa-inbox", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }
  res.json(multiWA.getChatList(userId));
});

router.get("/admin/users/:userId/wa-inbox/:jid/messages", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }
  const jid = req.params.jid;
  multiWA.markRead(userId, jid);
  res.json(multiWA.getChatMessages(userId, jid));
});

router.post("/admin/users/:userId/wa-inbox/:jid/send", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }
  const jid = req.params.jid;
  const { text } = req.body ?? {};
  if (!text || typeof text !== "string") { res.status(400).json({ error: "text required" }); return; }
  const fullJid = jid.includes("@") ? jid : `${jid}@s.whatsapp.net`;
  try {
    await multiWA.sendToJid(userId, fullJid, text);
  } catch {
    // multiWA not connected — fallback to legacy bot WA
    const phone = fullJid.split("@")[0];
    await whatsappService.sendMessage(phone, text);
  }
  res.json({ success: true });
});

// DELETE /api/admin/wipe-all — destroy all media, sessions, and messages
router.delete("/admin/wipe-all", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    // Delete all chat messages
    await db.delete(chatMessagesTable);
    // Delete all chat sessions
    await db.delete(chatSessionsTable);
    // Delete all media file records from DB
    await db.delete(mediaFilesTable);
    res.json({ success: true, message: "Sab data wipe ho gaya" });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Wipe failed" });
  }
});

router.delete("/admin/users/:userId/wa-inbox/:jid/:msgId", async (req, res): Promise<void> => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(req.params.userId);
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid user ID" }); return; }
  const { jid, msgId } = req.params;
  const { fromMe } = req.body ?? {};
  await multiWA.deleteForEveryone(userId, jid, msgId, !!fromMe);
  res.json({ success: true });
});

export { hashPassword, requireAdmin };
export default router;
