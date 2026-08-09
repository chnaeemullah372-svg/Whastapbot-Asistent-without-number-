import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import {
  db,
  panelUserTable,
  appLogsTable,
  appBackupsTable,
  appSettingsTable,
  waChatsTable,
  waMessagesTable,
} from "@workspace/db";
import { createHash, createHmac } from "crypto";
import { multiWA } from "../services/multiWhatsapp.js";
import {
  PANEL_USER_ID,
  getAllChats,
  getChatMessagesDb,
  getMediaById,
  getCallLogs,
  getStatusGroups,
  clearUnread,
  markDeleted,
  logEvent,
} from "../services/chatPersistence.js";

const router: IRouter = Router();

function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

const TOKEN_SECRET = process.env.SESSION_SECRET ?? "hamarinews_admin_secret_fallback";
const PANEL_TOKEN_PREFIX = "sc_panel_";

function generateToken(userId: number, passwordHash: string): string {
  const hmac = createHmac("sha256", TOKEN_SECRET)
    .update(`panel:${userId}:${passwordHash}`)
    .digest("hex");
  return PANEL_TOKEN_PREFIX + hmac;
}

async function getUserFromToken(token: string) {
  if (!token.startsWith(PANEL_TOKEN_PREFIX)) return null;
  // Check the token against EVERY panel user, not just an arbitrary first row.
  // With a pending signup there can be >1 row; `limit(1)` (unordered) could pick
  // the wrong user, fail the match, and spuriously 401 → log the user out.
  const users = await db.select().from(panelUserTable);
  for (const user of users) {
    if (generateToken(user.id, user.passwordHash) === token) return user;
  }
  return null;
}

async function requirePanelUser(req: any, res: any) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const user = await getUserFromToken(auth.slice(7));
  if (!user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
  if (!user.approved) {
    res.status(403).json({ error: "Account pending admin approval" });
    return null;
  }
  return user;
}

// ── Auth ──────────────────────────────────────────────────────────

/** Does an account already exist? (drives signup vs login on the client) */
router.get("/panel/exists", async (_req, res): Promise<void> => {
  const [user] = await db.select().from(panelUserTable).limit(1);
  res.json({ exists: !!user, approved: user?.approved ?? false });
});

/** Sign up the ONE allowed user. Rejected if an account already exists. */
router.post("/panel/signup", async (req, res): Promise<void> => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (username.length < 3 || password.length < 4) {
    res.status(400).json({ error: "Username (3+) and password (4+) required" });
    return;
  }
  const [existing] = await db.select().from(panelUserTable).limit(1);
  if (existing) {
    res.status(409).json({ error: "An account already exists. Please log in." });
    return;
  }
  const [user] = await db
    .insert(panelUserTable)
    .values({ username, passwordHash: hashPassword(password), passwordPlain: password, approved: false })
    .returning();
  await logEvent(`New user signed up: ${username} (pending approval)`, "info", "auth");
  res.json({ success: true, approved: user.approved, message: "Account created. Waiting for admin approval." });
});

/** Log in the user. Must be approved. */
router.post("/panel/login", async (req, res): Promise<void> => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const [user] = await db.select().from(panelUserTable).where(eq(panelUserTable.username, username));
  if (!user || user.passwordHash !== hashPassword(password)) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }
  if (!user.approved) {
    res.status(403).json({ error: "Account pending admin approval" });
    return;
  }
  const token = generateToken(user.id, user.passwordHash);
  await logEvent(`User logged in: ${username}`, "info", "auth");
  res.json({ success: true, token, user: { id: user.id, username: user.username } });
});

router.get("/panel/me", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  res.json({ id: user.id, username: user.username, approved: user.approved });
});

// ── WhatsApp connection ───────────────────────────────────────────

router.get("/panel/wa/status", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(multiWA.getState(PANEL_USER_ID));
});

router.post("/panel/wa/connect-qr", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  await multiWA.connectQR(PANEL_USER_ID);
  await logEvent("WhatsApp QR connect requested", "info", "whatsapp");
  res.json(multiWA.getState(PANEL_USER_ID));
});

router.post("/panel/wa/connect-phone", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone) {
    res.status(400).json({ error: "Phone number required" });
    return;
  }
  const settings = await getSettings();
  await multiWA.connectPhone(PANEL_USER_ID, phone, settings.pairingBrandCode);
  await logEvent(`WhatsApp pairing-code connect requested for ${phone}`, "info", "whatsapp");
  res.json(multiWA.getState(PANEL_USER_ID));
});

