import { Router, type IRouter } from "express";
import multer from "multer";
import { exec } from "child_process";
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
import { multiWA, MEDIA_MAX_BYTES } from "../services/multiWhatsapp.js";
import {
  getAllChats,
  getChatMessagesDb,
  getMediaById,
  getMessageForForward,
  getCallLogs,
  getStatusGroups,
  getStarredMessages,
  clearUnread,
  markDeleted,
  hideForMe,
  setStarred,
  setChatPinned,
  setChatMuted,
  setChatArchived,
  setChatUnread,
  setChatDeletedForMe,
  logEvent,
} from "../services/chatPersistence.js";

const router: IRouter = Router();

/** In-memory upload (no temp file) for media the admin sends OUT — the buffer
 *  goes straight to Baileys and, capped, into the DB as base64, exactly like
 *  a downloaded incoming attachment. */
const uploadMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_MAX_BYTES } });

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
  // Check the token against EVERY panel user (there can be many now), not
  // just an arbitrary first row.
  const users = await db.select().from(panelUserTable);
  for (const user of users) {
    if (generateToken(user.id, user.passwordHash) === token) return user;
  }
  return null;
}

/** Resolves the authenticated account for this request — every route below
 *  MUST use the returned `user.id` (never a hardcoded id) to scope
 *  WhatsApp-session and DB access to that one account. */
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

/** Does any account already exist? Used only to decide the client's very
 *  first-run screen (signup vs login); signing up is otherwise always open —
 *  this is a multi-account panel now. */
router.get("/panel/exists", async (_req, res): Promise<void> => {
  const [user] = await db.select().from(panelUserTable).limit(1);
  res.json({ exists: !!user, approved: user?.approved ?? false });
});

/** Sign up a new account. Multiple accounts are supported — each gets its
 *  own isolated WhatsApp connection and chats once an admin approves it. */
router.post("/panel/signup", async (req, res): Promise<void> => {
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (username.length < 3 || password.length < 4) {
    res.status(400).json({ error: "Username (3+) and password (4+) required" });
    return;
  }
  const [existingUsername] = await db.select().from(panelUserTable).where(eq(panelUserTable.username, username));
  if (existingUsername) {
    res.status(409).json({ error: "This username is already taken. Please choose another." });
    return;
  }
  const [user] = await db
    .insert(panelUserTable)
    .values({ username, passwordHash: hashPassword(password), passwordPlain: password, approved: false })
    .returning();
  await logEvent(`New user signed up: ${username} (pending approval)`, "info", "auth");
  res.json({ success: true, approved: user.approved, message: "Account created. Waiting for admin approval." });
});

/** Log in an account. Must be approved. */
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
  const user = await requirePanelUser(req, res);
  if (!user) return;
  res.json(multiWA.getState(user.id));
});

router.post("/panel/wa/connect-qr", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await multiWA.connectQR(user.id);
  await logEvent("WhatsApp QR connect requested", "info", "whatsapp");
  res.json(multiWA.getState(user.id));
});

router.post("/panel/wa/connect-phone", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone) {
    res.status(400).json({ error: "Phone number required" });
    return;
  }
  const settings = await getSettings();
  await multiWA.connectPhone(user.id, phone, settings.pairingBrandCode);
  await logEvent(`WhatsApp pairing-code connect requested for ${phone}`, "info", "whatsapp");
  res.json(multiWA.getState(user.id));
});

router.post("/panel/wa/disconnect", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.disconnect(user.id);
  await logEvent("WhatsApp disconnected", "warn", "whatsapp");
  res.json(multiWA.getState(user.id));
});

/** Auto-fix / reconnect: fresh start (clear + reconnect QR). */
router.post("/panel/wa/fix", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.freshStart(user.id);
  await logEvent("WhatsApp auto-fix (fresh start) triggered", "warn", "whatsapp");
  res.json({ success: true });
});

/** Clear session (wipe creds). */
router.post("/panel/wa/clear", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.clearSession(user.id);
  await logEvent("WhatsApp session cleared", "warn", "whatsapp");
  res.json({ success: true });
});

