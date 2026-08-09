import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage,
  type WASocket,
  type ConnectionState,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSIONS_BASE = path.join(__dirname, "../../.user-sessions");

const silentLogger = pino({ level: "silent" });

let cachedVersion: [number, number, number] | null = null;
async function getWAVersion(): Promise<[number, number, number]> {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    return version;
  } catch {
    return [2, 2413, 51];
  }
}

export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected";

export interface UserWAState {
  userId: number;
  status: WAStatus;
  qr: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface WAChatMsg {
  id: string;
  text: string;
  fromMe: boolean;
  ts: number;
  status: number; // 0=pending, 1=sent, 2=delivered, 3=read, 4=played
  deleted?: boolean;
  quotedText?: string;
  quotedId?: string;
  media?: string; // base64-encoded media payload (downloaded photos/voice/etc.)
  mediaMime?: string;
  mediaKind?: string; // image | video | audio | sticker | document
  fileName?: string;
  /** JID of the actual poster/sender — set for status@broadcast (stories) and
   *  group messages, so Status updates can be grouped by poster. */
  participant?: string;
}

/** Normalize a phone number to international digits-only form for pairing.
 *  Accepts local formats (e.g. 0300-1234567 → 923001234567) and already-
 *  international ones (+92…, 0092…, 92…). Defaults a leading 0 to Pakistan. */
export function normalizePhone(input: string): string {
  let d = (input || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2); // 0092… → 92…
  else if (d.startsWith("0")) d = "92" + d.slice(1); // 0300… → 92300…
  return d;
}

/** Cap base64 media we keep in the DB so a huge video can't bloat a row. */
const MEDIA_MAX_BYTES = 8 * 1024 * 1024; // 8 MB raw

/** Download a media message to base64. Re-uploads expired media via the socket
 *  so even older history photos can usually be fetched. Never throws. */
async function downloadMediaBase64(msg: any, sock: WASocket): Promise<string | null> {
  try {
    const buffer: any = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: silentLogger as any, reuploadRequest: sock.updateMediaMessage },
    );
    if (!buffer || buffer.length === 0 || buffer.length > MEDIA_MAX_BYTES) return null;
    return Buffer.from(buffer).toString("base64");
  } catch {
    return null;
  }
}

export interface WAChat {
  jid: string;
  phone: string;
  name?: string;
  lastMsg: string;
  lastMsgTs: number;
  unread: number;
}

export interface IncomingWAMsg {
  waMessageId: string;
  text: string;
  ts: number;
  quotedWaId?: string;
  quotedText?: string;
}
export interface StatusUpdate {
  waMessageId: string;
  jid: string;
  status: number; // 1=sent, 2=delivered, 3=read, 4=played
}

type Listener = (state: UserWAState) => void;
type MsgListener = (userId: number, senderPhone: string, msg: IncomingWAMsg) => void;
type StatusListener = (userId: number, update: StatusUpdate) => void;
/** Fired for EVERY new message (incoming + outgoing) so it can be persisted to DB.
 * `history` is true when the message comes from a WhatsApp history sync (so the
 * persister knows not to bump unread counters for old messages). */
type PersistListener = (userId: number, jid: string, phone: string, msg: WAChatMsg, history?: boolean, name?: string) => void;
/** Fired when a message is deleted-for-everyone, so the DB can flag it while
 *  keeping the original content (anti-delete monitoring). */
type DeleteListener = (userId: number, waMessageId: string) => void;

/** A WhatsApp call notification captured from a linked device. A linked device
 *  receives only call NOTIFICATIONS (offer + terminal state), so the talk
 *  duration of a call answered on the phone is generally unavailable. */
export interface WACall {
  callId: string;
  jid: string;
  phone: string;
  name?: string;
  isVideo: boolean;
  isGroup: boolean;
  outgoing: boolean;
  rawStatus: string;
  outcome: "incoming" | "missed" | "rejected" | "accepted" | "ongoing" | "unknown";
  ts: number;
}
/** Fired for every WhatsApp call notification so the DB can log it. */
type CallListener = (userId: number, call: WACall) => void;

export interface HydrateChat {
  meta: WAChat;
  msgs: WAChatMsg[];
}

