import { eq, sql, desc, asc, count, and, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import {
  db,
  waChatsTable,
  waMessagesTable,
  waMessageReactionsTable,
  waCallLogsTable,
  waAccountsTable,
  waSessionsTable,
  appLogsTable,
  adminUsersTable,
  panelUserTable,
  type WaChat,
} from "@workspace/db";
import { multiWA, type HydrateChat, type WAChatMsg, type WACall } from "./multiWhatsapp";

/**
 * Legacy default account id — the very first panel user ever created (before
 * multi-account support), kept only as the DB column default so old rows
 * stay valid. New code must always pass the real authenticated user's id;
 * never hardcode this to route a request.
 */
export const PANEL_USER_ID = 1;

let started = false;

/** ANTI-DELETE timing safety: (userId, waMessageId) pairs seen as
 *  deleted-for-everyone BEFORE their original message was persisted. Any
 *  later-arriving original with one of these ids is written as
 *  already-deleted, so a revoke can never "lose" to an out-of-order
 *  original (e.g. during history sync). Keyed by user too — a message id is
 *  only unique within one account's WhatsApp connection. */
const pendingDeletes = new Set<string>();
const pendingKey = (userId: number, waMessageId: string) => `${userId}:${waMessageId}`;

/** The currently-open backup session (wa_sessions.id) per panel account, if
 *  its WhatsApp number is connected right now. Absent/undefined = no open
 *  session, so freshly-arriving messages just aren't tagged with one. */
const openSessionByUser = new Map<number, number>();

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
  userId: number, jid: string, phone: string, msg: WAChatMsg, history = false, name?: string, avatarUrl?: string,
) {
  try {
    // The WhatsApp number that is currently linked — every chat we capture is
    // tagged with it so the admin can browse each connected number separately.
    const accountPhone = multiWA.getSessionInfo(userId)?.phoneNumber ?? null;
    const sessionId = openSessionByUser.get(userId) ?? null;
    // If a revoke for this id arrived before the original, honour it now.
    const isDeleted = (msg.deleted ?? false) || pendingDeletes.has(pendingKey(userId, msg.id));
    await db
      .insert(waMessagesTable)
      .values({
        userId,
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
        sessionId,
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
        target: [waMessagesTable.userId, waMessagesTable.waMessageId],
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
          // Keep whichever session first captured this message — a later
          // resync/reprocess must never re-tag it into today's session.
          sessionId: sql`COALESCE(${waMessagesTable.sessionId}, ${sessionId})`,
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
        userId,
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
        target: [waChatsTable.userId, waChatsTable.jid],
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
          // Corrects itself once a @lid chat's real number resolves (see
          // multiWhatsapp's ensureRealPhone) — always the engine's current
          // best-known value, never blocked behind a COALESCE.
          phone,
          // Keep the first owning account for OLD/history-sync traffic (so
          // connecting a new number doesn't retroactively relabel chats that
          // only ever existed from a previous number's history). But a
          // genuinely LIVE message (history=false) can only have just arrived
          // on the socket that is connected RIGHT NOW — so it must always
          // reassign accountPhone to the current number, even if this jid's
          // row already had a stale one from an earlier connected number.
          // Without this, a real-world contact whose WhatsApp-assigned @lid
          // stays the same across our different linked numbers gets its chat
          // permanently frozen under the first number that ever saw it, and
          // every later live reply — though correctly received — silently
          // disappears from /panel/chats (which filters by the currently
          // connected number).
          accountPhone: history
            ? sql`COALESCE(${waChatsTable.accountPhone}, ${accountPhone})`
            : accountPhone,
          unread:
            history || msg.fromMe
              ? sql`${waChatsTable.unread}`
              : sql`${waChatsTable.unread} + 1`,
          // A deleted chat reappears the moment it sees new live activity
          // (either direction) — matching real WhatsApp Web. A history-sync
          // replay of old messages must never resurrect it.
          deletedForMe: history ? sql`${waChatsTable.deletedForMe}` : false,
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
export async function recordAccount(userId: number, phone: string) {
  try {
    await db
      .insert(waAccountsTable)
      .values({ userId, phone })
      .onConflictDoUpdate({
        target: [waAccountsTable.userId, waAccountsTable.phone],
        set: {
          lastConnectedAt: new Date(),
          connectCount: sql`${waAccountsTable.connectCount} + 1`,
        },
      });
  } catch (err) {
    console.error("[persist] failed to record account:", err);
  }
}

/**
 * Open a new backup session for this account's number (owner's "complete
 * backup from connect to disconnect" feature). Stores the new session id in
 * `openSessionByUser` so `persistMessage`/`saveCallLog` tag every row that
 * arrives while this session stays open. Best-effort — a failure here should
 * never break the live connection, only skip tagging for that stretch.
 */
export async function openSession(userId: number, phone: string): Promise<void> {
  try {
    const [row] = await db.insert(waSessionsTable).values({ userId, phone }).returning({ id: waSessionsTable.id });
    if (row) openSessionByUser.set(userId, row.id);
  } catch (err) {
    console.error("[persist] failed to open backup session:", err);
  }
}

/** Close the currently-open backup session for this account (real
 *  disconnect — see the "connected" -> "disconnected" transition in
 *  startPersistence's global listener). A later reconnect always opens a
 *  brand new session rather than resuming this one. */
export async function closeSession(userId: number): Promise<void> {
  const sessionId = openSessionByUser.get(userId);
  if (sessionId == null) return;
  openSessionByUser.delete(userId);
  try {
    await db.update(waSessionsTable).set({ disconnectedAt: new Date() }).where(eq(waSessionsTable.id, sessionId));
  } catch (err) {
    console.error("[persist] failed to close backup session:", err);
  }
}

/** All connected numbers for one account + how many chats belong to each. */
export async function getAccounts(userId: number) {
  const accounts = await db
    .select()
    .from(waAccountsTable)
    .where(eq(waAccountsTable.userId, userId))
    .orderBy(desc(waAccountsTable.lastConnectedAt));
  const counts = await db
    .select({ accountPhone: waChatsTable.accountPhone, value: count() })
    .from(waChatsTable)
    .where(eq(waChatsTable.userId, userId))
    .groupBy(waChatsTable.accountPhone);
  const byPhone = new Map(counts.map((c) => [c.accountPhone, Number(c.value)]));
  return accounts.map((a) => ({ ...a, chatCount: byPhone.get(a.phone) ?? 0 }));
}

/** Update the delivery/read status of a stored message. */
async function persistStatus(userId: number, waMessageId: string, status: number) {
  try {
    await db
      .update(waMessagesTable)
      .set({ status })
      .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)));
  } catch (err) {
    console.error("[persist] failed to update status:", err);
  }
}

/** Mark a chat's unread counter back to zero (when the user opens it). */
export async function clearUnread(userId: number, jid: string) {
  try {
    await db
      .update(waChatsTable)
      .set({ unread: 0 })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to clear unread:", err);
  }
}

/** Flag a stored message as deleted-for-everyone WITHOUT losing its content.
 *  ANTI-DELETE: the original text + media stay on the server for monitoring;
 *  we only set the flag + the time it was deleted. */
export async function markDeleted(userId: number, waMessageId: string) {
  // Remember it even if the row isn't stored yet, so an out-of-order original
  // (e.g. arriving later via history sync) is written as already-deleted.
  pendingDeletes.add(pendingKey(userId, waMessageId));
  try {
    await db
      .update(waMessagesTable)
      .set({ deleted: true, deletedAt: new Date() })
      .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)));
  } catch (err) {
    console.error("[persist] failed to mark deleted:", err);
  }
}

