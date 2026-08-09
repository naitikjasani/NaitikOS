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

## What is not built

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