class UserSession {
  private sock: WASocket | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pairingRequested = false;
  private pairingPhone: string | null = null;
  private brandCode: string | null = null;
  private didPair = false;
  public state: UserWAState;
  private listeners: Set<Listener> = new Set();
  private msgListeners: Set<MsgListener> = new Set();
  private statusListeners: Set<StatusListener> = new Set();
  private persistListeners: Set<PersistListener> = new Set();
  private deleteListeners: Set<DeleteListener> = new Set();
  private callListeners: Set<CallListener> = new Set();
  private chatStore = new Map<string, { meta: WAChat; msgs: WAChatMsg[] }>();
  /** Map of waMessageId → key, for sendReceipt round-trips. */
  private incomingKeys = new Map<string, { remoteJid: string; id: string; participant?: string; fromMe: boolean }>();
  /** Group jids whose subject (title) we've already fetched, so we don't refetch. */
  private groupNamesFetched = new Set<string>();

  addMsgListener(fn: MsgListener) { this.msgListeners.add(fn); return () => this.msgListeners.delete(fn); }
  addStatusListener(fn: StatusListener) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  addPersistListener(fn: PersistListener) { this.persistListeners.add(fn); return () => this.persistListeners.delete(fn); }
  addDeleteListener(fn: DeleteListener) { this.deleteListeners.add(fn); return () => this.deleteListeners.delete(fn); }
  addCallListener(fn: CallListener) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
  private notifyPersist(jid: string, msg: WAChatMsg, history = false) {
    const phone = jid.split("@")[0];
    const name = this.chatStore.get(jid)?.meta.name;
    for (const fn of this.persistListeners) { try { fn(this.userId, jid, phone, msg, history, name); } catch {} }
  }
  private notifyDelete(waMessageId: string) {
    for (const fn of this.deleteListeners) { try { fn(this.userId, waMessageId); } catch {} }
  }
  private notifyCall(call: WACall) {
    for (const fn of this.callListeners) { try { fn(this.userId, call); } catch {} }
  }
  /** Map a Baileys `call` event into a call-log entry. A linked device only
   *  receives call NOTIFICATIONS (an offer + a terminal state), not a full
   *  telephony record — so we record who/what/outcome, never a reliable talk
   *  duration. Outgoing calls placed from the phone are usually not delivered
   *  here at all; we still defensively detect them via our own number. */
  private handleCall(c: any) {
    const callId: string = c?.id ?? `call-${Date.now()}`;
    const fromJid: string = c?.from ?? c?.chatId ?? "";
    if (!fromJid) return;
    const ownNum = (this.state.phoneNumber ?? "").replace(/\D/g, "");
    const fromNum = fromJid.split("@")[0].split(":")[0];
    const outgoing = !!ownNum && fromNum === ownNum;
    const counterpartJid = outgoing ? (c?.chatId ?? fromJid) : fromJid;
    const phone = (counterpartJid.split("@")[0] || "").split(":")[0];
    const rawStatus = String(c?.status ?? "");
    let outcome: WACall["outcome"];
    switch (rawStatus) {
      case "offer":
      case "ringing": outcome = outgoing ? "ongoing" : "incoming"; break;
      case "timeout": outcome = "missed"; break;
      case "reject": outcome = "rejected"; break;
      case "accept": outcome = "accepted"; break;
      default: outcome = "unknown";
    }
    const name =
      this.chatStore.get(counterpartJid)?.meta.name ??
      this.chatStore.get(`${phone}@s.whatsapp.net`)?.meta.name ??
      undefined;
    const ts = c?.date ? new Date(c.date).getTime() : Date.now();
    this.notifyCall({
      callId, jid: counterpartJid, phone, name,
      isVideo: !!c?.isVideo, isGroup: !!c?.isGroup, outgoing, rawStatus, outcome, ts,
    });
  }

  /** Load chat history from DB into the in-memory store (called on startup). */
  hydrate(chats: HydrateChat[]) {
    for (const c of chats) {
      this.chatStore.set(c.meta.jid, { meta: { ...c.meta }, msgs: [...c.msgs] });
      for (const m of c.msgs) {
        if (!m.fromMe) this.incomingKeys.set(m.id, { remoteJid: c.meta.jid, id: m.id, fromMe: false });
      }
    }
  }
  private notifyMsg(senderPhone: string, msg: IncomingWAMsg) {
    for (const fn of this.msgListeners) { try { fn(this.userId, senderPhone, msg); } catch {} }
  }
  private notifyStatus(update: StatusUpdate) {
    for (const fn of this.statusListeners) { try { fn(this.userId, update); } catch {} }
  }