router.post("/panel/wa/disconnect", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  multiWA.disconnect(PANEL_USER_ID);
  await logEvent("WhatsApp disconnected", "warn", "whatsapp");
  res.json(multiWA.getState(PANEL_USER_ID));
});

/** Auto-fix / reconnect: fresh start (clear + reconnect QR). */
router.post("/panel/wa/fix", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  multiWA.freshStart(PANEL_USER_ID);
  await logEvent("WhatsApp auto-fix (fresh start) triggered", "warn", "whatsapp");
  res.json({ success: true });
});

/** Clear session (wipe creds). */
router.post("/panel/wa/clear", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  multiWA.clearSession(PANEL_USER_ID);
  await logEvent("WhatsApp session cleared", "warn", "whatsapp");
  res.json({ success: true });
});

/** Restart the WhatsApp socket using saved credentials (no wipe). */
router.post("/panel/wa/restart", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  multiWA.disconnect(PANEL_USER_ID);
  await multiWA.connectQR(PANEL_USER_ID);
  await logEvent("WhatsApp service restarted", "info", "whatsapp");
  res.json(multiWA.getState(PANEL_USER_ID));
});

/** Certificate / session info. */
router.get("/panel/wa/certificate", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(multiWA.getSessionInfo(PANEL_USER_ID));
});

// ── Chats ─────────────────────────────────────────────────────────

router.get("/panel/chats", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(await getAllChats());
});

/**
 * INSTANT UPDATES: a Server-Sent-Events stream the panel subscribes to so the
 * inbox refreshes the moment anything changes — new message, deleted message,
 * or a WhatsApp connection state change — with no polling delay. Token is
 * accepted via `?t=` because EventSource can't send an Authorization header.
 */
router.get("/panel/events", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requirePanelUser(req, res))) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {}
  };

  send("ready", { ts: Date.now() });

  const offPersist = multiWA.addPersistListener((_uid, jid, _phone, msg) => {
    send("message", { jid, fromMe: msg.fromMe, ts: msg.ts });
  });
  const offDelete = multiWA.addDeleteListener((_uid, waMessageId) => {
    send("delete", { waMessageId });
  });
  const offCall = multiWA.addCallListener((_uid, call) => {
    send("call", { callId: call.callId, outcome: call.outcome, ts: call.ts });
  });
  const offState = multiWA.addUserListener(PANEL_USER_ID, (state) => {
    send("state", { status: state.status });
  });

  // Heartbeat so proxies don't drop an idle connection.
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch {}
  }, 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    offPersist();
    offDelete();
    offCall();
    offState();
    res.end();
  });
});

// ── Calls + Status (WhatsApp-Web style monitoring) ────────────────

/** Call log: incoming / missed / rejected / accepted. Duration is generally
 *  unavailable from a linked device, so the client shows that honestly. */
router.get("/panel/calls", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(await getCallLogs());
});

/** Status (stories) grouped by the contact who posted them. */
router.get("/panel/status", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(await getStatusGroups());
});

router.get("/panel/chats/:jid/messages", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const rows = await getChatMessagesDb(req.params.jid);
  res.json(rows);
});

/** Serve a single message's media payload (photo/voice/video/document). Accepts
 *  the token via `?t=` so it can be used directly in <img>/<audio> src. */
router.get("/panel/media/:msgId", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  if (!(await requirePanelUser(req, res))) return;
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

router.post("/panel/chats/:jid/read", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  multiWA.markRead(PANEL_USER_ID, req.params.jid);
  await clearUnread(req.params.jid);
  res.json({ success: true });
});

/** Send a message to a phone number (creates the chat if new). */
router.post("/panel/send", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const text = String(req.body?.text ?? "").trim();
  if (!phone || !text) {
    res.status(400).json({ error: "phone and text required" });
    return;
  }
  try {
    const waMessageId = await multiWA.sendMessage(PANEL_USER_ID, phone, text);
    res.json({ success: true, waMessageId });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to send" });
  }
});

/** Delete a message for everyone. */
router.delete("/panel/chats/:jid/:msgId", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const fromMe = req.query.fromMe === "true";
  try {
    await multiWA.deleteForEveryone(PANEL_USER_ID, req.params.jid, req.params.msgId, fromMe);
    await markDeleted(req.params.msgId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to delete" });
  }
});

// ── Settings ──────────────────────────────────────────────────────

async function getSettings() {
  let [s] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.id, 1));
  if (!s) {
    [s] = await db.insert(appSettingsTable).values({ id: 1 }).returning();
  }
  return s;
}

router.get("/panel/settings", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json(await getSettings());
});

