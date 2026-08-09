import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel, panelAuth, fmtTime, fmtClock, type StatusGroup } from "@/lib/panelApi";
import { CircleDashed, X } from "lucide-react";

// Some text rows are just emoji placeholders the engine stores for media-only
// posts; hide them when the post already shows its media.
const PLACEHOLDER_RE = /^(\u{1F4F7}|\u{1F4F9}|\u{1F3B5}|\u{1F4C4}|\u{1F4CE})/u;

export default function Status() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<StatusGroup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<StatusGroup | null>(null);

  const handleAuthError = useCallback((err: any) => {
    if (err?.status === 401) {
      panelAuth.clear();
      navigate("/login");
    }
  }, [navigate]);

  const load = useCallback(() => {
    panel.get("/panel/status")
      .then((r) => { setGroups(r || []); setLoaded(true); })
      .catch(handleAuthError);
  }, [handleAuthError]);

  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [user, load]);

  // New status posts arrive as normal messages on the SSE stream.
  useEffect(() => {
    if (!user) return;
    const es = new EventSource(panel.eventsUrl());
    es.addEventListener("message", () => load());
    return () => es.close();
  }, [user, load]);

  return (
    <Shell title="Status">
      <div className="flex flex-col h-full">
        <div className="flex-1 overflow-y-auto wa-scroll">
          {!loaded ? null : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 text-muted-foreground">
              <CircleDashed className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">Abhi koi status update nahi.</p>
              <p className="text-xs mt-1">Aapke contacts ki stories yahan dikhengi.</p>
            </div>
          ) : (
            <>
              <p className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Recent updates
              </p>
              {groups.map((g) => {
                const label = g.name || (g.phone ? `+${g.phone}` : "Unknown");
                const initial = (g.name ? label.charAt(0) : (g.phone.charAt(0) || "?")).toUpperCase();
                return (
                  <button
                    key={g.participant}
                    onClick={() => setActive(g)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition text-left border-b border-border/40"
                  >
                    <div className="w-12 h-12 rounded-full ring-2 ring-primary p-0.5 shrink-0">
                      <div className="w-full h-full rounded-full bg-primary/20 text-primary flex items-center justify-center font-semibold">
                        {initial}
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium truncate block">{label}</span>
                      <span className="text-xs text-muted-foreground">
                        {g.count} update{g.count > 1 ? "s" : ""} · {fmtTime(g.latestTs)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
      {active && <StatusViewer group={active} onClose={() => setActive(null)} />}
    </Shell>
  );
}

function StatusViewer({ group, onClose }: { group: StatusGroup; onClose: () => void }) {
  const items = group.items.filter((it) => !it.deleted);
  const [idx, setIdx] = useState(0);
  const item = items[idx];

  // If everything in this group was deleted-for-everyone, close the viewer.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  if (!item) return null;
  const label = group.name || (group.phone ? `+${group.phone}` : "Unknown");
  const initial = (group.name ? label.charAt(0) : (group.phone.charAt(0) || "?")).toUpperCase();
  const url = panel.mediaUrl(item.waMessageId);
  const next = () => (idx < items.length - 1 ? setIdx(idx + 1) : onClose());
  const prev = () => idx > 0 && setIdx(idx - 1);
  const showText = item.text && !PLACEHOLDER_RE.test(item.text);

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col max-w-md mx-auto">
      {/* progress segments */}
      <div className="flex gap-1 px-2 pt-2 shrink-0">
        {items.map((_, i) => (
          <div key={i} className={`h-1 flex-1 rounded-full ${i <= idx ? "bg-white" : "bg-white/30"}`} />
        ))}
      </div>
      {/* header */}
      <div className="flex items-center gap-3 px-4 py-2 text-white shrink-0">
        <div className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center font-semibold">
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{label}</p>
          <p className="text-xs text-white/60">{fmtClock(item.ts)}</p>
        </div>
        <button onClick={onClose} className="p-1" aria-label="Close"><X className="w-6 h-6" /></button>
      </div>
      {/* body */}
      <div className="flex-1 relative flex items-center justify-center overflow-hidden">
        <button onClick={prev} className="absolute left-0 top-0 h-full w-1/3 z-10" aria-label="Previous" />
        <button onClick={next} className="absolute right-0 top-0 h-full w-2/3 z-10" aria-label="Next" />
        {item.hasMedia && (item.mediaKind === "image" || item.mediaKind === "sticker") ? (
          <img src={url} alt="" className="max-h-full max-w-full object-contain" />
        ) : item.hasMedia && item.mediaKind === "video" ? (
          <video src={url} autoPlay controls className="max-h-full max-w-full" />
        ) : item.hasMedia && item.mediaKind === "audio" ? (
          <div className="px-8 w-full"><audio src={url} controls className="w-full" /></div>
        ) : null}
        {showText && (
          <p className="absolute left-0 right-0 bottom-20 px-6 text-center text-white text-lg whitespace-pre-wrap break-words">
            {item.text}
          </p>
        )}
        {!item.hasMedia && !showText && <p className="text-white/50">Status</p>}
      </div>
    </div>
  );
}
