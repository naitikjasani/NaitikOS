# Offline — the outbox, the read cache, and the PWA

> Blueprint §5.7, §5.8, §12 week 2. Code: `apps/web/lib/offline/`,
> `apps/web/lib/query/`, `apps/web/public/sw.js`,
> `packages/db/src/repositories/idempotency.repository.ts`.

> "The PWA must be fully usable in a gym basement with no signal. That is the
> actual, concrete requirement, and it is the one that dictates the design."

§5.7 rejected full local-first replication (SQLite-WASM plus a sync engine) as
solving a harder problem than the one that exists. What is built instead is
**outbox writes plus a persisted read cache**, and the two halves have different
guarantees on purpose.

```
WRITE   optimistic UI update
          → append to IndexedDB outbox { id, idempotencyKey, payload, hlc }
          → drain on connectivity / visibility / interval
          → server deduplicates on idempotencyKey
          → reconcile, invalidate, drop from outbox

READ    TanStack Query persisted cache
          → offline: serve from cache, banner states data age
          → online: stale-while-revalidate
```

## The write path

### Durable before the network

`submitClose` does not call `fetch`. It calls `enqueue`, which resolves only
after the entry is in IndexedDB. The optimistic UI update happens separately and
immediately; the await is what makes the promise that the write survives the tab
being closed one second later.

The practical consequence is that **submitting a Close cannot fail** from the
operator's point of view. It is queued, the banner says so, and it is sent when
it can be.

### Nothing is ever discarded

> "Outbox durability is a hard requirement. A failed drain must never silently
> discard a write. Entries persist until acknowledged; entries that fail
> repeatedly surface in a visible 'unsynced' state with a manual retry. Losing a
> logged workout because the drain failed quietly would end the user's trust in
> the system, and trust is the whole product."

An entry has three states and only one exit:

| State | Meaning |
|---|---|
| `pending` | Waiting. Retried on the next drain, after its backoff |
| `sending` | In flight. Reset to `pending` at startup if the tab died |
| `blocked` | Out of attempts. Needs a person. **Never deleted** |

`acknowledge` is the only function that removes an entry, and it runs only on a
2xx. A 4xx that will never succeed walks the entry to `blocked`, where the
banner surfaces it with a retry — not to deletion.

Six attempts with exponential backoff (2, 4, 8, 16, 32, 60 seconds) is a little
over an hour of trying. Past that the failure is not transient and automatic
retries are noise.

### The stalled-entry recovery

A tab that dies mid-request leaves its entry `sending`, and a `sending` entry is
invisible to every future drain — the silent discard §5.7 forbids, arriving
through the back door. `recoverStalled` runs once at startup and returns them to
`pending`. It is safe because the server deduplicates: re-sending an entry that
did arrive returns the original response.

### Ordering

The drain is **sequential**, oldest first. Two closes of the same day queued
offline must reach the server in the order they were made, or the earlier answer
supersedes the later one and the correction chain records the operator changing
their mind backwards. Parallelism would buy nothing at this volume.

### Raw IndexedDB, no wrapper

`idb` would halve the file. Rejected on C2: this is the component that must
never lose a write, and in 2046 it must still run. Two hundred lines of a stable
browser API is a smaller liability than a dependency that must still install and
still be correct in twenty years.

The one genuine trap is handled explicitly at `withStore`: an IndexedDB
transaction auto-commits when the microtask queue drains, so `await`-ing
anything unrelated inside one silently closes it and every subsequent request
throws `TransactionInactiveError`. Every transaction here builds its requests
synchronously and resolves on `oncomplete`.

### Dependency ordering

*Added in the Gym milestone, because Gym is the first module whose writes depend
on each other.*

A `workout_set` references its session by foreign key. A session logged offline
queues one start and a dozen sets, and a set that reaches the server first is
rejected with `23503`.

Sorting by `enqueuedAt` is **not sufficient**, and this is the part that is easy
to get wrong: the drain continues past a failure, so one failed session start
would let every set behind it try, fail, and burn one of its six attempts.

So an entry may name a prerequisite:

```ts
await queueAndDrain({
  endpoint: '/api/gym/sets',
  body: { sessionId, set },
  label: `Set · ${exerciseName}`,
  dependsOn: sessionQueueEntryId,   //  ← held until that entry is acknowledged
});
```

