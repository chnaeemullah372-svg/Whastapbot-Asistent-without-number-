import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { Avatar } from "@/components/avatar";
import {
  panel, panelAuth, fmtTime, fmtClock, displayName,
  type WAChat, type WAMessage, type WAStatus, type GroupInfo as GroupInfoT, type GroupParticipant,
} from "@/lib/panelApi";
import {
  Search, Send, ChevronLeft, Check, CheckCheck, Trash2,
  Loader2, MoreVertical, Circle, Users2, Reply, X, Star, Forward, Paperclip,
  CircleDashed, Timer, Copy, LogOut, Shield, ShieldOff, UserMinus, Pencil, Link2, Mic,
} from "lucide-react";

const PLACEHOLDER_RE = /^(📷|📹|🎵|📄|🩷|📎)/;
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

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
    // Sent/delivered/read (blue tick) changes and reactions — bump so the open
    // conversation reloads instead of waiting on poll.
    es.addEventListener("status", bump);
    es.addEventListener("reaction", bump);
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
  const groups = chats
    .filter((c) => c.jid.endsWith("@g.us") && (c.name || "").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastMsgTs - a.lastMsgTs));

  if (activeJid) {
    return (
      <GroupConversation
        jid={activeJid}
        chat={chats.find((c) => c.jid === activeJid)}
        allChats={chats}
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
                <Avatar url={c.avatarUrl} icon={<Users2 className="w-6 h-6" />} size={48} />
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

function GroupConversation({
  jid, chat, allChats, liveTick, onBack,
}: { jid: string; chat?: WAChat; allChats: WAChat[]; liveTick: number; onBack: () => void }) {
  const [messages, setMessages] = useState<WAMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<WAMessage | null>(null);
  const [forwardFor, setForwardFor] = useState<WAMessage | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    didInitialScroll.current = false;
    setReplyTo(null);
    setSearchOpen(false);
    setChatSearch("");
    setInfoOpen(false);
    if (mediaRecorderRef.current) {
      if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
      try { mediaRecorderRef.current.stop(); } catch {}
      mediaRecorderRef.current = null;
      setRecording(false);
    }
  }, [jid]);

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
    const quote = replyTo
      ? { quotedId: replyTo.waMessageId, quotedFromMe: replyTo.fromMe, quotedText: replyTo.text }
      : {};
    try {
      // Pass the full group JID so the backend routes to sendToJid
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
        emoji, fromMe: msg.fromMe, participant: msg.fromMe ? undefined : jid,
      });
      load();
    } catch {}
  }

  async function forwardTo(toJid: string) {
    if (!forwardFor) return;
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(forwardFor.waMessageId)}/forward`, { toJid });
    } catch {}
    setForwardFor(null);
  }

  const visibleMessages = chatSearch.trim()
    ? messages.filter((m) => m.text.toLowerCase().includes(chatSearch.toLowerCase()))
    : messages;

  return (
    <div className="h-[100dvh] bg-background flex flex-col max-w-md mx-auto">
      <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
        <button onClick={onBack} className="p-1">
          <ChevronLeft className="w-6 h-6" />
        </button>
        <button onClick={() => setInfoOpen(true)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
          <Avatar url={chat?.avatarUrl} icon={<Users2 className="w-5 h-5" />} size={36} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold leading-tight truncate">{title}</p>
            <p className="text-[10px] text-white/60">Tap for group info</p>
          </div>
        </button>
        <button onClick={() => setSearchOpen((v) => !v)} className="p-1" aria-label="Search in chat">
          <Search className="w-5 h-5" />
        </button>
      </header>

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

      <div ref={scrollRef} className="flex-1 overflow-y-auto wa-scroll wa-chat-bg px-3 py-4 space-y-1.5">
        {visibleMessages.map((m) => {
          const oldNoRead = m.fromMe && !m.deleted && m.status === 2 && Date.now() - m.ts > 24 * 3600 * 1000;
          return (
          <div key={m.waMessageId} className={`flex flex-col ${m.fromMe ? "items-end" : "items-start"}`}>
            <div
              onClick={() => !m.deleted && setMenuFor(menuFor === m.waMessageId ? null : m.waMessageId)}
              className={`relative max-w-[78%] rounded-lg px-3 py-1.5 text-sm shadow-sm ${
                m.fromMe ? "bg-wa-bubble-out text-foreground rounded-tr-none" : "bg-wa-bubble-in text-foreground rounded-tl-none"
              }`}
            >
              <>
                  {(m.deleted || m.viewOnce || m.ephemeral) && (
                    <div className="flex items-center gap-1 mb-1 text-[10px] text-destructive italic">
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
            {chatSearch.trim() ? "No matching messages." : "No messages yet in this group."}
          </div>
        )}
      </div>

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

      {sendError && (
        <p className="px-3 py-1 text-xs text-destructive bg-wa-panel shrink-0">{sendError}</p>
      )}

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
            onChange={(e) => setText(e.target.value)}
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

      {forwardFor && (
        <ForwardSheet chats={allChats} onClose={() => setForwardFor(null)} onPick={forwardTo} />
      )}
      {infoOpen && (
        <GroupInfoScreen jid={jid} chat={chat} onClose={() => setInfoOpen(false)} onLeft={onBack} />
      )}
    </div>
  );
}

/** Pick a chat to forward a message's content to. */
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
              <Avatar url={c.avatarUrl} label={displayName(c.name, c.phone)} icon={c.jid.endsWith("@g.us") ? <Users2 className="w-5 h-5" /> : undefined} size={40} />
              <span className="font-medium truncate">{c.jid.endsWith("@g.us") ? (c.name || "Group") : displayName(c.name, c.phone)}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">No chats found.</p>}
        </div>
      </div>
    </div>
  );
}

/** Group Info: subject/description editing, participant list with admin
 *  actions, invite link, and leave-group — the WhatsApp "tap the group name"
 *  screen. */
function GroupInfoScreen({ jid, chat, onClose, onLeft }: { jid: string; chat?: WAChat; onClose: () => void; onLeft: () => void }) {
  const [info, setInfo] = useState<GroupInfoT | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingSubject, setEditingSubject] = useState(false);
  const [subjectDraft, setSubjectDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [invite, setInvite] = useState<{ code: string; link: string } | null>(null);
  const [participantMenuFor, setParticipantMenuFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    panel.get(`/panel/groups/${encodeURIComponent(jid)}/info`)
      .then((r: GroupInfoT) => { setInfo(r); setSubjectDraft(r.subject); setDescDraft(r.description || ""); })
      .catch((err) => setError(err?.message || "Failed to load group info"))
      .finally(() => setLoading(false));
  }, [jid]);

  useEffect(() => { load(); }, [load]);

  async function saveSubject() {
    const subject = subjectDraft.trim();
    if (!subject) return;
    setBusy(true);
    try {
      await panel.put(`/panel/groups/${encodeURIComponent(jid)}/subject`, { subject });
      setEditingSubject(false);
      load();
    } catch (err: any) {
      setError(err?.message || "Failed to update group name");
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription() {
    setBusy(true);
    try {
      await panel.put(`/panel/groups/${encodeURIComponent(jid)}/description`, { description: descDraft.trim() });
      setEditingDesc(false);
      load();
    } catch (err: any) {
      setError(err?.message || "Failed to update description");
    } finally {
      setBusy(false);
    }
  }

  async function participantAction(p: GroupParticipant, action: "promote" | "demote" | "remove") {
    setParticipantMenuFor(null);
    setBusy(true);
    try {
      await panel.post(`/panel/groups/${encodeURIComponent(jid)}/participants`, {
        jids: [p.jid], action: action === "remove" ? "remove" : action,
      });
      load();
    } catch (err: any) {
      setError(err?.message || "Failed to update participant");
    } finally {
      setBusy(false);
    }
  }

  async function fetchInvite() {
    setBusy(true);
    try {
      const r = await panel.get(`/panel/groups/${encodeURIComponent(jid)}/invite`);
      setInvite(r);
    } catch (err: any) {
      setError(err?.message || "Failed to fetch invite link");
    } finally {
      setBusy(false);
    }
  }

  async function resetInvite() {
    setBusy(true);
    try {
      const r = await panel.post(`/panel/groups/${encodeURIComponent(jid)}/invite/revoke`);
      setInvite(r);
    } catch (err: any) {
      setError(err?.message || "Failed to reset invite link");
    } finally {
      setBusy(false);
    }
  }

  async function leaveGroup() {
    if (!confirm("Leave this group?")) return;
    setBusy(true);
    try {
      await panel.post(`/panel/groups/${encodeURIComponent(jid)}/leave`);
      onLeft();
    } catch (err: any) {
      setError(err?.message || "Failed to leave group");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-background flex flex-col max-w-md mx-auto">
      <header className="flex items-center gap-2 px-3 h-14 bg-wa-header text-white shrink-0 shadow-md">
        <button onClick={onClose} className="p-1"><ChevronLeft className="w-6 h-6" /></button>
        <p className="font-semibold">Group info</p>
      </header>
      <div className="flex-1 overflow-y-auto wa-scroll">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : !info ? (
          <p className="text-sm text-destructive text-center py-10">{error || "Could not load group info."}</p>
        ) : (
          <>
            {error && <p className="text-xs text-destructive px-4 pt-3">{error}</p>}
            <div className="flex flex-col items-center gap-2 py-6 border-b border-border">
              <Avatar url={chat?.avatarUrl} icon={<Users2 className="w-10 h-10" />} size={96} />
              {editingSubject ? (
                <div className="flex items-center gap-2 px-4 w-full">
                  <input
                    autoFocus
                    value={subjectDraft}
                    onChange={(e) => setSubjectDraft(e.target.value)}
                    className="flex-1 rounded-lg bg-card border border-border px-3 py-1.5 text-sm text-center outline-none focus:border-primary"
                  />
                  <button disabled={busy} onClick={saveSubject} className="text-primary text-sm font-medium">Save</button>
                  <button onClick={() => { setEditingSubject(false); setSubjectDraft(info.subject); }} className="text-muted-foreground text-sm">Cancel</button>
                </div>
              ) : (
                <button onClick={() => setEditingSubject(true)} className="flex items-center gap-1.5 text-lg font-semibold">
                  {info.subject} <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              )}
              <p className="text-xs text-muted-foreground">{info.participants.length} participants</p>
            </div>

            <div className="px-4 py-3 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Description</p>
              {editingDesc ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={descDraft}
                    onChange={(e) => setDescDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded-lg bg-card border border-border px-3 py-2 text-sm outline-none focus:border-primary"
                  />
                  <div className="flex gap-2">
                    <button disabled={busy} onClick={saveDescription} className="text-primary text-sm font-medium">Save</button>
                    <button onClick={() => { setEditingDesc(false); setDescDraft(info.description || ""); }} className="text-muted-foreground text-sm">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setEditingDesc(true)} className="text-sm text-left w-full flex items-start justify-between gap-2">
                  <span className={info.description ? "" : "text-muted-foreground italic"}>{info.description || "Add a group description"}</span>
                  <Pencil className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                </button>
              )}
            </div>

            <div className="px-4 py-3 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Invite link</p>
              {invite ? (
                <div className="space-y-2">
                  <p className="text-sm break-all">{invite.link}</p>
                  <div className="flex gap-3">
                    <button onClick={() => navigator.clipboard?.writeText(invite.link)} className="flex items-center gap-1 text-primary text-sm">
                      <Copy className="w-3.5 h-3.5" /> Copy
                    </button>
                    <button disabled={busy} onClick={resetInvite} className="flex items-center gap-1 text-destructive text-sm">
                      <Link2 className="w-3.5 h-3.5" /> Reset link
                    </button>
                  </div>
                </div>
              ) : (
                <button disabled={busy} onClick={fetchInvite} className="flex items-center gap-1.5 text-primary text-sm">
                  <Link2 className="w-3.5 h-3.5" /> Get invite link
                </button>
              )}
            </div>

            <div className="px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                {info.participants.length} participants
              </p>
              {info.participants.map((p) => {
                const isAdmin = p.admin === "admin" || p.admin === "superadmin";
                const label = p.name || `+${p.jid.split("@")[0].split(":")[0]}`;
                return (
                  <div key={p.jid} className="relative flex items-center gap-3 py-2 border-b border-border/40 last:border-b-0">
                    <Avatar label={label} size={40} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{label}</p>
                      {isAdmin && <p className="text-xs text-primary">{p.admin === "superadmin" ? "Group owner" : "Admin"}</p>}
                    </div>
                    <button onClick={() => setParticipantMenuFor(participantMenuFor === p.jid ? null : p.jid)} className="p-1 text-muted-foreground">
                      <MoreVertical className="w-4 h-4" />
                    </button>
                    {participantMenuFor === p.jid && (
                      <div className="absolute top-8 right-0 flex flex-col bg-popover border border-border rounded-lg shadow-lg z-10 overflow-hidden min-w-[170px] text-sm">
                        {isAdmin ? (
                          <button onClick={() => participantAction(p, "demote")} className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                            <ShieldOff className="w-3.5 h-3.5" /> Dismiss as admin
                          </button>
                        ) : (
                          <button onClick={() => participantAction(p, "promote")} className="flex items-center gap-2 px-3 py-2 text-left hover:bg-accent">
                            <Shield className="w-3.5 h-3.5" /> Make group admin
                          </button>
                        )}
                        <button onClick={() => participantAction(p, "remove")} className="flex items-center gap-2 px-3 py-2 text-left text-destructive hover:bg-accent">
                          <UserMinus className="w-3.5 h-3.5" /> Remove from group
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="px-4 py-4">
              <button disabled={busy} onClick={leaveGroup} className="flex items-center gap-2 text-destructive text-sm font-medium">
                <LogOut className="w-4 h-4" /> Leave group
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
