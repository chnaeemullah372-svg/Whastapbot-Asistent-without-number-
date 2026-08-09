import { eq, sql, desc, asc, count } from "drizzle-orm";
import { createHash } from "crypto";
import {
  db,
  waChatsTable,
  waMessagesTable,
  waCallLogsTable,
  waAccountsTable,
  appLogsTable,
  adminUsersTable,
  type WaChat,
} from "@workspace/db";
import { multiWA, type HydrateChat, type WAChatMsg, type WACall } from "./multiWhatsapp";

/**
 * The whole app is built around ONE panel user. We pin every WhatsApp session
 * to this fixed id so the single user always drives the same Baileys engine.
 */
export const PANEL_USER_ID = 1;

let started = false;

/** ANTI-DELETE timing safety: ids seen as deleted-for-everyone BEFORE their
 *  original message was persisted. Any later-arriving original with one of these
 *  ids is written as already-deleted, so a revoke can never "lose" to an
 *  out-of-order original (e.g. during history sync). */
const pendingDeletes = new Set<string>();

/** Append a line to the application log table (best-effort, never throws). */
export async function logEvent(message: string, level = "info", source = "system") {
  try {
    await db.insert(appLogsTable).values({ message, level, source });
  } catch (err) {
    console.error("[log] failed to persist log:", err);
  }
}

/** Persist a single message + upsert its chat row. Best-effort.
 *  When `history` is true the message came from a WhatsApp history sync, so we
 *  never bump the unread counter (those messages are old) and only advance the
 *  chat's last-message preview when this message is actually newer. */
