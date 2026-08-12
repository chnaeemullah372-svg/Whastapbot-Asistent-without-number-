import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import Shell, { useRequirePanelAuth } from "./Shell";
import { Avatar } from "@/components/avatar";
import { panel, fmtTime, displayName, type WAChat } from "@/lib/panelApi";
import { Star, Loader2, Users2 } from "lucide-react";

interface StarredMessage {
  id: number;
  waMessageId: string;
  jid: string;
  text: string;
  fromMe: boolean;
  ts: number;
  mediaKind: string | null;
  fileName: string | null;
  hasMedia: boolean;
}

export default function Starred() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const [items, setItems] = useState<StarredMessage[]>([]);
  const [chats, setChats] = useState<WAChat[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([panel.get("/panel/starred"), panel.get("/panel/chats")])
      .then(([starred, allChats]) => { setItems(starred || []); setChats(allChats || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  async function unstar(waMessageId: string, jid: string) {
    try {
      await panel.post(`/panel/chats/${encodeURIComponent(jid)}/${encodeURIComponent(waMessageId)}/star`, { starred: false });
      load();
    } catch {}
  }

  const chatByJid = new Map(chats.map((c) => [c.jid, c]));

  return (
    <Shell title="Starred messages" back>
      <div className="flex-1 overflow-y-auto wa-scroll">
        {loading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground text-center px-8">
            <Star className="w-10 h-10 mb-2 opacity-40" />
            <p className="text-sm">No starred messages yet.</p>
            <p className="text-xs mt-1">Tap a message and choose Star to keep it here.</p>
          </div>
        ) : (
          items.map((m) => {
            const c = chatByJid.get(m.jid);
            const isGroup = m.jid.endsWith("@g.us");
            const label = isGroup ? (c?.name || "Group") : displayName(c?.name, c?.phone ?? m.jid.split("@")[0]);
            const preview = m.hasMedia
              ? (m.mediaKind === "image" ? "📷 Photo" : m.mediaKind === "video" ? "📹 Video" :
                 m.mediaKind === "audio" ? "🎵 Voice message" : `📄 ${m.fileName ?? "Document"}`)
              : m.text;
            return (
              <button
                key={m.waMessageId}
                onClick={() => navigate(isGroup ? "/groups" : "/")}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-card/60 transition text-left border-b border-border/40"
              >
                <Avatar url={c?.avatarUrl} label={label} icon={isGroup ? <Users2 className="w-5 h-5" /> : undefined} size={44} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate">{label}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{fmtTime(m.ts)}</span>
                  </div>
                  <p className="text-sm text-muted-foreground truncate">{m.fromMe ? "You: " : ""}{preview}</p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); unstar(m.waMessageId, m.jid); }}
                  className="p-1 shrink-0"
                  aria-label="Unstar"
                >
                  <Star className="w-4 h-4 fill-current text-primary" />
                </button>
              </button>
            );
          })
        )}
      </div>
    </Shell>
  );
}