`readyEntries` withholds an entry while its dependency is still in the store —
and since only `acknowledge` deletes, *still in the store* means *the server has
not confirmed it*. The drain re-reads between sends rather than iterating one
snapshot, so a set becomes ready the instant its session lands rather than
waiting for the next sweep thirty seconds later.

A dependency that exhausts its attempts takes its dependants with it, **visibly**:
`orphanedEntries` finds them and the drain moves them to `blocked`, where §5.7
wants them "surfaced in a visible unsynced state with a manual retry". Leaving
them pending forever would be the silent discard §5.7 forbids, arriving slowly.

The server carries the same guarantee independently. If an entry slips through
without a declared dependency — a tab reloaded mid-session loses the in-memory
mapping — the foreign-key violation is translated into a *retryable*
`workout_session_missing` precondition rather than a permanent rejection. Belt on
the client, braces on the server.

## Idempotency

The server half. `withIdempotency` wraps every mutation, so a handler never sees
an idempotency key and can never forget to claim one.

| Outcome | Response |
|---|---|
| `fresh` | Run the handler, store its response, return it |
| `replayed` | Return the **stored response**, verbatim, with `X-Idempotent-Replay` |
| `in_flight` | `409` with `Retry-After` |

Storing the response is the point. A dedupe that merely *rejects* a replay would
leave the outbox entry queued forever — the client needs the original result in
order to reconcile and drop it.

`in_flight` covers two drains racing the same entry, which happens when a tab
and a background wake-up fire together. Without it both would see "no record",
both would execute, and the write path's own idempotency would be the only thing
standing between the user and a double-write. It holds — client-generated UUIDv7
primary keys plus `ON CONFLICT DO NOTHING` — but relying on it means the
guarantee lives in two places and only one of them is documented.

The request is **fingerprinted**. A client bug that reuses one key for two
different Daily Closes would otherwise get the first close's response for the
second submission and silently discard it; the record would have no gap and no
error, it would simply lack a day.

Only successful outcomes are recorded. A stored 4xx would make the failure
permanent for the life of the key: the client fixes its payload, retries with
the same outbox entry, and gets the original rejection back for a week.

## The read path

TanStack Query with a hand-rolled `localStorage` persister.

`@tanstack/react-query-persist-client` plus a storage persister would do this,
and it is two more packages for about forty lines of `dehydrate`, `hydrate` and
a debounced write — both of which TanStack already exports from the core
package.

`localStorage` rather than IndexedDB, because the outbox is in IndexedDB for a
reason that does not apply here: losing a *write* is unacceptable, losing a
cached *read* costs one refetch. `localStorage` is synchronous, so the cache is
warm before first paint.

Only settled, successful queries are persisted. Persisting an error state would
make a transient failure survive a restart, which looks exactly like a permanent
one.

## The service worker

`public/sw.js` does exactly one job: **serve the application shell offline**, so
that opening the app with no signal produces the app rather than the browser's
error page.

It deliberately does **not** cache API responses and does **not** queue writes.

Reads are cached by TanStack Query, which knows what a query *is* — a service
worker sees only URLs, so its cache cannot be invalidated by a mutation and
would serve a stale Daily Close after one was submitted. Two caches with
different invalidation rules is one cache too many.

Writes go to the outbox, which is durable before the request is attempted.
Background Sync would be a *second* queue with its own retry policy, and §5.7's
guarantee is only checkable with one.

Three fetch strategies:

| Request | Strategy | Why |
|---|---|---|
| `/api/*` | Never intercepted | The query cache and the outbox already have opinions |
| Navigations | Network first, `/offline` fallback | Every page carries authorisation state |
| `/_next/static/*`, fonts | Cache first | Next fingerprints these, so a cached one cannot be stale |

`/sw.js` is excluded from the proxy's matcher and from `UNGUARDED_PREFIXES`.
This is not convenience: `navigator.serviceWorker.register` requires a
same-origin response with a JavaScript MIME type, and the auth guard's 307 to
the sign-in page is neither. The symptom is silent — registration rejects, the
shell never caches, and the failure only shows up in a gym basement.

## Device identity and the clock

`lib/offline/device.ts` holds two strings in `localStorage`: the device id and
the last HLC the server issued.

`localStorage` rather than IndexedDB because these are read on *every* mutation
and it is synchronous — an async read would make the enqueue path async for no
reason. Not a cookie, because a cookie travels on every request including static
assets, and the device id would then be a tracking identifier sent to a CDN.

