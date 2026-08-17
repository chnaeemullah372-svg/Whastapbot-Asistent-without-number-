import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { Avatar } from "@/components/avatar";
import {
  panel, panelAuth, fmtTime, fmtClock, phoneFromJid, displayName,
  type WAChat, type WAMessage, type WAStatus,
} from "@/lib/panelApi";
import {
  Search, Send, ChevronLeft, Check, CheckCheck, Trash2,
  MessageSquarePlus, X, Loader2, MoreVertical, Circle, Reply, Star,
  Paperclip, Pin, BellOff, Archive, Forward, CircleDashed, Timer, Mic, Copy,
} from "lucide-react";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

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
    // Download directly (like WhatsApp Web) instead of opening a new tab —
    // most document types (xlsx, docx…) can't render in a browser tab anyway,
    // which just leaves a confusing blank tab behind.
    <a href={url} download={msg.fileName || "document"} className="flex items-center gap-1.5 underline break-all">
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
  const [showArchived, setShowArchived] = useState(false);
  const [chatMenuFor, setChatMenuFor] = useState<string | null>(null);

  async function toggleChatFlag(jid: string, flag: "pin" | "mute" | "archive", value: boolean) {
    setChatMenuFor(null);
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${flag}`, { value });
      loadChats();
    } catch {}
  }

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
  const [presenceByJid, setPresenceByJid] = useState<Record<string, { presence: string; lastSeen?: number }>>({});

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
    // Sent/delivered/read (blue tick) changes — bump so the open conversation
    // reloads and shows the updated tick instantly instead of waiting on poll.
    es.addEventListener("status", bump);
    es.addEventListener("state", () => loadStatus());
    // Online / typing / recording status for whichever chat is subscribed.
    es.addEventListener("presence", (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setPresenceByJid((prev) => ({ ...prev, [data.jid]: { presence: data.presence, lastSeen: data.lastSeen } }));
      } catch {}
    });
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

  // Individual chats only — exclude groups (@g.us) and status broadcasts
  const individualChats = chats.filter((c) => !c.jid.endsWith("@g.us") && c.jid !== "status@broadcast");
  const archivedCount = individualChats.filter((c) => c.archived).length;
  const filtered = individualChats
    .filter((c) => (showArchived ? c.archived : !c.archived))
    .filter((c) => displayName(c.name, c.phone).toLowerCase().includes(search.toLowerCase()))
    // Pinned chats float to the top, exactly like WhatsApp; otherwise newest first.
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastMsgTs - a.lastMsgTs));

  if (activeJid) {
    return (
      <Conversation
        jid={activeJid}
        chat={chats.find((c) => c.jid === activeJid)}
        allChats={individualChats}
        presence={presenceByJid[activeJid]}
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

        {/* Archived toggle — mirrors WhatsApp's "Archived" row at the top of the list */}
        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="flex items-center gap-2 px-4 py-2.5 text-sm border-b border-border/40 hover:bg-card/60 transition"
          >
            <Archive className="w-4 h-4 text-muted-foreground" />
            {showArchived ? "Back to chats" : `Archived (${archivedCount})`}
          </button>
        )}

        {/* Chat list */}
        <div className="flex-1 overflow-y-auto wa-scroll">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <MessageSquarePlus className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">{showArchived ? "No archived chats." : "No chats yet."}</p>
              {!showArchived && <p className="text-xs mt-1">Start a new conversation with the button below.</p>}
            </div>
          ) : (
            filtered.map((c) => (
              <div key={c.jid} className="relative w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition border-b border-border/40">
                <button onClick={() => setActiveJid(c.jid)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  <Avatar url={c.avatarUrl} label={displayName(c.name, c.phone)} size={48} textClassName="text-lg" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate flex items-center gap-1">
                        {c.pinned && <Pin className="w-3 h-3 text-muted-foreground shrink-0" />}
                        {c.muted && <BellOff className="w-3 h-3 text-muted-foreground shrink-0" />}
                        {displayName(c.name, c.phone)}
                      </span>
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
                <button
                  onClick={(e) => { e.stopPropagation(); setChatMenuFor(chatMenuFor === c.jid ? null : c.jid); }}
                  className="p-1 shrink-0 text-muted-foreground"
                  aria-label="Chat options"
                >
                  <MoreVertical className="w-4 h-4" />
                </button>
                {chatMenuFor === c.jid && (
                  <div className="absolute top-10 right-4 flex flex-col bg-popover border border-border rounded-lg shadow-lg z-10 overflow-hidden min-w-[160px] text-sm">
                    <button onClick={() => toggleChatFlag(c.jid, "pin", !c.pinned)} className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                      <Pin className="w-3.5 h-3.5" /> {c.pinned ? "Unpin chat" : "Pin chat"}
                    </button>
                    <button onClick={() => toggleChatFlag(c.jid, "mute", !c.muted)} className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                      <BellOff className="w-3.5 h-3.5" /> {c.muted ? "Unmute" : "Mute notifications"}
                    </button>
                    <button onClick={() => toggleChatFlag(c.jid, "archive", !c.archived)} className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                      <Archive className="w-3.5 h-3.5" /> {c.archived ? "Unarchive" : "Archive chat"}
                    </button>
                  </div>
                )}
              </div>
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

function Conversation({
  jid, chat, allChats, presence, liveTick, onBack,
}: {
  jid: string; chat?: WAChat; allChats: WAChat[];
  presence?: { presence: string; lastSeen?: number };
  liveTick: number; onBack: () => void;
}) {
  const [messages, setMessages] = useState<WAMessage[]>([]);
  const [text, setText] = useState("");
  const wasComposing = useRef(false);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [sendError, setSendError] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<WAMessage | null>(null);
  const [forwardFor, setForwardFor] = useState<WAMessage | null>(null);
  // Swipe-to-reply: only one bubble can be mid-drag at a time, so a single
  // (id, offset) pair is enough — no per-message state needed.
  const [swipe, setSwipe] = useState<{ id: string; dx: number } | null>(null);
  const swipeStartX = useRef(0);
  const swipeDidDrag = useRef(false);
  const SWIPE_TRIGGER_PX = 56;
  const SWIPE_MAX_PX = 72;
  // Multi-select mode (WhatsApp-style): long-press a bubble to enter it,
  // tap more bubbles to add to the selection, act on all of them at once.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectMode = selected.size > 0;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justEnteredSelectMode = useRef(false);
  const suppressNextClick = useRef(false);
  const [bulkForward, setBulkForward] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const didInitialScroll = useRef(false);
  const phone = phoneFromJid(jid);
  const title = displayName(chat?.name, phone);

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
  // realtime event (new/deleted message, tick change, reaction) so the open
  // chat updates without delay.
  useEffect(() => {
    if (liveTick > 0) load();
  }, [liveTick, load]);

  // Opening a different chat must re-jump to its newest message and drop any
  // reply-to draft from the previous conversation.
  useEffect(() => {
    didInitialScroll.current = false;
    setReplyTo(null);
    setSearchOpen(false);
    setChatSearch("");
    // Never leave a recording running (or its mic stream open) behind when
    // switching chats.
    if (mediaRecorderRef.current) {
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
      setRecording(false);
    }
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
    setSendError("");
    setText("");
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    if (wasComposing.current) {
      wasComposing.current = false;
      panel.post(`/panel/chats/${encodeURIComponent(jid)}/typing`, { composing: false }).catch(() => {});
    }
    const quote = replyTo
      ? { quotedId: replyTo.waMessageId, quotedFromMe: replyTo.fromMe, quotedText: replyTo.text }
      : {};
    try {
      // Send by full jid, not a reconstructed phone number — some contacts
      // (WhatsApp's newer privacy "LID" addressing) have a jid that is NOT a
      // real phone number at all; rebuilding "<phone>@s.whatsapp.net" from
      // it would silently address the message to the wrong place.
      await panel.post("/panel/send", { jid, text: body, ...quote });
      setReplyTo(null);
      load();
    } catch (err: any) {
      setText(body);
      setSendError(err?.message || "Failed to send");
    } finally {
      setSending(false);
    }
  }

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const kind = file.type.startsWith("image/") ? "image"
      : file.type.startsWith("video/") ? "video"
      : file.type.startsWith("audio/") ? "audio" : "document";
    setSending(true);
    setSendError("");
    const form = new FormData();
    form.append("file", file);
    form.append("jid", jid);
    form.append("kind", kind);
    if (text.trim()) form.append("caption", text.trim());
    if (replyTo) {
      form.append("quotedId", replyTo.waMessageId);
      form.append("quotedFromMe", String(replyTo.fromMe));
      form.append("quotedText", replyTo.text);
    }
    try {
      await panel.postForm("/panel/send-media", form);
      setText("");
      setReplyTo(null);
      load();
    } catch (err: any) {
      setSendError(err?.message || "Failed to send file");
    } finally {
      setSending(false);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      mr.onstop = () => stream.getTracks().forEach((t) => t.stop());
      mr.start();
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setSendError("Microphone access denied or unavailable");
    }
  }

  async function stopRecording(shouldSend: boolean) {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setRecording(false);
    await new Promise<void>((resolve) => {
      mr.addEventListener("stop", () => resolve(), { once: true });
      mr.stop();
    });
    mediaRecorderRef.current = null;
    const chunks = recordChunksRef.current;
    recordChunksRef.current = [];
    if (!shouldSend || chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
    setSending(true);
    setSendError("");
    const form = new FormData();
    form.append("file", blob, "voice-note.webm");
    form.append("jid", jid);
    form.append("kind", "audio");
    if (replyTo) {
      form.append("quotedId", replyTo.waMessageId);
      form.append("quotedFromMe", String(replyTo.fromMe));
      form.append("quotedText", replyTo.text);
    }
    try {
      await panel.postForm("/panel/send-media", form);
      setReplyTo(null);
      load();
    } catch (err: any) {
      setSendError(err?.message || "Failed to send voice message");
    } finally {
      setSending(false);
    }
  }

  // Tell WhatsApp we're composing a reply (debounced) — real WhatsApp Web
  // sends this as you type and "paused" a moment after you stop.
  function onTypingChange(value: string) {
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    if (value.trim() && !wasComposing.current) {
      wasComposing.current = true;
      panel.post(`/panel/chats/${encodeURIComponent(jid)}/typing`, { composing: true }).catch(() => {});
    }
    typingTimeout.current = setTimeout(() => {
      wasComposing.current = false;
      panel.post(`/panel/chats/${encodeURIComponent(jid)}/typing`, { composing: false }).catch(() => {});
    }, 3000);
  }

  // Stop signalling "typing" the moment we leave this chat.
  useEffect(() => {
    return () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (wasComposing.current) {
        wasComposing.current = false;
        panel.post(`/panel/chats/${encodeURIComponent(jid)}/typing`, { composing: false }).catch(() => {});
      }
    };
  }, [jid]);

  async function del(msg: WAMessage) {
    setMenuFor(null);
    try {
      await panel.del(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}`);
      load();
    } catch {}
  }

  async function hideForMe(msg: WAMessage) {
    setMenuFor(null);
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}/hide`);
      load();
    } catch {}
  }

  async function toggleStar(msg: WAMessage) {
    setMenuFor(null);
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}/star`, { starred: !msg.starred });
      load();
    } catch {}
  }

  async function react(msg: WAMessage, emoji: string) {
    setMenuFor(null);
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(msg.waMessageId)}/react`, {
        emoji, fromMe: msg.fromMe,
      });
      load();
    } catch {}
  }

  function toggleSelect(msg: WAMessage) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(msg.waMessageId)) next.delete(msg.waMessageId);
      else next.add(msg.waMessageId);
      return next;
    });
  }
  function cancelSelect() { setSelected(new Set()); }

  // WhatsApp-style swipe-to-reply (drag right past a threshold) + long-press
  // to enter multi-select — both live on the same bubble pointer handlers so
  // they can tell a drag, a tap, and a hold apart.
  function onBubblePointerDown(e: React.PointerEvent, msg: WAMessage) {
    if (msg.deleted) return;
    swipeStartX.current = e.clientX;
    swipeDidDrag.current = false;
    if (!selectMode) setSwipe({ id: msg.waMessageId, dx: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (!selectMode) {
      longPressTimer.current = setTimeout(() => {
        justEnteredSelectMode.current = true;
        setSwipe(null);
        toggleSelect(msg);
      }, 450);
    }
  }
  function onBubblePointerMove(e: React.PointerEvent, msg: WAMessage) {
    const raw = e.clientX - swipeStartX.current;
    if (Math.abs(raw) > 4) {
      swipeDidDrag.current = true;
      if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    }
    if (selectMode || !swipe || swipe.id !== msg.waMessageId) return;
    const dx = Math.max(0, Math.min(SWIPE_MAX_PX, raw));
    setSwipe({ id: msg.waMessageId, dx });
  }
  function onBubblePointerUp(msg: WAMessage) {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    if (justEnteredSelectMode.current) { justEnteredSelectMode.current = false; suppressNextClick.current = true; return; }
    if (selectMode) { suppressNextClick.current = true; toggleSelect(msg); return; }
    if (swipe?.id === msg.waMessageId && swipe.dx >= SWIPE_TRIGGER_PX) setReplyTo(msg);
    setSwipe(null);
  }

  async function forwardTo(toJid: string) {
    const targets = bulkForward ? messages.filter((m) => selected.has(m.waMessageId)) : forwardFor ? [forwardFor] : [];
    for (const m of targets) {
      try {
        await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(m.waMessageId)}/forward`, { toJid });
      } catch {}
    }
    setForwardFor(null);
    setBulkForward(false);
    cancelSelect();
  }

  const selectedMsgs = messages.filter((m) => selected.has(m.waMessageId));

  async function bulkDeleteForMe() {
    if (!window.confirm(`Delete ${selectedMsgs.length} message(s) for you?`)) return;
    for (const m of selectedMsgs) {
      try { await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(m.waMessageId)}/hide`); } catch {}
    }
    cancelSelect();
    load();
  }

  async function bulkStar() {
    const makeStarred = selectedMsgs.some((m) => !m.starred);
    for (const m of selectedMsgs) {
      try {
        await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(m.waMessageId)}/star`, { starred: makeStarred });
      } catch {}
    }
    cancelSelect();
    load();
  }

  function bulkCopy() {
    const text = selectedMsgs
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .map((m) => m.text)
      .filter(Boolean)
      .join("\n");
    if (text) navigator.clipboard?.writeText(text);
    cancelSelect();
  }

  const visibleMessages = chatSearch.trim()
    ? messages.filter((m) => m.text.toLowerCase().includes(chatSearch.toLowerCase()))
    : messages;

  const presenceLabel =
    presence?.presence === "composing" ? "typing…" :
    presence?.presence === "recording" ? "recording audio…" :
    presence?.presence === "available" ? "online" :
    presence?.lastSeen ? `last seen ${fmtTime(presence.lastSeen)}` :
    null;

  return (
    <div className="h-[100dvh] bg-background flex flex-col max-w-md mx-auto">
      {/* Conversation header — sidebar hidden, back button shown. Swaps to a
          multi-select action bar (WhatsApp-style) once anything is selected. */}
      {selectMode ? (
        <header className="flex items-center gap-1 px-2 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
          <button onClick={cancelSelect} className="p-2" aria-label="Cancel selection">
            <X className="w-5 h-5" />
          </button>
          <p className="flex-1 font-semibold">{selected.size} selected</p>
          <button onClick={bulkStar} className="p-2" aria-label="Star">
            <Star className="w-5 h-5" />
          </button>
          <button onClick={bulkCopy} className="p-2" aria-label="Copy text">
            <Copy className="w-5 h-5" />
          </button>
          <button onClick={() => setBulkForward(true)} className="p-2" aria-label="Forward">
            <Forward className="w-5 h-5" />
          </button>
          <button onClick={bulkDeleteForMe} className="p-2" aria-label="Delete">
            <Trash2 className="w-5 h-5" />
          </button>
        </header>
      ) : (
        <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
          <button onClick={onBack} className="p-1">
            <ChevronLeft className="w-6 h-6" />
          </button>
          <Avatar url={chat?.avatarUrl} label={title} size={36} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold leading-tight truncate">{title}</p>
            {presenceLabel && (
              <p className={`text-[11px] leading-tight truncate ${presenceLabel === "typing…" ? "text-emerald-300" : "text-white/60"}`}>
                {presenceLabel}
              </p>
            )}
          </div>
          <button onClick={() => setSearchOpen((v) => !v)} className="p-1" aria-label="Search in chat">
            <Search className="w-5 h-5" />
          </button>
        </header>
      )}

      {/* In-chat search */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-3 py-2 bg-wa-panel border-b border-border shrink-0">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={chatSearch}
            onChange={(e) => setChatSearch(e.target.value)}
            placeholder="Search in this chat"
            className="flex-1 bg-transparent outline-none text-sm"
          />
          <button onClick={() => { setSearchOpen(false); setChatSearch(""); }} aria-label="Close search">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto wa-scroll wa-chat-bg px-3 py-4 space-y-1.5">
        {visibleMessages.map((m) => {
          const oldNoRead = m.fromMe && !m.deleted && m.status === 2 && Date.now() - m.ts > 24 * 3600 * 1000;
          const dx = swipe?.id === m.waMessageId ? swipe.dx : 0;
          const isSelected = selected.has(m.waMessageId);
          return (
          <div key={m.waMessageId} className={`flex flex-col ${m.fromMe ? "items-end" : "items-start"} ${isSelected ? "bg-primary/10 -mx-3 px-3" : ""}`}>
            <div className="relative max-w-[78%]">
              <Reply
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-[130%] w-5 h-5 text-primary"
                style={{ opacity: Math.min(1, dx / SWIPE_TRIGGER_PX) }}
              />
              <div
                onClick={() => { if (swipeDidDrag.current) { swipeDidDrag.current = false; return; } if (suppressNextClick.current) { suppressNextClick.current = false; return; } !m.deleted && setMenuFor(menuFor === m.waMessageId ? null : m.waMessageId); }}
                onPointerDown={(e) => onBubblePointerDown(e, m)}
                onPointerMove={(e) => onBubblePointerMove(e, m)}
                onPointerUp={() => onBubblePointerUp(m)}
                onPointerCancel={() => onBubblePointerUp(m)}
                style={{ transform: `translateX(${dx}px)`, transition: dx === 0 && swipe?.id !== m.waMessageId ? "transform 150ms ease-out" : "none", touchAction: "pan-y" }}
                className={`relative rounded-lg px-3 py-1.5 text-sm shadow-sm select-none ${
                  m.fromMe ? "bg-wa-bubble-out text-foreground rounded-tr-none" : "bg-wa-bubble-in text-foreground rounded-tl-none"
                }`}
              >
              {isSelected && (
                <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow">
                  <Check className="w-3.5 h-3.5" />
                </div>
              )}
              <>
                  {(m.deleted || m.viewOnce || m.ephemeral) && (
                    <div className="flex items-center gap-1 mb-1 text-[10px] text-destructive italic">
                      {/* Content below is kept and shown as-is even when deleted — the other
                          side asked to see the original message, not a redacted placeholder,
                          so a deletion/view-once/disappearing message is labelled, not hidden. */}
                      {m.deleted && <><Trash2 className="w-3 h-3" /> Deleted for everyone</>}
                      {m.viewOnce && <><CircleDashed className="w-3 h-3" /> View once</>}
                      {m.ephemeral && <><Timer className="w-3 h-3" /> Disappearing</>}
                    </div>
                  )}
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
                  {m.linkPreviewUrl && (
                    <a
                      href={m.linkPreviewUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="block mt-1.5 rounded-md overflow-hidden border border-border/50 bg-black/5"
                    >
                      {m.linkPreviewThumb && (
                        <img src={`data:image/jpeg;base64,${m.linkPreviewThumb}`} alt="" className="w-full max-h-40 object-cover" />
                      )}
                      <div className="px-2 py-1.5">
                        {m.linkPreviewTitle && <p className="text-xs font-semibold truncate">{m.linkPreviewTitle}</p>}
                        {m.linkPreviewDescription && (
                          <p className="text-[11px] text-muted-foreground line-clamp-2">{m.linkPreviewDescription}</p>
                        )}
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">{m.linkPreviewUrl}</p>
                      </div>
                    </a>
                  )}
              </>
              <span className="float-right ml-2 mt-1 flex items-center gap-1 text-[10px] text-muted-foreground translate-y-0.5">
                {m.starred && <Star className="w-3 h-3 fill-current" />}
                {m.edited && !m.deleted && <span className="italic">edited</span>}
                {fmtClock(m.ts)}
                {m.fromMe && !m.deleted && (
                  <span title={oldNoRead ? "Read receipts might be off for this contact" : undefined}>
                    {m.status >= 3 ? <CheckCheck className="w-3.5 h-3.5 text-sky-400" /> :
                     m.status === 2 ? <CheckCheck className="w-3.5 h-3.5" /> :
                     <Check className="w-3.5 h-3.5" />}
                  </span>
                )}
              </span>
              {menuFor === m.waMessageId && (
                <div className="absolute -top-2 right-0 translate-y-[-100%] flex flex-col bg-popover border border-border rounded-lg shadow-lg z-10 overflow-hidden min-w-[170px]">
                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
                    {QUICK_EMOJIS.map((em) => (
                      <button key={em} onClick={() => react(m, em)} className="text-lg hover:scale-125 transition p-0.5">{em}</button>
                    ))}
                  </div>
                  <button onClick={() => { setReplyTo(m); setMenuFor(null); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left hover:bg-accent">
                    <Reply className="w-3.5 h-3.5" /> Reply
                  </button>
                  <button onClick={() => toggleStar(m)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left hover:bg-accent">
                    <Star className="w-3.5 h-3.5" /> {m.starred ? "Unstar" : "Star"}
                  </button>
                  <button onClick={() => { setForwardFor(m); setMenuFor(null); }} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left hover:bg-accent">
                    <Forward className="w-3.5 h-3.5" /> Forward
                  </button>
                  <button onClick={() => hideForMe(m)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left hover:bg-accent">
                    <Trash2 className="w-3.5 h-3.5" /> Delete for me
                  </button>
                  {m.fromMe && (
                    <button onClick={() => del(m)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left text-destructive hover:bg-accent">
                      <Trash2 className="w-3.5 h-3.5" /> Delete for everyone
                    </button>
                  )}
                </div>
              )}
              </div>
            </div>
            {m.reactions?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-0.5">
                {m.reactions.map((r) => (
                  <span
                    key={r.emoji}
                    className={`text-xs rounded-full px-1.5 py-0.5 border ${r.byMe ? "border-primary bg-primary/10" : "border-border bg-card"}`}
                  >
                    {r.emoji}{r.count > 1 ? ` ${r.count}` : ""}
                  </span>
                ))}
              </div>
            )}
          </div>
          );
        })}
        {visibleMessages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground mt-10">
            {chatSearch.trim() ? "No matching messages." : "No messages yet. Say hello 👋"}
          </div>
        )}
      </div>

      {/* Reply-to preview */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 bg-wa-panel border-t border-border shrink-0">
          <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
            <p className="text-xs font-medium text-primary truncate">{replyTo.fromMe ? "You" : title}</p>
            <p className="text-xs text-muted-foreground truncate">{replyTo.text}</p>
          </div>
          <button type="button" onClick={() => setReplyTo(null)} className="p-1 shrink-0" aria-label="Cancel reply">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      )}

      {sendError && (
        <p className="px-3 py-1 text-xs text-destructive bg-wa-panel shrink-0">{sendError}</p>
      )}

      {/* Composer */}
      {recording ? (
        <div className="flex items-center gap-2 p-2 bg-wa-panel shrink-0 border-t border-border">
          <button
            type="button"
            onClick={() => stopRecording(false)}
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-destructive hover:bg-card transition"
            aria-label="Cancel recording"
          >
            <Trash2 className="w-5 h-5" />
          </button>
          <div className="flex-1 flex items-center gap-2 px-4">
            <span className="w-2.5 h-2.5 rounded-full bg-destructive animate-pulse" />
            <span className="text-sm tabular-nums">
              {String(Math.floor(recordSeconds / 60)).padStart(2, "0")}:{String(recordSeconds % 60).padStart(2, "0")}
            </span>
          </div>
          <button
            type="button"
            onClick={() => stopRecording(true)}
            disabled={sending}
            className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-50 active:scale-95 transition"
            aria-label="Send voice message"
          >
            {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </button>
        </div>
      ) : (
        <form onSubmit={send} className="flex items-center gap-2 p-2 bg-wa-panel shrink-0 border-t border-border">
          <input ref={fileInputRef} type="file" className="hidden" onChange={pickFile} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-muted-foreground hover:bg-card transition disabled:opacity-50"
            aria-label="Attach media"
          >
            <Paperclip className="w-5 h-5" />
          </button>
          <input
            value={text}
            onChange={(e) => { setText(e.target.value); onTypingChange(e.target.value); }}
            placeholder="Type a message"
            className="flex-1 rounded-full bg-background border border-border px-4 py-2.5 text-sm outline-none focus:border-primary"
          />
          {text.trim() ? (
            <button
              type="submit"
              disabled={sending}
              className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-50 active:scale-95 transition"
            >
              {sending ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
            </button>
          ) : (
            <button
              type="button"
              onClick={startRecording}
              disabled={sending}
              className="w-11 h-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 disabled:opacity-50 active:scale-95 transition"
              aria-label="Record voice message"
            >
              <Mic className="w-5 h-5" />
            </button>
          )}
        </form>
      )}

      {(forwardFor || bulkForward) && (
        <ForwardSheet chats={allChats} onClose={() => { setForwardFor(null); setBulkForward(false); }} onPick={forwardTo} />
      )}
    </div>
  );
}

/** Pick a chat to forward a message's content to — WhatsApp-style contact/chat picker. */
function ForwardSheet({ chats, onClose, onPick }: { chats: WAChat[]; onClose: () => void; onPick: (jid: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = chats.filter((c) => displayName(c.name, c.phone).toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center max-w-md mx-auto">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full bg-card rounded-t-2xl p-4 space-y-3 max-h-[70vh] flex flex-col animate-in slide-in-from-bottom duration-200">
        <div className="flex items-center justify-between shrink-0">
          <h3 className="font-semibold text-lg">Forward to…</h3>
          <button onClick={onClose}><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats"
          className="w-full rounded-full bg-background border border-border px-4 py-2 text-sm outline-none focus:border-primary shrink-0"
        />
        <div className="flex-1 overflow-y-auto wa-scroll -mx-4 px-4">
          {filtered.map((c) => (
            <button
              key={c.jid}
              onClick={() => onPick(c.jid)}
              className="w-full flex items-center gap-3 py-2.5 text-left border-b border-border/40"
            >
              <Avatar url={c.avatarUrl} label={displayName(c.name, c.phone)} size={40} />
              <span className="font-medium truncate">{displayName(c.name, c.phone)}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No chats found.</p>}
        </div>
      </div>
    </div>
  );
}
