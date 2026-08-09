import { Router, type Request, type Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { db } from "@workspace/db";
import { mediaFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "./admin.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "../../uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "audio/ogg", "audio/mp3", "application/pdf"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("File type not allowed"));
  },
});

const router = Router();

// Serve uploaded files statically
router.get("/uploads/:filename", (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  const filepath = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(filepath)) {
    res.status(404).json({ error: "File not found" });
    return;
  }
  res.sendFile(filepath);
});

// GET /api/admin/media — list all media
router.get("/admin/media", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;
  const files = await db.select().from(mediaFilesTable).orderBy(mediaFilesTable.createdAt);
  res.json(files.map(f => ({ ...f, createdAt: f.createdAt.toISOString() })));
});

// POST /api/admin/media/upload — upload file
router.post("/admin/media/upload", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  upload.single("file")(req, res, async (err) => {
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }
    const url = `/api/uploads/${req.file.filename}`;
    const [record] = await db.insert(mediaFilesTable).values({
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: String(req.file.size),
      url,
      uploadedBy: adminId,
    }).returning();

    res.status(201).json({ ...record, createdAt: record.createdAt.toISOString() });
  });
});

// DELETE /api/admin/media/:id
router.delete("/admin/media/:id", async (req: Request, res: Response) => {
  const adminId = await requireAdmin(req, res);
  if (!adminId) return;

  const id = parseInt(String(req.params.id));
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const [file] = await db.select().from(mediaFilesTable).where(eq(mediaFilesTable.id, id));
  if (!file) { res.status(404).json({ error: "File not found" }); return; }

  const filepath = path.join(UPLOAD_DIR, file.filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  await db.delete(mediaFilesTable).where(eq(mediaFilesTable.id, id));
  res.json({ success: true });
});

export default router;