`rememberHlc` guards with a string comparison, because the encoding is designed
so lexicographic order is causal order. Two requests completing out of order —
routine when the outbox drains several entries at once — would otherwise let the
older one overwrite the newer.

Clearing site data gives the device a new id and no HLC. Neither is a data loss:
ids already written are untouched, and the clock restarts from physical time,
which is still ahead of everything that device wrote before.

## Clearing local data

> `/settings/privacy` → "On this device".
> Code: `apps/web/features/settings/screens/LocalDataScreen.tsx`,
> `apps/web/features/settings/services/localData.ts`.

`outbox.ts` promised a "clear local data path in settings" in a comment for
months and nothing called it. §8.10's draft autosave is what turned that from a
loose end into a gap: journal prose and Daily Close answers are now persisted to
`localStorage` in plain text, §4.7 makes journal content "the most sensitive data
in the system", and the only two ways it left the device were the fourteen-day
expiry and saving the entry it belonged to. Neither is something a person can
reach for.

### Three stores, three controls

Conflating them would be the bug. They differ in the only respect that matters —
what clearing one costs.

| Store | Where | Cost of clearing | Recovery |
|---|---|---|---|
| Drafts | `localStorage`, `naitikos.draft.v1.*` | Unsaved writing, gone | Undo, for the life of a toast |
| Cached reads | `localStorage` + the query client | One refetch per screen | Automatic |
| Capture outbox | IndexedDB `naitikos-outbox` | **Writes the operator believes are saved** | None, ever |

One button would have to price itself at the worst of those, so the cheap,
frequently-wanted action would inherit a warning about permanent loss and stop
being read. It would also couple the two real needs: "I am handing this laptop to
someone" wants the prose and the cached rows gone, while "the sync looks stuck"
wants the queue looked at and must not touch the drafts.

The controls are ordered by ascending cost, and there is deliberately no
combined "clear everything" — the handover sequence is stated as a sentence
instead, because a combined button would have to inherit the outbox's refusal
and would therefore fail on the one occasion it was most wanted.

### The confirmation model

§8.12 is explicit that "destructive actions never rely solely on a confirm
dialog … confirmation dialogs train people to click through them; undo actually
protects data". Applied per control rather than by reaching for a modal three
times:

| Control | Confirmation | Why |
|---|---|---|
| Cached reads | None | Nothing is lost. A dialog here is the click-through training, and it is what teaches the operator to dismiss the one that matters |
| Drafts | None, plus a real undo | The removed records are held in memory and written back byte-identically, so `savedAt` survives and the restored draft expires when it always would have |
| Unsent writes | `AlertDialog`, no undo | The one case where undo is unavailable rather than inconvenient: undo works because a soft delete leaves the row (§9.4), and an unsent write has no copy anywhere by definition |

Every label carries its count — "Clear 3 drafts", not "Clear drafts". Neither
store is browsable: there is no screen that lists drafts and the queue is visible
only as a banner, so the number on the button is the whole of the operator's view
into what they are about to destroy.

### A pending outbox blocks rather than warns

The rule is per entry, not per queue, and it is enforced in the store rather than
in the screen. `discardBlockedEntries` deletes entries in `blocked` and can
touch nothing else, so a stale count in a React state cannot cause a `sending`
entry to be deleted.

- **`pending` and `sending` are never discardable.** Not behind a dialog, not
  behind a typed confirmation. §5.7's requirement is that "a failed drain must
  never silently discard a write", and both of those are writes that have not
  finished trying. The remedy is free — connect, drain, or wait out the backoff —
  so refusing costs a wait, while agreeing costs a workout the operator believes
  is logged. The asymmetry is total, which is what makes a warning the wrong
  instrument.
- **`blocked` is discardable.** It has spent every one of `MAX_ATTEMPTS`, §5.7
  puts it in "a visible unsynced state with a manual retry", and it is waiting
  for a person. Abandoning it is that person's decision and the only route to a
  device with nothing unsent on it — a queue that could never be emptied would
  mean the operator could never honestly hand the machine to anybody.
- **The two coexist.** Three pending alongside two blocked offers a discard of
  exactly two, and says so. Refusing on account of the three would be theatre.

The screen also offers "try sending now", which is the cheaper answer to the
refusal, and it names the unsendable entries by label — "Daily Close, 3 August"
is what lets the operator decide; a bare count is a decision they cannot make.
The label is a kind and a date, never captured content (§5.13).

