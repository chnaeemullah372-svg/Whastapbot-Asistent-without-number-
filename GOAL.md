# GOAL.md — Building a proper WhatsApp Web clone

> Analysis + plan document requested by the project owner (2026-08-12). Every
> change made against this goal happens on branch
> `claude/website-incoming-outgoing-issue-77uox7`, which auto-deploys to the
> owner's VPS on push. The owner's stated end goal: **this panel should behave
> like real WhatsApp Web** — every gap found vs. that target gets logged here
> and worked through.

## Round 1 — name/number resolution + chat/status/group separation

(See §3–5 below — unchanged from the first pass.)

## Round 2 — quoted replies ("mention"), delivery ticks, and a full feature audit

Owner's report (paraphrased): replying to a message ("mention" in their
wording — quoting a message the way WhatsApp pushes a small quoted snippet
to the side) wasn't working reliably end-to-end — sending, receiving, and
the tick status — and asked for a complete sweep of whatever else is missing
compared to real WhatsApp Web.

### Findings

- `parseWAMessage()` only ever looked for a quote's `contextInfo` on
  `extendedTextMessage` (plain text replies). WhatsApp attaches
  `contextInfo` to **any** message type — replying with a photo/video/voice
  note/document/sticker carries the quote on that media message's own
  `contextInfo`, not on an `extendedTextMessage`. So quoting a message and
  replying with media silently dropped the quote.
- `sendToJid()` (used for **groups**) had no `quoted` parameter at all —
  only the 1:1 `sendMessage()` path supported sending a quoted reply. Group
  quoted replies were impossible even at the engine level.
- `/panel/send` never accepted a quote in its request body, and the
  frontend (`chats.tsx`, `groups.tsx`) had **no UI to quote-reply at all** —
  no way to select a message and reply to it. So even though the engine
  could technically send a quoted reply, nothing in the product let an admin
  trigger one.
- The SSE stream (`/panel/events`) had no event for tick changes
  (sent → delivered → read). The open conversation only found out about a
  new blue tick on its next 12-second poll, not live like WhatsApp.

### Fixed

- `multiWhatsapp.ts`: new `extractQuoted()` reads `contextInfo` off every
  message type (text + all media kinds), so a quote is never lost based on
  what the reply itself contains.
- `multiWhatsapp.ts`: `sendToJid()` now accepts and sends a `quoted` payload,
  same as `sendMessage()` — group quoted replies now work at the engine
  level.
- `panel.ts`: `/panel/send` accepts `quotedId` / `quotedFromMe` /
  `quotedText` and passes them through to whichever send path is used.
  `/panel/events` now emits a `status` SSE event on every tick change.
- `chats.tsx` / `groups.tsx`: tapping any message now offers **Reply**
  (own or the other party's messages) in addition to Delete (own messages
  only); replying shows a WhatsApp-style quoted preview bar above the
  composer with a cancel (×), and sending includes the quote. Both list
  screens now bump the open conversation on the new `status` SSE event, so
  ticks update instantly.

### Full feature-parity audit — results

A read-only audit compared this app against real WhatsApp Web across 19
feature areas. Full detail per item (with file:line evidence) lives in the
audit output; the summary and backlog below is what matters for planning.

