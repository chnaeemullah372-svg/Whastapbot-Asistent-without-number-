import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import {
  panel, panelAuth, fmtTime, fmtClock, phoneFromJid,
  type WAChat, type WAMessage, type WAStatus,
} from "@/lib/panelApi";
import {
  Search, Send, ChevronLeft, Check, CheckCheck, Trash2,
  MessageSquarePlus, X, Loader2, MoreVertical, Circle,
} from "lucide-react";

const PLACEHOLDER_RE = /^(📷|📹|🎵|📄|🩷|📎)/;

/** Render the real photo / voice note / video / document for a message. */
function MediaContent({ msg }: { msg: WAMessage }) {
  if (!msg.hasMedia) {
    return <span className="whitespace-pre-wrap break-words">{msg.text}</span>;
  }
  const url = panel.mediaUrl(msg.waMessageId);
  if (msg.mediaKind === "image" || msg.mediaKind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt=""
          loading="lazy"
          className={msg.mediaKind === "sticker" ? "max-w-[140px]" : "rounded-md max-w-full max-h-72 object-cover"}
        />
      </a>
    );
  }
  if (msg.mediaKind === "video") {
    return <video src={url} controls className="rounded-md max-w-full max-h-72" />;
  }
  if (msg.mediaKind === "audio") {
    return <audio src={url} controls className="max-w-[230px]" />;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline break-all">
      📄 {msg.fileName || "Document"}
    </a>
  );
}

const STATUS_LABEL: Record<WAStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  qr_ready: "Scan QR to connect",
  pairing: "Enter pairing code",
  connected: "Connected",
};