/** "Delete for me": a purely local hide, never touches WhatsApp or the other
 *  party's copy — just removes the row from what this panel shows going
 *  forward. Distinct from markDeleted (delete-for-everyone / revoke). */
export async function hideForMe(userId: number, waMessageId: string) {
  try {
    await db
      .update(waMessagesTable)
      .set({ hiddenForMe: true })
      .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)));
  } catch (err) {
    console.error("[persist] failed to hide message:", err);
  }
}

export async function setStarred(userId: number, waMessageId: string, starred: boolean) {
  try {
    await db
      .update(waMessagesTable)
      .set({ starred })
      .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)));
  } catch (err) {
    console.error("[persist] failed to star message:", err);
  }
}

/** All starred messages across every chat for one account, newest first, for
 *  a Starred Messages screen. */
export async function getStarredMessages(userId: number) {
  return db
    .select({
      id: waMessagesTable.id,
      waMessageId: waMessagesTable.waMessageId,
      jid: waMessagesTable.jid,
      text: waMessagesTable.text,
      fromMe: waMessagesTable.fromMe,
      ts: waMessagesTable.ts,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
      hasMedia: sql<boolean>`(${waMessagesTable.media} IS NOT NULL)`,
    })
    .from(waMessagesTable)
    // Exclude the heavy base64 `media` column here — this can list starred
    // photos/videos across many chats, callers fetch media on demand.
    .where(and(
      eq(waMessagesTable.userId, userId),
      eq(waMessagesTable.starred, true),
      eq(waMessagesTable.hiddenForMe, false),
    ))
    .orderBy(desc(waMessagesTable.ts));
}

