import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
  type ConnectionState,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import pino from "pino";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = path.join(__dirname, "../../.whatsapp-session");

const silentLogger = pino({ level: "silent" });

// ─── In-memory debug log (last 300 lines) ───────────────────────────────────
const debugLog: { t: string; msg: string }[] = [];
export function getDebugLog() { return [...debugLog]; }
export function clearDebugLog() { debugLog.length = 0; }
function dbg(msg: string) {
  const entry = { t: new Date().toISOString().slice(11, 23), msg };
  debugLog.push(entry);
  if (debugLog.length > 300) debugLog.shift();
  // eslint-disable-next-line no-console
  console.log(`[WA-DBG] ${entry.t}  ${msg}`);
}

let cachedVersion: [number, number, number] | null = null;
async function getWAVersion(): Promise<[number, number, number]> {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = version;
    dbg(`WA version: ${version.join(".")}`);
    return version;
  } catch (e: any) {
    dbg(`Version fetch failed (${e?.message}), fallback 2.2413.51`);
    return [2, 2413, 51];
  }
}

export type WAStatus =
  | "disconnected"
  | "connecting"
  | "qr_ready"
  | "pairing"
  | "connected";

export interface WAState {
  status: WAStatus;
  qr: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  lastError: string | null;
  connectedAt: string | null;
  phoneNumber: string | null;
}

type SSEListener = (event: string, data: unknown) => void;

export interface LegacyIncomingMsg {
  waMessageId: string;
  text: string;
  senderPhone: string;
  quotedWaId?: string;
  quotedText?: string;
  ts: number;
}

export interface LegacyStatusUpdate {
  waMessageId: string;
  status: number;
}

class WhatsAppService {
  private sock: WASocket | null = null;
  private state: WAState = {
    status: "disconnected",
    qr: null,
    pairingCode: null,
    pairingPhone: null,
    lastError: null,
    connectedAt: null,
    phoneNumber: null,
  };
  private listeners: Set<SSEListener> = new Set();
  private messageListeners: Set<(msg: LegacyIncomingMsg) => void> = new Set();
  private statusListeners: Set<(update: LegacyStatusUpdate) => void> = new Set();
  /** Map msgId → remoteJid for read receipts */
  private incomingKeys = new Map<string, string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pairingTimer: ReturnType<typeof setTimeout> | null = null;

  // Pairing state — cleared after successful reconnect
  private pairingPhone: string | null = null;
  private didPair = false;

