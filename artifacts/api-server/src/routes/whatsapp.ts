import { Router, type Request, type Response } from "express";
import { whatsappService, getDebugLog, clearDebugLog } from "../services/whatsapp.js";
import { multiWA } from "../services/multiWhatsapp.js";
import { requireAdmin } from "./admin.js";

const router = Router();

// GET /api/whatsapp/status — public (widget needs to poll)
router.get("/whatsapp/status", (_req: Request, res: Response) => {
  const global = whatsappService.getState();
  // Also check if any per-user multiWA session is connected
  const anyUserConnected = multiWA.getAllStates().some(s => s.status === "connected");
  const effectiveStatus = global.status === "connected" || anyUserConnected ? "connected" : global.status;
  res.json({ status: effectiveStatus, phoneNumber: global.phoneNumber, connectedAt: global.connectedAt });
});

// GET /api/whatsapp/status/full — admin full state
router.get("/whatsapp/status/full", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  res.json(whatsappService.getState());
});

// GET /api/whatsapp/events — SSE stream, token via query param
router.get("/whatsapp/events", async (req: Request, res: Response) => {
  // Accept token from query param since EventSource doesn't support custom headers
  const queryToken = req.query.token as string | undefined;
  if (queryToken) {
    (req as any).headers = { ...(req as any).headers, authorization: `Bearer ${queryToken}` };
  }
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ event: "state", data: whatsappService.getState() })}\n\n`);

  const remove = whatsappService.addListener((event, data) => {
    res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
  });

  const ping = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(ping);
    remove();
  });
});

// POST /api/whatsapp/connect-qr
router.post("/whatsapp/connect-qr", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  try {
    await whatsappService.connectQR();
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/connect-phone — starts pairing; code arrives via SSE
router.post("/whatsapp/connect-phone", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const { phone } = req.body as { phone?: string };
  if (!phone) {
    res.status(400).json({ error: "phone required" });
    return;
  }
  try {
    // Don't await — socket + pairingTimer run in background; code arrives via SSE
    whatsappService.connectPhone(phone).catch(() => {});
    res.json({ success: true, message: "Connecting — code SSE se aayega" });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/disconnect
router.post("/whatsapp/disconnect", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  whatsappService.disconnect();
  res.json({ success: true });
});

// POST /api/whatsapp/fix
router.post("/whatsapp/fix", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  whatsappService.fix();
  res.json({ success: true });
});

// POST /api/whatsapp/clear-session
router.post("/whatsapp/clear-session", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  whatsappService.clearSession();
  res.json({ success: true });
});

// POST /api/whatsapp/fresh-start
router.post("/whatsapp/fresh-start", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  whatsappService.freshStart();
  res.json({ success: true });
});

// GET /api/whatsapp/debug-log — live debug logs for pairing troubleshooting
router.get("/whatsapp/debug-log", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  res.json({ logs: getDebugLog() });
});

// DELETE /api/whatsapp/debug-log — clear debug logs
router.delete("/whatsapp/debug-log", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  clearDebugLog();
  res.json({ success: true });
});

export default router;
