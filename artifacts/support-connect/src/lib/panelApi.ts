const API = "/api";

const PANEL_TOKEN_KEY = "wa_panel_token";
const ADMIN_TOKEN_KEY = "wa_admin_token";

export const panelAuth = {
  get: () => localStorage.getItem(PANEL_TOKEN_KEY),
  set: (t: string) => localStorage.setItem(PANEL_TOKEN_KEY, t),
  clear: () => localStorage.removeItem(PANEL_TOKEN_KEY),
};

export const adminAuth = {
  get: () => localStorage.getItem(ADMIN_TOKEN_KEY),
  set: (t: string) => localStorage.setItem(ADMIN_TOKEN_KEY, t),
  clear: () => localStorage.removeItem(ADMIN_TOKEN_KEY),
};

function headers(token: string | null): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function handle(res: Response) {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── Panel (user) client ───────────────────────────────────────────
export const panel = {
  get: (url: string) => fetch(`${API}${url}`, { headers: headers(panelAuth.get()) }).then(handle),
  post: (url: string, body?: object) =>
    fetch(`${API}${url}`, { method: "POST", headers: headers(panelAuth.get()), body: body ? JSON.stringify(body) : undefined }).then(handle),
  put: (url: string, body?: object) =>
    fetch(`${API}${url}`, { method: "PUT", headers: headers(panelAuth.get()), body: body ? JSON.stringify(body) : undefined }).then(handle),
  del: (url: string) => fetch(`${API}${url}`, { method: "DELETE", headers: headers(panelAuth.get()) }).then(handle),
  raw: (url: string) => fetch(`${API}${url}`, { headers: headers(panelAuth.get()) }),
  /** Multipart upload (outgoing media / group icon) — no Content-Type header,
   *  the browser sets the multipart boundary itself. */
  postForm: (url: string, form: FormData) => {
    const token = panelAuth.get();
    return fetch(`${API}${url}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    }).then(handle);
  },
  mediaUrl: (msgId: string) =>
    `${API}/panel/media/${encodeURIComponent(msgId)}?t=${encodeURIComponent(panelAuth.get() ?? "")}`,
  eventsUrl: () =>
    `${API}/panel/events?t=${encodeURIComponent(panelAuth.get() ?? "")}`,
};

// ── Admin client ──────────────────────────────────────────────────
export const admin = {
  get: (url: string) => fetch(`${API}${url}`, { headers: headers(adminAuth.get()) }).then(handle),
  post: (url: string, body?: object) =>
    fetch(`${API}${url}`, { method: "POST", headers: headers(adminAuth.get()), body: body ? JSON.stringify(body) : undefined }).then(handle),
  put: (url: string, body?: object) =>
    fetch(`${API}${url}`, { method: "PUT", headers: headers(adminAuth.get()), body: body ? JSON.stringify(body) : undefined }).then(handle),
  del: (url: string) => fetch(`${API}${url}`, { method: "DELETE", headers: headers(adminAuth.get()) }).then(handle),
  raw: (url: string) => fetch(`${API}${url}`, { headers: headers(adminAuth.get()) }),
  mediaUrl: (msgId: string) =>
    `${API}/admin-panel/media/${encodeURIComponent(msgId)}?t=${encodeURIComponent(adminAuth.get() ?? "")}`,
};

// ── Shared types ──────────────────────────────────────────────────
export type WAStatus = "disconnected" | "connecting" | "qr_ready" | "pairing" | "connected";

export interface WAState {
  userId?: number;
  status: WAStatus;
  qr: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

export interface WAChat {
  jid: string;
  phone: string;
  name: string | null;
  lastMsg: string;
  lastMsgTs: number;
  unread: number;
  updatedAt: string;
  accountPhone: string | null;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  avatarUrl: string | null;
}

export interface WAAccount {
  phone: string;
  name: string | null;
  firstConnectedAt: string;
  lastConnectedAt: string;
  connectCount: number;
  chatCount: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  byMe: boolean;
}

export interface WAMessage {
  id: number;
  waMessageId: string;
  jid: string;
  text: string;
  fromMe: boolean;
  ts: number;
  status: number;
  deleted: boolean;
  deletedAt: string | null;
  quotedText: string | null;
  quotedId: string | null;
  mediaKind: string | null; // image | video | audio | sticker | document
  mediaMime: string | null;
  fileName: string | null;
  hasMedia: boolean;
  participant: string | null; // group sender's jid — null for 1:1 chats
  starred: boolean;
  edited: boolean;
  viewOnce: boolean;
  ephemeral: boolean;
  linkPreviewUrl: string | null;
  linkPreviewTitle: string | null;
  linkPreviewDescription: string | null;
  linkPreviewThumb: string | null;
  reactions: MessageReaction[];
}

export interface WACallLog {
  id: number;
  callId: string;
  jid: string;
  phone: string;
  name: string | null;
  accountPhone: string | null;
  outgoing: boolean;
  isVideo: boolean;
  isGroup: boolean;
  outcome: "incoming" | "missed" | "rejected" | "accepted" | "ongoing" | "unknown";
  rawStatus: string | null;
  ts: number;
  durationSec: number | null;
  avatarUrl: string | null;
}

export interface StatusItem {
  waMessageId: string;
  text: string;
  ts: number;
  deleted: boolean;
  mediaMime: string | null;
  mediaKind: string | null;
  fileName: string | null;
  hasMedia: boolean;
}

export interface StatusGroup {
  participant: string;
  phone: string;
  name: string | null;
  avatarUrl: string | null;
  latestTs: number;
  count: number;
  items: StatusItem[];
}

export interface AppLog {
  id: number;
  level: string;
  source: string;
  message: string;
  createdAt: string;
}

export interface BackupMeta {
  id: number;
  filename: string;
  sizeBytes: number;
  chatCount: number;
  messageCount: number;
  note?: string | null;
  createdAt: string;
}

export interface GroupParticipant {
  jid: string;
  admin: "admin" | "superadmin" | null;
  name?: string;
  phone?: string;
}

export interface GroupInfo {
  id: string;
  subject: string;
  description: string | null;
  owner: string | null;
  participants: GroupParticipant[];
}

export interface SessionInfo {
  userId: number;
  status: WAStatus;
  phoneNumber: string | null;
  connectedAt: string | null;
  lastError: string | null;
  hasCredentials: boolean;
  credentialsUpdatedAt: string | null;
  sessionDir: string;
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function fmtClock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function phoneFromJid(jid: string) {
  return "+" + jid.split("@")[0];
}

/** Format a raw phone number for display: digits with a leading "+". */
export function formatPhone(phone: string | null | undefined) {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : (phone || "Unknown");
}

/** WhatsApp-Web-style label: the saved contact name if we have one, otherwise
 *  the phone number itself (never a placeholder like "••••••" — a real number
 *  is what WhatsApp Web shows for a contact you haven't saved). */
export function displayName(name: string | null | undefined, phone: string | null | undefined) {
  return name && name.trim() ? name : formatPhone(phone);
}

/** WhatsApp-Web-style contact search: matches the saved name OR the raw phone
 *  number, even when a name is shown instead of the number in the list.
 *  Typing a local number without the leading "0" (or with it) still matches
 *  the stored international-format number, the same way WhatsApp Web's
 *  search box resolves a locally-typed number against a saved contact. */
export function matchesContactSearch(
  name: string | null | undefined,
  phone: string | null | undefined,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if ((name ?? "").toLowerCase().includes(q)) return true;
  const phoneDigits = (phone ?? "").replace(/\D/g, "");
  const qDigits = q.replace(/\D/g, "");
  if (!phoneDigits || !qDigits) return false;
  if (phoneDigits.includes(qDigits)) return true;
  // A locally-typed number often carries a leading 0 the stored
  // international-format number doesn't (e.g. "0300…" vs "9230…").
  return qDigits.startsWith("0") && phoneDigits.includes(qDigits.slice(1));
}