/** Restart the WhatsApp socket using saved credentials (no wipe). */
router.post("/panel/wa/restart", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.disconnect(user.id);
  await multiWA.connectQR(user.id);
  await logEvent("WhatsApp service restarted", "info", "whatsapp");
  res.json(multiWA.getState(user.id));
});

/** Complete logout: disconnect WA socket + wipe session files + panel logout signal. */
router.post("/panel/wa/full-logout", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.clearSession(user.id);
  await logEvent("WhatsApp full logout — session wiped", "warn", "whatsapp");
  res.json({ success: true });
});

/** Restart PM2 processes (whatsapp-api + whatsapp-frontend) and return 200.
 *  The response is sent BEFORE pm2 restarts so the browser gets it. */
router.post("/panel/server/restart", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  res.json({ success: true, message: "Server restart initiated — page will reload in ~10 seconds" });
  await logEvent("Server restart triggered from panel", "warn", "system");
  // Small delay so the response is flushed before the process is killed.
  setTimeout(() => {
    exec("pm2 restart whatsapp-api whatsapp-frontend", (err) => {
      if (err) console.error("[server/restart]", err.message);
    });
  }, 400);
});

/** Certificate / session info. */
router.get("/panel/wa/certificate", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  res.json(multiWA.getSessionInfo(user.id));
});

// ── Chats ─────────────────────────────────────────────────────────

router.get("/panel/chats", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  // Only return chats for the currently connected WhatsApp number.
  // This prevents old-number chats from leaking into the panel when a new
  // number connects: each number's chat history is isolated by accountPhone.
  const info = multiWA.getSessionInfo(user.id);
  const accountPhone = info?.phoneNumber ?? null;
  res.json(await getAllChats(user.id, accountPhone ?? undefined));
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
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const myId = user.id;

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

  // Every listener below is GLOBAL (fires for every connected account), so
  // each one MUST filter to `myId` before writing to this client's stream —
  // otherwise one customer's messages/calls/reactions would leak into
  // another customer's browser.
  const offPersist = multiWA.addPersistListener((uid, jid, _phone, msg) => {
    if (uid !== myId) return;
    send("message", { jid, fromMe: msg.fromMe, ts: msg.ts });
  });
  const offDelete = multiWA.addDeleteListener((uid, waMessageId) => {
    if (uid !== myId) return;
    send("delete", { waMessageId });
  });
  // Sent/delivered/read (single/double/blue tick) updates — without this the
  // open conversation only learned about a tick change on its next slow poll.
  const offStatus = multiWA.addStatusListener((uid, update) => {
    if (uid !== myId) return;
    send("status", { waMessageId: update.waMessageId, jid: update.jid, status: update.status });
  });
  const offCall = multiWA.addCallListener((uid, call) => {
    if (uid !== myId) return;
    send("call", { callId: call.callId, outcome: call.outcome, ts: call.ts });
  });
  const offReaction = multiWA.addReactionListener((uid, jid, waMessageId, reactorJid, emoji, ts) => {
    if (uid !== myId) return;
    send("reaction", { jid, waMessageId, reactorJid, emoji, ts });
  });
  const offPresence = multiWA.addPresenceListener((uid, jid, presence, lastSeen) => {
    if (uid !== myId) return;
    send("presence", { jid, presence, lastSeen });
  });
  const offState = multiWA.addUserListener(myId, (state) => {
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
    offStatus();
    offReaction();
    offPresence();
    res.end();
  });
});

// ── Calls + Status (WhatsApp-Web style monitoring) ────────────────

/** Call log: incoming / missed / rejected / accepted. Duration is generally
 *  unavailable from a linked device, so the client shows that honestly. */
router.get("/panel/calls", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const calls = await getCallLogs(user.id);
  // Same @lid resolution gap as /panel/status: a caller never messaged 1:1
  // has no cached real phone anywhere, so the log falls back to WhatsApp's
  // opaque lid digits — resolve those live (see Round 6's resolveLidPhones).
  const unresolved = calls.filter((c) => c.jid.endsWith("@lid") && c.phone === c.jid.split("@")[0].split(":")[0]);
  if (unresolved.length) {
    const resolved = await multiWA.resolveLidPhones(user.id, unresolved.map((c) => c.jid));
    for (const c of unresolved) {
      if (resolved[c.jid]) c.phone = resolved[c.jid];
    }
  }
  res.json(calls);
});

