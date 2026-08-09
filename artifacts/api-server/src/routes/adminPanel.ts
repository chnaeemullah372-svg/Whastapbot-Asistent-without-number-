import { Router, type IRouter } from "express";
import { eq, desc, count, sum } from "drizzle-orm";
import {
  db,
  adminUsersTable,
  panelUserTable,
  waChatsTable,
  waMessagesTable,
  appLogsTable,
  appBackupsTable,
  appSettingsTable,
} from "@workspace/db";
import { createHmac } from "crypto";
import { multiWA } from "../services/multiWhatsapp.js";
import {
  PANEL_USER_ID,
  getAllChats,
  getAccounts,
  getChatMessagesDb,
  getMediaById,
  getCallLogs,
  getStatusGroups,
  logEvent,
} from "../services/chatPersistence.js";

const router: IRouter = Router();

const TOKEN_SECRET = process.env.SESSION_SECRET ?? "hamarinews_admin_secret_fallback";
const ADMIN_TOKEN_PREFIX = "sc_admin_";

function generateAdminToken(adminId: number, passwordHash: string): string {
  const hmac = createHmac("sha256", TOKEN_SECRET).update(`${adminId}:${passwordHash}`).digest("hex");
  return ADMIN_TOKEN_PREFIX + hmac;
}

async function requireAdmin(req: any, res: any): Promise<number | null> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const token = auth.slice(7);
  if (!token.startsWith(ADMIN_TOKEN_PREFIX)) {
    res.status(401).json({ error: "Invalid token" });
    return null;
  }
  const admins = await db.select().from(adminUsersTable);
  for (const a of admins) {
    if (generateAdminToken(a.id, a.passwordHash) === token) return a.id;
  }
  res.status(401).json({ error: "Invalid or expired token" });
  return null;
}

// ── The managed user (creds + approval) ───────────────────────────

/** Admin can SEE the created user's username + password (self-hosted tool). */
router.get("/admin-panel/user", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.json({ exists: false });
    return;
  }
  res.json({
    exists: true,
    id: user.id,
    username: user.username,
    password: user.passwordPlain,
    approved: user.approved,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
  });
});

router.post("/admin-panel/user/approve", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.status(404).json({ error: "No user to approve" });
    return;
  }
  const [updated] = await db
    .update(panelUserTable)
    .set({ approved: true, approvedAt: new Date() })
    .where(eq(panelUserTable.id, user.id))
    .returning();
  await logEvent(`Admin approved user: ${user.username}`, "info", "admin");
  res.json({ success: true, approved: updated.approved });
});

router.post("/admin-panel/user/revoke", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [user] = await db.select().from(panelUserTable).limit(1);
  if (!user) {
    res.status(404).json({ error: "No user found" });
    return;
  }
  await db.update(panelUserTable).set({ approved: false, approvedAt: null }).where(eq(panelUserTable.id, user.id));
  await logEvent(`Admin revoked user access: ${user.username}`, "warn", "admin");
  res.json({ success: true });
});

// ── Pairing brand code (editable from admin) ──────────────────────

async function getAppSettings() {
  let [s] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1));
  if (!s) [s] = await db.insert(appSettingsTable).values({ id: 1 }).returning();
  return s;
}

router.get("/admin-panel/pairing-code", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const s = await getAppSettings();
  res.json({ pairingBrandCode: s.pairingBrandCode });
});

router.put("/admin-panel/pairing-code", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const raw = String(req.body?.pairingBrandCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw.length !== 8) {
    res.status(400).json({ error: "Pairing code theek 8 characters (A-Z, 0-9) ka hona chahiye" });
    return;
  }
  await getAppSettings();
  const [updated] = await db
    .update(appSettingsTable)
    .set({ pairingBrandCode: raw, updatedAt: new Date() })
    .where(eq(appSettingsTable.id, 1))
    .returning();
  await logEvent(`Admin set pairing code to ${raw}`, "info", "admin");
  res.json({ pairingBrandCode: updated.pairingBrandCode });
});

