import { eq, sql, desc, asc, count, and, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import {
  db,
  waChatsTable,
  waMessagesTable,
  waMessageReactionsTable,
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
async function persistMessage(
  jid: string, phone: string, msg: WAChatMsg, history = false, name?: string, avatarUrl?: string,
) {
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
        edited: msg.edited ?? false,
        viewOnce: msg.viewOnce ?? false,
        ephemeral: msg.ephemeral ?? false,
        linkPreviewUrl: msg.linkPreviewUrl ?? null,
        linkPreviewTitle: msg.linkPreviewTitle ?? null,
        linkPreviewDescription: msg.linkPreviewDescription ?? null,
        linkPreviewThumb: msg.linkPreviewThumb ?? null,
      })
      .onConflictDoUpdate({
        target: waMessagesTable.waMessageId,
        // ANTI-DELETE: once a message is flagged deleted we KEEP the original
        // text + media (don't overwrite). Otherwise refresh the text (e.g. an
        // old row saved as "Media" before the envelope-unwrap fix, or an
        // edited message replacing its own text) and backfill media when a
        // re-seen row finally downloaded its payload.
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
          // Never flips back to false once an edit is seen, even across
          // multiple edits of the same message.
          edited: sql`${waMessagesTable.edited} OR ${msg.edited ?? false}`,
        },
      });

    await db
      .insert(waChatsTable)
      .values({
        jid,
        phone,
        name: name ?? null,
        avatarUrl: avatarUrl ?? null,
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
          // Refresh the readable chat title whenever we learn a (better) one; the
          // engine only ever calls us with a name once it's at least as
          // authoritative as what it already knew (see multiWhatsapp's name-tier
          // system), so it's always safe to overwrite here — never keep a stale
          // one behind via COALESCE, or a corrected/renamed contact would never
          // update in the database.
          name: name != null ? name : sql`${waChatsTable.name}`,
          avatarUrl: avatarUrl != null ? avatarUrl : sql`${waChatsTable.avatarUrl}`,
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

/** "Delete for me": a purely local hide, never touches WhatsApp or the other
 *  party's copy — just removes the row from what this panel shows going
 *  forward. Distinct from markDeleted (delete-for-everyone / revoke). */
export async function hideForMe(waMessageId: string) {
  try {
    await db.update(waMessagesTable).set({ hiddenForMe: true }).where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to hide message:", err);
  }
}

export async function setStarred(waMessageId: string, starred: boolean) {
  try {
    await db.update(waMessagesTable).set({ starred }).where(eq(waMessagesTable.waMessageId, waMessageId));
  } catch (err) {
    console.error("[persist] failed to star message:", err);
  }
}

/** All starred messages across every chat, newest first, for a Starred
 *  Messages screen. */
export async function getStarredMessages() {
  return db
    .select()
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.starred, true), eq(waMessagesTable.hiddenForMe, false)))
    .orderBy(desc(waMessagesTable.ts));
}

/** A single message's full content (text + media), for re-sending as a
 *  forward to a different chat. */