async function persistMessage(jid: string, phone: string, msg: WAChatMsg, history = false, name?: string) {
  try {
    // The WhatsApp number that is currently linked — every chat we capture is
    // tagged with it so the admin can browse each connected number separately.
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    // If a revoke for this id arrived before the original, honour it now.
    const isDeleted = (msg.deleted ?? false) || pendingDeletes.has(msg.id);
    await db
      .insert(waMessagesTable)
      .values({
        waMessageId: msg.id,
        jid,
        text: msg.text,
        fromMe: msg.fromMe,
        ts: msg.ts,
        status: msg.status,
        deleted: isDeleted,
        deletedAt: isDeleted ? new Date() : null,
        quotedText: msg.quotedText,
        quotedId: msg.quotedId,
        media: msg.media,
        mediaMime: msg.mediaMime,
        mediaKind: msg.mediaKind,
        fileName: msg.fileName,
        participant: msg.participant ?? null,
      })
      .onConflictDoUpdate({
        target: waMessagesTable.waMessageId,
        // ANTI-DELETE: once a message is flagged deleted we KEEP the original
        // text + media (don't overwrite). Otherwise refresh the text (e.g. an
        // old row saved as "Media" before the envelope-unwrap fix) and backfill
        // media when a re-seen row finally downloaded its payload.
        set: {
          text: sql`CASE WHEN ${waMessagesTable.deleted} OR ${isDeleted} THEN ${waMessagesTable.text} ELSE ${msg.text} END`,
          deleted: sql`${waMessagesTable.deleted} OR ${isDeleted}`,
          deletedAt: sql`COALESCE(${waMessagesTable.deletedAt}, ${isDeleted ? new Date() : null})`,
          quotedText: msg.quotedText,
          quotedId: msg.quotedId,
          media: sql`COALESCE(${waMessagesTable.media}, ${msg.media ?? null})`,
          mediaMime: sql`COALESCE(${waMessagesTable.mediaMime}, ${msg.mediaMime ?? null})`,
          mediaKind: sql`COALESCE(${waMessagesTable.mediaKind}, ${msg.mediaKind ?? null})`,
          fileName: sql`COALESCE(${waMessagesTable.fileName}, ${msg.fileName ?? null})`,
          participant: sql`COALESCE(${waMessagesTable.participant}, ${msg.participant ?? null})`,
        },
      });

    await db
      .insert(waChatsTable)
      .values({
        jid,
        phone,
        name: name ?? null,
        lastMsg: msg.text,
        lastMsgTs: msg.ts,
        unread: 0,
        accountPhone,
      })
      .onConflictDoUpdate({
        target: waChatsTable.jid,
        set: {
          // Only move the preview forward for newer messages (history syncs can
          // arrive out of order).
          lastMsg: sql`CASE WHEN ${msg.ts} >= ${waChatsTable.lastMsgTs} THEN ${msg.text} ELSE ${waChatsTable.lastMsg} END`,
          lastMsgTs: sql`GREATEST(${waChatsTable.lastMsgTs}, ${msg.ts})`,
          // Fill in / refresh the readable chat title when we learn it.
          name: sql`COALESCE(${name ?? null}, ${waChatsTable.name})`,
          // Keep the first owning account; only fill it in if it was unknown.
          accountPhone: sql`COALESCE(${waChatsTable.accountPhone}, ${accountPhone})`,
          unread:
            history || msg.fromMe
              ? sql`${waChatsTable.unread}`
              : sql`${waChatsTable.unread} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error("[persist] failed to persist message:", err);
  }
}

/**
 * Record (or refresh) a connected WhatsApp number in the account registry.
 * Called whenever a session reaches the "connected" state with a phone number.
 */
export async function recordAccount(phone: string) {
  try {
    await db
      .insert(waAccountsTable)
      .values({ phone })
      .onConflictDoUpdate({
        target: waAccountsTable.phone,
        set: {
          lastConnectedAt: new Date(),
          connectCount: sql`${waAccountsTable.connectCount} + 1`,
        },
      });
  } catch (err) {
    console.error("[persist] failed to record account:", err);
  }
}

/** All connected numbers + how many chats belong to each. */
export async function getAccounts() {
  const accounts = await db
    .select()
    .from(waAccountsTable)
    .orderBy(desc(waAccountsTable.lastConnectedAt));
  const counts = await db
    .select({ accountPhone: waChatsTable.accountPhone, value: count() })
    .from(waChatsTable)
    .groupBy(waChatsTable.accountPhone);
  const byPhone = new Map(counts.map((c) => [c.accountPhone, Number(c.value)]));
  return accounts.map((a) => ({ ...a, chatCount: byPhone.get(a.phone) ?? 0 }));
}

/** Update the delivery/read status of a stored message. */
async function persistStatus(waMessageId: string, status: number) {
  try {
    await db
      .update(waMessagesTable)
      .set({ status })
      .where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to update status:", err);
  }
}

/** Mark a chat's unread counter back to zero (when the user opens it). */
export async function clearUnread(jid: string) {
  try {
    await db.update(waChatsTable).set({ unread: 0 }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] failed to clear unread:", err);
  }
}

/** Flag a stored message as deleted-for-everyone WITHOUT losing its content.
 *  ANTI-DELETE: the original text + media stay on the server for monitoring;
 *  we only set the flag + the time it was deleted. */
export async function markDeleted(waMessageId: string) {
  // Remember it even if the row isn't stored yet, so an out-of-order original
  // (e.g. arriving later via history sync) is written as already-deleted.
  pendingDeletes.add(waMessageId);
  try {
    await db
      .update(waMessagesTable)
      .set({ deleted: true, deletedAt: new Date() })
      .where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to mark deleted:", err);
  }
}

/** Read full chat history from DB shaped for the engine's hydrate(). */
export async function loadHistory(): Promise<HydrateChat[]> {
  const chats = await db
    .select()
    .from(waChatsTable)
    .orderBy(desc(waChatsTable.lastMsgTs));

  const result: HydrateChat[] = [];
  for (const c of chats) {
    const msgs = await db
      .select()
      .from(waMessagesTable)
      .where(eq(waMessagesTable.jid, c.jid))
      .orderBy(asc(waMessagesTable.ts))
      .limit(300);
    result.push({
      meta: {
        jid: c.jid,
        phone: c.phone,
        name: c.name ?? undefined,
        lastMsg: c.lastMsg,
        lastMsgTs: c.lastMsgTs,
        unread: c.unread,
      },
      msgs: msgs.map((m) => ({
        id: m.waMessageId,
        text: m.text,
        fromMe: m.fromMe,
        ts: m.ts,
        status: m.status,
        deleted: m.deleted,
        quotedText: m.quotedText ?? undefined,
        quotedId: m.quotedId ?? undefined,
        media: m.media ?? undefined,
        mediaMime: m.mediaMime ?? undefined,
        mediaKind: m.mediaKind ?? undefined,
        fileName: m.fileName ?? undefined,
      })),
    });
  }
  return result;
}

/** All chats (for admin overview), optionally filtered to one connected number. */
export async function getAllChats(accountPhone?: string): Promise<WaChat[]> {
  const q = db.select().from(waChatsTable);
  if (accountPhone) {
    return q.where(eq(waChatsTable.accountPhone, accountPhone)).orderBy(desc(waChatsTable.lastMsgTs));
  }
  return q.orderBy(desc(waChatsTable.lastMsgTs));
}

/** All messages for a chat (from DB — survives restart). The heavy base64
 *  `media` column is intentionally excluded; clients fetch each payload on
 *  demand via the media endpoint using `hasMedia`/`mediaKind`. */
export async function getChatMessagesDb(jid: string) {
  const rows = await db
    .select({
      id: waMessagesTable.id,
      waMessageId: waMessagesTable.waMessageId,
      jid: waMessagesTable.jid,
      text: waMessagesTable.text,
      fromMe: waMessagesTable.fromMe,
      ts: waMessagesTable.ts,
      status: waMessagesTable.status,
      deleted: waMessagesTable.deleted,
      deletedAt: waMessagesTable.deletedAt,
      quotedText: waMessagesTable.quotedText,
      quotedId: waMessagesTable.quotedId,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    .where(eq(waMessagesTable.jid, jid))
    .orderBy(asc(waMessagesTable.ts));
  return rows;
}

/** Fetch a single message's media payload (base64) for the serve endpoint. */
export async function getMediaById(waMessageId: string) {
  const [row] = await db
    .select({
      media: waMessagesTable.media,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
    })
    .from(waMessagesTable)
    .where(eq(waMessagesTable.waMessageId, waMessageId))
    .limit(1);
  return row ?? null;
}

// ── Calls + Status ──────────────────────────────────────────────────

/** Persist (upsert) a WhatsApp call-log entry. Events for the same call share a
 *  callId (offer → terminal state), so we upsert and never let a late/duplicate
 *  ringing event downgrade a terminal outcome (missed/rejected/accepted). */
export async function saveCallLog(call: WACall) {
  try {
    const accountPhone = multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? null;
    await db
      .insert(waCallLogsTable)
      .values({
        callId: call.callId,
        jid: call.jid,
        phone: call.phone,
        name: call.name ?? null,
        accountPhone,
        outgoing: call.outgoing,
        isVideo: call.isVideo,
        isGroup: call.isGroup,
        outcome: call.outcome,
        rawStatus: call.rawStatus,
        ts: call.ts,
      })
      .onConflictDoUpdate({
        target: waCallLogsTable.callId,
        set: {
          outcome: sql`CASE WHEN ${waCallLogsTable.outcome} IN ('missed','rejected','accepted') THEN ${waCallLogsTable.outcome} ELSE ${call.outcome} END`,
          rawStatus: call.rawStatus,
          name: sql`COALESCE(${waCallLogsTable.name}, ${call.name ?? null})`,
          isVideo: call.isVideo,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error("[persist] failed to persist call log:", err);
  }
}

/** Recent call log, newest first. */
export async function getCallLogs(limit = 200) {
  return db
    .select()
    .from(waCallLogsTable)
    .orderBy(desc(waCallLogsTable.ts))
    .limit(limit);
}

/** Status (stories) grouped by the contact who posted them. WhatsApp stores all
 *  statuses under status@broadcast; we group by the captured poster JID and
 *  resolve a display name from the chat registry. */
export async function getStatusGroups() {
  const rows = await db
    .select({
      waMessageId: waMessagesTable.waMessageId,
      participant: waMessagesTable.participant,
      text: waMessagesTable.text,
      ts: waMessagesTable.ts,
      deleted: waMessagesTable.deleted,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    .where(eq(waMessagesTable.jid, "status@broadcast"))
    .orderBy(desc(waMessagesTable.ts));

  // Resolve poster display names from the chat registry.
  const chats = await db
    .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name })
    .from(waChatsTable);
  const nameByJid = new Map(chats.map((c) => [c.jid, c.name]));
  const nameByPhone = new Map(chats.map((c) => [c.phone, c.name]));

  type StatusItem = {
    waMessageId: string;
    text: string;
    ts: number;
    deleted: boolean;
    mediaMime: string | null;
    mediaKind: string | null;
    fileName: string | null;
    hasMedia: boolean;
  };
  type StatusGroup = {
    participant: string;
    phone: string;
    name: string | null;
    latestTs: number;
    count: number;
    items: StatusItem[];
  };

  const groups = new Map<string, StatusGroup>();
  for (const r of rows) {
    // Skip revoked (deleted-for-everyone) statuses so a group's count matches
    // what the viewer can actually show; groups left empty are never created.
    if (r.deleted) continue;
    const pj = r.participant ?? "unknown";
    const phone = pj.includes("@") ? pj.split("@")[0].split(":")[0] : "";
    let g = groups.get(pj);
    if (!g) {
      const name =
        nameByJid.get(pj) ??
        (phone ? nameByPhone.get(phone) ?? null : null) ??
        null;
      g = { participant: pj, phone, name, latestTs: r.ts, count: 0, items: [] };
      groups.set(pj, g);
    }
    g.count++;
    if (r.ts > g.latestTs) g.latestTs = r.ts;
    g.items.push({
      waMessageId: r.waMessageId,
      text: r.text,
      ts: r.ts,
      deleted: r.deleted,
      mediaMime: r.mediaMime,
      mediaKind: r.mediaKind,
      fileName: r.fileName,
      hasMedia: r.hasMedia,
    });
  }
  return [...groups.values()].sort((a, b) => b.latestTs - a.latestTs);
}

/**
 * Ensure at least one admin account exists so the admin panel is usable.
 * Self-hosted personal tool: seeds from ADMIN_USERNAME/ADMIN_PASSWORD env vars,
 * or falls back to admin / admin123 (logged so the owner can change it).
 */
async function seedDefaultAdmin() {
  try {
    const admins = await db.select().from(adminUsersTable).limit(1);
    if (admins.length) return;
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin123";
    await db
      .insert(adminUsersTable)
      .values({ username, passwordHash: createHash("sha256").update(password).digest("hex") } as any)
      .onConflictDoNothing();
    console.log(`[seed] created default admin "${username}" — change the password after first login`);
    await logEvent(`Default admin account "${username}" created`, "warn", "auth");
  } catch (err) {
    console.error("[seed] failed to seed admin:", err);
  }
}

/**
 * Wire engine → DB and load saved history into the engine. Idempotent.
 */
export async function startPersistence() {
  if (started) return;
  started = true;

  await seedDefaultAdmin();

  multiWA.addPersistListener((_uid, jid, phone, msg, history, name) => {
    void persistMessage(jid, phone, msg, history, name);
  });
  multiWA.addStatusListener((_uid, update) => {
    void persistStatus(update.waMessageId, update.status);
  });
  // ANTI-DELETE: when WhatsApp revokes a message (deleted for everyone), flag it
  // in the DB but keep the original content for monitoring.
  multiWA.addDeleteListener((_uid, waMessageId) => {
    void markDeleted(waMessageId);
  });
  // Calls log: persist every call notification (incoming / missed / rejected).
  multiWA.addCallListener((_uid, call) => {
    void saveCallLog(call);
  });
  // Per-account registry: record every number that reaches the connected state.
  multiWA.addGlobalListener((state) => {
    if (state.status === "connected" && state.phoneNumber) {
      void recordAccount(state.phoneNumber);
    }
  });

  try {
    const history = await loadHistory();
    if (history.length) {
      multiWA.hydrate(PANEL_USER_ID, history);
      console.log(`[persist] hydrated ${history.length} chats from DB`);
    }
  } catch (err) {
    console.error("[persist] failed to hydrate history:", err);
  }

  await logEvent("Persistence started; engine wired to DB", "info", "system");
}