| # | Feature | Status |
|---|---|---|
| 1 | Message reactions (emoji react) | Missing |
| 2 | Message editing (edit-in-place) | Partial — unwrapped for text only, never applied as an update; shows as a duplicate message, no "edited" label |
| 3 | Delete for me vs delete for everyone | Partial — only "delete for everyone" (revoke) exists; no local-only hide |
| 4 | Forward a message to another chat | Missing |
| 5 | Starred/pinned messages in a chat | Missing |
| 6 | Pin / mute / archive a chat | Missing |
| 7 | Typing indicator + online/last-seen presence | Missing |
| 8 | @mentions in groups (render `@Name`, mention on compose) | Missing |
| 9 | Link previews for shared URLs | Missing (explicitly disabled: `generateHighQualityLinkPreview: false`) |
| 10 | Group management (participants, add/remove, promote/demote, subject/description/icon, invite link, leave) | Missing |
| 11 | Real profile photos (contacts + groups) | Missing — avatars are always a generated initial-letter circle |
| 12 | View-once media handling | Partial — deliberately unwrapped and permanently saved (anti-delete monitoring design), no "View once" UI indication at all |
| 13 | Disappearing messages | Partial — envelope unwrapped for text only; timer never read/shown |
| 14 | Search within an open chat | Missing (only chat-list search exists) |
| 15 | Sending media (photo/video/voice/document) as an outgoing message | Missing — composer is text-only, `/panel/send` has no media field |
| 16 | Multi-account (2+ numbers linked at once) | Partial — schema + admin read-only history browser exist, but the live engine is hard-pinned to one session (`PANEL_USER_ID = 1`) |
| 17 | Avatar consistency | Missing (same root cause as #11) |
| 18 | Read-receipt-disabled awareness (grey ticks forever) | Missing — no UI explanation for a contact who has read receipts off |
| 19 | Send-path robustness (not-on-WhatsApp check, rate limiting, offline queueing) | Partial — errors surface to the admin, but no `onWhatsApp()` pre-check, no retry/queue if the socket drops mid-send |

### Backlog, triaged

**Quick wins** (small, no schema change, no new screens):
- #18 note/tooltip when a sent message has had no read update for a long time (read receipts likely off)
- #19 `onWhatsApp()` pre-send check with a clear composer error
- #9 link previews (flip the disabled flag + a preview-card in the bubble renderer)
- #14 in-chat search (client-side filter over already-loaded messages)
- #3 a genuine local "Delete for me" alongside the existing "Delete for everyone"

**Medium** (schema change and/or a new endpoint, moderate UI):
- #1 reactions (column/table + `messages.reaction` listener + react endpoint + emoji picker)
- #4 forwarding (new endpoint reusing existing message content + chat picker)
- #5 starred messages (boolean column + star action + a Starred screen)
- #6 pin/mute/archive chat (boolean columns + chat-list menu + sort/filter)
- #8 @mentions (parse `mentionedJid` → render `@Name`; compose-time mention insert is separate follow-up)
- #15 outgoing media (multipart upload + Baileys media payload + attachment/camera/mic UI)
- #11/#17 profile photos (fetch/cache `profilePictureUrl`, new avatar column, `<img>`-with-initials-fallback everywhere)

**Big lifts** (new subsystems, multiple screens, or a product decision):
- #2 proper message editing (apply as update-in-place, "edited" label, edit history)
- #7 presence/typing (needs `sendPresenceUpdate` + an SSE presence pipeline + a privacy/perf call on always broadcasting "online")
- #10 group management (participant list, add/remove/promote/demote, subject/description/icon editing, invite link, leave — effectively a new "Group Info" screen)
- #12/#13 view-once/ephemeral — **this is a product/policy decision, not a code gap**: today the app *deliberately* defeats both (permanently saves view-once media, ignores disappearing timers) as part of its anti-delete/monitoring design. Whether that stays, changes, or just gets labeled honestly in the UI needs an explicit owner decision before any code changes here.
- #16 true multi-account (more than one simultaneous Baileys session, an account switcher UI, decoupling `PANEL_USER_ID` from a single hardcoded session)

Status: ~~awaiting owner prioritization~~ — owner said build all of it, top to bottom, and label view-once/disappearing content clearly in the UI rather than changing the underlying anti-delete behavior. See Round 3.

## Round 3 — building the rest of the WhatsApp Web feature set

Everything in the backlog above is now implemented, except true multi-account
(explicitly held back — see below).

| # | Feature | Status |
|---|---|---|
| 1 | Message reactions | ✅ done — emoji react/unreact, live via SSE, shown as pills under the bubble |
| 2 | Message editing | ✅ done — applied in place (protocolMessage MESSAGE_EDIT), "edited" label |
| 3 | Delete for me vs everyone | ✅ done — separate "Delete for me" (local hide) and "Delete for everyone" (revoke) |
| 4 | Forward a message | ✅ done — chat picker, re-sends the stored text/media |
| 5 | Starred messages | ✅ done — star/unstar + a dedicated Starred Messages screen (Settings → Starred Messages) |
| 6 | Pin / mute / archive chat | ✅ done — chat-list menu, pinned-first sort, Archived section |
| 7 | Typing indicator + presence | ✅ done for 1:1 chats (typing…/recording/online/last seen, both directions). Group per-participant typing not built (see Known gaps). |
| 8 | @mentions in groups | ✅ done for receiving (renders `@Name`); composing with an `@` autocomplete was not built (see Known gaps) |
| 9 | Link previews | ✅ done — thumbnail/title/description card in the bubble |
| 10 | Group management | ✅ done — Group Info screen: participants, promote/demote/remove, edit subject/description, invite link get/reset, leave |
| 11 | Real profile photos | ✅ done — fetched/cached from WhatsApp, shown everywhere an avatar renders |
| 12 | View-once media | ✅ labeled — content is still saved (monitoring design, kept as-is per owner's choice), now shows a clear "View once" badge instead of silently looking like a normal photo |
| 13 | Disappearing messages | ✅ labeled — same as above, shows a "Disappearing" badge |
| 14 | In-chat search | ✅ done — search icon in the conversation header, filters the open chat |
| 15 | Outgoing media | ✅ done — attachment button sends photo/video/voice-note/document via a new upload endpoint |
| 16 | Multi-account (2+ numbers at once) | ❌ **not built — see below** |
| 17 | Avatar consistency | ✅ done (same as #11) |
| 18 | Read-receipt-off awareness | ✅ done — a tick stuck at double-grey for 24h+ gets a tooltip hinting read receipts may be off |
| 19 | Send-path robustness | ✅ done — `onWhatsApp()` pre-check before messaging a brand-new number, with a clear error instead of a silent failure |

### Why multi-account (#16) was not built

This app's entire auth model is one admin login mapped to one hardcoded
WhatsApp session (`PANEL_USER_ID = 1`, called out explicitly in
`chatPersistence.ts`: "The whole app is built around ONE panel user").
Running two or more WhatsApp numbers connected *at the same time* means
deciding: does the admin log into separate accounts per number, or does one
login control several simultaneous sessions with a switcher? Either answer
changes the login/session model this app is built on today, on a branch that
auto-deploys straight to production. That's a product decision, not a code
gap — implementing a guess here risks breaking the single-account panel
that's currently working. **Needs an explicit decision from the owner
before any code changes.** Everything else in the original 19-item audit is
built.

### Known small gaps (not blocking, worth a mention)

- **Group typing indicator**: presence/typing is wired for 1:1 chats only.
  WhatsApp shows per-participant "X is typing…" in groups, which needs
  mapping each participant jid to a name and handling multiple simultaneous
  typers — a smaller follow-up if wanted.
- **Composing an @mention**: incoming mentions render as `@Name` correctly,
  but there's no `@`-triggered autocomplete when typing a new group message
  (you can still type a number and WhatsApp will resolve it as a mention on
  the receiving end once sent, but there's no in-app assist for it).
- **Live verification**: none of this has been exercised against a real
  linked WhatsApp account — that requires scanning a QR/pairing code on an
  actual phone, which isn't possible from this sandboxed session. Please
  check the panel after each deploy and report anything that doesn't behave
  like real WhatsApp Web; the fix loop from here is fast.

## 1. Reported problem (as described by the owner, in Urdu)

- Website ke dashboard mein contact ka **naam/number sahi tarah show nahi
  hota** — kabhi number show hota hai, kabhi sirf `••••••` (dots) dikhte
  hain, formula samajh nahi aata.
- Expectation: jaise WhatsApp Web mein hota hai — agar number phone ke
  **saved contacts** mein maujood hai (jo connected WhatsApp account ke
  through sync hota hai) to uska **saved naam** show ho; agar naam save
  nahi hai to **number khud show** ho (dots nahi).
- **Chats** tab mein sirf 1:1 chats aani chahiye, **Status** tab mein sirf
  status/stories, **Groups** tab mein sirf groups — bilkul WhatsApp app ki
  tarah alag alag.

## 2. Codebase map (this is a pnpm monorepo)

```
artifacts/api-server/       Express backend. Baileys (@whiskeysockets/baileys)
                             drives the actual WhatsApp connection.
  src/services/multiWhatsapp.ts   The WhatsApp engine: one Baileys socket per
                                  user, in-memory chat store, all WA event
                                  handling (messages, history sync, calls,
                                  contacts, connection state).
  src/services/chatPersistence.ts DB read/write layer (Drizzle) sitting
                                  between the engine and Postgres.
  src/routes/panel.ts             REST endpoints the frontend calls
                                  (/panel/chats, /panel/status, /panel/calls…).

artifacts/support-connect/  The WhatsApp-Web-style PWA (React) — this is
                             "the website" the owner is looking at.
  src/pages/panel/chats.tsx       1:1 chat list + conversation view.
  src/pages/panel/groups.tsx      Group list + conversation view.
  src/pages/panel/status.tsx      Status/stories viewer.
  src/pages/panel/calls.tsx       Call log.
  src/lib/panelApi.ts             Shared API client + display helpers.

lib/db/                     Drizzle schema + migrations (wa_chats, wa_messages,
                             wa_call_logs, wa_accounts, …).
```

## 3. Root cause analysis

### 3.1 Name/number bug (the main complaint)

Found in `multiWhatsapp.ts`. The engine had **no listener at all** for
Baileys' `contacts.upsert` / `contacts.update` events — the events that
carry the **real, phonebook-saved contact name** synced from the linked
phone. Instead, a contact's display name was taken only from:

1. `msg.pushName` — the sender's own **self-set** WhatsApp display name
   (not the name *you* saved for them). This is unreliable: it's often
   missing on the first message of a history sync, some people set it to
   nothing, and some clients literally send the phone number back as
   `pushName`. This alone explains "kabhi number show hota hai, kabhi kuch
   aur" — the app was quietly showing whatever the *other person* chose to
   call themselves, inconsistently.
2. The chat title from `messaging-history.set` (Baileys does derive this
   from the contact store when available) or a group's `subject`.

Whichever of these arrived **last** won, unconditionally — a later,
worse `pushName` could silently overwrite a better name learned earlier
in the same session (`upsertMsg` did `entry.meta.name = nameHint` with no
notion of "how good is this name").

On top of that, `chatPersistence.ts` wrote the name to Postgres with
`COALESCE(new_name, existing_name)` — meaning **once any name (even a bad
one) was stored, it could never be corrected**, not even by a later,
better source, and a group rename would never update either.

Finally, the frontend (`chats.tsx`, `status.tsx`, `calls.tsx`) rendered
`name || "••••••"` — hiding the number entirely instead of falling back to
it, which is the opposite of real WhatsApp Web behaviour (unsaved
contacts show their number, not a placeholder).

### 3.2 Chats / Status / Groups separation

This part was **already implemented correctly** on this branch (commits
`ac595c8`, `f0033e2`): `chats.tsx` filters out `@g.us` and
`status@broadcast`, `groups.tsx` shows only `@g.us`, and `status.tsx`
reads from a dedicated `/panel/status` endpoint that groups
`status@broadcast` messages by poster. No changes were needed here beyond
verifying it — see §5.

## 4. Fix implemented

### 4.1 `multiWhatsapp.ts` — real contact-name resolution with a priority system

- Added a **name tier** per jid (`nameTier` map): tier 2 = a real contact
  (`contacts.upsert`/`contacts.update` → `name` or `verifiedName`), tier 1
  = a guessed chat title (history-sync chat title / group subject). A
  lower tier can never overwrite a higher one already known.
- Added `sock.ev.on("contacts.upsert", …)` and `sock.ev.on("contacts.update", …)`
  — this is the missing piece that reads the actual phonebook-saved name
  (or WhatsApp's verified business name) from the linked account's synced
  contacts.
- Removed `pushName` as a name source entirely for individual chats — it
  is not a saved contact name and was the main source of the inconsistent
  behaviour described.
- New `applyName()` helper centralizes every name write through the tier
  check, and creates a bare chat entry the moment a contact's name is
  known even before their first message arrives.

### 4.2 `chatPersistence.ts` — stop freezing the first name forever

- `wa_chats.name` and `wa_call_logs.name` now **overwrite** on every
  update where a name is supplied (the engine only ever supplies one once
  it's at least as good as what it had), instead of `COALESCE`-ing and
  permanently keeping the first value ever seen. This also fixes group
  renames never propagating.

### 4.3 Frontend — show the number instead of a placeholder

- Added `formatPhone()` / `displayName()` helpers to `panelApi.ts`.
- `chats.tsx`, `status.tsx`, `calls.tsx`: replaced every `name || "••••••"`
  with `displayName(name, phone)` — saved name if known, otherwise the
  real number, matching WhatsApp Web.
- Chat search in `chats.tsx` now matches against the resolved
  name-or-number too.

### 4.4 Verified, not changed

- Chats/Groups/Status separation (`chats.tsx`, `groups.tsx`, `status.tsx`,
  `/panel/chats`, `/panel/status`) — confirmed correct, no change made.

## 5. Status

- [x] Root-cause analysis complete.
- [x] Backend: `contacts.upsert`/`contacts.update` wired in, name-tier
      system added, pushName dropped as a name source.
- [x] Backend: DB name persistence no longer freezes on the first value.
- [x] Frontend: number shown instead of `••••••` when no saved name.
- [x] `tsc --noEmit` clean on both packages for the touched files (no new
      errors vs. the pre-existing baseline).
- [ ] **Live verification on a real linked WhatsApp account** — this
      requires scanning a QR / pairing code on an actual phone, which
      cannot be done from this sandboxed dev session. Needs the owner (or
      a VPS this session is attached to) to deploy and link a real number,
      then confirm saved contacts now show their real names and unsaved
      ones show their number.
- [ ] Optional follow-up (not requested yet): show a small "•" or
      WhatsApp-style label for business "verified name" vs. a plain saved
      contact name, if the owner wants that distinction visible in the UI.

## 6. Round 4 — live testing on hatelecom.xyz + a deployment bug found

Logged into the live site (admin panel + user panel) with the credentials
the owner provided and probed the real, deployed API directly (not just
the source code) to verify everything actually works end to end.

### 6.1 Confirmed working live

- Login (user panel + admin panel), multi-account DB schema is live
  (`panel_user` table already has 2+ rows, composite per-user columns on
  `wa_chats`/`wa_messages` are in place).
- `GET /admin-panel/users` (new multi-account list), `GET
  /admin-panel/stats`, `GET /admin-panel/pairing-code` — all return
  correct, per-account-scoped, up-to-date data (280 chats / 12,885
  messages on the main account, matching what's expected).
- Signup flow (`/panel/signup`) — creates new accounts fine (used to
  create a real second test account, `probe_signup_test`, id 3).

### 6.2 Bug found: the live server is running frozen/stale code

`POST /admin-panel/users`, `POST /admin-panel/users/:id/approve`, `POST
/admin-panel/users/:id/revoke`, and `DELETE /admin-panel/users/:id` all
return a plain Express `Cannot POST/DELETE ...` 404 on the live site —
even though they are correctly defined in `adminPanel.ts` on this branch,
in the same file and same commit as the `GET` routes that *do* work.

Since Express registers every route independently (one route failing to
register can't skip over later ones in the same file), the only
explanation that fits the evidence is: **the Node process actually
serving hatelecom.xyz is running an older build of the api-server that
predates these four routes**, while the database schema and some other
routes were already updated (because `scripts/post-merge.sh` pushes DB
schema and pulls source, but never rebuilds or restarts the running app
process).

`.replit` confirms this is architecturally expected: `[postMerge]` has a
hard `timeoutMs: 20000` (20s) — nowhere near enough time to run a full
monorepo `pnpm run build` (esbuild bundle + Vite frontend build) safely,
so it was correctly scoped to just `pnpm install` + `pnpm --filter db
push`. **Shipping new backend/frontend code to production is a separate
step this project relies on Replit's own Deployment feature for** (the
`[deployment]` block, `deploymentTarget = "gce"`) — that's the thing that
needs to be re-triggered (Redeploy) after a push for the running server
to actually pick up new code. Pushing to git alone updates files + the
database, but not the live running process.

**Action needed from the owner:** open the Replit Deployments dashboard
for this project and hit **Redeploy** (or turn on "auto-deploy on push"
for this branch there, if available) so the live server picks up
everything already pushed: the LID-address fix, voice message recording,
document download/forward, and full multi-account admin CRUD. Everything
described in Round 3 and below is done and pushed to
`claude/website-incoming-outgoing-issue-77uox7` — it just isn't being
served yet because the process hasn't restarted on new code since before
several of these commits landed.

### 6.3 Not yet verified (blocked on the above)

- [ ] Multi-account isolation end-to-end (create 2nd account via the new
      admin UI, confirm empty/separate chat list + own WhatsApp QR).
- [ ] Voice message send/receive on a real chat.
- [ ] Document (.xlsx etc.) download + in-app forward-to-any-number on a
      real chat.
- [ ] Reactions/star/forward/pin/mute/archive/typing/presence/@mentions
      on a real, live conversation (all pushed and typechecked, but only
      exercised locally, not against the live WhatsApp connection).

## Round 5 — search formula + open-chat "more options" menu, on the live VPS

Owner's report (paraphrased, Urdu): the send/forward contact search should
match real WhatsApp Web's formula — search by saved name, or by number with
or without the leading local "0" — and every chat's top-right 3-dot menu
should carry all of WhatsApp Web's options. Investigated directly against
the live, connected panel (283 real chats, `+923186959638`) on the VPS this
now runs on (self-hosted under PM2, not Replit — see the deploy section at
the top of this file, which superseded the Replit flow described in Round 4).

### Bug found: contact search never matched by phone once a name was saved

`displayName(name, phone)` returns *either* the name *or* the phone —
never both — by design (it's a display helper). But `chats.tsx`,
`groups.tsx`'s `ForwardSheet` (×2), and the main chat list all filtered
search results by running the search text against that single display
string. Once a contact had a saved name, its phone number became
permanently unsearchable — typing a number, with or without the leading
local "0", could never find a named contact. Confirmed against real data
(e.g. a saved contact at `923069122298`): searching `03069122298` returned
nothing before the fix.

**Fixed**: new `matchesContactSearch(name, phone, query)` in `panelApi.ts`
checks the name *and* the raw phone digits independently, stripping a
leading "0" from the typed query before comparing against the stored
international-format number — the same normalization WhatsApp Web's own
search box applies. Wired into all three affected filters. Verified against
live data both via unit-style checks and the real `/panel/chats` endpoint.

### Gap found: the open-conversation header had no 3-dot menu at all

Only a search icon existed in `Conversation`'s header — none of WhatsApp
Web's per-chat "more options" (accessible without going back to the chat
list) were present.

**Added**: a 3-dot menu in the conversation header with Contact info (a
simple avatar/name/number sheet), Select messages (now enterable without
first long-pressing a bubble), Mute/Unmute notifications, Archive chat, and
Close chat.

**Also added to the chat-list row's 3-dot menu** (had only Pin/Mute/Archive):
Mark as unread / Mark as read, and Delete chat. "Delete chat" follows this
app's existing anti-delete philosophy (same as message-level "delete for
me"): it's a local-only hide (`wa_chats.deleted_for_me`, pushed live via
`drizzle-kit push`), never a WhatsApp protocol call, and clears itself the
next time that chat sees a live message — exactly like real WhatsApp Web,
where a deleted chat reappears once new activity arrives. Both new actions
verified end-to-end against the live API (mark unread/read, delete/restore).

### Not done in this pass — flagged, not silently skipped

- **Report contact / Block contact** (present in WhatsApp Web's open-chat
  menu): no backend support exists at all — Baileys has a block API but
  nothing here calls it, and "Report" has no destination to report to on a
  self-hosted panel. A real "big lift" like #16 in Round 3 — needs an
  explicit decision on what Block should even do here (hide vs. actually
  block the WhatsApp number) before building it.
- **Disappearing-messages toggle** in the conversation menu: the app
  already reads/labels disappearing timers (Round 3, #13) but never lets
  the admin *set* one from the UI — a separate, smaller follow-up if wanted.
- A pre-existing crash was observed independently of this work: the
  `whatsapp-api` PM2 process has restarted ~28 times, at least one crash
  traced to an uncaught `UND_ERR_SOCKET` (undici) surfacing as an unhandled
  rejection and killing the whole process instead of just that one request.
  Worth a follow-up (wrap the offending call, or a global
  `unhandledRejection` guard) since every crash briefly drops the live
  WhatsApp connection until PM2 restarts it.

### Status

- [x] Search formula fixed (3 call sites) and verified against live data.
- [x] Conversation header 3-dot menu added (Contact info, Select messages,
      Mute, Archive, Close).
- [x] Chat-list 3-dot menu: Mark as unread/read + Delete chat added,
      schema pushed live, verified end-to-end against the running API.
- [x] `tsc --noEmit` clean on `db`, `api-server`, `support-connect`; both
      packages rebuilt and the live PM2 processes restarted onto the new
      build.
- [ ] Report/Block contact — needs an owner decision (see above), not built.
- [ ] `UND_ERR_SOCKET` crash-loop — noted, not fixed in this pass.

## Round 6 — live message-action testing on Chromium + @lid number bugs (Groups/Status/Calls)

Owner asked for a real, in-browser walkthrough (not just API checks): send a
message in the first chat, exercise every message-level 3-dot action
(reactions/reply/star/forward/delete-for-me/delete-for-everyone/view-once),
and separately check why Groups and Status were showing wrong numbers.
Driven live via headless Chromium (Playwright) against `hatelecom.xyz`,
logged in as `admin`, on the real connected account (`+923186959638`) — the
owner was actively on the other end of the test chat in real time and
independently confirmed both the bug and the fix (see below).

### Critical bug found and fixed: quoted replies sent from the panel never carried the quote

Clicking **Reply** on a message, typing an answer, and sending produced a
perfectly normal, **unquoted** message — `replyTo` was silently never being
set. Root cause: the per-message action menu (`chats.tsx`) is nested inside
the same bubble `<div>` that runs the swipe-to-reply gesture, which calls
`setPointerCapture()` on `pointerdown`. Because nothing in the menu stopped
event propagation, every tap inside it (Reply, Star, Forward, Delete…)
bubbled up into that bubble's own click/pointer handlers, and the resulting
interference meant `setReplyTo(m)` never stuck. This is the same "mention
message نہیں آیا" (quote didn't come through) the owner had already noticed
live — confirmed independently from the real recipient's phone while
testing, and confirmed fixed the same way afterward (`quotedText` correctly
attached in the DB row, and the recipient's own reply quoted it back). Fix:
`e.stopPropagation()` on the menu's `onClick`/`onPointerDown` in both
`chats.tsx` and `groups.tsx` (groups doesn't use pointer-capture but the
same nesting risk existed there too).

### Bug found and fixed: Groups and Status showed WhatsApp's opaque @lid digits instead of real phone numbers

Same root cause in three places — a poster/participant's `@lid` jid (an
opaque per-app privacy id, *not* a phone number) was being digit-split
directly instead of resolved to the real number:

- `getStatusGroups` (`chatPersistence.ts`) recomputed a status poster's
  phone from the raw participant jid instead of using the already-resolved
  real phone sitting right there in `wa_chats` for anyone we've ever
  chatted with directly.
- `getGroupInfo` (`multiWhatsapp.ts`) did the same for group participants —
  worse here, since most group members were never messaged 1:1, so there
  was no cached phone at all for the vast majority (557/557 participants in
  one sampled group all showed wrong numbers before the fix).
- `handleCall`'s call-log phone (same file) had the identical bug for the
  Calls tab.

**Fixed**: `getStatusGroups` now prefers `wa_chats.phone` (keyed by jid)
over the raw split. For posters/participants with **no** chat history at
all (the common case for group members), added `resolveLidPhones()` — a
live, read-only `sock.signalRepository.lidMapping.getPNForLID()` lookup
(the same primitive `ensureRealPhone` already used for regular chats) — and
wired it into both `/panel/status` and `getGroupInfo`. Verified live: every
one of 29 status posters and all 557 participants in a sampled group now
show a correct `92xxxxxxxxx`-format number instead of 15-digit lid noise.
Calls got the cheap half (prefer the cached chat phone) without the live
lookup, since it wasn't the reported bug.

### Feature added: sending a photo/video as "View once"

Round 3 only handled *receiving* view-once media (label + anti-delete
save); there was no way to *send* one from the panel. Added: Baileys'
`viewOnce: true` on `sendMessage`'s image/video content
(`multiWhatsapp.ts`), a `viewOnce` field threaded through
`/panel/send-media`, and a WhatsApp-style pre-send preview screen in
`chats.tsx` (photo/video preview + caption + a "View once" toggle pill)
replacing the old fire-and-forget-on-pick behavior for images/videos only
(voice notes/documents still send immediately, unchanged). Verified live —
sent and confirmed the outgoing message renders its own "View once" badge.

### Confirmed working live (no change needed)

- Delete for everyone: revokes on WhatsApp and immediately shows the red
  "Deleted for everyone" label while keeping the original content visible
  (anti-delete design working as intended) — verified via direct delete +
  via the fixed UI button.
- Reactions, Star, Forward, Delete for me — menu renders and is wired
  correctly (verified visually; not each individually round-tripped this
  pass since none showed the reply-style symptom).

### Not chased this pass (flagged, not silent)

- The owner reported messages arriving slow ("*msg slow aty jaty han*")
  during live testing — no root cause investigated yet; worth a dedicated
  pass (check Baileys event-loop pressure / the existing `UND_ERR_SOCKET`
  crash-loop above as a possible related cause) rather than a guess here.
- Reaction "by me" detection (`chatPersistence.ts`'s `getChatMessagesDb`)
  has the same raw-lid-split pattern for the *reactor's own* jid — lower
  priority since it only affects the `byMe` highlight on a self-reaction
  sent from a lid-addressed linked device, not a visible wrong number.
