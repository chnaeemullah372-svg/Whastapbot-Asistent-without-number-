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
  /** Set once a later edit replaces this message's text. */
  edited?: boolean;
  /** Was sent as WhatsApp "View once" media. Content is still saved (this
   *  app's anti-delete/monitoring design), but the UI labels it honestly. */
  viewOnce?: boolean;
  /** Was sent inside a disappearing-messages chat. */
  ephemeral?: boolean;
  /** Link-preview metadata WhatsApp attaches to a URL shared in a text message. */
  linkPreviewUrl?: string;
  linkPreviewTitle?: string;
  linkPreviewDescription?: string;
  linkPreviewThumb?: string; // base64 JPEG thumbnail
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
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024; // 8 MB raw

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
  /** Cached WhatsApp profile photo URL (contact or group icon). */
  avatarUrl?: string;
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
type PersistListener = (
  userId: number, jid: string, phone: string, msg: WAChatMsg, history?: boolean, name?: string, avatarUrl?: string,
) => void;
/** Fired when a message is deleted-for-everyone, so the DB can flag it while
 *  keeping the original content (anti-delete monitoring). */
type DeleteListener = (userId: number, waMessageId: string) => void;
/** Fired on every emoji reaction (add or remove — an empty `emoji` means the
 *  reactor removed theirs). */
type ReactionListener = (
  userId: number, jid: string, waMessageId: string, reactorJid: string, emoji: string, ts: number,
) => void;
/** Fired on a presence change for a chat: "composing" (typing…), "recording"
 *  (voice note), "available" (online), "paused"/"unavailable" (idle/offline). */