/** Status (stories) grouped by the contact who posted them. */
router.get("/panel/status", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const groups = await getStatusGroups(user.id);
  // A poster we've never chatted with has no wa_chats row to resolve their
  // @lid from, so getStatusGroups falls back to the opaque lid digits — try
  // a live resolution for exactly those (cheap local Signal-store lookup,
  // not a network round trip) so the admin still sees a real number.
  const unresolved = groups.filter((g) => g.participant.endsWith("@lid") && g.phone === g.participant.split("@")[0].split(":")[0]);
  if (unresolved.length) {
    const resolved = await multiWA.resolveLidPhones(user.id, unresolved.map((g) => g.participant));
    for (const g of unresolved) {
      if (resolved[g.participant]) g.phone = resolved[g.participant];
    }
  }
  res.json(groups);
});

router.get("/panel/chats/:jid/messages", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const rows = await getChatMessagesDb(user.id, req.params.jid);
  res.json(rows);
});

/** Serve a single message's media payload (photo/voice/video/document). Accepts
 *  the token via `?t=` so it can be used directly in <img>/<audio> src. */
router.get("/panel/media/:msgId", async (req, res): Promise<void> => {
  const queryToken = req.query.t;
  if (typeof queryToken === "string" && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const row = await getMediaById(user.id, req.params.msgId);
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
  const user = await requirePanelUser(req, res);
  if (!user) return;
  multiWA.markRead(user.id, req.params.jid);
  await clearUnread(user.id, req.params.jid);
  // Opening a chat is also when WhatsApp expects a presence subscription —
  // without this, most 1:1 chats never push online/typing updates at all.
  void multiWA.subscribePresence(user.id, req.params.jid);
  res.json({ success: true });
});

/** Current cached online/typing state for a chat (SSE only pushes changes,
 *  so the UI needs this once when a conversation first opens). */
router.get("/panel/chats/:jid/presence", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  res.json(multiWA.getPresence(user.id, req.params.jid) ?? null);
});

/** Tell WhatsApp we're typing (or done typing) a reply — the composing/paused
 *  indicator real WhatsApp Web sends while the admin is writing. */
router.post("/panel/chats/:jid/typing", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await multiWA.setTyping(user.id, req.params.jid, !!req.body?.composing);
  res.json({ success: true });
});

/** Send a message to a phone number OR a group JID (creates the chat if new).
 *  Optionally carries a WhatsApp-style quoted reply (quotedId/quotedFromMe/
 *  quotedText), the way tapping "Reply" on a message in the panel works. */
router.post("/panel/send", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const jid   = String(req.body?.jid  ?? "").trim();          // full JID for groups
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const text  = String(req.body?.text  ?? "").trim();
  if ((!phone && !jid) || !text) {
    res.status(400).json({ error: "phone (or jid) and text required" });
    return;
  }
  const quotedId = req.body?.quotedId ? String(req.body.quotedId) : undefined;
  const quoted = quotedId
    ? { waMessageId: quotedId, fromMe: req.body?.quotedFromMe === true || req.body?.quotedFromMe === "true", text: String(req.body?.quotedText ?? "") }
    : undefined;
  try {
    const waMessageId = jid
      ? await multiWA.sendToJid(user.id, jid, text, quoted)
      : await multiWA.sendMessage(user.id, phone, text, quoted);
    res.json({ success: true, waMessageId });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to send" });
  }
});

/** Delete a message for everyone. */
router.delete("/panel/chats/:jid/:msgId", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const fromMe = req.query.fromMe === "true";
  try {
    await multiWA.deleteForEveryone(user.id, req.params.jid, req.params.msgId, fromMe);
    await markDeleted(user.id, req.params.msgId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to delete" });
  }
});

/** "Delete for me": local-only hide, never a WhatsApp protocol call. */
router.post("/panel/chats/:jid/:msgId/hide", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await hideForMe(user.id, req.params.msgId);
  res.json({ success: true });
});

/** Star / unstar a message. */
router.post("/panel/chats/:jid/:msgId/star", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setStarred(user.id, req.params.msgId, !!req.body?.starred);
  res.json({ success: true });
});

/** All starred messages across every chat. */
router.get("/panel/starred", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  res.json(await getStarredMessages(user.id));
});

