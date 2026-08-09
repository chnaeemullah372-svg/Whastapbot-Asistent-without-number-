import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { admin, adminAuth, fmtClock, fmtBytes, fmtTime, type AppLog, type WAChat, type WAMessage, type WAAccount } from "@/lib/panelApi";
import {
  ShieldCheck, Users, MessageSquare, ArrowDownLeft, ArrowUpRight, LogOut,
  Download, RefreshCw, Wrench, Trash2, CheckCircle2, XCircle, Eye, EyeOff,
  Loader2, Activity, Power, LayoutDashboard, MessagesSquare, HardDrive,
  Database, ScrollText, Menu, X, Circle, Search, ChevronLeft, Crown, KeyRound,
  Smartphone, CalendarClock,
} from "lucide-react";
import { isVip, setVip } from "@/lib/theme";

const PLACEHOLDER_RE = /^(📷|📹|🎵|📄|🩷|📎)/;

/** Render the real photo / voice / video / document for an admin-viewed msg. */
function AdminMedia({ msg }: { msg: WAMessage }) {
  if (!msg.hasMedia) return <span className="break-words whitespace-pre-wrap">{msg.text}</span>;
  const url = admin.mediaUrl(msg.waMessageId);
  if (msg.mediaKind === "image" || msg.mediaKind === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img src={url} alt="" loading="lazy" className={msg.mediaKind === "sticker" ? "max-w-[120px]" : "rounded-md max-w-full max-h-64 object-cover"} />
      </a>
    );
  }
  if (msg.mediaKind === "video") return <video src={url} controls className="rounded-md max-w-full max-h-64" />;
  if (msg.mediaKind === "audio") return <audio src={url} controls className="max-w-[220px]" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline break-all">
      📄 {msg.fileName || "Document"}
    </a>
  );
}

interface Stats {
  chats: number;
  messages: number;
  backups: number;
  incoming: number;
  outgoing: number;
  storageBytes: number;
  dbConnected: boolean;
  whatsapp: { status: string; phoneNumber: string | null; connectedAt: string | null };
}
interface PanelUser {
  exists: boolean;
  id?: number;
  username?: string;
  password?: string;
  approved?: boolean;
  createdAt?: string;
  approvedAt?: string | null;
}

type View = "overview" | "users" | "accounts" | "chats" | "live" | "storage" | "logs" | "tools";

const NAV: { key: View; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Dashboard", icon: LayoutDashboard },
  { key: "users", label: "User Account", icon: Users },
  { key: "accounts", label: "Connected Numbers", icon: Smartphone },
  { key: "chats", label: "All Chats", icon: MessagesSquare },
  { key: "live", label: "Live Messages", icon: Activity },
  { key: "storage", label: "Storage & Backups", icon: HardDrive },
  { key: "logs", label: "System Logs", icon: ScrollText },
  { key: "tools", label: "Maintenance", icon: Wrench },
];

