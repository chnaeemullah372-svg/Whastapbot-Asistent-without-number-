import Shell, { useRequirePanelAuth } from "./Shell";
import { HelpCircle, QrCode, Wrench, DatabaseBackup, ShieldCheck, MessageCircle } from "lucide-react";

const FAQ = [
  {
    icon: QrCode,
    q: "How do I connect WhatsApp?",
    a: "Go to WhatsApp Connect, then either scan the QR code or request a pairing code. Open WhatsApp on your phone → Linked Devices → Link a Device.",
  },
  {
    icon: Wrench,
    q: "My connection dropped. What now?",
    a: "Open Auto Fix / Tools and tap Auto Fix. If that fails, try Reconnect. As a last resort, Clear Session and scan the QR again.",
  },
  {
    icon: DatabaseBackup,
    q: "How do backups work?",
    a: "Backup & Restore lets you snapshot all chats and messages. You can download a backup file or restore a previous one anytime.",
  },
  {
    icon: ShieldCheck,
    q: "What is the Certificate page?",
    a: "It shows the status of your stored WhatsApp session credentials — the secure key that keeps you logged in.",
  },
];

export default function Help() {
  useRequirePanelAuth();
  return (
    <Shell title="Help & Support" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
        <div className="rounded-2xl bg-card border border-border p-5 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-primary/15 text-primary flex items-center justify-center mb-3">
            <HelpCircle className="w-8 h-8" />
          </div>
          <p className="font-semibold text-lg">How can we help?</p>
          <p className="text-xs text-muted-foreground mt-1">Common questions and quick guides.</p>
        </div>

        <div className="space-y-3">
          {FAQ.map((f, i) => {
            const Icon = f.icon;
            return (
              <div key={i} className="rounded-2xl bg-card border border-border p-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon className="w-4 h-4 text-primary" />
                  <p className="font-medium text-sm">{f.q}</p>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{f.a}</p>
              </div>
            );
          })}
        </div>

        <div className="rounded-2xl bg-accent text-accent-foreground border border-primary/30 p-4 flex items-center gap-3">
          <MessageCircle className="w-5 h-5 text-primary shrink-0" />
          <p className="text-xs">Still need help? Contact your system administrator.</p>
        </div>
      </div>
    </Shell>
  );
}
