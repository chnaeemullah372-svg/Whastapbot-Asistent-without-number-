import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import Shell, { useRequirePanelAuth } from "./Shell";
import { panel, type WAStatus, type WAState } from "@/lib/panelApi";
import { QrCode, Smartphone, Loader2, CheckCircle2, RefreshCw, Power, AlertTriangle, Copy, Check, Wifi, MessageCircle } from "lucide-react";

/** Official WhatsApp glyph (lucide dropped brand icons). */
function WhatsAppLogo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38c1.45.79 3.08 1.21 4.79 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2zm0 18.15c-1.52 0-3.01-.41-4.31-1.18l-.31-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 0 1-1.26-4.35c0-4.54 3.7-8.24 8.24-8.24 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43-.14-.01-.31-.01-.48-.01-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z" />
    </svg>
  );
}

/** Convert any local/international format to digits-only international.
 *  0300-1234567 → 923001234567, 0092… → 92…, +92… → 92… */
function normalizeNum(input: string): string {
  let d = (input || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "92" + d.slice(1);
  return d;
}

export default function Connect() {
  const user = useRequirePanelAuth();
  const [, navigate] = useLocation();
  const firstConnected = useRef<boolean | null>(null);
  const [state, setState] = useState<WAState | null>(null);
  const [mode, setMode] = useState<"qr" | "phone">("phone");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [qrDataUrl, setQrDataUrl] = useState("");

  const refresh = useCallback(() => {
    panel.get("/panel/wa/status").then((st) => {
      setState(st);
      // Record whether WhatsApp was ALREADY linked when this screen first loaded,
      // so we only auto-jump to chats after a *fresh* link (not when the user
      // opened Connect on purpose to disconnect).
      if (firstConnected.current === null) firstConnected.current = st?.status === "connected";
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [user, refresh]);

  // countdown ticker for the live code/QR
  useEffect(() => {
    if (seconds <= 0) return;
    const t = setInterval(() => setSeconds((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [seconds]);

  // render QR locally (never send the pairing payload to a third party)
  useEffect(() => {
    if (!state?.qr) {
      setQrDataUrl("");
      return;
    }
    QRCode.toDataURL(state.qr, { width: 240, margin: 1, errorCorrectionLevel: "M" })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(""));
  }, [state?.qr]);

  const status: WAStatus = state?.status || "disconnected";
  const connected = status === "connected";

  // After a fresh link, glide to the chats inbox like WhatsApp Web.
  useEffect(() => {
    if (!(firstConnected.current === false && connected)) return undefined;
    const t = setTimeout(() => navigate("/"), 1500);
    return () => clearTimeout(t);
  }, [connected, navigate]);

  // switch to the QR tab and auto-generate a fresh code if none is showing
  function openQrTab() {
    setMode("qr");
    if (!connected && !state?.qr && status !== "connecting") connectQr();
  }

  async function connectQr() {
    setBusy(true);
    setError("");
    try {
      await panel.post("/panel/wa/connect-qr");
      setSeconds(60);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function connectPhone() {
    const clean = normalizeNum(phone);
    if (clean.length < 8) {
      setError("Enter a valid number with country code");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await panel.post("/panel/wa/connect-phone", { phone: clean });
      setSeconds(60);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await panel.post("/panel/wa/disconnect");
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function copyCode() {
    if (!state?.pairingCode) return;
    navigator.clipboard?.writeText(state.pairingCode.replace(/[^A-Z0-9]/gi, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Shell title="WhatsApp Connect" back>
      <div className="flex-1 overflow-y-auto wa-scroll p-5 space-y-5">
        {/* Status hero */}
        <div className="rounded-3xl bg-gradient-to-b from-card to-background border border-border p-6 text-center shadow-sm">
          <div
            className={`w-20 h-20 mx-auto rounded-full flex items-center justify-center mb-4 ring-4 ${
              connected ? "bg-primary/15 ring-primary/20" : "bg-muted ring-border/40"
            }`}
          >
            {connected ? (
              <CheckCircle2 className="w-10 h-10 text-primary" />
            ) : status === "connecting" ? (
              <Loader2 className="w-9 h-9 text-primary animate-spin" />
            ) : (
              <WhatsAppLogo className="w-11 h-11 text-[#25D366]" />
            )}
          </div>
          <p className="font-bold text-xl tracking-tight">
            {connected ? "WhatsApp Connected" :
             status === "connecting" ? "Connecting…" :
             status === "qr_ready" ? "Scan the QR Code" :
             status === "pairing" ? "Enter Pairing Code" : "Not Connected"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            {connected && state?.phoneNumber
              ? state.phoneNumber
              : "Link your WhatsApp account to start chatting"}
          </p>
          {state?.lastError && !connected && (
            <p className="text-xs text-destructive mt-3 flex items-center justify-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {state.lastError}
            </p>
          )}
        </div>

        {error && (
          <div className="rounded-xl bg-destructive/10 text-destructive text-sm p-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}

        {connected ? (
          <div className="space-y-3">
            <button
              onClick={() => navigate("/")}
              className="w-full rounded-2xl bg-primary text-primary-foreground font-semibold py-4 flex items-center justify-center gap-2 active:scale-[0.99] transition"
            >
              <MessageCircle className="w-5 h-5" /> Open Chats
            </button>
            <button
              onClick={disconnect}
              disabled={busy}
              className="w-full rounded-2xl bg-destructive/15 text-destructive font-semibold py-4 flex items-center justify-center gap-2 active:scale-[0.99] transition"
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Power className="w-5 h-5" />}
              Disconnect WhatsApp
            </button>
          </div>
        ) : (
          <>
            {/* Mode toggle */}
            <div className="flex rounded-2xl bg-muted p-1">
              <button
                onClick={openQrTab}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition ${mode === "qr" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
              >
                <QrCode className="w-4 h-4" /> QR Code
              </button>
              <button
                onClick={() => setMode("phone")}
                className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition ${mode === "phone" ? "bg-card shadow text-foreground" : "text-muted-foreground"}`}
              >
                <Smartphone className="w-4 h-4" /> Pairing Code
              </button>
            </div>

            {mode === "qr" ? (
              <div className="rounded-3xl bg-card border border-border p-6 flex flex-col items-center">
                {state?.qr && qrDataUrl ? (
                  <>
                    <div className="bg-white p-4 rounded-2xl shadow-inner">
                      <img src={qrDataUrl} alt="WhatsApp QR" width={240} height={240} />
                    </div>
                    {seconds > 0 && (
                      <p className="text-xs text-primary font-medium mt-4">
                        Code refreshes in {seconds}s — scan now
                      </p>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center py-10 text-muted-foreground">
                    {busy || status === "connecting" || status === "qr_ready" ? (
                      <>
                        <Loader2 className="w-9 h-9 animate-spin mb-3 text-primary" />
                        <p className="text-sm">Generating QR code…</p>
                      </>
                    ) : (
                      <>
                        <QrCode className="w-12 h-12 mb-3 opacity-30" />
                        <p className="text-sm">Tap below to generate a QR code.</p>
                      </>
                    )}
                  </div>
                )}

                <div className="w-full mt-5 rounded-2xl bg-muted/60 p-4 text-xs text-muted-foreground leading-relaxed">
                  <p className="font-semibold text-foreground mb-1">How to link</p>
                  Open WhatsApp → <span className="text-foreground">Settings</span> →{" "}
                  <span className="text-foreground">Linked Devices</span> →{" "}
                  <span className="text-foreground">Link a Device</span>, then scan this code.
                </div>

                <button
                  onClick={connectQr}
                  disabled={busy}
                  className="mt-4 w-full rounded-2xl bg-primary text-primary-foreground font-semibold py-3.5 flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  {state?.qr ? "Regenerate QR Code" : "Generate QR Code"}
                </button>
              </div>
            ) : (
              <div className="rounded-3xl bg-card border border-border p-6">
                {state?.pairingCode ? (
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-3">Enter this code in WhatsApp</p>
                    <button
                      onClick={copyCode}
                      className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary/10 px-3 py-4"
                    >
                      <span className="text-2xl sm:text-3xl font-extrabold tracking-[0.22em] text-primary whitespace-nowrap">
                        {state.pairingCode}
                      </span>
                      {copied ? (
                        <Check className="w-5 h-5 shrink-0 text-primary" />
                      ) : (
                        <Copy className="w-5 h-5 shrink-0 text-primary/70" />
                      )}
                    </button>
                    {seconds > 0 && (
                      <p className="text-xs text-primary font-medium mt-3">
                        Enter within {seconds}s
                      </p>
                    )}
                    <div className="text-left w-full mt-5 rounded-2xl bg-muted/60 p-4 text-xs text-muted-foreground leading-relaxed space-y-1">
                      <p><span className="text-foreground font-semibold">1.</span> Open WhatsApp on your phone</p>
                      <p><span className="text-foreground font-semibold">2.</span> Settings → Linked Devices → Link a Device</p>
                      <p><span className="text-foreground font-semibold">3.</span> Tap "Link with phone number instead"</p>
                      <p><span className="text-foreground font-semibold">4.</span> Enter the code above</p>
                    </div>
                  </div>
                ) : (
                  <>
                    <label className="text-xs font-medium text-muted-foreground">
                      Your WhatsApp number (with country code)
                    </label>
                    <div className="mt-2 flex items-center gap-2 rounded-2xl bg-background border border-border px-4 focus-within:border-primary transition">
                      <Smartphone className="w-4 h-4 text-muted-foreground" />
                      <input
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="0300 1234567 or 92300…"
                        inputMode="tel"
                        className="flex-1 bg-transparent py-3.5 text-sm outline-none"
                      />
                    </div>
                    {normalizeNum(phone).length >= 8 ? (
                      <div className="mt-3 flex items-center justify-between rounded-2xl bg-primary/10 px-4 py-3">
                        <div>
                          <p className="text-[11px] text-muted-foreground">WhatsApp number</p>
                          <p className="text-lg font-bold tracking-wide text-primary">+{normalizeNum(phone)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard?.writeText("+" + normalizeNum(phone));
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                          }}
                          className="p-2 rounded-xl bg-primary/15 active:scale-95 transition"
                          aria-label="Copy number"
                        >
                          {copied ? <Check className="w-5 h-5 text-primary" /> : <Copy className="w-5 h-5 text-primary/80" />}
                        </button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-2">
                        Type any format — e.g. 0300 1234567 — we'll convert it to +92… automatically.
                      </p>
                    )}
                  </>
                )}
                <button
                  onClick={connectPhone}
                  disabled={busy}
                  className="mt-5 w-full rounded-2xl bg-primary text-primary-foreground font-semibold py-3.5 flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.99] transition"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                  {state?.pairingCode ? "Request New Code" : "Get Pairing Code"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}