  /** Send a WhatsApp "read" receipt for inbound messages by waMessageId. */
  async markIncomingRead(waMessageIds: string[]): Promise<void> {
    if (!this.sock || this.state.status !== "connected" || waMessageIds.length === 0) return;
    const byJid = new Map<string, { id: string; participant?: string }[]>();
    for (const wid of waMessageIds) {
      const k = this.incomingKeys.get(wid);
      if (!k || k.fromMe) continue;
      const arr = byJid.get(k.remoteJid) ?? [];
      arr.push({ id: k.id, participant: k.participant });
      byJid.set(k.remoteJid, arr);
    }
    for (const [jid, items] of byJid) {
      try {
        await this.sock.readMessages(items.map(it => ({ remoteJid: jid, id: it.id, participant: it.participant })) as any);
      } catch {}
    }
  }

  getChatList(): WAChat[] {
    return [...this.chatStore.values()]
      .map(c => c.meta)
      .sort((a, b) => b.lastMsgTs - a.lastMsgTs);
  }

  getChatMessages(jid: string): WAChatMsg[] {
    return this.chatStore.get(jid)?.msgs ?? [];
  }

  markRead(jid: string) {
    const c = this.chatStore.get(jid);
    if (c) c.meta.unread = 0;
  }

  async sendToJid(jid: string, text: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    const result = await this.sock.sendMessage(jid, { text });
    const msgId = result?.key.id ?? `local-${Date.now()}`;
    this.upsertMsg(jid, { id: msgId, text, fromMe: true, ts: Date.now(), status: 1 }, text);
    return msgId;
  }