/** A single message's full content (text + media), for re-sending as a
 *  forward to a different chat. */
export async function getMessageForForward(userId: number, waMessageId: string) {
  const [row] = await db
    .select({
      text: waMessagesTable.text,
      media: waMessagesTable.media,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
    })
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)))
    .limit(1);
  return row ?? null;
}

export async function setChatPinned(userId: number, jid: string, pinned: boolean) {
  try {
    await db
      .update(waChatsTable)
      .set({ pinned })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to set pinned:", err);
  }
}

export async function setChatMuted(userId: number, jid: string, muted: boolean) {
  try {
    await db
      .update(waChatsTable)
      .set({ muted })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to set muted:", err);
  }
}

export async function setChatArchived(userId: number, jid: string, archived: boolean) {
  try {
    await db
      .update(waChatsTable)
      .set({ archived })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to set archived:", err);
  }
}

/** "Mark as unread" / "Mark as read" from the chat-list menu (distinct from
 *  clearUnread, which fires automatically when a chat is opened). */
export async function setChatUnread(userId: number, jid: string, unread: boolean) {
  try {
    await db
      .update(waChatsTable)
      .set({ unread: unread ? 1 : 0 })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to set unread:", err);
  }
}

/** "Delete chat" (WhatsApp Web): local-only hide, same anti-delete philosophy
 *  as message-level hideForMe — see the deletedForMe column comment. */
export async function setChatDeletedForMe(userId: number, jid: string, deleted: boolean) {
  try {
    await db
      .update(waChatsTable)
      .set({ deletedForMe: deleted })
      .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.jid, jid)));
  } catch (err) {
    console.error("[persist] failed to set deletedForMe:", err);
  }
}

/** Add/update or (with an empty emoji) remove a reactor's reaction on a message. */
export async function saveReaction(userId: number, waMessageId: string, reactorJid: string, emoji: string, ts: number) {
  try {
    if (!emoji) {
      await db
        .delete(waMessageReactionsTable)
        .where(and(
          eq(waMessageReactionsTable.userId, userId),
          eq(waMessageReactionsTable.waMessageId, waMessageId),
          eq(waMessageReactionsTable.reactorJid, reactorJid),
        ));
      return;
    }
    await db
      .insert(waMessageReactionsTable)
      .values({ userId, waMessageId, reactorJid, emoji, ts })
      .onConflictDoUpdate({
        target: [waMessageReactionsTable.userId, waMessageReactionsTable.waMessageId, waMessageReactionsTable.reactorJid],
        set: { emoji, ts },
      });
  } catch (err) {
    console.error("[persist] failed to save reaction:", err);
  }
}

/** Read one account's full chat history from DB shaped for the engine's hydrate(). */
export async function loadHistory(userId: number): Promise<HydrateChat[]> {
  const chats = await db
    .select()
    .from(waChatsTable)
    .where(eq(waChatsTable.userId, userId))
    .orderBy(desc(waChatsTable.lastMsgTs));

  const result: HydrateChat[] = [];
  for (const c of chats) {
    const msgs = await db
      .select()
      .from(waMessagesTable)
      .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.jid, c.jid)))
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

