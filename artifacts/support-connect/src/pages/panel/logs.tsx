import { useState, useEffect, useCallback } from "react";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel, type AppLog } from "@/lib/panelApi";
import { ScrollText, RefreshCw, Loader2 } from "lucide-react";

const LEVEL_COLOR: Record<string, string> = {
  info: "text-sky-400 bg-sky-400/10",
  warn: "text-yellow-400 bg-yellow-400/10",
  error: "text-destructive bg-destructive/10",
  success: "text-primary bg-primary/10",
};

export default function Logs() {
  const user = useRequirePanelAuth();
  const [logs, setLogs] = useState<AppLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(() => {
    panel.get("/panel/logs")
      .then((r) => setLogs(r || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [user, load]);

  const levels = ["all", "info", "success", "warn", "error"];
  const shown = filter === "all" ? logs : logs.filter((l) => l.level === filter);

  return (
    <Shell title="Logs" back>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 p-3 overflow-x-auto wa-scroll shrink-0 border-b border-border">
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => setFilter(l)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium capitalize whitespace-nowrap transition ${
                filter === l ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              }`}
            >
              {l}
            </button>
          ))}
          <button onClick={load} className="ml-auto p-1.5 text-muted-foreground shrink-0">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto wa-scroll p-3 space-y-2 font-mono text-xs">
          {loading ? (
            <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <ScrollText className="w-10 h-10 mb-2 opacity-40" />
              <p className="text-sm">No logs to show.</p>
            </div>
          ) : (
            shown.map((l) => (
              <div key={l.id} className="rounded-lg bg-card border border-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 rounded uppercase font-bold text-[10px] ${LEVEL_COLOR[l.level] || "text-muted-foreground bg-muted"}`}>
                    {l.level}
                  </span>
                  <span className="text-muted-foreground">{l.source}</span>
                  <span className="ml-auto text-muted-foreground">{new Date(l.createdAt).toLocaleTimeString()}</span>
                </div>
                <p className="text-foreground/90 break-words whitespace-pre-wrap">{l.message}</p>
              </div>
            ))
          )}
        </div>
      </div>
    </Shell>
  );
}