  async deleteForEveryone(jid: string, msgId: string, fromMe: boolean) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.sendMessage(jid, {
      delete: { remoteJid: jid, id: msgId, fromMe, participant: fromMe ? undefined : jid },
    } as any);
    const entry = this.chatStore.get(jid);
    if (entry) {
      const m = entry.msgs.find(x => x.id === msgId);
      // ANTI-DELETE: flag it but keep the original text/media for monitoring.
      if (m) m.deleted = true;
    }
    this.notifyDelete(msgId);
  }

  /** Resolve a group's title (subject) once and store it on the chat so the list
   *  shows a readable name instead of the raw group id. Best-effort + async. */
  private ensureGroupName(jid: string) {
    if (!jid.endsWith("@g.us") || this.groupNamesFetched.has(jid)) return;
    const sock = this.sock;
    if (!sock) return;
    this.groupNamesFetched.add(jid);
    sock.groupMetadata(jid)
      .then((meta: any) => {
        const subject = meta?.subject;
        const entry = this.chatStore.get(jid);
        if (subject && entry) {
          entry.meta.name = subject;
          const last = entry.msgs[entry.msgs.length - 1];
          if (last) this.notifyPersist(jid, last, true);
        }
      })
      .catch(() => { this.groupNamesFetched.delete(jid); });
  }

  private upsertMsg(jid: string, m: WAChatMsg, display: string, history = false, nameHint?: string) {
    let entry = this.chatStore.get(jid);
    if (!entry) {
      const phone = jid.split("@")[0];
      entry = { meta: { jid, phone, lastMsg: "", lastMsgTs: 0, unread: 0 }, msgs: [] };
      this.chatStore.set(jid, entry);
    }
    if (nameHint && entry.meta.name !== nameHint) entry.meta.name = nameHint;
    let added = false;
    let corrected = false;
    const existing = entry.msgs.find(x => x.id === m.id);
    if (!existing) {
      entry.msgs.push(m);
      if (entry.msgs.length > 300) entry.msgs.splice(0, entry.msgs.length - 300);
      entry.msgs.sort((a, b) => a.ts - b.ts);
      added = true;
    } else if (!existing.deleted && ((existing.text !== m.text && m.text) || (m.media && !existing.media))) {
      // Same message re-seen with better text (e.g. an old row that was parsed
      // as "Media" before the envelope-unwrap fix) or now with downloaded media.
      if (m.text) existing.text = m.text;
      existing.quotedText = m.quotedText;
      existing.quotedId = m.quotedId;
      if (m.media && !existing.media) {
        existing.media = m.media;
        existing.mediaMime = m.mediaMime;
        existing.mediaKind = m.mediaKind;
        existing.fileName = m.fileName;
      }
      corrected = true;
    }
    if (m.ts >= entry.meta.lastMsgTs) {
      entry.meta.lastMsg = display;
      entry.meta.lastMsgTs = m.ts;
    }
    // History messages are old — never inflate the unread badge with them.
    if (added && !m.fromMe && !history) entry.meta.unread++;
    if (added || corrected) this.notifyPersist(jid, m, history);
  }

  /** Baileys wraps real content inside envelopes: outgoing messages sent from
   *  the phone arrive as `deviceSentMessage`, disappearing chats as
   *  `ephemeralMessage`, view-once as `viewOnceMessage*`, etc. Unwrap them so
   *  text extraction works (otherwise every message falls back to "Media"). */
  private unwrapMessage(message: any): any {
    let m = message;
    for (let i = 0; i < 6 && m; i++) {
      const next =
        m.ephemeralMessage?.message ||
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m.viewOnceMessageV2Extension?.message ||
        m.deviceSentMessage?.message ||
        m.documentWithCaptionMessage?.message ||
        m.editedMessage?.message;
      if (!next) break;
      m = next;
    }
    return m;
  }

  /** Pull text + display label out of a Baileys proto message. Shared by the
   *  live `messages.upsert` and the `messaging-history.set` history sync. */
  private parseWAMessage(msg: any): { jid: string; m: WAChatMsg; display: string; raw: any; nameHint?: string } | null {
    if (!msg?.message) return null;
    const jid = msg.key?.remoteJid ?? "";
    // Show EVERYTHING: individual chats, groups and status/stories.
    const isUser = jid.endsWith("@s.whatsapp.net");
    const isGroup = jid.endsWith("@g.us");
    const isStatus = jid === "status@broadcast";
    if (!isUser && !isGroup && !isStatus) return null;
    const fromMe = msg.key?.fromMe ?? false;
    const msgId = msg.key?.id ?? `unknown-${Date.now()}`;
    const ts = ((msg.messageTimestamp as number) ?? 0) * 1000 || Date.now();
    const raw = this.unwrapMessage(msg.message);
    if (!raw) return null;
    const text =
      raw.conversation ||
      raw.extendedTextMessage?.text ||
      raw.imageMessage?.caption ||
      raw.videoMessage?.caption ||
      "";
    // Classify any attached media so the UI can render the real photo/voice/etc.
    let mediaKind: string | undefined;
    let mediaMime: string | undefined;
    let fileName: string | undefined;
    if (raw.imageMessage) { mediaKind = "image"; mediaMime = raw.imageMessage.mimetype || "image/jpeg"; }
    else if (raw.stickerMessage) { mediaKind = "sticker"; mediaMime = raw.stickerMessage.mimetype || "image/webp"; }
    else if (raw.videoMessage) { mediaKind = "video"; mediaMime = raw.videoMessage.mimetype || "video/mp4"; }
    else if (raw.audioMessage) { mediaKind = "audio"; mediaMime = raw.audioMessage.mimetype || "audio/ogg"; }
    else if (raw.documentMessage) {
      mediaKind = "document";
      mediaMime = raw.documentMessage.mimetype || "application/octet-stream";
      fileName = raw.documentMessage.fileName || undefined;
    }
    const display =
      text ||
      (mediaKind === "image" ? "📷 Photo" :
       mediaKind === "video" ? "📹 Video" :
       mediaKind === "audio" ? "🎵 Voice message" :
       mediaKind === "document" ? `📄 ${fileName ?? "Document"}` :
       mediaKind === "sticker" ? "🩷 Sticker" : "📎 Media");
    const quotedMsg = raw.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quotedMsg ? (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "") : undefined;
    const quotedId = raw.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;
    // A readable chat title: "Status" for stories, the sender's WhatsApp display
    // name (pushName) for individual incoming chats. Group titles are resolved
    // separately (async groupMetadata) because they aren't on the message.
    let nameHint: string | undefined;
    if (isStatus) nameHint = "Status";
    else if (isUser && !fromMe && msg.pushName) nameHint = String(msg.pushName);
    return {
      jid,
      display,
      raw,
      nameHint,
      m: { id: msgId, text: display, fromMe, ts, status: fromMe ? 1 : 0, quotedText, quotedId, mediaKind, mediaMime, fileName, participant: msg.key?.participant ?? undefined },
    };
  }

  constructor(public userId: number) {
    this.state = {
      userId, status: "disconnected", qr: null,
      pairingCode: null, phoneNumber: null, lastError: null, connectedAt: null,
    };
  }

  addListener(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private notify() { for (const fn of this.listeners) { try { fn(this.state); } catch {} } }
  private set(patch: Partial<UserWAState>) { this.state = { ...this.state, ...patch }; this.notify(); }

  private sessionDir() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private wipe() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }

  private closeSocket() {
    if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) { try { this.sock.end(undefined); } catch {} this.sock = null; }
    this.pairingRequested = false;
  }

  async connectQR() {
    this.closeSocket();
    this.pairingPhone = null;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(false, "");
  }

  async connectPhone(phone: string, brandCode?: string | null) {
    this.closeSocket();
    this.wipe();
    const cleanPhone = normalizePhone(phone);
    this.pairingPhone = cleanPhone;
    const brand = (brandCode ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    this.brandCode = brand.length === 8 ? brand : null;
    this.didPair = false;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(true, cleanPhone);
  }

  /** Reconnect with saved creds — clears pairing state to prevent infinite loop */
  private async reconnectSaved() {
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    this.set({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(false, "");
  }

  private async _boot(usePairing: boolean, phone: string, pairingRetry = 0) {
    const dir = this.sessionDir();
    const { state: authState, saveCreds } = await useMultiFileAuthState(dir);
    const version = await getWAVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, silentLogger),
      },
      logger: silentLogger,
      printQRInTerminal: false,
      browser: Browsers.macOS("Safari"),
      markOnlineOnConnect: false,
      connectTimeoutMs: 120_000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 20_000,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: "" }),
    });
    this.sock = sock;
    let codeRequested = false;

    sock.ev.on("creds.update", () => {
      this.didPair = true;
      saveCreds();
    });

    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !usePairing) this.set({ status: "qr_ready", qr });

      // Request pairing code on first non-close event (same pattern as whatsapp.ts)
      if (usePairing && phone && !codeRequested && connection !== "close") {
        codeRequested = true;
        this.pairingTimer = setTimeout(async () => {
          if (this.sock !== sock) return;
          // Never request a code for already-registered creds (Baileys throws).
          if (sock.authState.creds.registered) return;
          try {
            const code = this.brandCode
              ? await sock.requestPairingCode(phone, this.brandCode)
              : await sock.requestPairingCode(phone);
            const display = code.replace(/(.{4})(.{4})/, "$1-$2");
            this.set({ status: "pairing", pairingCode: display, qr: null });
          } catch (e: any) {
            this.set({ status: "disconnected", lastError: `Pairing code nahi mila: ${e?.message ?? "unknown"}` });
          }
        }, 5000);
      }

      if (connection === "open") {
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
        const jid = sock.user?.id ?? null;
        const phoneNumber = jid ? jid.split(":")[0].split("@")[0] : null;
        this.set({
          status: "connected", qr: null, pairingCode: null,
          connectedAt: new Date().toISOString(),
          phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
          lastError: null,
        });
      }

      if (connection === "close") {
        // Ignore close events from stale sockets (e.g. old QR socket killed by closeSocket)
        if (this.sock !== sock) return;
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession;

        if (isLoggedOut) {
          this.wipe();
          this.pairingPhone = null;
          this.didPair = false;
          this.set({ status: "disconnected", connectedAt: null, phoneNumber: null, lastError: "Logged out — dobara link karein." });
          return;
        }

        // After pairing code accepted → WA closes initial WS → reconnect with saved creds
        const wasInPairing = this.state.status === "pairing" || this.didPair;
        if (wasInPairing) {
          this.set({ status: "connecting", lastError: null, pairingCode: null });
          const snapSock = sock;
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this.reconnectSaved();
            }
          }, 3000);
          return;
        }

        // If close fired before pairing code was received, retry up to 3 times
        if (usePairing && codeRequested && pairingRetry < 3) {
          this.set({ status: "connecting", lastError: null });
          const snapSock = sock;
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this._boot(true, phone, pairingRetry + 1);
            }
          }, 2000);
          return;
        }

        this.set({ status: "disconnected", connectedAt: null, phoneNumber: null, lastError: "Connection band." });
        // Auto-retry QR (not if phone pairing is in progress)
        if (!usePairing && !this.pairingPhone) {
          this.reconnectTimer = setTimeout(() => this.connectQR(), 8_000);
        }
      }
    });

    // Capture ALL messages (incoming + outgoing) for WhatsApp Web inbox
    sock.ev.on("messages.upsert", async (m: BaileysEventMap["messages.upsert"]) => {
      // "notify" = a brand-new live message arriving at this device.
      // "append" = a message added to a chat from ELSEWHERE — most importantly the
      //   messages you send from your OWN phone (WhatsApp→WhatsApp). Without
      //   handling it, the panel never shows phone-sent outgoing messages live.
      if (m.type !== "notify" && m.type !== "append") return;
      const isLive = m.type === "notify";
      for (const msg of m.messages) {
        // ANTI-DELETE: a "delete for everyone" arrives as a protocolMessage
        // REVOKE (type 0). It can be wrapped (deviceSent / ephemeral), so unwrap
        // first. Flag the referenced message but KEEP its content, and never
        // store the revoke envelope itself as a junk message.
        const proto = this.unwrapMessage((msg.message as any))?.protocolMessage
          ?? (msg.message as any)?.protocolMessage;
        if (proto && proto.type === 0 && proto.key?.id) {
          const delId: string = proto.key.id;
          const delJid: string = msg.key?.remoteJid ?? proto.key.remoteJid ?? "";
          const entry = this.chatStore.get(delJid);
          const target = entry?.msgs.find((x) => x.id === delId);
          if (target) target.deleted = true;
          this.notifyDelete(delId);
          continue;
        }
        const parsed = this.parseWAMessage(msg);
        if (!parsed) continue;
        const { jid, m: chatMsg } = parsed;
        // Show the message IMMEDIATELY (text or media placeholder) so the inbox
        // updates in real time. The actual media bytes are downloaded in the
        // background below and patched in via a second upsert (COALESCE-backfill).
        // append → treat like history (no unread bump); notify → live (counts unread).
        this.upsertMsg(jid, chatMsg, parsed.display, !isLive, parsed.nameHint);
        this.ensureGroupName(jid);
        if (chatMsg.mediaKind && !chatMsg.media) {
          // Pass the UNWRAPPED message so view-once / ephemeral media downloads
          // correctly (Baileys can't find media inside the envelope otherwise).
          downloadMediaBase64({ key: msg.key, message: parsed.raw }, sock)
            .then((b64) => {
              if (b64) {
                // `history=true` → this is a media backfill of an already-counted
                // message, so it must NOT increment the unread badge again.
                this.upsertMsg(jid, { ...chatMsg, media: b64 }, parsed.display, true);
              }
            })
            .catch(() => {});
        }
        if (!chatMsg.fromMe && isLive) {
          // Remember the key so /read endpoint can send blue-tick when admin reads
          this.incomingKeys.set(chatMsg.id, { remoteJid: jid, id: chatMsg.id, fromMe: false });
          // Do NOT call readMessages here — that gives immediate blue-tick
          // before admin actually opens the widget conversation.
          // Notify listeners for incoming messages to route to support sessions
          const senderPhone = jid.split("@")[0];
          this.notifyMsg(`+${senderPhone}`, {
            waMessageId: chatMsg.id,
            text: chatMsg.text,
            ts: chatMsg.ts,
            quotedWaId: chatMsg.quotedId,
            quotedText: chatMsg.quotedText,
          });
        }
      }
    });

    // Sync existing chats + messages when the device links (WhatsApp-Web-style
    // inbox). Baileys streams recent history in one or more of these events.
    sock.ev.on("messaging-history.set", async (h: BaileysEventMap["messaging-history.set"]) => {
      const unreadByJid = new Map<string, number>();
      const nameByJid = new Map<string, string>();
      for (const c of h.chats ?? []) {
        if (!c.id) continue;
        // Count unread for every chat type (individual, group, status).
        unreadByJid.set(c.id, Math.max(0, c.unreadCount ?? 0));
        // WhatsApp gives a chat title here for groups (and named contacts).
        const title = (c as any).name ?? (c as any).subject;
        if (title) nameByJid.set(c.id, String(title));
      }
      for (const msg of h.messages ?? []) {
        const parsed = this.parseWAMessage(msg);
        if (!parsed) continue;
        const { jid, m: chatMsg } = parsed;
        if (chatMsg.mediaKind && !chatMsg.media) {
          // Unwrapped message → view-once / ephemeral media downloads correctly.
          const b64 = await downloadMediaBase64({ key: msg.key, message: parsed.raw }, sock);
          if (b64) chatMsg.media = b64;
        }
        this.upsertMsg(jid, chatMsg, parsed.display, true, nameByJid.get(jid) ?? parsed.nameHint);
        if (jid.endsWith("@g.us") && !nameByJid.get(jid)) this.ensureGroupName(jid);
        if (!chatMsg.fromMe) {
          this.incomingKeys.set(chatMsg.id, { remoteJid: jid, id: chatMsg.id, fromMe: false });
        }
      }
      // Apply chat titles even for chats with no synced messages yet.
      for (const [jid, name] of nameByJid) {
        const entry = this.chatStore.get(jid);
        if (entry && entry.meta.name !== name) entry.meta.name = name;
      }
      // Apply the real unread counts reported by WhatsApp for each chat.
      for (const [jid, unread] of unreadByJid) {
        const entry = this.chatStore.get(jid);
        if (entry) entry.meta.unread = unread;
      }
    });

    // Track message status updates (sent/delivered/read ticks)
    sock.ev.on("messages.update", (updates: BaileysEventMap["messages.update"]) => {
      for (const update of updates) {
        const jid = update.key.remoteJid ?? "";
        if (!jid) continue;
        const entry = this.chatStore.get(jid);
        const m = entry?.msgs.find(x => x.id === update.key.id);
        if (m && update.update.status != null) m.status = update.update.status as number;
        if (update.key.id && update.update.status != null) {
          this.notifyStatus({
            waMessageId: update.key.id,
            jid,
            status: update.update.status as number,
          });
        }
      }
    });

    // Capture call notifications (incoming / missed / rejected / accepted) so the
    // Calls log can mirror WhatsApp. A linked device receives notifications only.
    sock.ev.on("call", (calls: BaileysEventMap["call"]) => {
      for (const c of calls) this.handleCall(c);
    });
  }

  /**
   * Send a text message to a phone number. Returns the WA message id so
   * callers can persist it for tick/status round-trips.
   *
   * `quoted` lets callers attach a WhatsApp-style quoted reply. We need the
   * original sender's jid + their stanza id + the original text to build
   * Baileys' `quoted` payload.
   */
  async sendMessage(
    toPhone: string,
    text: string,
    quoted?: { waMessageId: string; fromMe: boolean; text: string },
  ): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    const jid = `${toPhone.replace(/\D/g, "")}@s.whatsapp.net`;
    let opts: any = undefined;
    if (quoted?.waMessageId) {
      opts = {
        quoted: {
          key: { remoteJid: jid, fromMe: quoted.fromMe, id: quoted.waMessageId },
          message: { conversation: quoted.text || "" },
        },
      };
    }
    const result = await this.sock.sendMessage(jid, { text }, opts);
    const msgId = result?.key.id ?? `local-${Date.now()}`;
    this.upsertMsg(
      jid,
      { id: msgId, text, fromMe: true, ts: Date.now(), status: 1, quotedText: quoted?.text, quotedId: quoted?.waMessageId },
      text,
    );
    return msgId;
  }

  disconnect() {
    this.closeSocket();
    this.pairingPhone = null;
    this.set({ status: "disconnected", qr: null, pairingCode: null, lastError: "Disconnected", connectedAt: null });
  }

  clearSession() {
    this.closeSocket();
    this.pairingPhone = null;
    this.wipe();
    this.set({ status: "disconnected", qr: null, pairingCode: null, lastError: "Session cleared", connectedAt: null, phoneNumber: null });
  }

  freshStart() {
    this.clearSession();
    setTimeout(() => this.connectQR(), 500);
  }

  /** Session/certificate info: whether WA creds exist on disk + connection meta. */
  getSessionInfo() {
    const dir = path.join(SESSIONS_BASE, `user-${this.userId}`);
    const credsFile = path.join(dir, "creds.json");
    const hasCreds = fs.existsSync(credsFile);
    let credsUpdatedAt: string | null = null;
    if (hasCreds) {
      try { credsUpdatedAt = fs.statSync(credsFile).mtime.toISOString(); } catch {}
    }
    return {
      userId: this.userId,
      status: this.state.status,
      phoneNumber: this.state.phoneNumber,
      connectedAt: this.state.connectedAt,
      lastError: this.state.lastError,
      hasCredentials: hasCreds,
      credentialsUpdatedAt: credsUpdatedAt,
      sessionDir: `user-${this.userId}`,
    };
  }
}

