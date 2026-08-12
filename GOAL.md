# GOAL.md — WhatsApp Panel: Name/Number Resolution & Chat/Status/Group Separation

> Analysis + plan document requested by the project owner (2026-08-12). Every
> change made against this goal happens on branch
> `claude/website-incoming-outgoing-issue-77uox7`.

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