export default function Chats() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [chats, setChats] = useState<WAChat[]>([]);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [waStatus, setWaStatus] = useState<WAStatus>("disconnected");
  const [connChecked, setConnChecked] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);

  // A genuine 401 means the token was invalidated (e.g. password changed) — log
  // out. Any other failure (server restart, network blip) is transient: keep the
  // session so the user is NEVER logged out while their authorization is valid.
  const handleAuthError = useCallback((err: any) => {
    if (err?.status === 401) {
      panelAuth.clear();
      navigate("/login");
    }
  }, [navigate]);

  const loadChats = useCallback(() => {
    panel.get("/panel/chats").then((r) => setChats(r || [])).catch(handleAuthError);
  }, [handleAuthError]);

  const loadStatus = useCallback(() => {
    panel.get("/panel/wa/status")
      .then((r) => { setWaStatus(r.status); setConnChecked(true); })
      .catch(handleAuthError);
  }, [handleAuthError]);

  // A counter bumped on every realtime event; the open Conversation watches it
  // and reloads instantly so a new/deleted message shows without waiting on poll.
  const [liveTick, setLiveTick] = useState(0);

  useEffect(() => {
    if (!user) return;
    loadChats();
    loadStatus();
    // Polling stays as a safety net (much slower now); SSE drives instant updates.
    const t = setInterval(() => {
      loadChats();
      loadStatus();
    }, 15000);
    return () => clearInterval(t);
  }, [user, loadChats, loadStatus]);

  // INSTANT UPDATES: subscribe to the server's event stream. Any new message,
  // deletion, or connection-state change refreshes the inbox immediately. The
  // browser auto-reconnects the EventSource if the connection drops.
  useEffect(() => {
    if (!user) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        loadChats();
        setLiveTick((n) => n + 1);
      }, 250);
    };
    const es = new EventSource(panel.eventsUrl());
    es.addEventListener("message", bump);
    es.addEventListener("delete", bump);
    es.addEventListener("state", () => loadStatus());
    return () => {
      if (debounce) clearTimeout(debounce);
      es.close();
    };
  }, [user, loadChats, loadStatus]);

  // Connect-first (WhatsApp-Web style): until WhatsApp is linked, send the user
  // to the Connect screen. Once linked, Connect sends them back here. We wait for
  // the first real status check (connChecked) to avoid a flash, and never yank
  // the user out of an open conversation.
  useEffect(() => {
    if (!user || !connChecked || activeJid) return;
    if (waStatus !== "connected") navigate("/connect");
  }, [user, connChecked, waStatus, activeJid, navigate]);

  // Make the device/browser BACK button (and the in-app ◀) return to the chat
  // list instead of leaving the panel. We push a history entry when a chat opens
  // and close the chat on popstate.
  useEffect(() => {
    if (!activeJid) return;
    window.history.pushState({ scChat: activeJid }, "");
    const onPop = () => {
      setActiveJid(null);
      loadChats();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [activeJid, loadChats]);

  const filtered = chats.filter(
    (c) =>
      (c.name || "").toLowerCase().includes(search.toLowerCase()) ||
      c.phone.includes(search),
  );

  if (activeJid) {
    return (
      <Conversation
        jid={activeJid}
        chat={chats.find((c) => c.jid === activeJid)}
        liveTick={liveTick}
        onBack={() => {
          // Prefer unwinding the history entry we pushed (so the device back
          // button and this ◀ stay in sync). If for any reason it isn't there,
          // close directly so the button ALWAYS returns to the chat list.
          if (window.history.state?.scChat) window.history.back();
          else {
            setActiveJid(null);
            loadChats();
          }
        }}
      />
    );
  }

  return (
    <Shell title="Chats">
      <div className="flex flex-col h-full">
        {/* Connection banner */}
        {waStatus !== "connected" && (
          <button
            onClick={() => navigate("/connect")}
            className="flex items-center gap-2 px-4 py-2 text-xs bg-accent text-accent-foreground border-b border-border"
          >
            <Circle className="w-2.5 h-2.5 fill-yellow-500 text-yellow-500" />
            {STATUS_LABEL[waStatus]} — tap to connect WhatsApp
          </button>
        )}

        {/* Search */}
        <div className="p-3 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search or start new chat"
              className="w-full rounded-full bg-card border border-border pl-10 pr-4 py-2.5 text-sm outline-none focus:border-primary transition"
            />
          </div>
        </div>

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto wa-scroll">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <MessageSquarePlus className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No chats yet.</p>
              <p className="text-xs mt-1">Start a new conversation with the button below.</p>
            </div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.jid}
                onClick={() => setActiveJid(c.jid)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition text-left border-b border-border/40"
              >
                <div className="w-12 h-12 rounded-full bg-primary/20 text-primary flex items-center justify-center font-semibold text-lg shrink-0">
                  {(c.name || c.phone).charAt(c.name ? 0 : 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{c.name || c.phone}</span>
                    <span className={`text-xs shrink-0 ${c.unread ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                      {fmtTime(c.lastMsgTs)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className="text-sm text-muted-foreground truncate">{c.lastMsg}</span>
                    {c.unread > 0 && (
                      <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center">
                        {c.unread}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* New chat FAB */}
        <button
          onClick={() => setNewChatOpen(true)}
          className="absolute bottom-6 right-6 w-14 h-14 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/30 active:scale-95 transition"
        >
          <MessageSquarePlus className="w-6 h-6" />
        </button>
      </div>

      {newChatOpen && (
        <NewChatSheet
          onClose={() => setNewChatOpen(false)}
          onStart={(jid) => {
            setNewChatOpen(false);
            setActiveJid(jid);
          }}
        />
      )}
    </Shell>
  );
}

function NewChatSheet({ onClose, onStart }: { onClose: () => void; onStart: (jid: string) => void }) {
  const [phone, setPhone] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const clean = phone.replace(/[^0-9]/g, "");
    if (clean.length < 8) {
      setError("Enter a valid number with country code");
      return;
    }
    setBusy(true);
    try {
      await panel.post("/panel/send", { phone: clean, text: text || "Hello" });
      onStart(`${clean}@s.whatsapp.net`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center max-w-md mx-auto">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <form onSubmit={start} className="relative w-full bg-card rounded-t-2xl p-5 space-y-4 animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">New Chat</h3>
          <button type="button" onClick={onClose}><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div>
          <label className="text-xs text-muted-foreground">Phone number (with country code)</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 923001234567"
            inputMode="tel"
            className="mt-1 w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">First message</label>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message"
            className="mt-1 w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
          />
        </div>
        <button
          disabled={busy}
          className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Start Chat
        </button>
      </form>
    </div>
  );
}

function Conversation({ jid, chat, liveTick, onBack }: { jid: string; chat?: WAChat; liveTick: number; onBack: () => void }) {
  const [messages, setMessages] = useState<WAMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const phone = phoneFromJid(jid);
  const title = chat?.name || phone;

  const load = useCallback(() => {
    panel.get(`/panel/chats/${encodeURIComponent(jid)}/messages`)
      .then((r) => setMessages(r || []))
      .catch(() => {});
  }, [jid]);

  useEffect(() => {
    load();
    panel.post(`/panel/chats/${encodeURIComponent(jid)}/read`).catch(() => {});
    // Slow poll as a safety net; the live event below drives instant refresh.
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load, jid]);

  // INSTANT UPDATES: reload this conversation the moment the parent receives a
  // realtime event (new/deleted message) so the open chat updates without delay.
  useEffect(() => {
    if (liveTick > 0) load();
  }, [liveTick, load]);

  // Opening a different chat must re-jump to its newest message.
  useEffect(() => {
    didInitialScroll.current = false;
  }, [jid]);

  // Keep the newest message in view like WhatsApp: always land at the bottom when
  // the chat first opens, and on later poll updates only auto-scroll if the user
  // is already near the bottom — so scrolling up to read old messages is never
  // interrupted by the 3s refresh.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (!didInitialScroll.current || nearBottom) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      didInitialScroll.current = true;
    }
  }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    setText("");
    try {
      await panel.post("/panel/send", { phone: phone.replace("+", ""), text: body });
      load();
    } catch {
      setText(body);
    } finally {
      setSending(false);
    }
  }

  async function del(msg: WAMessage) {
    setMenuFor(null);
    try {
      await panel.del(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}`);
      load();
    } catch {}
  }

  return (
    <div className="h-[100dvh] bg-background flex flex-col max-w-md mx-auto">
      {/* Conversation header — sidebar hidden, back button shown */}
      <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
        <button onClick={onBack} className="p-1">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center font-semibold shrink-0">
          {title.charAt(chat?.name ? 0 : 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-tight truncate">{title}</p>
          <p className="text-xs text-white/70 truncate">{phone}</p>
        </div>
        <MoreVertical className="w-5 h-5" />
      </header>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto wa-scroll wa-chat-bg px-3 py-4 space-y-1.5">
        {messages.map((m) => (
          <div key={m.waMessageId} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
            <div
              onClick={() => m.fromMe && !m.deleted && setMenuFor(menuFor === m.waMessageId ? null : m.waMessageId)}
              className={`relative max-w-[78%] rounded-lg px-3 py-1.5 text-sm shadow-sm ${
                m.fromMe ? "bg-wa-bubble-out text-foreground rounded-tr-none" : "bg-wa-bubble-in text-foreground rounded-tl-none"
              }`}
            >
              {m.deleted ? (
                <span className="italic text-muted-foreground text-xs">🚫 This message was deleted</span>
              ) : (
                <>
                  {m.quotedText && (
                    <div className="mb-1 border-l-2 border-primary pl-2 text-xs text-muted-foreground line-clamp-2">
                      {m.quotedText}
                    </div>
                  )}
                  {m.mediaKind ? (
                    <div className="space-y-1">
                      <MediaContent msg={m} />
                      {!PLACEHOLDER_RE.test(m.text) && (
                        <span className="whitespace-pre-wrap break-words block">{m.text}</span>
                      )}
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap break-words">{m.text}</span>
                  )}
                </>
              )}
              <span className="float-right ml-2 mt-1 flex items-center gap-0.5 text-[10px] text-muted-foreground translate-y-0.5">
                {fmtClock(m.ts)}
                {m.fromMe && !m.deleted && (
                  m.status >= 3 ? <CheckCheck className="w-3.5 h-3.5 text-sky-400" /> :
                  m.status === 2 ? <CheckCheck className="w-3.5 h-3.5" /> :
                  <Check className="w-3.5 h-3.5" />
                )}
              </span>
              {menuFor === m.waMessageId && (
                <button
                  onClick={() => del(m)}
                  className="absolute -top-2 right-0 translate-y-[-100%] flex items-center gap-1.5 bg-popover border border-border rounded-lg px-3 py-1.5 text-xs text-destructive shadow-lg z-10"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              )}
            </div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground mt-10">
            No messages yet. Say hello 👋
          </div>
        )}
      </div>

      {/* Composer */}
      <form onSubmit={send} className="flex items-center gap-2 p-2 bg-wa-panel shrink-0 border-t border-border">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message"
          className="flex-1 rounded-full bg-background border border-border px-4 py-2.5 text-sm outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-50 active:scale-95 transition"
        >
          {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
        </button>
      </form>
    </div>
  );
}