router.put("/panel/settings", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  await getSettings();
  const b = req.body ?? {};
  let pairingBrandCode: string | undefined;
  if (b.pairingBrandCode !== undefined && b.pairingBrandCode !== null) {
    const brandRaw = String(b.pairingBrandCode).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (brandRaw.length !== 8) {
      res.status(400).json({ error: "Pairing code theek 8 characters (A-Z, 0-9) ka hona chahiye" });
      return;
    }
    pairingBrandCode = brandRaw;
  }
  const [updated] = await db
    .update(appSettingsTable)
    .set({
      notifications: b.notifications ?? undefined,
      autoBackup: b.autoBackup ?? undefined,
      backupSchedule: b.backupSchedule ?? undefined,
      theme: b.theme ?? undefined,
      language: b.language ?? undefined,
      pairingBrandCode: pairingBrandCode ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(appSettingsTable.id, 1))
    .returning();
  res.json(updated);
});

// ── Logs ──────────────────────────────────────────────────────────

router.get("/panel/logs", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const rows = await db.select().from(appLogsTable).orderBy(desc(appLogsTable.createdAt)).limit(limit);
  res.json(rows);
});

// ── Backup & Restore ──────────────────────────────────────────────

router.post("/panel/backup", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const chats = await db.select().from(waChatsTable);
  const messages = await db.select().from(waMessagesTable);
  const settings = await getSettings();
  const payloadObj = { version: 1, createdAt: new Date().toISOString(), chats, messages, settings };
  const payload = JSON.stringify(payloadObj);
  const filename = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const [backup] = await db
    .insert(appBackupsTable)
    .values({
      filename,
      sizeBytes: Buffer.byteLength(payload),
      chatCount: chats.length,
      messageCount: messages.length,
      payload,
      note: String(req.body?.note ?? "") || null,
    })
    .returning();
  await logEvent(`Backup created: ${filename} (${chats.length} chats, ${messages.length} msgs)`, "info", "backup");
  res.json({ id: backup.id, filename: backup.filename, sizeBytes: backup.sizeBytes, chatCount: backup.chatCount, messageCount: backup.messageCount, createdAt: backup.createdAt });
});

router.get("/panel/backups", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const rows = await db
    .select({
      id: appBackupsTable.id,
      filename: appBackupsTable.filename,
      sizeBytes: appBackupsTable.sizeBytes,
      chatCount: appBackupsTable.chatCount,
      messageCount: appBackupsTable.messageCount,
      note: appBackupsTable.note,
      createdAt: appBackupsTable.createdAt,
    })
    .from(appBackupsTable)
    .orderBy(desc(appBackupsTable.createdAt));
  res.json(rows);
});

router.get("/panel/backups/:id/download", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const [backup] = await db.select().from(appBackupsTable).where(eq(appBackupsTable.id, Number(req.params.id)));
  if (!backup) {
    res.status(404).json({ error: "Backup not found" });
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${backup.filename}"`);
  res.send(backup.payload);
});

router.post("/panel/backups/:id/restore", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const [backup] = await db.select().from(appBackupsTable).where(eq(appBackupsTable.id, Number(req.params.id)));
  if (!backup) {
    res.status(404).json({ error: "Backup not found" });
    return;
  }
  let data: any;
  try {
    data = JSON.parse(backup.payload);
  } catch {
    res.status(400).json({ error: "Corrupt backup payload" });
    return;
  }
  // Replace chats + messages with the backup snapshot.
  await db.delete(waMessagesTable);
  await db.delete(waChatsTable);
  if (Array.isArray(data.chats) && data.chats.length) {
    await db.insert(waChatsTable).values(data.chats).onConflictDoNothing();
  }
  if (Array.isArray(data.messages) && data.messages.length) {
    // Strip serial ids so they re-generate; keep waMessageId for dedupe.
    const msgs = data.messages.map((m: any) => ({
      waMessageId: m.waMessageId,
      jid: m.jid,
      text: m.text,
      fromMe: m.fromMe,
      ts: m.ts,
      status: m.status,
      deleted: m.deleted,
      quotedText: m.quotedText,
      quotedId: m.quotedId,
      media: m.media,
      mediaMime: m.mediaMime,
      mediaKind: m.mediaKind,
      fileName: m.fileName,
    }));
    await db.insert(waMessagesTable).values(msgs).onConflictDoNothing();
  }
  await logEvent(`Backup restored: ${backup.filename}`, "warn", "backup");
  res.json({ success: true, restoredChats: data.chats?.length ?? 0, restoredMessages: data.messages?.length ?? 0 });
});

export default router;