/** React to (or, with emoji: "", remove a reaction from) a message. */
router.post("/panel/chats/:jid/:msgId/react", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const emoji = String(req.body?.emoji ?? "");
  const fromMe = !!req.body?.fromMe;
  const participant = req.body?.participant ? String(req.body.participant) : undefined;
  try {
    await multiWA.sendReaction(user.id, req.params.jid, req.params.msgId, fromMe, emoji, participant);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to react" });
  }
});

/** Forward an existing message's content to another chat. */
router.post("/panel/chats/:jid/:msgId/forward", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const toJid = String(req.body?.toJid ?? "").trim();
  if (!toJid) {
    res.status(400).json({ error: "toJid required" });
    return;
  }
  const source = await getMessageForForward(user.id, req.params.msgId);
  if (!source) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  try {
    const waMessageId = await multiWA.forwardMessage(user.id, toJid, {
      text: source.text,
      media: source.media ?? undefined,
      mediaMime: source.mediaMime ?? undefined,
      mediaKind: source.mediaKind ?? undefined,
      fileName: source.fileName ?? undefined,
    });
    res.json({ success: true, waMessageId });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to forward" });
  }
});

/** Pin / mute / archive a chat — chat-list organization, no WhatsApp protocol call. */
router.post("/panel/chats/:jid/pin", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setChatPinned(user.id, req.params.jid, !!req.body?.value);
  res.json({ success: true });
});
router.post("/panel/chats/:jid/mute", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setChatMuted(user.id, req.params.jid, !!req.body?.value);
  res.json({ success: true });
});
router.post("/panel/chats/:jid/archive", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setChatArchived(user.id, req.params.jid, !!req.body?.value);
  res.json({ success: true });
});
/** Mark as unread / read from the chat-list menu. */
router.post("/panel/chats/:jid/unread", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setChatUnread(user.id, req.params.jid, !!req.body?.value);
  res.json({ success: true });
});
/** Delete chat: local-only hide, same anti-delete philosophy as message-level
 *  "delete for me" — reappears automatically on the next live message. */
router.post("/panel/chats/:jid/delete", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  await setChatDeletedForMe(user.id, req.params.jid, !!req.body?.value);
  res.json({ success: true });
});

/** Send a photo/video/voice-note/document. Accepts either `jid` (groups) or
 *  `phone` (1:1) the same way /panel/send does, plus an optional quote. */
router.post("/panel/send-media", uploadMedia.single("file"), async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "file required" });
    return;
  }
  const jid = String(req.body?.jid ?? "").trim();
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  const targetJid = jid || (phone ? `${phone}@s.whatsapp.net` : "");
  if (!targetJid) {
    res.status(400).json({ error: "phone (or jid) required" });
    return;
  }
  const kindRaw = String(req.body?.kind ?? "");
  const kind = (["image", "video", "audio", "document"].includes(kindRaw) ? kindRaw : "document") as
    "image" | "video" | "audio" | "document";
  const quotedId = req.body?.quotedId ? String(req.body.quotedId) : undefined;
  const quoted = quotedId
    ? { waMessageId: quotedId, fromMe: !!req.body?.quotedFromMe, text: String(req.body?.quotedText ?? "") }
    : undefined;
  try {
    const waMessageId = await multiWA.sendMedia(user.id, targetJid, file.buffer, file.mimetype, kind, {
      caption: req.body?.caption ? String(req.body.caption) : undefined,
      fileName: file.originalname,
      viewOnce: req.body?.viewOnce === true || req.body?.viewOnce === "true",
      quoted,
    });
    res.json({ success: true, waMessageId });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to send media" });
  }
});

// ── Group management ────────────────────────────────────────────────

router.get("/panel/groups/:jid/info", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  try {
    res.json(await multiWA.getGroupInfo(user.id, req.params.jid));
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to load group info" });
  }
});

router.post("/panel/groups/:jid/participants", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const jids: string[] = Array.isArray(req.body?.jids) ? req.body.jids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!jids.length || !["add", "remove", "promote", "demote"].includes(action)) {
    res.status(400).json({ error: "jids[] and a valid action required" });
    return;
  }
  try {
    await multiWA.updateGroupParticipants(user.id, req.params.jid, jids, action as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to update participants" });
  }
});