class MultiWhatsAppService {
  private sessions = new Map<number, UserSession>();
  private globalListeners: Set<(state: UserWAState) => void> = new Set();
  private globalMsgListeners: Set<MsgListener> = new Set();
  private globalStatusListeners: Set<StatusListener> = new Set();
  private globalPersistListeners: Set<PersistListener> = new Set();
  private globalDeleteListeners: Set<DeleteListener> = new Set();
  private globalCallListeners: Set<CallListener> = new Set();

  addGlobalListener(fn: (state: UserWAState) => void) {
    this.globalListeners.add(fn);
    return () => this.globalListeners.delete(fn);
  }

  /** Subscribe to EVERY new message (in + out) across all sessions for DB persistence. */
  addPersistListener(fn: PersistListener) {
    this.globalPersistListeners.add(fn);
    return () => this.globalPersistListeners.delete(fn);
  }

  /** Subscribe to delete-for-everyone events across all sessions (anti-delete). */
  addDeleteListener(fn: DeleteListener) {
    this.globalDeleteListeners.add(fn);
    return () => this.globalDeleteListeners.delete(fn);
  }

  /** Subscribe to call notifications across all sessions (Calls log). */
  addCallListener(fn: CallListener) {
    this.globalCallListeners.add(fn);
    return () => this.globalCallListeners.delete(fn);
  }