// ── Oversight: chats + messages ───────────────────────────────────

router.get("/admin-panel/wa/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(multiWA.getSessionInfo(PANEL_USER_ID));
});

router.get("/admin-panel/accounts", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getAccounts());
});

router.get("/admin-panel/chats", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json(await getAllChats(account));
});

router.get("/admin-panel/chats/:jid/messages", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getChatMessagesDb(req.params.jid));
});

/** Serve a message's media payload. Token via `?t=` so it works in <img> src. */
router.get("/admin-panel/media/:msgId", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requireAdmin(req, res))) return;
  const row = await getMediaById(req.params.msgId);
  if (!row || !row.media) {
    res.status(404).json({ error: "No media" });
    return;
  }
  const buf = Buffer.from(row.media, "base64");
  res.setHeader("Content-Type", row.mediaMime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  if (row.mediaKind === "document" && row.fileName) {
    res.setHeader("Content-Disposition", `inline; filename="${row.fileName.replace(/"/g, "")}"`);
  }
  res.send(buf);
});

// Admin panel is monitoring-only — no message sending.

// ── Oversight: calls + status (read-only) ─────────────────────────

router.get("/admin-panel/calls", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getCallLogs());
});

router.get("/admin-panel/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  res.json(await getStatusGroups());
});

// ── Export / download all chats ───────────────────────────────────

router.get("/admin-panel/export", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const chats = await db.select().from(waChatsTable);
  const messages = await db.select().from(waMessagesTable);
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), chats, messages }, null, 2);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="chats-export-${Date.now()}.json"`);
  res.send(payload);
});

// ── Stats ─────────────────────────────────────────────────────────

router.get("/admin-panel/stats", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const [{ value: chatCount }] = await db.select({ value: count() }).from(waChatsTable);
  const [{ value: msgCount }] = await db.select({ value: count() }).from(waMessagesTable);
  const [{ value: backupCount }] = await db.select({ value: count() }).from(appBackupsTable);
  const [{ value: inCount }] = await db.select({ value: count() }).from(waMessagesTable).where(eq(waMessagesTable.fromMe, false));
  const [{ value: outCount }] = await db.select({ value: count() }).from(waMessagesTable).where(eq(waMessagesTable.fromMe, true));
  const [{ value: backupBytes }] = await db.select({ value: sum(appBackupsTable.sizeBytes) }).from(appBackupsTable);
  const state = multiWA.getSessionInfo(PANEL_USER_ID);
  res.json({
    chats: chatCount,
    messages: msgCount,
    backups: backupCount,
    incoming: inCount,
    outgoing: outCount,
    storageBytes: Number(backupBytes ?? 0),
    dbConnected: true,
    whatsapp: { status: state.status, phoneNumber: state.phoneNumber, connectedAt: state.connectedAt },
  });
});

// ── Tools: auto-fix / reconnect / clear-session / restart ─────────

router.post("/admin-panel/tools/fix", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  multiWA.freshStart(PANEL_USER_ID);
  await logEvent("Admin triggered auto-fix (fresh start)", "warn", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/reconnect", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  await multiWA.connectQR(PANEL_USER_ID);
  await logEvent("Admin triggered reconnect", "info", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/clear-session", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  multiWA.clearSession(PANEL_USER_ID);
  await logEvent("Admin cleared WhatsApp session", "warn", "admin");
  res.json({ success: true });
});

// ── Logs ──────────────────────────────────────────────────────────

router.get("/admin-panel/logs", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const rows = await db.select().from(appLogsTable).orderBy(desc(appLogsTable.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin-panel/backups", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const rows = await db
    .select({
      id: appBackupsTable.id,
      filename: appBackupsTable.filename,
      sizeBytes: appBackupsTable.sizeBytes,
      chatCount: appBackupsTable.chatCount,
      messageCount: appBackupsTable.messageCount,
      createdAt: appBackupsTable.createdAt,
    })
    .from(appBackupsTable)
    .orderBy(desc(appBackupsTable.createdAt));
  res.json(rows);
});

export default router;