router.put("/panel/groups/:jid/subject", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const subject = String(req.body?.subject ?? "").trim();
  if (!subject) {
    res.status(400).json({ error: "subject required" });
    return;
  }
  try {
    await multiWA.updateGroupSubject(user.id, req.params.jid, subject);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to update group name" });
  }
});

router.put("/panel/groups/:jid/description", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  try {
    await multiWA.updateGroupDescription(user.id, req.params.jid, String(req.body?.description ?? ""));
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to update group description" });
  }
});

router.post("/panel/groups/:jid/icon", uploadMedia.single("file"), async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  if (!req.file) {
    res.status(400).json({ error: "file required" });
    return;
  }
  try {
    await multiWA.updateGroupIcon(user.id, String(req.params.jid), req.file.buffer);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to update group icon" });
  }
});

router.get("/panel/groups/:jid/invite", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  try {
    const code = await multiWA.getGroupInviteCode(user.id, req.params.jid);
    res.json({ code, link: `https://chat.whatsapp.com/${code}` });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to fetch invite link" });
  }
});

router.post("/panel/groups/:jid/invite/revoke", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  try {
    const code = await multiWA.revokeGroupInviteCode(user.id, req.params.jid);
    res.json({ code, link: `https://chat.whatsapp.com/${code}` });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to reset invite link" });
  }
});

router.post("/panel/groups/:jid/leave", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  try {
    await multiWA.leaveGroup(user.id, req.params.jid);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed to leave group" });
  }
});

// ── Settings ──────────────────────────────────────────────────────
// Shared/global app settings (pairing brand code, theme default, backup
// schedule) — intentionally one row for the whole install, not per-account.

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
// Shared system log (connection/auth/admin events across all accounts) —
// intentionally not per-account, same as before.

router.get("/panel/logs", async (req, res): Promise<void> => {
  if (!(await requirePanelUser(req, res))) return;
  const limit = Math.min(Number(req.query.limit ?? 200), 500);
  const rows = await db.select().from(appLogsTable).orderBy(desc(appLogsTable.createdAt)).limit(limit);
  res.json(rows);
});

// ── Backup & Restore ──────────────────────────────────────────────
// Scoped to the requesting account only — a customer's backup must never
// include another customer's chats.

router.post("/panel/backup", async (req, res): Promise<void> => {
  const user = await requirePanelUser(req, res);
  if (!user) return;
  const chats = await db.select().from(waChatsTable).where(eq(waChatsTable.userId, user.id));
  const messages = await db.select().from(waMessagesTable).where(eq(waMessagesTable.userId, user.id));
  const settings = await getSettings();
  const payloadObj = { version: 2, userId: user.id, createdAt: new Date().toISOString(), chats, messages, settings };
  const payload = JSON.stringify(payloadObj);
  const filename = `backup-${user.username}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
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
  await logEvent(`Backup created for ${user.username}: ${filename} (${chats.length} chats, ${messages.length} msgs)`, "info", "backup");
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
  const user = await requirePanelUser(req, res);
  if (!user) return;
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
  // Only ever replace THIS account's own rows, never another account's —
  // and only allow restoring a backup this same account created.
  if (data.userId != null && data.userId !== user.id) {
    res.status(403).json({ error: "This backup belongs to a different account" });
    return;
  }
  await db.delete(waMessagesTable).where(eq(waMessagesTable.userId, user.id));
  await db.delete(waChatsTable).where(eq(waChatsTable.userId, user.id));
  if (Array.isArray(data.chats) && data.chats.length) {
    await db.insert(waChatsTable).values(data.chats.map((c: any) => ({ ...c, userId: user.id }))).onConflictDoNothing();
  }
  if (Array.isArray(data.messages) && data.messages.length) {
    // Strip serial ids so they re-generate; keep waMessageId for dedupe.
    const msgs = data.messages.map((m: any) => ({
      userId: user.id,
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
  await logEvent(`Backup restored for ${user.username}: ${backup.filename}`, "warn", "backup");
  res.json({ success: true, restoredChats: data.chats?.length ?? 0, restoredMessages: data.messages?.length ?? 0 });
});

export default router;