/** All chats for one account, optionally filtered to one connected number. */
export async function getAllChats(userId: number, accountPhone?: string): Promise<WaChat[]> {
  const q = db.select().from(waChatsTable);
  if (accountPhone) {
    return q
      .where(and(
        eq(waChatsTable.userId, userId),
        eq(waChatsTable.accountPhone, accountPhone),
        eq(waChatsTable.deletedForMe, false),
      ))
      .orderBy(desc(waChatsTable.lastMsgTs));
  }
  return q
    .where(and(eq(waChatsTable.userId, userId), eq(waChatsTable.deletedForMe, false)))
    .orderBy(desc(waChatsTable.lastMsgTs));
}

/** All messages for one account's chat (from DB — survives restart). The
 *  heavy base64 `media` column is intentionally excluded; clients fetch each
 *  payload on demand via the media endpoint using `hasMedia`/`mediaKind`. */
export async function getChatMessagesDb(userId: number, jid: string) {
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
      participant: waMessagesTable.participant,
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
    .where(and(
      eq(waMessagesTable.userId, userId),
      eq(waMessagesTable.jid, jid),
      eq(waMessagesTable.hiddenForMe, false),
    ))
    .orderBy(asc(waMessagesTable.ts));

  const ids = rows.map((r: any) => r.waMessageId);
  const reactionRows = ids.length
    ? await db.select().from(waMessageReactionsTable).where(and(
        eq(waMessageReactionsTable.userId, userId),
        inArray(waMessageReactionsTable.waMessageId, ids),
      ))
    : [];
  const myPhone = (multiWA.getSessionInfo(userId)?.phoneNumber ?? "").replace(/\D/g, "");
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

// ── Backup sessions (admin-only) ─────────────────────────────────────
// A "session" is one connect→disconnect window for one number. These three
// functions back the admin panel's Backups screen: pick a number, pick a
// session (date/time), then browse it exactly like the live chat panel — but
// frozen to only what that session captured, regardless of what the panel
// user has since hidden/deleted (see the anti-delete design above).

/** Every backup session for this account, newest first, with a message count
 *  so the admin can tell an empty/aborted connect attempt from a real one. */
export async function getSessions(userId: number, phone?: string) {
  const rows = await db
    .select()
    .from(waSessionsTable)
    .where(phone ? and(eq(waSessionsTable.userId, userId), eq(waSessionsTable.phone, phone)) : eq(waSessionsTable.userId, userId))
    .orderBy(desc(waSessionsTable.connectedAt));
  if (!rows.length) return [];
  const counts = await db
    .select({ sessionId: waMessagesTable.sessionId, value: count() })
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), inArray(waMessagesTable.sessionId, rows.map((r) => r.id))))
    .groupBy(waMessagesTable.sessionId);
  const byId = new Map(counts.map((c) => [c.sessionId, Number(c.value)]));
  return rows.map((r) => ({ ...r, messageCount: byId.get(r.id) ?? 0 }));
}

/** The chat list as it looked during one session: every jid that had at
 *  least one message tagged with this session id, with the name/avatar the
 *  contact currently has (names don't un-resolve, so today's saved name is
 *  the right one to show for a past session too) and a preview computed only
 *  from that session's own messages. */
export async function getSessionChats(userId: number, sessionId: number) {
  const rows = await db
    .select({
      jid: waMessagesTable.jid,
      lastMsg: sql<string>`(array_agg(${waMessagesTable.text} ORDER BY ${waMessagesTable.ts} DESC))[1]`,
      lastMsgTs: sql<number>`MAX(${waMessagesTable.ts})`,
      messageCount: count(),
    })
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.sessionId, sessionId)))
    .groupBy(waMessagesTable.jid);
  if (!rows.length) return [];
  const chats = await db
    .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name, avatarUrl: waChatsTable.avatarUrl })
    .from(waChatsTable)
    .where(and(eq(waChatsTable.userId, userId), inArray(waChatsTable.jid, rows.map((r) => r.jid))));
  const metaByJid = new Map(chats.map((c) => [c.jid, c]));
  return rows
    .map((r) => {
      const meta = metaByJid.get(r.jid);
      return {
        jid: r.jid,
        phone: meta?.phone ?? r.jid.split("@")[0],
        name: meta?.name ?? null,
        avatarUrl: meta?.avatarUrl ?? null,
        lastMsg: r.lastMsg,
        lastMsgTs: Number(r.lastMsgTs),
        messageCount: Number(r.messageCount),
      };
    })
    .sort((a, b) => b.lastMsgTs - a.lastMsgTs);
}

