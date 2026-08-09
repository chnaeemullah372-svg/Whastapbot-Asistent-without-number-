import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { panel, panelAuth } from "@/lib/panelApi";
import { MessageCircle, Eye, EyeOff, Loader2 } from "lucide-react";

export default function PanelLogin() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (panelAuth.get()) navigate("/");
    panel.get("/panel/exists").then((r: any) => {
      if (!r.exists) setMode("signup");
    }).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    if (mode === "signup" && password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        await panel.post("/panel/signup", { username, password });
        setNotice("Account created. Waiting for admin approval before you can log in.");
        setMode("login");
        setPassword("");
        setConfirm("");
      } else {
        const r = await panel.post("/panel/login", { username, password });
        panelAuth.set(r.token);
        navigate("/");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-10 bg-background">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/30 mb-5">
            <MessageCircle className="w-10 h-10 text-primary-foreground" strokeWidth={2.2} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            {mode === "login" ? "Welcome Back!" : "Create New User"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            {mode === "login" ? "Login to continue to your chat" : "Create your account to get started"}
          </p>
        </div>

        {notice && (
          <div className="mb-4 text-sm rounded-lg bg-accent text-accent-foreground px-4 py-3 border border-primary/30">
            {notice}
          </div>
        )}
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
              placeholder="Enter username"
              autoCapitalize="none"
              className="mt-1 w-full rounded-xl bg-card border border-border px-4 py-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Password</label>
            <div className="relative mt-1">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full rounded-xl bg-card border border-border px-4 py-3 pr-11 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          {mode === "signup" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Confirm Password</label>
              <input
                type={showPw ? "text" : "password"}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter password"
                className="mt-1 w-full rounded-xl bg-card border border-border px-4 py-3 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-primary text-primary-foreground font-semibold py-3 flex items-center justify-center gap-2 hover:opacity-95 active:scale-[0.99] transition disabled:opacity-60"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {mode === "login" ? "Login" : "Create Account"}
          </button>
        </form>

        <p className="text-center text-sm text-muted-foreground mt-6">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button onClick={() => { setMode("signup"); setError(""); setNotice(""); }} className="text-primary font-semibold">
                Sign Up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => { setMode("login"); setError(""); setNotice(""); }} className="text-primary font-semibold">
                Login
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
