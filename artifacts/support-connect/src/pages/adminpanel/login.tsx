import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { admin, adminAuth } from "@/lib/panelApi";
import { ShieldCheck, Loader2, Eye, EyeOff } from "lucide-react";

export default function AdminLogin() {
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (adminAuth.get()) navigate("/admin");
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await admin.post("/admin/login", { username, password });
      adminAuth.set(r.token);
      navigate("/admin");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30 mb-4">
            <ShieldCheck className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold">Admin Panel</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to manage the system</p>
        </div>

        {error && (
          <div className="mb-4 text-sm rounded-lg bg-destructive/15 text-destructive px-4 py-3 border border-destructive/30">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              className="mt-1 w-full rounded-xl bg-card border border-border px-4 py-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Password</label>
            <div className="relative mt-1">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl bg-card border border-border px-4 py-3 pr-11 text-sm outline-none focus:border-primary"
              />
              <button type="button" onClick={() => setShowPw((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
