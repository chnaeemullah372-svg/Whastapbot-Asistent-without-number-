import { useState, useEffect, type ReactNode } from "react";
import { useLocation } from "wouter";
import { panel, panelAuth } from "@/lib/panelApi";
import {
  Menu, X, LayoutDashboard, QrCode, Settings, Wrench, ShieldCheck,
  DatabaseBackup, ScrollText, LogOut, MessageCircle, ChevronLeft, HelpCircle,
  Phone, CircleDashed,
} from "lucide-react";

interface MenuItem {
  label: string;
  icon: typeof LayoutDashboard;
  path: string;
}

const ITEMS: MenuItem[] = [
  { label: "Dashboard", icon: LayoutDashboard, path: "/" },
  { label: "Calls", icon: Phone, path: "/calls" },
  { label: "Status", icon: CircleDashed, path: "/status" },
  { label: "WhatsApp Connect", icon: QrCode, path: "/connect" },
  { label: "Settings", icon: Settings, path: "/settings" },
  { label: "Auto Fix / Tools", icon: Wrench, path: "/tools" },
  { label: "Certificate", icon: ShieldCheck, path: "/certificate" },
  { label: "Backup & Restore", icon: DatabaseBackup, path: "/backup" },
  { label: "Logs", icon: ScrollText, path: "/logs" },
  { label: "Help & Support", icon: HelpCircle, path: "/help" },
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
        // Only force a logout if the token is genuinely rejected (401/403).
        // Transient failures (server restarting, network blip) must NOT log the
        // user out — the session stays valid as long as the token is accepted.
        if (err?.status === 401 || err?.status === 403) {
          panelAuth.clear();
          navigate("/login");
        } else {
          // Keep the session; show the panel optimistically and let polling recover.
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
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
  hideHeader?: boolean;
}) {
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    panel.get("/panel/me").then((r) => setUsername(r.username)).catch(() => {});
  }, []);

  function logout() {
    panelAuth.clear();
    navigate("/login");
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

      <main className="flex-1 min-h-0 flex flex-col">{children}</main>

      {/* Drawer overlay */}
      {open && <div className="fixed inset-0 bg-black/50 z-20" onClick={() => setOpen(false)} />}

      {/* Drawer */}
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
          {ITEMS.map((item) => {
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
            className="w-full flex items-center gap-4 px-5 py-3.5 text-sm text-destructive hover:bg-sidebar-accent transition text-left"
          >
            <LogOut className="w-5 h-5" />
            Logout
          </button>
        </nav>

        <div className="px-5 py-4 text-xs text-muted-foreground border-t border-sidebar-border">
          App Version 1.0.0
        </div>
      </aside>
    </div>
  );
}