  /** Load DB chat history into a session's in-memory store (call before connect). */
  hydrate(userId: number, chats: HydrateChat[]) { this.getSession(userId).hydrate(chats); }

  private getSession(userId: number): UserSession {
    if (!this.sessions.has(userId)) {
      const sess = new UserSession(userId);
      sess.addListener(state => {
        for (const fn of this.globalListeners) { try { fn(state); } catch {} }
      });
      sess.addMsgListener((uid, phone, msg) => {
        for (const fn of this.globalMsgListeners) { try { fn(uid, phone, msg); } catch {} }
      });
      sess.addStatusListener((uid, update) => {
        for (const fn of this.globalStatusListeners) { try { fn(uid, update); } catch {} }
      });
      sess.addPersistListener((uid, jid, phone, msg, history, name) => {
        for (const fn of this.globalPersistListeners) { try { fn(uid, jid, phone, msg, history, name); } catch {} }
      });
      sess.addDeleteListener((uid, waMessageId) => {
        for (const fn of this.globalDeleteListeners) { try { fn(uid, waMessageId); } catch {} }
      });
      sess.addCallListener((uid, call) => {
        for (const fn of this.globalCallListeners) { try { fn(uid, call); } catch {} }
      });
      this.sessions.set(userId, sess);
    }
    return this.sessions.get(userId)!;
  }

