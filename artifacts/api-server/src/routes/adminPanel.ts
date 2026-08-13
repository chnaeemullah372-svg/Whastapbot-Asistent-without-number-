import { Router, type IRouter } from "express";
import { eq, desc, count, sum, and } from "drizzle-orm";
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
import { createHash, createHmac } from "crypto";
import { multiWA } from "../services/multiWhatsapp.js";
import {
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

// ── Panel accounts (multi-account: create / approve / revoke / delete) ────
// Every account gets its own isolated WhatsApp connection + chats. The admin
// can see each account's username + password (self-hosted tool — the admin
// owns the data).

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

/** Every panel account, newest first. */
router.get("/admin-panel/users", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const users = await db.select().from(panelUserTable).orderBy(desc(panelUserTable.createdAt));
  res.json(users.map((u: any) => ({
    id: u.id,
    username: u.username,
    password: u.passwordPlain,
    approved: u.approved,
    createdAt: u.createdAt,
    approvedAt: u.approvedAt,
  })));
});

/** Admin creates a new account directly (skips the signup+approve dance —
 *  it's auto-approved since the admin themself is vouching for it). */
router.post("/admin-panel/users", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (username.length < 3 || password.length < 4) {
    res.status(400).json({ error: "Username (3+) and password (4+) required" });
    return;
  }
  const [existing] = await db.select().from(panelUserTable).where(eq(panelUserTable.username, username));
  if (existing) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }
  const [user] = await db
    .insert(panelUserTable)
    .values({
      username, passwordHash: hashPassword(password), passwordPlain: password,
      approved: true, approvedAt: new Date(),
    })
    .returning();
  await logEvent(`Admin created account: ${username}`, "info", "admin");
  res.json({ id: user.id, username: user.username, password: user.passwordPlain, approved: user.approved, createdAt: user.createdAt });
});

router.post("/admin-panel/users/:id/approve", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  const [user] = await db.select().from(panelUserTable).where(eq(panelUserTable.id, id));
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const [updated] = await db
    .update(panelUserTable)
    .set({ approved: true, approvedAt: new Date() })
    .where(eq(panelUserTable.id, id))
    .returning();
  await logEvent(`Admin approved account: ${user.username}`, "info", "admin");
  res.json({ success: true, approved: updated.approved });
});

router.post("/admin-panel/users/:id/revoke", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  const [user] = await db.select().from(panelUserTable).where(eq(panelUserTable.id, id));
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  await db.update(panelUserTable).set({ approved: false, approvedAt: null }).where(eq(panelUserTable.id, id));
  await logEvent(`Admin revoked account access: ${user.username}`, "warn", "admin");
  res.json({ success: true });
});

/** Permanently remove an account's login (disconnects its WhatsApp session
 *  too). Historical chat/message rows are left in place, just orphaned —
 *  not auto-deleted, so nothing already captured is silently lost. */
router.delete("/admin-panel/users/:id", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const id = Number(req.params.id);
  const [user] = await db.select().from(panelUserTable).where(eq(panelUserTable.id, id));
  if (!user) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  multiWA.clearSession(id);
  await db.delete(panelUserTable).where(eq(panelUserTable.id, id));
  await logEvent(`Admin deleted account: ${user.username}`, "warn", "admin");
  res.json({ success: true });
});

/** Which account's data an oversight endpoint should show. Defaults to the
 *  first account so single-account installs keep working without passing
 *  ?userId= explicitly. */
async function resolveUserId(req: any): Promise<number | null> {
  const q = Number(req.query?.userId);
  if (Number.isFinite(q) && q > 0) return q;
  const [first] = await db.select({ id: panelUserTable.id }).from(panelUserTable).orderBy(panelUserTable.id).limit(1);
  return first?.id ?? null;
}

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

/** Every oversight endpoint below accepts an optional `?userId=` to pick
 *  which account's data to view (defaults to the first account). */

router.get("/admin-panel/wa/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  res.json(userId ? multiWA.getSessionInfo(userId) : null);
});

router.get("/admin-panel/accounts", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  res.json(userId ? await getAccounts(userId) : []);
});

router.get("/admin-panel/chats", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  const account = typeof req.query.account === "string" ? req.query.account : undefined;
  res.json(userId ? await getAllChats(userId, account) : []);
});

router.get("/admin-panel/chats/:jid/messages", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  res.json(userId ? await getChatMessagesDb(userId, req.params.jid) : []);
});

/** Serve a message's media payload. Token via `?t=` so it works in <img> src. */
router.get("/admin-panel/media/:msgId", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  const row = userId ? await getMediaById(userId, req.params.msgId) : null;
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
  const userId = await resolveUserId(req);
  res.json(userId ? await getCallLogs(userId) : []);
});

router.get("/admin-panel/status", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = await resolveUserId(req);
  res.json(userId ? await getStatusGroups(userId) : []);
});

// ── Export / download all chats (every account, admin-wide backup) ────

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
  const userId = await resolveUserId(req);
  if (!userId) {
    res.json({
      chats: 0, messages: 0, backups: 0, incoming: 0, outgoing: 0, storageBytes: 0,
      dbConnected: true, whatsapp: { status: "disconnected", phoneNumber: null, connectedAt: null },
    });
    return;
  }
  const [{ value: chatCount }] = await db.select({ value: count() }).from(waChatsTable).where(eq(waChatsTable.userId, userId));
  const [{ value: msgCount }] = await db.select({ value: count() }).from(waMessagesTable).where(eq(waMessagesTable.userId, userId));
  const [{ value: backupCount }] = await db.select({ value: count() }).from(appBackupsTable);
  const [{ value: inCount }] = await db.select({ value: count() }).from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.fromMe, false)));
  const [{ value: outCount }] = await db.select({ value: count() }).from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.fromMe, true)));
  const [{ value: backupBytes }] = await db.select({ value: sum(appBackupsTable.sizeBytes) }).from(appBackupsTable);
  const state = multiWA.getSessionInfo(userId);
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
// Each accepts an optional `?userId=` (or body.userId) to target a specific
// account's WhatsApp connection; defaults to the first account.

router.post("/admin-panel/tools/fix", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = Number(req.body?.userId) || (await resolveUserId(req));
  if (!userId) { res.status(404).json({ error: "No account to fix" }); return; }
  multiWA.freshStart(userId);
  await logEvent("Admin triggered auto-fix (fresh start)", "warn", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/reconnect", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = Number(req.body?.userId) || (await resolveUserId(req));
  if (!userId) { res.status(404).json({ error: "No account to reconnect" }); return; }
  await multiWA.connectQR(userId);
  await logEvent("Admin triggered reconnect", "info", "admin");
  res.json({ success: true });
});

router.post("/admin-panel/tools/clear-session", async (req, res): Promise<void> => {
  if (!(await requireAdmin(req, res))) return;
  const userId = Number(req.body?.userId) || (await resolveUserId(req));
  if (!userId) { res.status(404).json({ error: "No account to clear" }); return; }
  multiWA.clearSession(userId);
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
