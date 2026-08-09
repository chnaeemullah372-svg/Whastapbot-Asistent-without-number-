import { useState, useEffect } from "react";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel } from "@/lib/panelApi";
import { Loader2, Save, User, Bell, DatabaseBackup, Globe, CalendarClock, Trash2, Info, Palette, Check } from "lucide-react";
import { getTheme, setTheme, THEMES, type ThemeId } from "@/lib/theme";

interface Settings {
  notifications?: boolean;
  autoBackup?: boolean;
  backupSchedule?: string;
  theme?: string;
  language?: string;
  pairingBrandCode?: string;
}

export default function SettingsPage() {
  const user = useRequirePanelAuth();
  const [s, setS] = useState<Settings>({});
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [cacheCleared, setCacheCleared] = useState(false);
  const [theme, setThemeState] = useState<ThemeId>(getTheme());

  function clearCache() {
    for (const k of Object.keys(localStorage)) {
      if (
        k.startsWith("wa_") && !k.includes("token") &&
        k !== "wa_theme_vip" && k !== "wa_theme"
      ) {
        localStorage.removeItem(k);
      }
    }
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  }

  useEffect(() => {
    if (!user) return;
    panel.get("/panel/settings").then((r) => setS(r || {})).catch(() => {});
    panel.get("/panel/me").then((r) => setUsername(r.username)).catch(() => {});
  }, [user]);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      // The pairing-code brand is admin-only now; never send it from the user side.
      const { pairingBrandCode: _omit, ...payload } = s;
      await panel.put("/panel/settings", payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e?.message || "Save nahi hua, dobara try karein");
    }
    finally {
      setBusy(false);
    }
  }

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <Shell title="Settings" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
        <div className="rounded-2xl bg-card border border-border p-5">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/15 text-primary flex items-center justify-center">
              <User className="w-6 h-6" />
            </div>
            <div>
              <p className="font-semibold">{username}</p>
              <p className="text-xs text-muted-foreground">Account username</p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl bg-card border border-border divide-y divide-border">
          <Toggle
            icon={Bell}
            label="Notifications"
            desc="Get notified of new messages"
            value={!!s.notifications}
            onChange={(v) => set("notifications", v)}
          />
          <Toggle
            icon={DatabaseBackup}
            label="Auto Backup"
            desc="Automatically back up your chats"
            value={!!s.autoBackup}
            onChange={(v) => set("autoBackup", v)}
          />
        </div>

        {s.autoBackup && (
          <div className="rounded-2xl bg-card border border-border p-4">
            <div className="flex items-center gap-2 mb-2">
              <CalendarClock className="w-4 h-4 text-primary" />
              <p className="text-sm font-medium">Backup Schedule</p>
            </div>
            <select
              value={s.backupSchedule || "daily"}
              onChange={(e) => set("backupSchedule", e.target.value)}
              className="w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
        )}

        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 mb-2">
            <Globe className="w-4 h-4 text-primary" />
            <p className="text-sm font-medium">Language</p>
          </div>
          <select
            value={s.language || "English"}
            onChange={(e) => set("language", e.target.value)}
            className="w-full rounded-xl bg-background border border-border px-4 py-3 text-sm outline-none focus:border-primary"
          >
            <option value="English">English</option>
            <option value="Urdu">Urdu</option>
            <option value="Roman Urdu">Roman Urdu</option>
          </select>
        </div>

        <div className="rounded-2xl bg-card border border-border p-4">
          <div className="flex items-center gap-2 mb-3">
            <Palette className="w-4 h-4 text-primary" />
            <p className="text-sm font-medium">Theme</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTheme(t.id); setThemeState(t.id); }}
                className={`relative flex items-center gap-3 rounded-xl border p-3 text-left transition ${
                  theme === t.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/50"
                }`}
              >
                <span className="flex shrink-0 -space-x-1.5">
                  <span className="w-5 h-5 rounded-full border border-black/10" style={{ background: t.swatch[0] }} />
                  <span className="w-5 h-5 rounded-full border border-black/10" style={{ background: t.swatch[1] }} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium truncate">{t.label}</span>
                  <span className="block text-xs text-muted-foreground truncate">{t.desc}</span>
                </span>
                {theme === t.id && <Check className="w-4 h-4 text-primary absolute top-2 right-2" />}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="rounded-2xl bg-card border border-border divide-y divide-border">
          <button onClick={clearCache} className="w-full flex items-center gap-3 p-4 text-left">
            <Trash2 className="w-5 h-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium">Clear Cache</p>
              <p className="text-xs text-muted-foreground">Free up local storage on this device</p>
            </div>
            {cacheCleared && <span className="text-xs text-primary">Cleared</span>}
          </button>
        </div>

        <div className="rounded-2xl bg-card border border-border p-4 flex items-center gap-3">
          <Info className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">About</p>
            <p className="text-xs text-muted-foreground">Support Connect · v1.0.0</p>
          </div>
        </div>

        <button
          onClick={save}
          disabled={busy}
          className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saved ? "Saved!" : "Save Settings"}
        </button>
      </div>
    </Shell>
  );
}

function Toggle({
  icon: Icon, label, desc, value, onChange,
}: {
  icon: typeof Bell; label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      <Icon className="w-5 h-5 text-primary shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        className={`w-11 h-6 rounded-full transition relative shrink-0 ${value ? "bg-primary" : "bg-muted"}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${value ? "left-[22px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}