  getState(userId: number): UserWAState { return this.getSession(userId).state; }
  getSessionInfo(userId: number) { return this.getSession(userId).getSessionInfo(); }
  getAllStates(): UserWAState[] { return [...this.sessions.values()].map(s => s.state); }
  addUserListener(userId: number, fn: (state: UserWAState) => void) { return this.getSession(userId).addListener(fn); }

  connectQR(userId: number)               { return this.getSession(userId).connectQR(); }
  connectPhone(userId: number, p: string, brandCode?: string | null) { return this.getSession(userId).connectPhone(p, brandCode); }
  disconnect(userId: number)              { this.getSession(userId).disconnect(); }
  clearSession(userId: number)            { this.getSession(userId).clearSession(); }
  freshStart(userId: number)              { this.getSession(userId).freshStart(); }
  sendMessage(userId: number, to: string, text: string, quoted?: { waMessageId: string; fromMe: boolean; text: string }) {
    return this.getSession(userId).sendMessage(to, text, quoted);
  }
  sendToJid(userId: number, jid: string, text: string) { return this.getSession(userId).sendToJid(jid, text); }
  getChatList(userId: number) { return this.getSession(userId).getChatList(); }
  getChatMessages(userId: number, jid: string) { return this.getSession(userId).getChatMessages(jid); }
  markRead(userId: number, jid: string) { this.getSession(userId).markRead(jid); }
  markIncomingRead(userId: number, ids: string[]) { return this.getSession(userId).markIncomingRead(ids); }
  deleteForEveryone(userId: number, jid: string, msgId: string, fromMe: boolean) { return this.getSession(userId).deleteForEveryone(jid, msgId, fromMe); }
  addMsgListener(fn: MsgListener) { this.globalMsgListeners.add(fn); return () => this.globalMsgListeners.delete(fn); }
  addStatusListener(fn: StatusListener) { this.globalStatusListeners.add(fn); return () => this.globalStatusListeners.delete(fn); }

  /** Send from any connected session — used by admin reply routing */
  async sendFromAnyConnected(to: string, text: string): Promise<{ ok: boolean; waMessageId?: string; userId?: number }> {
    for (const sess of this.sessions.values()) {
      if (sess.state.status === "connected") {
        try {
          const id = await sess.sendMessage(to, text);
          return { ok: true, waMessageId: id, userId: (sess as any).userId };
        } catch {}
      }
    }
    return { ok: false };
  }

  /** On server startup: reconnect any saved sessions found on disk */
  autoReconnectSaved() {
    if (!fs.existsSync(SESSIONS_BASE)) return;
    const dirs = fs.readdirSync(SESSIONS_BASE);
    for (const dir of dirs) {
      const match = dir.match(/^user-(\d+)$/);
      if (!match) continue;
      const userId = parseInt(match[1]);
      const credsFile = path.join(SESSIONS_BASE, dir, "creds.json");
      if (!fs.existsSync(credsFile)) continue;
      // Small stagger to avoid hammering WA servers simultaneously
      const delay = (userId % 10) * 2000;
      setTimeout(() => {
        this.getSession(userId).connectQR().catch(() => {});
      }, delay);
    }
  }
}

export const multiWA = new MultiWhatsAppService();
