import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel, type SessionInfo } from "@/lib/panelApi";
import { ShieldCheck, ShieldAlert, Loader2, Smartphone, Clock, FolderKey, RefreshCw, Trash2 } from "lucide-react";

export default function Certificate() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"refresh" | "delete" | null>(null);

  const load = useCallback(() => {
    return panel.get("/panel/wa/certificate")
      .then(setInfo)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  async function refresh() {
    setBusy("refresh");
    setLoading(true);
    await load();
    setBusy(null);
  }

  async function deleteReconnect() {
    if (!window.confirm("Delete this certificate and reconnect? You'll need to link WhatsApp again.")) return;
    setBusy("delete");
    try {
      await panel.post("/panel/wa/fix");
      navigate("/connect");
    } catch {
      setBusy(null);
    }
  }

  const valid = info?.hasCredentials && info?.status === "connected";

  return (
    <Shell title="Certificate" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
        <div className="rounded-3xl bg-gradient-to-b from-card to-background border border-border p-6 text-center shadow-sm">
          {loading ? (
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-3 ring-4 ${valid ? "bg-primary/15 ring-primary/20" : "bg-destructive/15 ring-destructive/20"}`}>
                {valid ? <ShieldCheck className="w-8 h-8 text-primary" /> : <ShieldAlert className="w-8 h-8 text-destructive" />}
              </div>
              <p className="font-bold text-lg">{valid ? "Certificate Valid" : "No Active Certificate"}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {valid ? "Your session credentials are stored and active." : "Connect WhatsApp to generate session credentials."}
              </p>
            </>
          )}
        </div>

        {info && (
          <div className="rounded-2xl bg-card border border-border divide-y divide-border">
            <Row icon={Smartphone} label="Phone Number" value={info.phoneNumber ? `+${info.phoneNumber.replace(/^\+/, "")}` : "—"} />
            <Row icon={ShieldCheck} label="Status" value={info.status} />
            <Row icon={FolderKey} label="Credentials Stored" value={info.hasCredentials ? "Yes" : "No"} />
            <Row
              icon={Clock}
              label="Created / Connected"
              value={info.connectedAt ? new Date(info.connectedAt).toLocaleString() : "—"}
            />
            <Row
              icon={Clock}
              label="Last Updated"
              value={info.credentialsUpdatedAt ? new Date(info.credentialsUpdatedAt).toLocaleString() : "—"}
            />
          </div>
        )}

        {info?.lastError && (
          <div className="rounded-xl bg-destructive/10 text-destructive text-sm p-4">{info.lastError}</div>
        )}

        <div className="space-y-3 pt-1">
          <button
            onClick={refresh}
            disabled={busy !== null}
            className="w-full rounded-2xl bg-primary text-primary-foreground font-semibold py-3.5 flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
          >
            {busy === "refresh" ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh Certificate
          </button>
          <button
            onClick={deleteReconnect}
            disabled={busy !== null}
            className="w-full rounded-2xl bg-destructive/15 text-destructive font-semibold py-3.5 flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
          >
            {busy === "delete" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Delete &amp; Reconnect
          </button>
        </div>
      </div>
    </Shell>
  );
}

function Row({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 p-4">
      <Icon className="w-5 h-5 text-primary shrink-0" />
      <span className="text-sm text-muted-foreground flex-1">{label}</span>
      <span className="text-sm font-medium text-right capitalize">{value}</span>
    </div>
  );
}
