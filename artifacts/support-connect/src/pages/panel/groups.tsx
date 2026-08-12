import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import {
  panel, panelAuth, fmtTime, fmtClock,
  type WAChat, type WAMessage, type WAStatus,
} from "@/lib/panelApi";
import {
  Search, Send, ChevronLeft, Check, CheckCheck, Trash2,
  Loader2, MoreVertical, Circle, Users2, Reply, X,
} from "lucide-react";

const PLACEHOLDER_RE = /^(📷|📹|🎵|📄|🩷|📎)/;

function MediaContent({ msg }: { msg: WAMessage }) {
  if (!msg.hasMedia) {
    return <span className="whitespace-pre-wrap break-words">{msg.text}</span>;
  }
  const url = panel.mediaUrl(msg.waMessageId);
  if (msg.mediaKind === "image" || msg.mediaKind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img src={url} alt="" loading="lazy"
          className={msg.mediaKind === "sticker" ? "max-w-[140px]" : "rounded-md max-w-full max-h-72 object-cover"} />
      </a>
    );
  }
  if (msg.mediaKind === "video") return <video src={url} controls className="rounded-md max-w-full max-h-72" />;
  if (msg.mediaKind === "audio") return <audio src={url} controls className="max-w-[230px]" />;
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

export default function Groups() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [chats, setChats] = useState<WAChat[]>([]);
  const [activeJid, setActiveJid] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [waStatus, setWaStatus] = useState<WAStatus>("disconnected");
  const [connChecked, setConnChecked] = useState(false);
  const [liveTick, setLiveTick] = useState(0);

  const handleAuthError = useCallback((err: any) => {
    if (err?.status === 401) { panelAuth.clear(); navigate("/login"); }
  }, [navigate]);

  const loadChats = useCallback(() => {
    panel.get("/panel/chats").then((r) => setChats(r || [])).catch(handleAuthError);
  }, [handleAuthError]);

  const loadStatus = useCallback(() => {
    panel.get("/panel/wa/status")
      .then((r) => { setWaStatus(r.status); setConnChecked(true); })
      .catch(handleAuthError);
  }, [handleAuthError]);

  useEffect(() => {
    if (!user) return;
    loadChats();
    loadStatus();
    const t = setInterval(() => { loadChats(); loadStatus(); }, 15000);
    return () => clearInterval(t);
  }, [user, loadChats, loadStatus]);

  useEffect(() => {
    if (!user) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { loadChats(); setLiveTick((n) => n + 1); }, 250);
    };
    const es = new EventSource(panel.eventsUrl());
    es.addEventListener("message", bump);
    es.addEventListener("delete", bump);
    // Sent/delivered/read (blue tick) changes — bump so the open conversation
    // reloads and shows the updated tick instantly instead of waiting on poll.
    es.addEventListener("status", bump);
    es.addEventListener("state", () => loadStatus());
    return () => { if (debounce) clearTimeout(debounce); es.close(); };
  }, [user, loadChats, loadStatus]);

  useEffect(() => {
    if (!user || !connChecked || activeJid) return;
    if (waStatus !== "connected") navigate("/connect");
  }, [user, connChecked, waStatus, activeJid, navigate]);

  useEffect(() => {
    if (!activeJid) return;
    window.history.pushState({ scChat: activeJid }, "");
    const onPop = () => { setActiveJid(null); loadChats(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [activeJid, loadChats]);

  // Groups only: JIDs ending in @g.us
  const groups = chats.filter(
    (c) =>
      c.jid.endsWith("@g.us") &&
      (c.name || "").toLowerCase().includes(search.toLowerCase()),
  );

  if (activeJid) {
    return (
      <GroupConversation
        jid={activeJid}
        chat={chats.find((c) => c.jid === activeJid)}
        liveTick={liveTick}
        onBack={() => {
          if (window.history.state?.scChat) window.history.back();
          else { setActiveJid(null); loadChats(); }
        }}
      />
    );
  }

  return (
    <Shell title="Groups">
      <div className="flex flex-col h-full">
        {waStatus !== "connected" && (
          <button
            onClick={() => navigate("/connect")}
            className="flex items-center gap-2 px-4 py-2 text-xs bg-accent text-accent-foreground border-b border-border"
          >
            <Circle className="w-2.5 h-2.5 fill-yellow-500 text-yellow-500" />
            {STATUS_LABEL[waStatus]} — tap to connect WhatsApp
          </button>
        )}

        <div className="p-3 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search groups"
              className="w-full rounded-full bg-card border border-border pl-10 pr-4 py-2.5 text-sm outline-none focus:border-primary transition"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto wa-scroll">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <Users2 className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">No group chats yet.</p>
              <p className="text-xs mt-1">Groups you are added to will appear here.</p>
            </div>
          ) : (
            groups.map((c) => (
              <button
                key={c.jid}
                onClick={() => setActiveJid(c.jid)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition text-left border-b border-border/40"
              >
                <div className="w-12 h-12 rounded-full bg-emerald-600/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
                  <Users2 className="w-6 h-6" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{c.name || "Group"}</span>
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
      </div>
    </Shell>
  );
}

function GroupConversation({ jid, chat, liveTick, onBack }: { jid: string; chat?: WAChat; liveTick: number; onBack: () => void }) {
  const [messages, setMessages] = useState<WAMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<WAMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const title = chat?.name || "Group";

  const load = useCallback(() => {
    panel.get(`/panel/chats/${encodeURIComponent(jid)}/messages`)
      .then((r) => setMessages(r || []))
      .catch(() => {});
  }, [jid]);

  useEffect(() => {
    load();
    panel.post(`/panel/chats/${encodeURIComponent(jid)}/read`).catch(() => {});
    const t = setInterval(load, 12000);
    return () => clearInterval(t);
  }, [load, jid]);

  useEffect(() => { if (liveTick > 0) load(); }, [liveTick, load]);

  useEffect(() => { didInitialScroll.current = false; setReplyTo(null); }, [jid]);

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
    const quote = replyTo
      ? { quotedId: replyTo.waMessageId, quotedFromMe: replyTo.fromMe, quotedText: replyTo.text }
      : {};
    try {
      // Pass the full group JID so the backend routes to sendToJid
      await panel.post("/panel/send", { jid, text: body, ...quote });
      setReplyTo(null);
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
      <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
        <button onClick={onBack} className="p-1">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center shrink-0">
          <Users2 className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold leading-tight truncate">{title}</p>
          <p className="text-[10px] text-white/60">Group</p>
        </div>
        <MoreVertical className="w-5 h-5" />
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto wa-scroll wa-chat-bg px-3 py-4 space-y-1.5">
        {messages.map((m) => (
          <div key={m.waMessageId} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
            <div
              onClick={() => !m.deleted && setMenuFor(menuFor === m.waMessageId ? null : m.waMessageId)}
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
                <div className="absolute -top-2 right-0 translate-y-[-100%] flex flex-col bg-popover border border-border rounded-lg shadow-lg z-10 overflow-hidden min-w-[110px]">
                  <button
                    onClick={() => { setReplyTo(m); setMenuFor(null); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left hover:bg-accent"
                  >
                    <Reply className="w-3.5 h-3.5" /> Reply
                  </button>
                  {m.fromMe && (
                    <button
                      onClick={() => del(m)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-left text-destructive hover:bg-accent"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {messages.length === 0 && (
          <div className="text-center text-xs text-muted-foreground mt-10">
            No messages yet in this group.
          </div>
        )}
      </div>

      {/* Reply-to preview */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 bg-wa-panel border-t border-border shrink-0">
          <div className="flex-1 min-w-0 border-l-2 border-primary pl-2">
            <p className="text-xs font-medium text-primary truncate">{replyTo.fromMe ? "You" : "Group member"}</p>
            <p className="text-xs text-muted-foreground truncate">{replyTo.text}</p>
          </div>
          <button type="button" onClick={() => setReplyTo(null)} className="p-1 shrink-0" aria-label="Cancel reply">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      )}

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