**One consequence, stated rather than papered over.** Discarding a blocked entry
releases anything held behind it by `dependsOn`. Those dependants become
sendable, are rejected for the row that no longer exists, and walk to `blocked`
themselves over `MAX_ATTEMPTS`. That is noisy but never silent, which is the
property §5.7 actually asks for, and the confirmation says so before the fact.

### What is deliberately left behind

- **The device id and the last HLC.** Neither says anything about the operator,
  and both are what keeps this device's clock ahead of everything it has written.
  The browser's own site-data dialog is what removes them, and the section above
  explains why doing so is harmless.
- **The service-worker shell cache, while offline.** It holds fingerprinted
  assets and `/offline` and no part of the record, so dropping it buys no privacy
  — and dropping it in the gym basement §5.7 is written for would delete the
  fallback page and turn the next reload into the browser's error screen. It goes
  only when `navigator.onLine` says there is a connection to fetch it back with.
  This is the one place in `lib/offline/` that trusts that flag, and the
  asymmetry is the reason: a false "online" costs one re-download.
- **An empty `naitikos.query.cache` key.** `queryClient.clear()` empties the
  in-memory cache and the persister then writes the now-empty dehydrated state
  back a second later. The rows are gone; the key is recreated holding nothing.
  The persisted copy is also removed synchronously, because a tab closed inside
  that one-second debounce would otherwise leave the full payload untouched on
  disk.

### Nothing here touches the server

Deleting a record is §9.4's soft delete with its audit entry, reached from the
entity that owns it. A "clear data" button that could reach the database would be
a different and far more dangerous feature. That is also why the surface is on
`/settings/privacy` rather than `/settings/data`: §3.2 gives privacy the exposure
boundary and data the record itself, and a button labelled "clear data" sitting
under the export builder would invite exactly the reading this feature must never
permit. `localData.test.ts` asserts the two sentences that carry the promise, so
an edit that dropped them fails rather than ships.

## What is not built

**Any server-side reading of this outbox** (§5.16). §5.16 asks for an alert on
"an outbox entry older than 24 hours … because it means data the user believes
is saved is not". There is no such alert for the queue on this page, and it is
not an oversight — the queue is IndexedDB in one browser profile on one device,
and no query on the server can see it.

Be careful with the two gauges that used to look like they cover it. Until
7 September 2026 `sync.outbox.depth` and `sync.outbox.oldest_age_seconds` were
emitted by `verify-media-integrity` and
by `GET /api/media/uploads`, and both read `upload_outbox` — the **media**
outbox, photographs waiting for a signed URL. The queue described on this page
contributes nothing to either. They are now named `media.outbox.depth` and
`media.outbox.oldest_age_seconds`, and `sync.outbox.*` is reserved for **this**
queue — the capture outbox — because only the client can report it and
`telemetryNameSchema` already accepted the name. Nothing emits it yet.
`docs/background-jobs.md` §8 has the full note.

Two ways to give this queue a real signal were priced and both declined for now.
Having the client report its own depth on the existing `/api/telemetry` beacon is
one `record()` call — and useless as an alert, because a backed-up outbox means a
device with no network, telemetry deliberately does not queue, and the reading
would therefore arrive only after the drain had already succeeded. The shape that
works is a drain **heartbeat** the server can notice the absence of: stamp
`sync_state.last_synced_at` per device on a successful drain and flag anything
older than 24 hours in the nightly run. `sync_state` has the columns and
`lib/offline/device.ts` has the device id, so the pieces exist — what does not is
a write path, a repository, and an answer to the case the heartbeat cannot
distinguish, which is that a phone that is stuck looks exactly like a phone that
is switched off. At n=1 with a tablet in a drawer, that is the common case.

Inventing a server-side number for this queue in the meantime would be worse
than the gap. A gauge that reads zero because nothing reports to it is
indistinguishable from a gauge that reads zero because nothing is stuck.

**Per-device sync watermarks and delta sync** (§5.8). `sync_state` exists and is
unpopulated. The current read path refetches rather than requesting a delta,
which at this volume is the right trade — a delta protocol is worth building
when a full refetch is slow, and it is not.

**Schema-version negotiation** (§5.8). The contract is in `sync_state.
schema_version`; nothing writes it yet. It matters when there is a second client
version in the wild, which there is not.

**Push notifications** (§5.9). The Daily Close reminder needs VAPID keys and an
installed PWA on iOS. The manifest makes the install possible; the reminder is
not built.