type PresenceListener = (userId: number, jid: string, presence: string, lastSeen?: number) => void;

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
  private reactionListeners: Set<ReactionListener> = new Set();
  private presenceListeners: Set<PresenceListener> = new Set();
  private presenceByJid = new Map<string, { presence: string; lastSeen?: number }>();
  private chatStore = new Map<string, { meta: WAChat; msgs: WAChatMsg[] }>();
  /** Map of waMessageId → key, for sendReceipt round-trips. */
  private incomingKeys = new Map<string, { remoteJid: string; id: string; participant?: string; fromMe: boolean }>();
  /** Group jids whose subject (title) we've already fetched, so we don't refetch. */
  private groupNamesFetched = new Set<string>();
  /** Jids whose profile photo we've already tried fetching once — WhatsApp
   *  photos rarely change and a privacy-restricted contact will always fail,
   *  so we never retry rather than hammering the same lookup on every message. */
  private avatarFetched = new Set<string>();
  /** @lid jids we've already tried resolving to a real phone number. WhatsApp's
   *  newer privacy addressing hands out an opaque numeric id (`<id>@lid`)
   *  instead of the real number for some contacts — showing that raw id as
   *  if it were a phone number is exactly the "weird huge number" confusion
   *  this set exists to fix. */
  private lidPhoneFetched = new Set<string>();
  /** How "authoritative" the currently-stored name for a jid is, so a lower-quality
   *  source (e.g. a chat title we just guessed) can never clobber a better one
   *  (e.g. the actual phonebook-saved contact name) once we learn it.
   *  1 = chat title from history sync / group subject, 2 = real contact
   *  (phonebook name or WhatsApp-verified business name) from the contacts store. */
  private nameTier = new Map<string, number>();

  addMsgListener(fn: MsgListener) { this.msgListeners.add(fn); return () => this.msgListeners.delete(fn); }
  addStatusListener(fn: StatusListener) { this.statusListeners.add(fn); return () => this.statusListeners.delete(fn); }
  addPersistListener(fn: PersistListener) { this.persistListeners.add(fn); return () => this.persistListeners.delete(fn); }
  addDeleteListener(fn: DeleteListener) { this.deleteListeners.add(fn); return () => this.deleteListeners.delete(fn); }
  addCallListener(fn: CallListener) { this.callListeners.add(fn); return () => this.callListeners.delete(fn); }
  addReactionListener(fn: ReactionListener) { this.reactionListeners.add(fn); return () => this.reactionListeners.delete(fn); }
  addPresenceListener(fn: PresenceListener) { this.presenceListeners.add(fn); return () => this.presenceListeners.delete(fn); }
  private notifyPersist(jid: string, msg: WAChatMsg, history = false) {
    const meta = this.chatStore.get(jid)?.meta;
    // Prefer the chat's resolved phone (corrected for @lid jids once known)
    // over blindly re-deriving it from the jid on every call.
    const phone = meta?.phone ?? jid.split("@")[0];
    for (const fn of this.persistListeners) { try { fn(this.userId, jid, phone, msg, history, meta?.name, meta?.avatarUrl); } catch {} }
  }
  private notifyDelete(waMessageId: string) {
    for (const fn of this.deleteListeners) { try { fn(this.userId, waMessageId); } catch {} }
  }
  private notifyReaction(jid: string, waMessageId: string, reactorJid: string, emoji: string, ts: number) {
    for (const fn of this.reactionListeners) { try { fn(this.userId, jid, waMessageId, reactorJid, emoji, ts); } catch {} }
  }
  private notifyPresence(jid: string, presence: string, lastSeen?: number) {
    this.presenceByJid.set(jid, { presence, lastSeen });
    for (const fn of this.presenceListeners) { try { fn(this.userId, jid, presence, lastSeen); } catch {} }
  }

  getPresence(jid: string) { return this.presenceByJid.get(jid); }

  /** Ask WhatsApp to start pushing presence (online/typing) updates for this
   *  chat — WhatsApp doesn't send them unsolicited for most 1:1 chats. */
  async subscribePresence(jid: string) {
    if (!this.sock || this.state.status !== "connected") return;
    try { await this.sock.presenceSubscribe(jid); } catch {}
  }

  /** Tell the other side we're typing (or done typing) — the composing/paused
   *  indicator real WhatsApp Web sends while you're writing a reply. */
  async setTyping(jid: string, composing: boolean) {
    if (!this.sock || this.state.status !== "connected") return;
    try { await this.sock.sendPresenceUpdate(composing ? "composing" : "paused", jid); } catch {}
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
    const counterpartEntry = this.chatStore.get(counterpartJid);
    const name =
      counterpartEntry?.meta.name ??
      this.chatStore.get(`${phone}@s.whatsapp.net`)?.meta.name ??
      undefined;
    // counterpartJid is often an opaque @lid with no real digits — prefer
    // whatever real phone we've already resolved for them from a direct chat.
    const resolvedPhone = counterpartEntry?.meta.phone ?? phone;
    const ts = c?.date ? new Date(c.date).getTime() : Date.now();
    this.notifyCall({
      callId, jid: counterpartJid, phone: resolvedPhone, name,
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

  async sendToJid(
    jid: string,
    text: string,
    quoted?: { waMessageId: string; fromMe: boolean; text: string },
  ) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
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

  /** React to (or, with an empty emoji, remove a reaction from) a message. */
  async sendReaction(jid: string, targetId: string, targetFromMe: boolean, emoji: string, targetParticipant?: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.sendMessage(jid, {
      react: { text: emoji, key: { remoteJid: jid, id: targetId, fromMe: targetFromMe, participant: targetParticipant } },
    } as any);
    // Reflect it locally right away rather than waiting for our own echo.
    const myJid = this.sock.user?.id ?? `me@s.whatsapp.net`;
    this.notifyReaction(jid, targetId, myJid, emoji, Date.now());
  }

  /** Send a photo/video/voice-note/document to an existing jid (1:1 or group —
   *  jid is already fully qualified, so this works for both). */
  async sendMedia(
    jid: string,
    buffer: Buffer,
    mimeType: string,
    kind: "image" | "video" | "audio" | "document",
    opts: { caption?: string; fileName?: string; viewOnce?: boolean; quoted?: { waMessageId: string; fromMe: boolean; text: string } } = {},
  ): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    let quotedOpt: any = undefined;
    if (opts.quoted?.waMessageId) {
      quotedOpt = {
        quoted: {
          key: { remoteJid: jid, fromMe: opts.quoted.fromMe, id: opts.quoted.waMessageId },
          message: { conversation: opts.quoted.text || "" },
        },
      };
    }
    // View-once is only a real WhatsApp concept for photos/videos.
    const viewOnce = opts.viewOnce && (kind === "image" || kind === "video") ? true : undefined;
    let content: any;
    if (kind === "image") content = { image: buffer, caption: opts.caption, mimetype: mimeType, viewOnce };
    else if (kind === "video") content = { video: buffer, caption: opts.caption, mimetype: mimeType, viewOnce };
    else if (kind === "audio") content = { audio: buffer, mimetype: mimeType, ptt: true };
    else content = { document: buffer, mimetype: mimeType, fileName: opts.fileName || "file" };

    const result = await this.sock.sendMessage(jid, content, quotedOpt);
    const msgId = result?.key.id ?? `local-${Date.now()}`;
    const display =
      opts.caption ||
      (kind === "image" ? "📷 Photo" :
       kind === "video" ? "📹 Video" :
       kind === "audio" ? "🎵 Voice message" : `📄 ${opts.fileName ?? "Document"}`);
    this.upsertMsg(
      jid,
      {
        id: msgId, text: display, fromMe: true, ts: Date.now(), status: 1,
        media: buffer.length <= MEDIA_MAX_BYTES ? buffer.toString("base64") : undefined,
        mediaMime: mimeType, mediaKind: kind, fileName: opts.fileName, viewOnce,
        quotedText: opts.quoted?.text, quotedId: opts.quoted?.waMessageId,
      },
      display,
    );
    return msgId;
  }

  /** Full group info for the "Group Info" screen: subject, description, owner,
   *  and the participant list with each member's admin rank + resolved name. */
  async getGroupInfo(jid: string) {
    if (!this.sock) throw new Error("Not connected");
    const meta: any = await this.sock.groupMetadata(jid);
    const participants: any[] = meta.participants ?? [];
    // Most group members were never messaged 1:1, so their jid is often an
    // opaque @lid with no real digits at all and no chatStore entry to read
    // a resolved phone from — resolve those live (see resolveLidPhones).
    const lidsToResolve = participants
      .map((p) => p.id as string)
      .filter((pid) => pid.endsWith("@lid") && !this.chatStore.get(pid)?.meta.phone);
    const resolved = lidsToResolve.length ? await this.resolveLidPhones(lidsToResolve) : {};
    return {
      id: meta.id as string,
      subject: meta.subject as string,
      description: (meta.desc as string) ?? null,
      owner: (meta.owner as string) ?? null,
      participants: participants.map((p) => {
        const entry = this.chatStore.get(p.id);
        const phone = entry?.meta.phone ?? resolved[p.id] ?? (String(p.id).includes("@") ? String(p.id).split("@")[0].split(":")[0] : String(p.id));
        return {
          jid: p.id as string,
          admin: (p.admin as string | null) ?? null, // "admin" | "superadmin" | null
          name: entry?.meta.name ?? undefined,
          phone,
        };
      }),
    };
  }

  async updateGroupParticipants(jid: string, participantJids: string[], action: "add" | "remove" | "promote" | "demote") {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.groupParticipantsUpdate(jid, participantJids, action);
  }

  async updateGroupSubject(jid: string, subject: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.groupUpdateSubject(jid, subject);
    // An explicit admin edit is as authoritative as it gets for a group title.
    this.applyName(jid, subject, 2);
  }

  async updateGroupDescription(jid: string, description: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.groupUpdateDescription(jid, description);
  }

  async updateGroupIcon(jid: string, buffer: Buffer) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.updateProfilePicture(jid, buffer);
    this.avatarFetched.delete(jid); // allow one refetch so the new photo shows up
    this.ensureAvatar(jid);
  }

  async getGroupInviteCode(jid: string): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    return (await this.sock.groupInviteCode(jid)) ?? "";
  }

  async revokeGroupInviteCode(jid: string): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    return (await this.sock.groupRevokeInvite(jid)) ?? "";
  }

  async leaveGroup(jid: string) {
    if (!this.sock || this.state.status !== "connected") throw new Error("Not connected");
    await this.sock.groupLeave(jid);
  }

  /** Forward an existing message's content (text or media) to another jid —
   *  re-sent as a fresh message from our own stored copy, since we don't keep
   *  the original raw WhatsApp protocol envelope needed for a native forward. */
  async forwardMessage(
    toJid: string,
    source: { text: string; media?: string; mediaMime?: string; mediaKind?: string | null; fileName?: string | null },
  ): Promise<string> {
    if (source.media && source.mediaMime && source.mediaKind && source.mediaKind !== "sticker") {
      const kind = source.mediaKind as "image" | "video" | "audio" | "document";
      return this.sendMedia(toJid, Buffer.from(source.media, "base64"), source.mediaMime, kind, {
        caption: source.text || undefined,
        fileName: source.fileName || undefined,
      });
    }
    return this.sendToJid(toJid, source.text || "");
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
        if (subject) this.applyName(jid, String(subject), 1);
      })
      .catch(() => { this.groupNamesFetched.delete(jid); });
  }

  /** Resolve a contact's or group's real WhatsApp profile photo once and cache
   *  its URL on the chat. Best-effort + async: many contacts restrict who can
   *  see their photo, so a failure here is normal and just leaves the
   *  initials-circle fallback in the UI. */
  private ensureAvatar(jid: string) {
    if (this.avatarFetched.has(jid)) return;
    const sock = this.sock;
    if (!sock) return;
    this.avatarFetched.add(jid);
    sock.profilePictureUrl(jid, "image")
      .then((url) => {
        if (!url) return;
        const entry = this.chatStore.get(jid);
        if (entry && entry.meta.avatarUrl !== url) {
          entry.meta.avatarUrl = url;
          const last = entry.msgs[entry.msgs.length - 1];
          if (last) this.notifyPersist(jid, last, true);
        }
      })
      .catch(() => {}); // no photo / privacy-restricted — leave the initials fallback
  }

  /** Resolve a `@lid` chat's real phone number (best-effort) so the admin
   *  sees an actual number instead of WhatsApp's opaque LID digits. Never
   *  changes which jid we message — sending must still use the exact jid
   *  the chat is keyed by. */
  private ensureRealPhone(jid: string) {
    if (!jid.endsWith("@lid") || this.lidPhoneFetched.has(jid)) return;
    const sock = this.sock;
    if (!sock) return;
    this.lidPhoneFetched.add(jid);
    sock.signalRepository.lidMapping.getPNForLID(jid)
      .then((pn: string | null) => {
        if (!pn) return;
        const phone = pn.split(":")[0].split("@")[0];
        const entry = this.chatStore.get(jid);
        if (entry && entry.meta.phone !== phone) {
          entry.meta.phone = phone;
          const last = entry.msgs[entry.msgs.length - 1];
          if (last) this.notifyPersist(jid, last, true);
        }
      })
      .catch(() => { this.lidPhoneFetched.delete(jid); });
  }

  /** Live, read-only resolution of `@lid` jids to real phone numbers — for
   *  status posters we've never chatted with, so no cached wa_chats phone
   *  exists yet (unlike ensureRealPhone, this never touches chatStore/
   *  persistence, it just answers the question for the caller). */
  async resolveLidPhones(lids: string[]): Promise<Record<string, string>> {
    const sock = this.sock;
    if (!sock) return {};
    const out: Record<string, string> = {};
    await Promise.all(lids.map(async (lid) => {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
        if (pn) out[lid] = pn.split(":")[0].split("@")[0];
      } catch {}
    }));
    return out;
  }

  /** Apply a resolved display name to a chat, honouring the tier system so a
   *  weaker source can never overwrite a stronger one already known (e.g. a
   *  guessed chat title must never replace the real saved contact name).
   *  Creates a bare (message-less) chat entry when the chat doesn't exist yet,
   *  so a contact's real name is remembered the moment WhatsApp tells us about
   *  it — even before the first message with them is seen. */
  private applyName(jid: string, name: string, tier: number) {
    if (!name) return;
    const prevTier = this.nameTier.get(jid) ?? 0;
    if (prevTier > tier) return;
    this.nameTier.set(jid, tier);
    let entry = this.chatStore.get(jid);
    if (!entry) {
      const phone = jid.split("@")[0];
      this.chatStore.set(jid, { meta: { jid, phone, name, lastMsg: "", lastMsgTs: 0, unread: 0 }, msgs: [] });
      return;
    }
    if (entry.meta.name === name) return;
    entry.meta.name = name;
    const last = entry.msgs[entry.msgs.length - 1];
    if (last) this.notifyPersist(jid, last, true);
  }

  private upsertMsg(jid: string, m: WAChatMsg, display: string, history = false, nameHint?: string, nameTier = 1) {
    let entry = this.chatStore.get(jid);
    if (!entry) {
      const phone = jid.split("@")[0];
      entry = { meta: { jid, phone, lastMsg: "", lastMsgTs: 0, unread: 0 }, msgs: [] };
      this.chatStore.set(jid, entry);
    }
    if (nameHint) this.applyName(jid, nameHint, nameTier);
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

  /** Same envelope walk as `unwrapMessage`, but reports whether a view-once or
   *  disappearing-messages wrapper was present anywhere along the way — this
   *  app deliberately unwraps past both (anti-delete/monitoring design keeps
   *  the content), but the UI should still label a message honestly instead
   *  of silently hiding that fact. Keep this walk in sync with unwrapMessage. */
  private detectEnvelopeFlags(message: any): { isViewOnce: boolean; isEphemeral: boolean } {
    let m = message;
    let isViewOnce = false;
    let isEphemeral = false;
    for (let i = 0; i < 6 && m; i++) {
      if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) isViewOnce = true;
      if (m.ephemeralMessage) isEphemeral = true;
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
    return { isViewOnce, isEphemeral };
  }

  /** Replace WhatsApp's raw "@<number>" mention tokens with the mentioned
   *  contact's resolved display name, e.g. "@923001234567 hi" → "@Ali hi".
   *  Only replaces names we've already resolved (see applyName's tier
   *  system) — an unresolved contact is left as the raw number rather than
   *  showing nothing. */
  private applyMentions(text: string, mentionedJid?: string[]): string {
    if (!text || !mentionedJid?.length) return text;
    let out = text;
    for (const jid of mentionedJid) {
      const phone = jid.split("@")[0].split(":")[0];
      const name = phone ? this.chatStore.get(jid)?.meta.name : undefined;
      if (phone && name) out = out.split(`@${phone}`).join(`@${name}`);
    }
    return out;
  }

  /** Pull the "replying to…" (quoted) message out of a proto message, the way
   *  WhatsApp's own contextInfo works: it can sit on ANY message type — a text
   *  reply, but just as often a reply that's itself a photo/video/voice note/
   *  document/sticker with its own caption. Checking only extendedTextMessage
   *  (as this used to) silently dropped the quote whenever the reply itself
   *  carried media, which is exactly the "quote sometimes just vanishes" bug. */
  private extractQuoted(raw: any): { quotedId?: string; quotedText?: string } {
    const ctx =
      raw.extendedTextMessage?.contextInfo ||
      raw.imageMessage?.contextInfo ||
      raw.videoMessage?.contextInfo ||
      raw.audioMessage?.contextInfo ||
      raw.documentMessage?.contextInfo ||
      raw.stickerMessage?.contextInfo ||
      raw.contextInfo;
    const quoted = ctx?.quotedMessage;
    if (!quoted || !ctx?.stanzaId) return {};
    const text =
      quoted.conversation ||
      quoted.extendedTextMessage?.text ||
      (quoted.imageMessage ? "📷 Photo" :
       quoted.videoMessage ? "📹 Video" :
       quoted.audioMessage ? "🎵 Voice message" :
       quoted.documentMessage ? `📄 ${quoted.documentMessage.fileName ?? "Document"}` :
       quoted.stickerMessage ? "🩷 Sticker" : "");
    return { quotedId: ctx.stanzaId, quotedText: text || undefined };
  }

  /** Pull text + display label out of a Baileys proto message. Shared by the
   *  live `messages.upsert` and the `messaging-history.set` history sync. */
  private parseWAMessage(msg: any): { jid: string; m: WAChatMsg; display: string; raw: any; nameHint?: string } | null {
    if (!msg?.message) return null;
    const jid = msg.key?.remoteJid ?? "";
    // Show EVERYTHING: individual chats, groups and status/stories.
    // "@lid" is WhatsApp's newer privacy-addressing JID format — treat it the
    // same as a regular user JID (@s.whatsapp.net) so incoming messages from
    // these contacts are not silently dropped (this was fixed once already
    // in 3aa8396, then lost during a later branch merge).
    const isUser = jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
    const isGroup = jid.endsWith("@g.us");
    const isStatus = jid === "status@broadcast";
    if (!isUser && !isGroup && !isStatus) return null;
    const fromMe = msg.key?.fromMe ?? false;
    const msgId = msg.key?.id ?? `unknown-${Date.now()}`;
    const ts = ((msg.messageTimestamp as number) ?? 0) * 1000 || Date.now();
    const raw = this.unwrapMessage(msg.message);
    if (!raw) return null;
    const { isViewOnce, isEphemeral } = this.detectEnvelopeFlags(msg.message);
    const rawText =
      raw.conversation ||
      raw.extendedTextMessage?.text ||
      raw.imageMessage?.caption ||
      raw.videoMessage?.caption ||
      "";
    // @mentions in a group: WhatsApp embeds the raw "@<number>" in the text
    // itself; swap in the resolved contact name wherever we know it.
    const mentionedJid: string[] | undefined = raw.extendedTextMessage?.contextInfo?.mentionedJid;
    const text = this.applyMentions(rawText, mentionedJid);
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
    const { quotedId, quotedText } = this.extractQuoted(raw);
    // Link-preview metadata WhatsApp attaches to a text message containing a
    // URL. Only ever present on a plain/extended text message, never media.
    const lp = raw.extendedTextMessage;
    const linkPreviewUrl: string | undefined = lp?.canonicalUrl || lp?.matchedText || undefined;
    const linkPreviewTitle: string | undefined = lp?.title || undefined;
    const linkPreviewDescription: string | undefined = lp?.description || undefined;
    const linkPreviewThumb: string | undefined = lp?.jpegThumbnail
      ? (typeof lp.jpegThumbnail === "string" ? lp.jpegThumbnail : Buffer.from(lp.jpegThumbnail).toString("base64"))
      : undefined;
    // A readable chat title: "Status" for the stories feed. Individual contact
    // names come ONLY from the phonebook-saved contact (contacts.upsert/update)
    // or WhatsApp's own chat-title sync — never the sender's self-set pushName,
    // which is unreliable (often missing, or literally just their own number)
    // and caused the name/number mismatch this app used to show. Group titles
    // are resolved separately (async groupMetadata) because they aren't on the
    // message.
    let nameHint: string | undefined;
    if (isStatus) nameHint = "Status";
    return {
      jid,
      display,
      raw,
      nameHint,
      m: {
        id: msgId, text: display, fromMe, ts, status: fromMe ? 1 : 0, quotedText, quotedId,
        mediaKind, mediaMime, fileName, participant: msg.key?.participant ?? undefined,
        viewOnce: isViewOnce || undefined, ephemeral: isEphemeral || undefined,
        linkPreviewUrl, linkPreviewTitle, linkPreviewDescription, linkPreviewThumb,
      },
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
      generateHighQualityLinkPreview: true,
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
        // Message edit arrives as a protocolMessage MESSAGE_EDIT (type 14)
        // carrying the new content + a key pointing at the ORIGINAL message.
        // Apply it as an update to the existing row instead of a new message,
        // the way WhatsApp replaces the bubble's text in place.
        if (proto && proto.type === 14 && proto.key?.id && proto.editedMessage) {
          const editId: string = proto.key.id;
          const editJid: string = msg.key?.remoteJid ?? proto.key.remoteJid ?? "";
          const entry = this.chatStore.get(editJid);
          const target = entry?.msgs.find((x) => x.id === editId);
          const newRaw = this.unwrapMessage(proto.editedMessage) ?? proto.editedMessage;
          const newText =
            newRaw?.conversation || newRaw?.extendedTextMessage?.text ||
            newRaw?.imageMessage?.caption || newRaw?.videoMessage?.caption || "";
          if (target && newText) {
            target.text = newText;
            target.edited = true;
            this.notifyPersist(editJid, target, true);
          }
          continue;
        }
        // Emoji reaction — its own message type, never stored as a chat row;
        // it targets an existing message by id.
        const reactionMsg = (msg.message as any)?.reactionMessage;
        if (reactionMsg?.key?.id) {
          const targetJid: string = msg.key?.remoteJid ?? reactionMsg.key.remoteJid ?? "";
          const reactorJid: string = msg.key?.participant ?? msg.key?.remoteJid ?? "";
          if (targetJid && reactorJid) {
            this.notifyReaction(targetJid, reactionMsg.key.id, reactorJid, String(reactionMsg.text ?? ""), Date.now());
          }
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
        this.ensureAvatar(jid);
        this.ensureRealPhone(jid);
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
        this.ensureAvatar(jid);
        this.ensureRealPhone(jid);
        if (!chatMsg.fromMe) {
          this.incomingKeys.set(chatMsg.id, { remoteJid: jid, id: chatMsg.id, fromMe: false });
        }
      }
      // Apply chat titles even for chats with no synced messages yet.
      for (const [jid, name] of nameByJid) this.applyName(jid, name, 1);
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

    // The real "saved contact name" source. `contacts.upsert` delivers the full
    // phonebook-synced contact list once after linking; `contacts.update` streams
    // incremental changes afterwards (a contact gets renamed, a business gets
    // verified, etc). `name` is the name saved in the linked phone's contacts;
    // `verifiedName` is WhatsApp's own verified business name. Either is a real
    // identity — unlike pushName, which is just the sender's own self-set label
    // and is never treated as a contact name here.
    const applyContact = (ct: any) => {
      const jid: string | undefined = ct?.id;
      const name = ct?.name || ct?.verifiedName;
      if (jid && name) this.applyName(jid, String(name), 2);
    };
    sock.ev.on("contacts.upsert", (contacts: any[]) => { for (const ct of contacts) applyContact(ct); });
    sock.ev.on("contacts.update", (updates: any[]) => { for (const ct of updates) applyContact(ct); });

    // WhatsApp learning (or telling us) a LID↔real-number mapping — catches a
    // resolution as soon as it's available, without waiting for the next
    // message in that chat to trigger ensureRealPhone's lookup.
    sock.ev.on("lid-mapping.update", (mapping: any) => {
      if (!mapping?.lid || !mapping?.pn) return;
      const phone = String(mapping.pn).split(":")[0].split("@")[0];
      this.lidPhoneFetched.add(mapping.lid);
      const entry = this.chatStore.get(mapping.lid);
      if (entry && entry.meta.phone !== phone) {
        entry.meta.phone = phone;
        const last = entry.msgs[entry.msgs.length - 1];
        if (last) this.notifyPersist(mapping.lid, last, true);
      }
    });

    // Online / typing / recording status for a chat we've subscribed to.
    sock.ev.on("presence.update", ({ id, presences }: any) => {
      const entry = presences?.[id] ?? Object.values(presences ?? {})[0];
      if (!entry) return;
      const presence = entry.lastKnownPresence ?? "unavailable";
      const lastSeen = entry.lastSeen ? entry.lastSeen * 1000 : undefined;
      this.notifyPresence(id, presence, lastSeen);
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
    // Only bother checking brand-new chats — an existing one is already a
    // proven WhatsApp number, so skip the extra round-trip on every reply.
    if (!this.chatStore.has(jid)) {
      const results = (await this.sock.onWhatsApp(jid).catch(() => undefined)) ?? [];
      const check = results[0];
      if (check && !check.exists) throw new Error("Ye number WhatsApp par registered nahi hai.");
    }
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
  private globalReactionListeners: Set<ReactionListener> = new Set();
  private globalPresenceListeners: Set<PresenceListener> = new Set();

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

  /** Subscribe to emoji reactions across all sessions. */
  addReactionListener(fn: ReactionListener) {
    this.globalReactionListeners.add(fn);
    return () => this.globalReactionListeners.delete(fn);
  }

  /** Subscribe to presence (online/typing) changes across all sessions. */
  addPresenceListener(fn: PresenceListener) {
    this.globalPresenceListeners.add(fn);
    return () => this.globalPresenceListeners.delete(fn);
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
      sess.addPersistListener((uid, jid, phone, msg, history, name, avatarUrl) => {
        for (const fn of this.globalPersistListeners) { try { fn(uid, jid, phone, msg, history, name, avatarUrl); } catch {} }
      });
      sess.addDeleteListener((uid, waMessageId) => {
        for (const fn of this.globalDeleteListeners) { try { fn(uid, waMessageId); } catch {} }
      });
      sess.addCallListener((uid, call) => {
        for (const fn of this.globalCallListeners) { try { fn(uid, call); } catch {} }
      });
      sess.addReactionListener((uid, jid, waMessageId, reactorJid, emoji, ts) => {
        for (const fn of this.globalReactionListeners) { try { fn(uid, jid, waMessageId, reactorJid, emoji, ts); } catch {} }
      });
      sess.addPresenceListener((uid, jid, presence, lastSeen) => {
        for (const fn of this.globalPresenceListeners) { try { fn(uid, jid, presence, lastSeen); } catch {} }
      });
      this.sessions.set(userId, sess);
    }
    return this.sessions.get(userId)!;
  }

  getState(userId: number): UserWAState { return this.getSession(userId).state; }
  getSessionInfo(userId: number) { return this.getSession(userId).getSessionInfo(); }
  resolveLidPhones(userId: number, lids: string[]) { return this.getSession(userId).resolveLidPhones(lids); }
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
  sendToJid(userId: number, jid: string, text: string, quoted?: { waMessageId: string; fromMe: boolean; text: string }) {
    return this.getSession(userId).sendToJid(jid, text, quoted);
  }
  getChatList(userId: number) { return this.getSession(userId).getChatList(); }
  getChatMessages(userId: number, jid: string) { return this.getSession(userId).getChatMessages(jid); }
  markRead(userId: number, jid: string) { this.getSession(userId).markRead(jid); }
  markIncomingRead(userId: number, ids: string[]) { return this.getSession(userId).markIncomingRead(ids); }
  deleteForEveryone(userId: number, jid: string, msgId: string, fromMe: boolean) { return this.getSession(userId).deleteForEveryone(jid, msgId, fromMe); }
  sendReaction(userId: number, jid: string, targetId: string, targetFromMe: boolean, emoji: string, targetParticipant?: string) {
    return this.getSession(userId).sendReaction(jid, targetId, targetFromMe, emoji, targetParticipant);
  }
  sendMedia(
    userId: number, jid: string, buffer: Buffer, mimeType: string, kind: "image" | "video" | "audio" | "document",
    opts?: { caption?: string; fileName?: string; viewOnce?: boolean; quoted?: { waMessageId: string; fromMe: boolean; text: string } },
  ) {
    return this.getSession(userId).sendMedia(jid, buffer, mimeType, kind, opts);
  }
  forwardMessage(
    userId: number, toJid: string,
    source: { text: string; media?: string; mediaMime?: string; mediaKind?: string | null; fileName?: string | null },
  ) {
    return this.getSession(userId).forwardMessage(toJid, source);
  }
  getGroupInfo(userId: number, jid: string) { return this.getSession(userId).getGroupInfo(jid); }
  updateGroupParticipants(userId: number, jid: string, participantJids: string[], action: "add" | "remove" | "promote" | "demote") {
    return this.getSession(userId).updateGroupParticipants(jid, participantJids, action);
  }
  updateGroupSubject(userId: number, jid: string, subject: string) { return this.getSession(userId).updateGroupSubject(jid, subject); }
  updateGroupDescription(userId: number, jid: string, description: string) { return this.getSession(userId).updateGroupDescription(jid, description); }
  updateGroupIcon(userId: number, jid: string, buffer: Buffer) { return this.getSession(userId).updateGroupIcon(jid, buffer); }
  getGroupInviteCode(userId: number, jid: string) { return this.getSession(userId).getGroupInviteCode(jid); }
  revokeGroupInviteCode(userId: number, jid: string) { return this.getSession(userId).revokeGroupInviteCode(jid); }
  leaveGroup(userId: number, jid: string) { return this.getSession(userId).leaveGroup(jid); }
  subscribePresence(userId: number, jid: string) { return this.getSession(userId).subscribePresence(jid); }
  setTyping(userId: number, jid: string, composing: boolean) { return this.getSession(userId).setTyping(jid, composing); }
  getPresence(userId: number, jid: string) { return this.getSession(userId).getPresence(jid); }
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
