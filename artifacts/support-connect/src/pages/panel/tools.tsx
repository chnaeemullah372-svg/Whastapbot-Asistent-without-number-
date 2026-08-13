import { useState } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel } from "@/lib/panelApi";
import {
  Wrench, RefreshCw, Trash2, Loader2, CheckCircle2, AlertTriangle,
  Activity, RotateCw, KeyRound, ShieldCheck, ServerCrash,
} from "lucide-react";

interface ToolDef {
  key: string;
  label: string;
  desc: string;
  icon: typeof Wrench;
  action: string;
  method: "get" | "post";
  endpoint: string;
  danger?: boolean;
  confirm?: string;
  navigateTo?: string;       // navigate after success
  reloadAfterMs?: number;    // auto-reload page after N ms (for server restart)
}

const TOOLS: ToolDef[] = [
  {
    key: "server-restart",
    label: "Restart Server",
    desc: "Restart all PM2 processes and reload the panel — use after a new deployment.",
    icon: ServerCrash,
    action: "Restart",
    method: "post",
    endpoint: "/panel/server/restart",
    confirm: "This will restart the server. The page will auto-reload in ~10 seconds. Continue?",
    reloadAfterMs: 10000,
  },
  {
    key: "check",
    label: "Connection Checker",
    desc: "Check your current WhatsApp connection status.",
    icon: Activity,
    action: "Check",
    method: "get",
    endpoint: "/panel/wa/certificate",
  },
  {
    key: "reconnect",
    label: "Reconnect WhatsApp",
    desc: "Reconnect using your saved credentials.",
    icon: RefreshCw,
    action: "Reconnect",
    method: "post",
    endpoint: "/panel/wa/connect-qr",
  },
  {
    key: "restart",
    label: "Restart WhatsApp Service",
    desc: "Restart the WhatsApp socket without losing your session.",
    icon: RotateCw,
    action: "Restart",
    method: "post",
    endpoint: "/panel/wa/restart",
  },
  {
    key: "clear",
    label: "Clear Session Data",
    desc: "Remove the active session. You'll need to link again.",
    icon: Trash2,
    action: "Clear",
    method: "post",
    endpoint: "/panel/wa/clear",
    danger: true,
    confirm: "This clears your WhatsApp session. You'll need to reconnect. Continue?",
    navigateTo: "/connect",
  },
  {
    key: "delete-auth",
    label: "Delete Auth & Reconnect",
    desc: "Wipe credentials completely and start fresh with a new QR / pairing code.",
    icon: KeyRound,
    action: "Delete",
    method: "post",
    endpoint: "/panel/wa/fix",
    danger: true,
    confirm: "This deletes ALL authentication data and starts a fresh link. Continue?",
    navigateTo: "/connect",
  },
];

export default function Tools() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  async function run(t: ToolDef) {
    if (t.confirm && !window.confirm(t.confirm)) return;
    setBusy(t.key);
    setResult(null);
    try {
      const r = t.method === "get" ? await panel.get(t.endpoint) : await panel.post(t.endpoint);
      let msg = `${t.label} completed successfully.`;
      if (t.key === "check" && r?.status) {
        msg = `Connection status: ${String(r.status).replace("_", " ")}${r.hasCredentials ? " · credentials stored" : ""}.`;
      }
      if (t.key === "server-restart") {
        msg = r?.message ?? msg;
      }
      setResult({ ok: true, msg });

      // Auto-reload after server restart
      if (t.reloadAfterMs) {
        setTimeout(() => window.location.reload(), t.reloadAfterMs);
      }
      // Navigate after destructive ops
      if (t.navigateTo) {
        setTimeout(() => navigate(t.navigateTo!), 800);
      }
    } catch (e: any) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Shell title="Auto Fix / Tools" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-4">
        <div className="rounded-2xl bg-primary/10 border border-primary/20 p-4 flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-primary/20 text-primary flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <p className="text-sm text-foreground/80 leading-relaxed">
            Facing any connection or login issue? Use these tools to diagnose and repair your WhatsApp link.
          </p>
        </div>

        {result && (
          <div className={`rounded-xl p-4 text-sm flex items-start gap-2 ${result.ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"}`}>
            {result.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
            {result.msg}
          </div>
        )}

        <div className="space-y-3">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <div key={t.key} className="rounded-2xl bg-card border border-border p-4 flex items-center gap-3">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${t.danger ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`font-semibold text-sm ${t.danger ? "text-destructive" : ""}`}>{t.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{t.desc}</p>
                </div>
                <button
                  onClick={() => run(t)}
                  disabled={busy !== null}
                  className={`shrink-0 rounded-lg font-semibold py-2 px-4 text-xs flex items-center justify-center gap-1.5 disabled:opacity-50 active:scale-95 transition ${
                    t.danger ? "bg-destructive/15 text-destructive" : "bg-primary text-primary-foreground"
                  }`}
                >
                  {busy === t.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {t.action}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
