import { useState, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { panel, panelAuth } from "@/lib/panelApi";
import {
  Menu, X, QrCode, Settings, Wrench, ShieldCheck,
  DatabaseBackup, ScrollText, LogOut, MessageCircle, ChevronLeft, HelpCircle,
  Users2, MessageSquare, Phone, CircleDashed, Loader2,
} from "lucide-react";

interface MenuItem {
  label: string;
  icon: typeof MessageSquare;
  path: string;
}

// Sidebar: only admin/utility items
const SIDEBAR_ITEMS: MenuItem[] = [
  { label: "WhatsApp Connect", icon: QrCode, path: "/connect" },
  { label: "Settings", icon: Settings, path: "/settings" },
  { label: "Auto Fix / Tools", icon: Wrench, path: "/tools" },
  { label: "Certificate", icon: ShieldCheck, path: "/certificate" },
  { label: "Backup & Restore", icon: DatabaseBackup, path: "/backup" },
  { label: "Logs", icon: ScrollText, path: "/logs" },
  { label: "Help & Support", icon: HelpCircle, path: "/help" },
];

// Bottom tab bar: WhatsApp-style main navigation
const TABS: MenuItem[] = [
  { label: "Chats", icon: MessageSquare, path: "/" },
  { label: "Groups", icon: Users2, path: "/groups" },
  { label: "Status", icon: CircleDashed, path: "/status" },
  { label: "Calls", icon: Phone, path: "/calls" },
];

export function useRequirePanelAuth() {
  const [, navigate] = useLocation();
  const [user, setUser] = useState<{ username: string } | null>(null);
  useEffect(() => {
    if (!panelAuth.get()) {
      navigate("/login");
      return;
    }
    panel.get("/panel/me")
      .then((r) => setUser({ username: r.username }))
      .catch((err: any) => {
        if (err?.status === 401 || err?.status === 403) {
          panelAuth.clear();
          navigate("/login");
        } else {
          setUser({ username: "" });
        }
      });
  }, []);
  return user;
}

export default function Shell({
  title,
  children,
  back,
  hideHeader,
  hideBottomTabs,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
  hideHeader?: boolean;
  hideBottomTabs?: boolean;
}) {
  const [location, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    panel.get("/panel/me").then((r) => setUsername(r.username)).catch(() => {});
  }, []);

  async function logout() {
    setLoggingOut(true);
    try {
      // Wipe WhatsApp session + panel auth in one go
      await panel.post("/panel/wa/full-logout");
    } catch {
      // Even if the API call fails, clear the local token
    } finally {
      panelAuth.clear();
      navigate("/login");
    }
  }

  return (
    <div className="h-[100dvh] bg-background flex flex-col max-w-md mx-auto relative overflow-hidden">
      {!hideHeader && (
        <header className="flex items-center gap-3 px-4 h-14 bg-wa-header text-white shrink-0 shadow-md z-10">
          {back ? (
            <button onClick={() => navigate("/")} className="-ml-1 p-1">
              <ChevronLeft className="w-6 h-6" />
            </button>
          ) : (
            <button onClick={() => setOpen(true)} className="-ml-1 p-1">
              <Menu className="w-6 h-6" />
            </button>
          )}
          <h1 className="text-lg font-semibold flex-1 truncate">{title}</h1>
        </header>
      )}

      <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {children}
      </main>

      {/* Bottom tab bar — WhatsApp style */}
      {!hideBottomTabs && (
        <nav className="shrink-0 flex items-center bg-wa-header border-t border-white/10 z-10">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = location === tab.path;
            return (
              <button
                key={tab.path}
                onClick={() => navigate(tab.path)}
                className={`relative flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 transition ${
                  active ? "text-white" : "text-white/50 hover:text-white/80"
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? "stroke-[2.5]" : ""}`} />
                <span className={`text-[10px] font-medium ${active ? "text-white" : "text-white/50"}`}>
                  {tab.label}
                </span>
                {active && (
                  <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-white rounded-t-full" />
                )}
              </button>
            );
          })}
        </nav>
      )}

      {/* Drawer overlay */}
      {open && <div className="fixed inset-0 bg-black/50 z-20" onClick={() => setOpen(false)} />}

      {/* Sidebar drawer — only utility items */}
      <aside
        className={`fixed top-0 left-0 h-full w-[82%] max-w-xs bg-sidebar z-30 transform transition-transform duration-300 ease-out flex flex-col ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="bg-wa-header text-white px-5 pt-6 pb-5">
          <div className="flex items-center justify-between">
            <div className="w-14 h-14 rounded-full bg-white/15 flex items-center justify-center">
              <MessageCircle className="w-7 h-7" />
            </div>
            <button onClick={() => setOpen(false)} className="p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
          <p className="mt-3 text-lg font-semibold">{username || "User"}</p>
          <p className="text-xs text-white/70">Online</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-2 wa-scroll">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.path}
                onClick={() => {
                  setOpen(false);
                  navigate(item.path);
                }}
                className="w-full flex items-center gap-4 px-5 py-3.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent transition text-left"
              >
                <Icon className="w-5 h-5 text-primary" />
                {item.label}
              </button>
            );
          })}
          <button
            onClick={logout}
            disabled={loggingOut}
            className="w-full flex items-center gap-4 px-5 py-3.5 text-sm text-destructive hover:bg-sidebar-accent transition text-left disabled:opacity-60"
          >
            {loggingOut ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
            {loggingOut ? "Logging out…" : "Logout"}
          </button>
        </nav>

        <div className="px-5 py-4 text-xs text-muted-foreground border-t border-sidebar-border">
          App Version 1.0.0
        </div>
      </aside>
    </div>
  );
}