  addListener(fn: SSEListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  addMessageListener(fn: (msg: LegacyIncomingMsg) => void) {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  addStatusListener(fn: (update: LegacyStatusUpdate) => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private emit(event: string, data: unknown) {
    for (const fn of this.listeners) {
      try { fn(event, data); } catch {}
    }
  }

  private setState(patch: Partial<WAState>) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  getState() { return this.state; }

  private ensureSessionDir() {
    if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
  }

  private wipeSession() {
    if (fs.existsSync(SESSION_DIR)) fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    dbg("Session wiped");
  }

  private closeSocket() {
    if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) {
      try { this.sock.end(undefined); } catch {}
      this.sock = null;
    }
  }

  async connectQR() {
    dbg("connectQR called");
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    this.ensureSessionDir();
    this.setState({ status: "connecting", qr: null, pairingCode: null, pairingPhone: null, lastError: null });
    await this._boot(false, "");
  }

  async connectPhone(phone: string) {
    const cleanPhone = phone.replace(/\D/g, "");
    clearDebugLog();
    dbg(`connectPhone: ${cleanPhone}`);
    this.closeSocket();
    this.wipeSession();
    this.ensureSessionDir();
    this.pairingPhone = cleanPhone;
    this.didPair = false;
    this.setState({ status: "connecting", qr: null, pairingCode: null, pairingPhone: cleanPhone, lastError: null });
    await this._boot(true, cleanPhone);
  }

  // Called after pairing WS closes — reconnect with saved creds
  // Clears pairingPhone/didPair BEFORE reconnecting to prevent infinite loop
  private async reconnectSaved() {
    dbg("reconnectSaved: using saved credentials");
    this.closeSocket();
    // Clear pairing state so if this reconnect also fails, we don't loop
    this.pairingPhone = null;
    this.didPair = false;
    this.setState({ status: "connecting", qr: null, pairingCode: null, lastError: null });
    await this._boot(false, "");
  }

  private async _boot(usePairing: boolean, phone: string, pairingRetry = 0) {
    dbg(`_boot: usePairing=${usePairing} phone=${phone || "(none)"} pairingRetry=${pairingRetry}`);

    const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    dbg(`Auth: registered=${authState.creds.registered} me=${authState.creds.me?.id ?? "none"}`);

    const version = await getWAVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, silentLogger),
      },
      logger: silentLogger,
      printQRInTerminal: false,
      // macOS/Safari works better for phone pairing than ubuntu/Chrome
      browser: Browsers.macOS("Safari"),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 120_000,
      // IMPORTANT: undefined allows pairing code requests to work properly
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 20_000,
      markOnlineOnConnect: false,
      getMessage: async () => ({ conversation: "" }),
    });

    this.sock = sock;
    let codeRequested = false;

    sock.ev.on("creds.update", () => {
      dbg("creds.update → saving to disk");
      this.didPair = true;
      saveCreds();
      dbg("creds saved OK");
    });

    sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      dbg(`connection.update: connection=${connection ?? "?"} statusCode=${statusCode ?? "?"} didPair=${this.didPair}`);

      // QR code for QR-based linking
      if (qr && !usePairing) {
        dbg("QR received");
        this.setState({ status: "qr_ready", qr });
      }

      // Request pairing code — first update event + 5s delay (more reliable than 3.5s)
      if (usePairing && phone && !codeRequested && connection !== "close") {
        codeRequested = true;
        dbg(`Scheduling pairing code for ${phone} in 5s...`);
        this.pairingTimer = setTimeout(async () => {
          if (this.sock !== sock) { dbg("sock changed, skip pairing"); return; }
          try {
            dbg(`requestPairingCode(${phone}) →`);
            const code = await sock.requestPairingCode(phone);
            const display = code.replace(/(.{4})(.{4})/, "$1-$2");
            dbg(`code received: ${display}`);
            this.setState({ status: "pairing", pairingCode: display, pairingPhone: phone, qr: null });
          } catch (e: any) {
            dbg(`requestPairingCode FAILED: ${e?.message}`);
            this.setState({
              status: "disconnected",
              lastError: `Pairing code nahi mila: ${e?.message ?? "unknown"}`,
            });
          }
        }, 5000);
      }

      if (connection === "open") {
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }
        const jid = sock.user?.id ?? null;
        const phoneNumber = jid ? jid.split(":")[0].split("@")[0] : null;
        dbg(`CONNECTION OPEN! jid=${jid} phone=+${phoneNumber}`);
        this.setState({
          status: "connected",
          qr: null,
          pairingCode: null,
          connectedAt: new Date().toISOString(),
          phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
          lastError: null,
        });
      }

      if (connection === "close") {
        // Ignore close events from stale sockets (e.g. old QR socket killed by closeSocket)
        if (this.sock !== sock) return;
        if (this.pairingTimer) { clearTimeout(this.pairingTimer); this.pairingTimer = null; }

        const isLoggedOut =
          statusCode === DisconnectReason.loggedOut ||
          statusCode === DisconnectReason.badSession;

        if (isLoggedOut) {
          dbg("Logged out — wiping session");
          this.wipeSession();
          this.pairingPhone = null;
          this.didPair = false;
          this.setState({
            status: "disconnected",
            lastError: "Logged out — dobara link karein.",
            connectedAt: null,
            phoneNumber: null,
          });
          return;
        }

        // 440 = ConnectionReplaced — another WA session (e.g. production server) is
        // already using this phone. Reconnecting would just kick THEM and create an
        // infinite battle. Show error and stop.
        if (statusCode === 440) {
          dbg("statusCode=440 (Connection Replaced) — stopping reconnect to avoid loop");
          this.setState({
            status: "disconnected",
            lastError: "Session kisi aur jagah open hai (440). Admin panel mein 'Fix' dabayein.",
            connectedAt: null,
            phoneNumber: null,
          });
          return;
        }

        // After pairing code accepted, WA closes the initial WS
        // We detect this by status === "pairing" OR didPair flag
        const savedPairingPhone = this.pairingPhone;
        const wasInPairing = this.state.status === "pairing" || this.didPair;
        dbg(`close: wasInPairing=${wasInPairing} savedPairingPhone=${savedPairingPhone}`);

        if (wasInPairing) {
          dbg("Pairing WS closed — reconnecting with saved creds in 3s");
          this.setState({ status: "connecting", lastError: null, pairingCode: null });
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
          dbg(`Pairing close before code — retry ${pairingRetry + 1}/3 in 2s`);
          this.setState({ status: "connecting", lastError: null });
          const snapSock = sock;
          this.reconnectTimer = setTimeout(() => {
            if (this.sock === snapSock || this.sock === null) {
              this.sock = null;
              this._boot(true, phone, pairingRetry + 1);
            }
          }, 2000);
          return;
        }

        dbg("Disconnect without pairing — staying disconnected");
        this.setState({
          status: "disconnected",
          lastError: "Connection tutgayi — thodi dair baad dobara try karein.",
          connectedAt: null,
          phoneNumber: null,
        });

        // Auto-retry QR connections (not if phone pairing is in progress)
        if (!usePairing && !this.pairingPhone) {
          this.reconnectTimer = setTimeout(() => this.connectQR(), 8_000);
        }
      }
    });

    sock.ev.on("messages.upsert", (m: BaileysEventMap["messages.upsert"]) => {
      for (const msg of m.messages) {
        if (!msg.key.fromMe && msg.message) {
          const raw = msg.message;
          const text =
            raw.conversation ||
            raw.extendedTextMessage?.text ||
            raw.imageMessage?.caption ||
            raw.videoMessage?.caption || "";
          const senderPhone = msg.key.remoteJid?.split("@")[0] ?? "";
          const msgId = msg.key.id ?? `fallback-${Date.now()}`;
          const jid = msg.key.remoteJid ?? "";

          // Extract quoted message info
          const ctxInfo = raw.extendedTextMessage?.contextInfo;
          const quotedMsg = ctxInfo?.quotedMessage;
          const quotedText = quotedMsg
            ? (quotedMsg.conversation || quotedMsg.extendedTextMessage?.text || "")
            : undefined;
          const quotedWaId = ctxInfo?.stanzaId ?? undefined;

          if (text && senderPhone) {
            // Remember key so /read endpoint can send blue-tick later
            this.incomingKeys.set(msgId, jid);
            // Do NOT call readMessages here — that would give immediate blue-tick
            // before admin actually reads the message in widget.
            for (const fn of this.messageListeners) {
              try {
                fn({
                  waMessageId: msgId,
                  text,
                  senderPhone: `+${senderPhone}`,
                  quotedWaId,
                  quotedText: quotedText || undefined,
                  ts: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
                });
              } catch {}
            }
          }
        }
      }
    });

    // Track tick status updates for bot-sent messages (delivery + read)
    sock.ev.on("messages.update", (updates: BaileysEventMap["messages.update"]) => {
      for (const update of updates) {
        if (update.key.fromMe && update.update.status != null) {
          const waMessageId = update.key.id;
          const status = update.update.status as number;
          if (waMessageId) {
            for (const fn of this.statusListeners) {
              try { fn({ waMessageId, status }); } catch {}
            }
          }
        }
      }
    });
  }

  async sendMessage(
    phone: string,
    text: string,
    quoted?: { waMessageId: string; fromMe: boolean; text: string; jid?: string },
  ): Promise<string> {
    if (!this.sock || this.state.status !== "connected") throw new Error("WhatsApp not connected");
    const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
    let opts: Record<string, unknown> = {};
    if (quoted?.waMessageId) {
      const qJid = quoted.jid ?? jid;
      opts = {
        quoted: {
          key: { remoteJid: qJid, fromMe: quoted.fromMe, id: quoted.waMessageId },
          message: { conversation: quoted.text || "" },
        },
      };
    }
    const result = await this.sock.sendMessage(jid, { text }, opts as any);
    return result?.key.id ?? `legacy-${Date.now()}`;
  }

  async markRead(phone: string, msgId: string) {
    if (!this.sock || this.state.status !== "connected") return;
    try {
      const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
      await this.sock.readMessages([{ remoteJid: jid, id: msgId }]);
    } catch {}
  }

  // Soft reconnect — try to fix disconnected state
  fix() {
    dbg("fix called");
    if (this.state.status === "connected") {
      dbg("Already connected");
      return;
    }
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    setTimeout(() => this.connectQR(), 500);
  }

  disconnect() {
    dbg("disconnect called");
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    this.setState({
      status: "disconnected",
      qr: null,
      pairingCode: null,
      lastError: "Manually disconnected",
      connectedAt: null,
    });
  }

  clearSession() {
    dbg("clearSession called");
    this.closeSocket();
    this.pairingPhone = null;
    this.didPair = false;
    this.wipeSession();
    this.setState({
      status: "disconnected",
      qr: null,
      pairingCode: null,
      lastError: "Session cleared",
      connectedAt: null,
      phoneNumber: null,
    });
  }

  freshStart() {
    this.clearSession();
    setTimeout(() => this.connectQR(), 500);
  }

  /** On server startup: reconnect if saved creds exist */
  autoReconnectSaved() {
    const credsFile = path.join(SESSION_DIR, "creds.json");
    if (!fs.existsSync(credsFile)) return;
    dbg("autoReconnectSaved: creds found, reconnecting…");
    this.connectQR().catch(() => {});
  }
}

export const whatsappService = new WhatsAppService();
