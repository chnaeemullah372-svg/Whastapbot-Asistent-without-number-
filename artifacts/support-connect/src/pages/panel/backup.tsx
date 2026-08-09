import { useState, useEffect, useCallback } from "react";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel, fmtBytes, type BackupMeta } from "@/lib/panelApi";
import { DatabaseBackup, Download, RotateCcw, Loader2, Plus, FileArchive, CalendarClock } from "lucide-react";

interface Settings {
  autoBackup?: boolean;
  backupSchedule?: string;
}

export default function Backup() {
  const user = useRequirePanelAuth();
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [s, setS] = useState<Settings>({});

  const load = useCallback(() => {
    panel.get("/panel/backups").then((r) => setBackups(r || [])).catch(() => {});
    panel.get("/panel/settings").then((r) => setS(r || {})).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  const lastBackup = backups[0];

  async function create() {
    setBusy(true);
    setMsg("");
    try {
      await panel.post("/panel/backup");
      setMsg("Backup created successfully.");
      load();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: number) {
    if (!window.confirm("Restore this backup? Current chats will be replaced.")) return;
    setRestoring(id);
    setMsg("");
    try {
      await panel.post(`/panel/backups/${id}/restore`);
      setMsg("Backup restored successfully.");
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setRestoring(null);
    }
  }

  async function download(id: number, filename: string) {
    try {
      const res = await panel.raw(`/panel/backups/${id}/download`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  }

  async function saveSettings(next: Settings) {
    setS(next);
    try {
      await panel.put("/panel/settings", next);
    } catch {}
  }

  return (
    <Shell title="Backup & Restore" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
        {/* Hero / create */}
        <div className="rounded-3xl bg-gradient-to-b from-card to-background border border-border p-6 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto rounded-full bg-primary/15 text-primary flex items-center justify-center mb-3 ring-4 ring-primary/10">
            <DatabaseBackup className="w-8 h-8" />
          </div>
          <p className="font-bold text-lg">Backup Your Chats</p>
          <p className="text-xs text-muted-foreground mt-1">
            {lastBackup ? `Last backup: ${new Date(lastBackup.createdAt).toLocaleString()}` : "No backups yet — create your first one."}
          </p>
          <button
            onClick={create}
            disabled={busy}
            className="mt-4 w-full rounded-2xl bg-primary text-primary-foreground font-semibold py-3.5 flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Backup Now
          </button>
        </div>

        {msg && <p className="text-sm text-center text-primary">{msg}</p>}

        {/* Auto backup */}
        <div className="rounded-2xl bg-card border border-border p-4 space-y-3">
          <div className="flex items-center gap-3">
            <CalendarClock className="w-5 h-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Auto Backup</p>
              <p className="text-xs text-muted-foreground">Automatically back up your chats on a schedule</p>
            </div>
            <button
              onClick={() => saveSettings({ ...s, autoBackup: !s.autoBackup })}
              className={`w-11 h-6 rounded-full transition relative shrink-0 ${s.autoBackup ? "bg-primary" : "bg-muted"}`}
            >
              <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${s.autoBackup ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </div>
          {s.autoBackup && (
            <select
              value={s.backupSchedule || "daily"}
              onChange={(e) => saveSettings({ ...s, backupSchedule: e.target.value })}
              className="w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          )}
        </div>

        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
            Saved Backups
          </p>
          {backups.length === 0 ? (
            <div className="rounded-2xl bg-card border border-border p-8 text-center text-muted-foreground">
              <FileArchive className="w-10 h-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No backups yet.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {backups.map((b) => (
                <div key={b.id} className="rounded-2xl bg-card border border-border p-4">
                  <div className="flex items-center gap-3">
                    <FileArchive className="w-5 h-5 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.filename}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(b.createdAt).toLocaleString()} · {fmtBytes(b.sizeBytes)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {b.chatCount} chats · {b.messageCount} messages
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => download(b.id, b.filename)}
                      className="flex-1 rounded-lg bg-muted text-sm font-medium py-2 flex items-center justify-center gap-1.5"
                    >
                      <Download className="w-4 h-4" /> Download
                    </button>
                    <button
                      onClick={() => restore(b.id)}
                      disabled={restoring === b.id}
                      className="flex-1 rounded-lg bg-primary/15 text-primary text-sm font-medium py-2 flex items-center justify-center gap-1.5 disabled:opacity-60"
                    >
                      {restoring === b.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