export default function AdminDashboard() {
  const [, navigate] = useLocation();
  const [view, setView] = useState<View>("overview");
  const [drawer, setDrawer] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [user, setUser] = useState<PanelUser | null>(null);
  const [messages, setMessages] = useState<(WAMessage & { _chat?: string })[]>([]);
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [chats, setChats] = useState<WAChat[]>([]);
  const [accounts, setAccounts] = useState<WAAccount[]>([]);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [activeChat, setActiveChat] = useState<WAChat | null>(null);
  const [chatMessages, setChatMessages] = useState<WAMessage[]>([]);
  const [showPw, setShowPw] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [vip, setVipState] = useState(isVip());
  const [toolMsg, setToolMsg] = useState("");
  const [search, setSearch] = useState("");
  const [brandCode, setBrandCode] = useState("");
  const [brandMsg, setBrandMsg] = useState("");
  const [brandBusy, setBrandBusy] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [st, us, lg, ch, ac] = await Promise.all([
        admin.get("/admin-panel/stats"),
        admin.get("/admin-panel/user"),
        admin.get("/admin-panel/logs?limit=120"),
        admin.get("/admin-panel/chats"),
        admin.get("/admin-panel/accounts"),
      ]);
      setStats(st);
      setUser(us);
      setLogs(lg || []);
      setChats(ch || []);
      setAccounts(ac || []);
      const recent: (WAMessage & { _chat?: string })[] = [];
      for (const c of (ch || []).slice(0, 10)) {
        const msgs: WAMessage[] = await admin.get(`/admin-panel/chats/${encodeURIComponent(c.jid)}/messages`);
        msgs.slice(-6).forEach((m) => recent.push({ ...m, _chat: c.name || c.phone }));
      }
      recent.sort((a, b) => b.ts - a.ts);
      setMessages(recent.slice(0, 40));
    } catch (e: any) {
      if (String(e.message).includes("401")) logout();
    }
  }, []);

  useEffect(() => {
    if (!adminAuth.get()) {
      navigate("/admin/login");
      return;
    }
    admin.get("/admin/me").then((r) => setAdminName(r.username)).catch(() => logout());
    admin.get("/admin-panel/pairing-code").then((r) => setBrandCode(r.pairingBrandCode || "")).catch(() => {});
    loadAll();
    const t = setInterval(loadAll, 5000);
    return () => clearInterval(t);
  }, []);

  async function openChat(c: WAChat) {
    setActiveChat(c);
    setChatMessages([]);
    try {
      const msgs: WAMessage[] = await admin.get(`/admin-panel/chats/${encodeURIComponent(c.jid)}/messages`);
      setChatMessages(msgs);
    } catch {
      setChatMessages([]);
    }
  }

  // Keep the open conversation live — refetch its messages every few seconds.
  useEffect(() => {
    if (!activeChat) return;
    const jid = activeChat.jid;
    const refetch = () => {
      admin.get(`/admin-panel/chats/${encodeURIComponent(jid)}/messages`)
        .then((msgs: WAMessage[]) => setChatMessages(msgs))
        .catch(() => {});
    };
    const t = setInterval(refetch, 3000);
    return () => clearInterval(t);
  }, [activeChat]);

  function logout() {
    adminAuth.clear();
    navigate("/admin/login");
  }

  async function approve() { await admin.post("/admin-panel/user/approve"); loadAll(); }
  async function revoke() { await admin.post("/admin-panel/user/revoke"); loadAll(); }

  async function saveBrand() {
    setBrandMsg("");
    if (brandCode.length !== 8) { setBrandMsg("Theek 8 characters likhein (A-Z, 0-9)."); return; }
    setBrandBusy(true);
    try {
      const r = await admin.put("/admin-panel/pairing-code", { pairingBrandCode: brandCode });
      setBrandCode(r.pairingBrandCode || brandCode);
      setBrandMsg("Pairing code save ho gaya ✓");
    } catch (e: any) {
      setBrandMsg(e?.message || "Save nahi hua.");
    } finally {
      setBrandBusy(false);
    }
  }

  async function runTool(path: string, label: string) {
    setToolMsg("");
    try {
      await admin.post(`/admin-panel/tools/${path}`);
      setToolMsg(`${label} completed.`);
      loadAll();
    } catch (e: any) {
      setToolMsg(e.message);
    }
  }

  function exportChats() {
    admin.raw("/admin-panel/export").then(async (res) => {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chats-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const waStatus = stats?.whatsapp.status || "…";
  const waConnected = waStatus === "connected";
  const filteredChats = chats.filter(
    (c) =>
      (!accountFilter || c.accountPhone === accountFilter) &&
      (!search || (c.name || "").toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search))
  );

  function go(v: View) { setView(v); setDrawer(false); setActiveChat(null); if (v !== "chats") setAccountFilter(null); }

  function openAccount(a: WAAccount) {
    setAccountFilter(a.phone);
    setActiveChat(null);
    setSearch("");
    setView("chats");
    setDrawer(false);
  }

  return (
    <div className="min-h-screen bg-background flex">
      {/* Sidebar */}
      <aside className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-wa-header text-white flex flex-col transition-transform ${drawer ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}`}>
        <div className="h-16 flex items-center gap-2.5 px-5 border-b border-white/10">
          <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <p className="font-bold leading-tight">Support Connect</p>
            <p className="text-[11px] text-white/60">Admin Monitoring</p>
          </div>
          <button onClick={() => setDrawer(false)} className="lg:hidden ml-auto text-white/70">
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = view === n.key;
            return (
              <button
                key={n.key}
                onClick={() => go(n.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition ${active ? "bg-white/20" : "text-white/70 hover:bg-white/10"}`}
              >
                <Icon className="w-[18px] h-[18px]" /> {n.label}
              </button>
            );
          })}
        </nav>
        <div className="p-3 border-t border-white/10">
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-white/60">
            <Circle className={`w-2 h-2 ${waConnected ? "fill-green-400 text-green-400" : "fill-white/40 text-white/40"}`} />
            WhatsApp {waStatus}
          </div>
          <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/80 hover:bg-white/10 transition">
            <LogOut className="w-[18px] h-[18px]" /> Logout
          </button>
        </div>
      </aside>

      {drawer && <div onClick={() => setDrawer(false)} className="fixed inset-0 bg-black/50 z-20 lg:hidden" />}

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-10 bg-card border-b border-border h-16 flex items-center gap-3 px-5">
          <button onClick={() => setDrawer(true)} className="lg:hidden text-muted-foreground">
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold leading-tight">{NAV.find((n) => n.key === view)?.label}</h1>
            <p className="text-xs text-muted-foreground">Signed in as {adminName || "admin"}</p>
          </div>
          <button
            onClick={() => { const v = !vip; setVip(v); setVipState(v); }}
            title="VIP Theme"
            className={`flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg transition ${vip ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/70"}`}
          >
            <Crown className="w-4 h-4" /> <span className="hidden sm:inline">VIP</span>
          </button>
          <button onClick={loadAll} className="flex items-center gap-1.5 text-sm bg-muted hover:bg-muted/70 transition px-3 py-2 rounded-lg">
            <RefreshCw className="w-4 h-4" /> <span className="hidden sm:inline">Refresh</span>
          </button>
        </header>

        <main className="flex-1 p-5 lg:p-6 space-y-6 overflow-y-auto wa-scroll">
          {view === "overview" && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={Users} label="Total Users" value={user?.exists ? "1" : "0"} tint="text-sky-400 bg-sky-400/10" />
                <StatCard icon={MessageSquare} label="Total Chats" value={String(stats?.chats ?? "—")} tint="text-primary bg-primary/10" />
                <StatCard icon={ArrowDownLeft} label="Incoming Messages" value={String(stats?.incoming ?? "—")} tint="text-emerald-400 bg-emerald-400/10" />
                <StatCard icon={ArrowUpRight} label="Outgoing Messages" value={String(stats?.outgoing ?? "—")} tint="text-violet-400 bg-violet-400/10" />
              </div>

              <div className="grid lg:grid-cols-3 gap-4">
                <StatusTile
                  icon={Power}
                  title="WhatsApp Status"
                  value={waStatus}
                  ok={waConnected}
                  sub={stats?.whatsapp.phoneNumber ? `+${stats.whatsapp.phoneNumber.replace(/^\+/, "")}` : "Not linked"}
                />
                <StatusTile
                  icon={Database}
                  title="Database Status"
                  value={stats?.dbConnected ? "Connected" : "Offline"}
                  ok={!!stats?.dbConnected}
                  sub={`${stats?.messages ?? 0} messages stored`}
                />
                <StatusTile
                  icon={HardDrive}
                  title="Storage Used"
                  value={fmtBytes(stats?.storageBytes ?? 0)}
                  ok
                  sub={`${stats?.backups ?? 0} backups`}
                />
              </div>

              <div className="grid lg:grid-cols-2 gap-6">
                <Card title="Recent Messages" icon={Activity}>
                  <MessageList messages={messages.slice(0, 12)} />
                </Card>
                <Card title="System Logs" icon={ScrollText}>
                  <LogList logs={logs.slice(0, 12)} />
                </Card>
              </div>
            </>
          )}

          {view === "users" && (
            <div className="max-w-lg">
              <Card title="Managed User Account" icon={Users}>
                {!user?.exists ? (
                  <p className="text-sm text-muted-foreground">No user has signed up yet.</p>
                ) : (
                  <div className="space-y-4">
                    <Field label="Username" value={user.username!} />
                    <div>
                      <p className="text-xs text-muted-foreground">Password</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <code className="text-sm font-mono bg-muted px-2 py-1 rounded flex-1">
                          {showPw ? user.password : "••••••••"}
                        </code>
                        <button onClick={() => setShowPw((s) => !s)} className="text-muted-foreground">
                          {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Status:</span>
                      {user.approved ? (
                        <span className="text-xs font-semibold text-primary flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Approved</span>
                      ) : (
                        <span className="text-xs font-semibold text-yellow-500 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> Pending Approval</span>
                      )}
                    </div>
                    {user.createdAt && <Field label="Signed up" value={new Date(user.createdAt).toLocaleString()} />}
                    {user.approved ? (
                      <button onClick={revoke} className="w-full rounded-lg bg-destructive/15 text-destructive text-sm font-semibold py-2.5">
                        Revoke Access
                      </button>
                    ) : (
                      <button onClick={approve} className="w-full rounded-lg bg-primary text-primary-foreground text-sm font-semibold py-2.5">
                        Approve User
                      </button>
                    )}
                  </div>
                )}
              </Card>
            </div>
          )}

          {view === "accounts" && (
            <Card title={`Connected Numbers (${accounts.length})`} icon={Smartphone}>
              <p className="text-xs text-muted-foreground mb-3">
                Har WhatsApp number jo kabhi connect hua, connect date ke saath. Kisi number par click karein to us account ki saari chats alag se khulengi.
              </p>
              {accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-10">Abhi tak koi number connect nahi hua.</p>
              ) : (
                <div className="space-y-2">
                  {accounts.map((a) => (
                    <button
                      key={a.phone}
                      onClick={() => openAccount(a)}
                      className="w-full text-left p-3 rounded-lg border border-border hover:bg-muted transition flex items-center gap-3"
                    >
                      <div className="w-11 h-11 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0">
                        <Smartphone className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">+{a.phone}</p>
                        <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <CalendarClock className="w-3 h-3" /> First connected {fmtTime(new Date(a.firstConnectedAt).getTime())}
                          {a.connectCount > 1 && <span className="ml-1">· {a.connectCount}× connected</span>}
                        </p>
                      </div>
                      <span className="text-[11px] bg-muted rounded-full px-2 py-0.5 font-medium shrink-0">{a.chatCount} chats</span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          {view === "chats" && !activeChat && (
            <Card title={accountFilter ? `Chats of +${accountFilter} (${filteredChats.length})` : `All Chats (${chats.length})`} icon={MessagesSquare}>
              {accountFilter && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-primary/10 text-primary px-3 py-2 mb-3 text-xs">
                  <span className="flex items-center gap-1.5 truncate"><Smartphone className="w-3.5 h-3.5" /> Showing chats for +{accountFilter}</span>
                  <button onClick={() => setAccountFilter(null)} className="font-semibold underline shrink-0">Show all</button>
                </div>
              )}
              <div className="flex items-center gap-2 rounded-lg bg-background border border-border px-3 mb-3">
                <Search className="w-4 h-4 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search chats…"
                  className="flex-1 bg-transparent py-2 text-sm outline-none"
                />
              </div>
              <div className="divide-y divide-border/40 max-h-[72vh] overflow-y-auto wa-scroll">
                {filteredChats.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">No chats found.</p>
                ) : filteredChats.map((c) => (
                  <button
                    key={c.jid}
                    onClick={() => openChat(c)}
                    className="w-full text-left p-3 transition flex items-center gap-3 hover:bg-muted rounded-lg"
                  >
                    <div className="w-11 h-11 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold shrink-0">
                      {(c.name || c.phone).charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{c.name || `+${c.phone}`}</p>
                        <span className="text-[11px] text-muted-foreground shrink-0">{fmtTime(c.lastMsgTs)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{c.lastMsg}</p>
                    </div>
                    {c.unread > 0 && (
                      <span className="text-[10px] bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 font-bold shrink-0">{c.unread}</span>
                    )}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {view === "chats" && activeChat && (
            <Card
              title=""
              icon={MessageSquare}
              hideHeader
            >
              <div className="flex items-center gap-3 -mt-1 mb-3 pb-3 border-b border-border">
                <button
                  onClick={() => setActiveChat(null)}
                  className="flex items-center justify-center w-9 h-9 rounded-full hover:bg-muted transition shrink-0"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <div className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold shrink-0">
                  {(activeChat.name || activeChat.phone).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold truncate leading-tight">{activeChat.name || `+${activeChat.phone}`}</p>
                  <p className="text-xs text-muted-foreground truncate">+{activeChat.phone}</p>
                </div>
              </div>
              <div className="space-y-2 max-h-[64vh] overflow-y-auto wa-scroll">
                {chatMessages.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-16">No messages in this chat yet.</p>
                ) : chatMessages.map((m) => (
                  <div key={m.waMessageId} className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.deleted ? "ring-1 ring-destructive/40 " : ""}${m.fromMe ? "bg-primary/15" : "bg-muted"}`}>
                      {m.mediaKind ? (
                        <div className="space-y-1">
                          <AdminMedia msg={m} />
                          {!PLACEHOLDER_RE.test(m.text) && <p className="break-words whitespace-pre-wrap">{m.text}</p>}
                        </div>
                      ) : (
                        <p className="break-words whitespace-pre-wrap">{m.text}</p>
                      )}
                      {m.deleted && (
                        <span className="block mt-1 text-[10px] font-semibold text-destructive">🚫 deleted by sender</span>
                      )}
                      <p className="text-[10px] text-muted-foreground mt-1 text-right">{fmtClock(m.ts)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {view === "live" && (
            <Card title="Live Message Monitor" icon={Activity}>
              <p className="text-xs text-muted-foreground mb-3">All incoming and outgoing messages across every chat, newest first. Updates automatically.</p>
              <MessageList messages={messages} />
            </Card>
          )}

          {view === "storage" && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={HardDrive} label="Storage Used" value={fmtBytes(stats?.storageBytes ?? 0)} tint="text-amber-400 bg-amber-400/10" />
                <StatCard icon={Database} label="Messages Stored" value={String(stats?.messages ?? "—")} tint="text-primary bg-primary/10" />
                <StatCard icon={MessageSquare} label="Chats Stored" value={String(stats?.chats ?? "—")} tint="text-sky-400 bg-sky-400/10" />
                <StatCard icon={Download} label="Backups" value={String(stats?.backups ?? "—")} tint="text-violet-400 bg-violet-400/10" />
              </div>
              <Card title="Database Status" icon={Database}>
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${stats?.dbConnected ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"}`}>
                    <Database className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-semibold">{stats?.dbConnected ? "Connected" : "Offline"}</p>
                    <p className="text-xs text-muted-foreground">PostgreSQL storing all chats and messages</p>
                  </div>
                </div>
                <button onClick={exportChats} className="mt-4 w-full rounded-lg bg-muted hover:bg-muted/70 transition text-sm font-medium py-2.5 flex items-center justify-center gap-2">
                  <Download className="w-4 h-4 text-primary" /> Export All Chats (JSON)
                </button>
              </Card>
            </>
          )}

          {view === "logs" && (
            <Card title="System Logs" icon={ScrollText}>
              <LogList logs={logs} />
            </Card>
          )}

          {view === "tools" && (
            <div className="max-w-lg space-y-4">
              <Card title="Pairing Code Name" icon={KeyRound}>
                <p className="text-xs text-muted-foreground mb-3">
                  Jo bhi yahan likhenge wohi code WhatsApp connect karte waqt OTP ki jagah dikhega. Theek 8 characters (sirf letters A–Z aur numbers 0–9).
                </p>
                <input
                  value={brandCode}
                  onChange={(e) => setBrandCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
                  maxLength={8}
                  placeholder="HASANALI"
                  className="w-full rounded-lg bg-background border border-border px-4 py-3 text-center text-xl font-extrabold tracking-[0.35em] uppercase outline-none focus:border-primary"
                />
                <button
                  onClick={saveBrand}
                  disabled={brandBusy}
                  className="mt-3 w-full rounded-lg bg-primary text-primary-foreground text-sm py-2.5 font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                >
                  {brandBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                  Save Pairing Code
                </button>
                {brandMsg && <p className="text-xs text-center text-muted-foreground pt-2">{brandMsg}</p>}
              </Card>

              <Card title="Maintenance Tools" icon={Wrench}>
                <p className="text-xs text-muted-foreground mb-4">Diagnose and repair the WhatsApp connection. These do not send any messages.</p>
                <div className="space-y-2">
                  <button onClick={() => runTool("fix", "Auto-fix")} className="w-full rounded-lg bg-muted hover:bg-muted/70 transition text-sm py-2.5 flex items-center justify-center gap-2">
                    <Wrench className="w-4 h-4 text-primary" /> Auto Fix (Fresh Start)
                  </button>
                  <button onClick={() => runTool("reconnect", "Reconnect")} className="w-full rounded-lg bg-muted hover:bg-muted/70 transition text-sm py-2.5 flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 text-primary" /> Reconnect WhatsApp
                  </button>
                  <button onClick={() => runTool("clear-session", "Clear session")} className="w-full rounded-lg bg-destructive/15 text-destructive transition text-sm py-2.5 flex items-center justify-center gap-2">
                    <Trash2 className="w-4 h-4" /> Clear Session
                  </button>
                  {toolMsg && <p className="text-xs text-center text-muted-foreground pt-1">{toolMsg}</p>}
                </div>
              </Card>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function MessageList({ messages }: { messages: (WAMessage & { _chat?: string })[] }) {
  if (messages.length === 0) return <p className="text-sm text-muted-foreground text-center py-8">No messages yet.</p>;
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto wa-scroll">
      {messages.map((m) => (
        <div key={`${m.jid}-${m.waMessageId}`} className="rounded-lg border border-border p-3">
          <div className="flex items-center gap-2 mb-1">
            {m.fromMe ? <ArrowUpRight className="w-3.5 h-3.5 text-violet-400" /> : <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400" />}
            <span className="text-xs font-medium truncate flex-1">{m._chat}</span>
            <span className="text-[10px] text-muted-foreground">{fmtTime(m.ts)} {fmtClock(m.ts)}</span>
          </div>
          <p className="text-sm text-foreground/90 break-words line-clamp-3">
            {m.text}
            {m.deleted && <span className="ml-1.5 text-[10px] font-semibold text-destructive align-middle">🚫 deleted</span>}
          </p>
        </div>
      ))}
    </div>
  );
}

function LogList({ logs }: { logs: AppLog[] }) {
  if (logs.length === 0) return <p className="text-sm text-muted-foreground text-center py-8">No logs.</p>;
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto wa-scroll font-mono text-xs">
      {logs.map((l) => (
        <div key={l.id} className="rounded border border-border p-2">
          <div className="flex items-center gap-2 mb-0.5">
            <span className={`uppercase font-bold text-[10px] ${
              l.level === "error" ? "text-destructive" :
              l.level === "warn" ? "text-yellow-500" :
              l.level === "success" ? "text-primary" : "text-sky-400"
            }`}>{l.level}</span>
            <span className="text-muted-foreground">{l.source}</span>
            <span className="ml-auto text-muted-foreground">{new Date(l.createdAt).toLocaleTimeString()}</span>
          </div>
          <p className="text-foreground/80 break-words">{l.message}</p>
        </div>
      ))}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tint }: { icon: typeof Users; label: string; value: string; tint: string }) {
  return (
    <div className="rounded-2xl bg-card border border-border p-5">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${tint}`}>
        <Icon className="w-5 h-5" />
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

function StatusTile({ icon: Icon, title, value, sub, ok }: { icon: typeof Power; title: string; value: string; sub: string; ok: boolean }) {
  return (
    <div className="rounded-2xl bg-card border border-border p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"}`}>
        <Icon className="w-6 h-6" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{title}</p>
        <p className="font-bold capitalize truncate">{value}</p>
        <p className="text-xs text-muted-foreground truncate">{sub}</p>
      </div>
    </div>
  );
}

function Card({ title, icon: Icon, children, className = "", hideHeader = false }: { title: string; icon: typeof Users; children: React.ReactNode; className?: string; hideHeader?: boolean }) {
  return (
    <div className={`rounded-2xl bg-card border border-border p-5 ${className}`}>
      {!hideHeader && (
        <div className="flex items-center gap-2 mb-4">
          <Icon className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-sm">{title}</h2>
        </div>
      )}
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