/** Every message tagged with this session, for one jid — the frozen,
 *  original content (never affected by a later "delete for me"/"for
 *  everyone" on the live chat). */
export async function getSessionMessages(userId: number, sessionId: number, jid: string) {
  return db
    .select()
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.sessionId, sessionId), eq(waMessagesTable.jid, jid)))
    .orderBy(asc(waMessagesTable.ts));
}

/** Fetch a single message's media payload (base64) for the serve endpoint.
 *  Scoped to the requesting account so one customer can never fetch
 *  another's media by guessing/reusing a message id. */
export async function getMediaById(userId: number, waMessageId: string) {
  const [row] = await db
    .select({
      media: waMessagesTable.media,
      mediaMime: waMessagesTable.mediaMime,
      mediaKind: waMessagesTable.mediaKind,
      fileName: waMessagesTable.fileName,
    })
    .from(waMessagesTable)
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.waMessageId, waMessageId)))
    .limit(1);
  return row ?? null;
}

// ── Calls + Status ──────────────────────────────────────────────────

/** Persist (upsert) a WhatsApp call-log entry. Events for the same call share a
 *  callId (offer → terminal state), so we upsert and never let a late/duplicate
 *  ringing event downgrade a terminal outcome (missed/rejected/accepted). */
export async function saveCallLog(userId: number, call: WACall) {
  try {
    const accountPhone = multiWA.getSessionInfo(userId)?.phoneNumber ?? null;
    const sessionId = openSessionByUser.get(userId) ?? null;
    await db
      .insert(waCallLogsTable)
      .values({
        userId,
        callId: call.callId,
        jid: call.jid,
        phone: call.phone,
        name: call.name ?? null,
        accountPhone,
        sessionId,
        outgoing: call.outgoing,
        isVideo: call.isVideo,
        isGroup: call.isGroup,
        outcome: call.outcome,
        rawStatus: call.rawStatus,
        ts: call.ts,
      })
      .onConflictDoUpdate({
        target: [waCallLogsTable.userId, waCallLogsTable.callId],
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

/** Recent call log for one account, newest first. Left-joins wa_chats (by jid)
 *  so a caller we've also messaged directly shows their real profile photo,
 *  same as the chat list and status screens, instead of always an initial. */
export async function getCallLogs(userId: number, limit = 200) {
  const rows = await db
    .select({ call: waCallLogsTable, avatarUrl: waChatsTable.avatarUrl })
    .from(waCallLogsTable)
    .leftJoin(waChatsTable, and(eq(waChatsTable.userId, waCallLogsTable.userId), eq(waChatsTable.jid, waCallLogsTable.jid)))
    .where(eq(waCallLogsTable.userId, userId))
    .orderBy(desc(waCallLogsTable.ts))
    .limit(limit);
  return rows.map((r) => ({ ...r.call, avatarUrl: r.avatarUrl ?? null }));
}

/** Status (stories) grouped by the contact who posted them, for one account.
 *  WhatsApp stores all statuses under status@broadcast; we group by the
 *  captured poster JID and resolve a display name from the chat registry. */
export async function getStatusGroups(userId: number) {
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
    .where(and(eq(waMessagesTable.userId, userId), eq(waMessagesTable.jid, "status@broadcast")))
    .orderBy(desc(waMessagesTable.ts));

  // Resolve poster display names + photos from the chat registry.
  const chats = await db
    .select({ jid: waChatsTable.jid, phone: waChatsTable.phone, name: waChatsTable.name, avatarUrl: waChatsTable.avatarUrl })
    .from(waChatsTable)
    .where(eq(waChatsTable.userId, userId));
  const nameByJid = new Map<string, string | null>(chats.map((c: any) => [c.jid, c.name]));
  const nameByPhone = new Map<string, string | null>(chats.map((c: any) => [c.phone, c.name]));
  const avatarByJid = new Map<string, string | null>(chats.map((c: any) => [c.jid, c.avatarUrl]));
  const avatarByPhone = new Map<string, string | null>(chats.map((c: any) => [c.phone, c.avatarUrl]));
  // A status poster's participant jid is often a @lid (WhatsApp's opaque
  // privacy-addressing id) that carries no real digits at all. If we've ever
  // chatted with them directly, their real phone was already resolved onto
  // their wa_chats row (see multiWhatsapp's ensureRealPhone) — prefer that
  // over re-deriving the raw (meaningless, for @lid) digits from the jid.
  const phoneByJid = new Map<string, string>(chats.map((c: any) => [c.jid, c.phone]));

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
    const rawPhone = pj.includes("@") ? pj.split("@")[0].split(":")[0] : "";
    const phone = phoneByJid.get(pj) ?? rawPhone;
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
 * Wire engine → DB and load saved history into the engine for EVERY panel
 * account (multi-tenant: each account gets its own isolated WhatsApp session
 * hydrated from its own chat history). Idempotent.
 */
export async function startPersistence() {
  if (started) return;
  started = true;

  await seedDefaultAdmin();

  multiWA.addPersistListener((uid, jid, phone, msg, history, name, avatarUrl) => {
    void persistMessage(uid, jid, phone, msg, history, name, avatarUrl);
  });
  multiWA.addStatusListener((uid, update) => {
    void persistStatus(uid, update.waMessageId, update.status);
  });
  // ANTI-DELETE: when WhatsApp revokes a message (deleted for everyone), flag it
  // in the DB but keep the original content for monitoring.
  multiWA.addDeleteListener((uid, waMessageId) => {
    void markDeleted(uid, waMessageId);
  });
  // Emoji reactions (add or, with an empty emoji, remove). Strip a linked
  // device suffix (":14" in "923...:14@s.whatsapp.net") before persisting —
  // the optimistic local echo (sent right after we react) and WhatsApp's own
  // real echo of the same reaction don't always carry the same device
  // suffix, and saveReaction's unique key is the raw jid string, so an
  // unnormalized mismatch here created two DB rows for one physical reaction
  // (visible as a stuck count and a reaction that couldn't be removed).
  multiWA.addReactionListener((uid, _jid, waMessageId, reactorJid, emoji, ts) => {
    const normalizedJid = reactorJid.replace(/:\d+(?=@)/, "");
    void saveReaction(uid, waMessageId, normalizedJid, emoji, ts);
  });
  // Calls log: persist every call notification (incoming / missed / rejected).
  multiWA.addCallListener((uid, call) => {
    void saveCallLog(uid, call);
  });
  // Per-account registry: record every number that reaches the connected state.
  multiWA.addGlobalListener((state) => {
    if (state.status === "connected" && state.phoneNumber) {
      void recordAccount(state.userId, state.phoneNumber);
      // Owner's backup feature: one session per connect→disconnect cycle.
      // Guard on openSessionByUser so a state notify that leaves "connected"
      // unchanged (e.g. some other field updating) doesn't open a second
      // session on top of an already-open one.
      if (!openSessionByUser.has(state.userId)) {
        void openSession(state.userId, state.phoneNumber);
      }
    } else if (openSessionByUser.has(state.userId)) {
      void closeSession(state.userId);
    }
  });

  try {
    const users = await db.select({ id: panelUserTable.id }).from(panelUserTable);
    let totalChats = 0;
    for (const u of users) {
      const history = await loadHistory(u.id);
      if (history.length) {
        multiWA.hydrate(u.id, history);
        totalChats += history.length;
      }
    }
    console.log(`[persist] hydrated ${totalChats} chats across ${users.length} account(s) from DB`);
  } catch (err) {
    console.error("[persist] failed to hydrate history:", err);
  }

  await logEvent("Persistence started; engine wired to DB", "info", "system");
}
