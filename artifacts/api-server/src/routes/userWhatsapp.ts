import { Router, type Request, type Response } from "express";
import { multiWA } from "../services/multiWhatsapp.js";
import { requireAdmin } from "./admin.js";

const router = Router();

// GET /api/admin/users/:userId/whatsapp/status
router.get("/admin/users/:userId/whatsapp/status", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  res.json(multiWA.getState(userId));
});

// SSE /api/admin/users/:userId/whatsapp/events
router.get("/admin/users/:userId/whatsapp/events", async (req: Request, res: Response) => {
  const queryToken = req.query.token as string | undefined;
  if (queryToken) {
    (req as any).headers = { ...(req as any).headers, authorization: `Bearer ${queryToken}` };
  }
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(multiWA.getState(userId))}\n\n`);

  const remove = multiWA.addUserListener(userId, (state) => {
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  });

  const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
  req.on("close", () => { clearInterval(ping); remove(); });
});

// POST /api/admin/users/:userId/whatsapp/connect-qr
router.post("/admin/users/:userId/whatsapp/connect-qr", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  multiWA.connectQR(userId).catch(() => {});
  res.json({ success: true });
});

// POST /api/admin/users/:userId/whatsapp/connect-phone
router.post("/admin/users/:userId/whatsapp/connect-phone", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ error: "phone required" }); return; }
  multiWA.connectPhone(userId, phone).catch(() => {});
  res.json({ success: true });
});

// POST /api/admin/users/:userId/whatsapp/disconnect
router.post("/admin/users/:userId/whatsapp/disconnect", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  multiWA.disconnect(userId);
  res.json({ success: true });
});

// POST /api/admin/users/:userId/whatsapp/clear-session
router.post("/admin/users/:userId/whatsapp/clear-session", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  multiWA.clearSession(userId);
  res.json({ success: true });
});

// POST /api/admin/users/:userId/whatsapp/fresh-start
router.post("/admin/users/:userId/whatsapp/fresh-start", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  multiWA.freshStart(userId);
  res.json({ success: true });
});

// POST /api/admin/users/:userId/whatsapp/send
router.post("/admin/users/:userId/whatsapp/send", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const userId = parseInt(String(req.params.userId));
  if (isNaN(userId)) { res.status(400).json({ error: "Invalid userId" }); return; }
  const { to, message } = req.body as { to?: string; message?: string };
  if (!to || !message) { res.status(400).json({ error: "to and message required" }); return; }
  try {
    await multiWA.sendMessage(userId, to, message);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Send failed" });
  }
});

export default router;