export async function getMessageForForward(waMessageId: string) {
  const [row] = await db
    .select({
      text: waMessagesTable.text,
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

export async function setChatPinned(jid: string, pinned: boolean) {
  try {
    await db.update(waChatsTable).set({ pinned }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] failed to set pinned:", err);
  }
}

export async function setChatMuted(jid: string, muted: boolean) {
  try {
    await db.update(waChatsTable).set({ muted }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] failed to set muted:", err);
  }
}

export async function setChatArchived(jid: string, archived: boolean) {
  try {
    await db.update(waChatsTable).set({ archived }).where(eq(waChatsTable.jid, jid));
  } catch (err) {
    console.error("[persist] failed to set archived:", err);
  }
}

/** Add/update or (with an empty emoji) remove a reactor's reaction on a message. */
export async function saveReaction(waMessageId: string, reactorJid: string, emoji: string, ts: number) {
  try {
    if (!emoji) {
      await db
        .delete(waMessageReactionsTable)
        .where(and(eq(waMessageReactionsTable.waMessageId, waMessageId), eq(waMessageReactionsTable.reactorJid, reactorJid)));
      return;
    }
    await db
      .insert(waMessageReactionsTable)
      .values({ waMessageId, reactorJid, emoji, ts })
      .onConflictDoUpdate({
        target: [waMessageReactionsTable.waMessageId, waMessageReactionsTable.reactorJid],
        set: { emoji, ts },
      });
  } catch (err) {
    console.error("[persist] failed to save reaction:", err);
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
      starred: waMessagesTable.starred,
      edited: waMessagesTable.edited,
      viewOnce: waMessagesTable.viewOnce,
      ephemeral: waMessagesTable.ephemeral,
      linkPreviewUrl: waMessagesTable.linkPreviewUrl,
      linkPreviewTitle: waMessagesTable.linkPreviewTitle,
      linkPreviewDescription: waMessagesTable.linkPreviewDescription,
      linkPreviewThumb: waMessagesTable.linkPreviewThumb,
    })
    .from(waMessagesTable)
    // "Delete for me" is a local-only hide — excluded from the list entirely.
    .where(and(eq(waMessagesTable.jid, jid), eq(waMessagesTable.hiddenForMe, false)))
    .orderBy(asc(waMessagesTable.ts));

  const ids = rows.map((r: any) => r.waMessageId);
  const reactionRows = ids.length
    ? await db.select().from(waMessageReactionsTable).where(inArray(waMessageReactionsTable.waMessageId, ids))
    : [];
  const myPhone = (multiWA.getSessionInfo(PANEL_USER_ID)?.phoneNumber ?? "").replace(/\D/g, "");
  const reactionsByMsg = new Map<string, Map<string, { count: number; byMe: boolean }>>();
  for (const r of reactionRows) {
    if (!r.emoji) continue;
    const reactorPhone = r.reactorJid.split("@")[0].split(":")[0];
    let m = reactionsByMsg.get(r.waMessageId);
    if (!m) { m = new Map(); reactionsByMsg.set(r.waMessageId, m); }
    const cur = m.get(r.emoji) ?? { count: 0, byMe: false };
    cur.count++;
    if (myPhone && reactorPhone === myPhone) cur.byMe = true;
    m.set(r.emoji, cur);
  }
  return rows.map((r: any) => ({
    ...r,
    reactions: [...(reactionsByMsg.get(r.waMessageId)?.entries() ?? [])].map(([emoji, v]) => ({
      emoji, count: v.count, byMe: v.byMe,
    })),
  }));
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
          name: call.name != null ? call.name : sql`${waCallLogsTable.name}`,
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

  // Resolve poster display names + photos from the chat registry.
  const chats = await db
    .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name, avatarUrl: waChatsTable.avatarUrl })
    .from(waChatsTable);
  const nameByJid = new Map<string, string | null>(chats.map((c: any) => [c.jid, c.name]));
  const nameByPhone = new Map<string, string | null>(chats.map((c: any) => [c.phone, c.name]));
  const avatarByJid = new Map<string, string | null>(chats.map((c: any) => [c.jid, c.avatarUrl]));
  const avatarByPhone = new Map<string, string | null>(chats.map((c: any) => [c.phone, c.avatarUrl]));

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
    avatarUrl: string | null;
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
      const avatarUrl =
        avatarByJid.get(pj) ??
        (phone ? avatarByPhone.get(phone) ?? null : null) ??
        null;
      g = { participant: pj, phone, name, avatarUrl, latestTs: r.ts, count: 0, items: [] };
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

  multiWA.addPersistListener((_uid, jid, phone, msg, history, name, avatarUrl) => {
    void persistMessage(jid, phone, msg, history, name, avatarUrl);
  });
  multiWA.addStatusListener((_uid, update) => {
    void persistStatus(update.waMessageId, update.status);
  });
  // ANTI-DELETE: when WhatsApp revokes a message (deleted for everyone), flag it
  // in the DB but keep the original content for monitoring.
  multiWA.addDeleteListener((_uid, waMessageId) => {
    void markDeleted(waMessageId);
  });
  // Emoji reactions (add or, with an empty emoji, remove).
  multiWA.addReactionListener((_uid, _jid, waMessageId, reactorJid, emoji, ts) => {
    void saveReaction(waMessageId, reactorJid, emoji, ts);
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
