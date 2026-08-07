# Storage

**Status:** implemented, Week 2 · **Blueprint sections:** §5.4, §5.5, §5.7, §5.8, §9.4, §9.8
**Related:** [media.md](media.md) · [background-jobs.md](background-jobs.md)

---

## 1. The provider is a port

§5.4 uses Supabase as "hosted Postgres with auth and storage", and promises that
"migrating to any other Postgres host becomes a connection-string change plus an
auth swap, rather than a rewrite." That has to be true of object storage too, or
the media library welds the application to one vendor.

```
packages/core/src/media/storage.ts     ── the port (StorageProvider)
apps/web/lib/storage/supabase-*.ts     ── the only file that knows it is Supabase
```

**An S3 adapter is a second file implementing the same interface, not a
refactor.** The port is deliberately small — six methods — because every method
is one more thing a second adapter has to reproduce.

```ts
type StorageProvider = {
  name: string;
  upload(request):        Result<UploadResult, DomainError>;
  download(key):          Result<Uint8Array, DomainError>;
  exists(key):            Result<boolean, DomainError>;
  createSignedUrl(key, { expiresInSeconds }): Result<SignedUrl, DomainError>;
  remove(key):            Result<void, DomainError>;
};
```

`download` is for §9.8's integrity check and §9.10's export — **not** for serving
media. That is what signed URLs are for.

---

## 2. Why the service-role key

Every read and write is server-mediated, so the browser never holds a storage
credential and never talks to the bucket except through a signed URL the server
minted.

The alternative — anon key plus Supabase Storage RLS policies — buys nothing and
costs a policy surface. §5.4 takes the same position on database RLS: "RLS is
enabled on every table with **zero policies**", because the application is the
authorization boundary and a provider policy is a second place for that decision
to live and disagree.

The consequence is stated rather than assumed: **the adapter must never be
imported from a client component.** `import 'server-only'` enforces it at build
time, which is the only enforcement that survives a refactor.

The provider **throws at construction** if the key is absent, not at first
upload. The failure mode that avoids: the app boots, the user takes a progress
photo, the pipeline encrypts it, and *then* the upload fails — so the plaintext
is gone from the capture screen and the ciphertext went nowhere. §5.12 says
failure never loses user input; the cheapest way to honour that is to not start.

---

## 3. Buckets and TTLs

| Tier | Bucket | Signed-URL TTL |
|---|---|---|
| `public` | `public-assets` | n/a (CDN) |
| `private` | `private-documents` | **60 s** |
| `sensitive` | `sensitive-media` | **300 s** |

One bucket per tier, so a policy mistake cannot span tiers — a wrong public-read
rule on one bucket must not expose skin photos.

**The sensitive tier's URL lives longer than the private one.** That looks
backwards and is not: the object is ciphertext, useless without the
passphrase-derived key, and a client decrypting a 12 MB photo on a slow
connection needs more than sixty seconds to finish the fetch. The private tier is
capped at §5.5's sixty seconds because the URL is a **bearer credential** —
anyone holding it can read the object, and one pasted into a chat outlives the
intent behind it.

`expiresAt` is computed locally from the requested TTL rather than parsed out of
the JWT in the URL. Reading the token's `exp` would mean trusting a claim to tell
us when to stop trusting it.

---

## 4. The upload outbox

§5.7 is unusually direct about the stakes:

> "**Outbox durability is a hard requirement.** A failed drain must never silently
> discard a write. Entries persist until acknowledged; entries that fail
> repeatedly surface in a visible 'unsynced' state with a manual retry. Losing a
> logged workout because the drain failed quietly would end the user's trust in
> the system, and trust is the whole product."

So every method in `upload-outbox.repository.ts` is written so that the *absence*
of a call leaves the row in a visible state. **There is no path that deletes a
row.**

```
pending ──claim──► uploading ──success──► uploaded
   ▲                   │
   │                   └──failure──► failed ──┐
   └───────── recoverStale ◄─────────────────┘
                       │
                       └──user gives up──► abandoned (+ reason)
```

### 4.1 There is deliberately no attempt cap

A task in `deferred_task` dead-letters after three attempts. An outbox entry
never does. §5.7 requires entries to "persist until acknowledged" and surface for
manual retry — giving up automatically is what "silently discard a write" looks
like from the user's side.

### 4.2 `abandoned` is a state, not a delete

§9.4: "Nothing is hard-deleted. Deletion sets a deleted-at timestamp and a
reason." The record that an upload was given up on still exists, which matters
when a photo appears missing from a series six months later. It stops being an
alert without stopping being a record.

### 4.3 Health, and the alert

```ts
{ pending: number; failed: number; oldestAgeSeconds: number | null }
```

§5.16: "Sync health: outbox depth and age. **An outbox entry older than 24 hours
is an alert, because it means data the user believes is saved is not.**"

A partial index on `(created_at) WHERE status <> 'uploaded' AND abandoned_reason
IS NULL` is what makes that check cheap enough to run nightly.

---

## 5. The offline asymmetry — read this one

**This table holds the metadata and the intent. The bytes live in IndexedDB on
the device.**

A 12 MB photo in a Postgres row would be a 12 MB write on a connection that is by
definition unreliable, and the whole point is that the device is offline.

The consequence, stated plainly:

> A photo taken **fully offline has no row here** until the device reaches the
> network. Until then, the device's own IndexedDB queue is the only record of it.

That asymmetry is inherent, not an oversight, and it is why the client-side queue
must itself be durable. It also means outbox *depth* is a lower bound on
unsynced work, never an exact count — a phone that has been in a drawer for a
week contributes nothing to it.

### The client-side queue is not built yet

The server half — the table, the repository, the endpoints, the health reading —
is complete and tested. The IndexedDB half belongs to the PWA/offline milestone.
Until it exists, an upload that fails while the app is open is retryable from the
unsynced list; one that fails while the app is closed is lost with the tab.

---

## 6. Idempotency

Two mechanisms, at two layers, doing the same job:

- **The outbox** deduplicates on a client-supplied `idempotencyKey` (unique
  index). §5.7: "The outbox may replay any request any number of times; the
  server deduplicates. Retry safety is structural, not hopeful."
- **The storage key** is content-addressed, so a retried upload writes identical
  bytes to the same place rather than creating a second object.

`failIfExists` defaults to true. Media keys are content-addressed, so a collision
means either a genuine duplicate the dedupe check should have caught, or a
key-generation bug. Overwriting silently destroys the original in both cases.

---

## 7. Claiming, and why it is one statement

```sql
UPDATE upload_outbox SET status = 'uploading' …
WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED)
RETURNING *
```

Not because of worker concurrency — there are no workers. §5.2 requires the
nightly run be "manually triggerable from `/settings/developer`", so a human can
start a second run while the cron's is still going. `SKIP LOCKED` makes the
second run take *different* rows rather than block or duplicate.

`RETURNING` order is unspecified, so the result is re-sorted oldest-first in
application code. Otherwise a row enqueued three nights ago can lose to tonight's
indefinitely.

---

## 8. Recovering stranded rows

A serverless invocation killed mid-step leaves its claim held forever. Because
`deferred_task`'s unique index is partial on `('pending','running')`, the *next*
enqueue for that subject then silently dedupes against a task nobody will ever
drain.

`recoverStale(olderThan)` returns those rows to `pending`. It runs as the first
thing in the nightly `drain-task-queue` step, with a six-hour threshold — far
longer than any run's fifteen-minute budget, so a task still legitimately in
flight is never stolen from a running invocation.

---

## 9. Migrating off Supabase

What actually has to change:

| Concern | Change |
|---|---|
| Object storage | one new file implementing `StorageProvider` |
| Bucket names | `BUCKET_FOR_TIER` in `core/media/storage.ts` |
| Signed URLs | the adapter's `createSignedUrl` |
| Credentials | `SUPABASE_SERVICE_ROLE_KEY` in `lib/env.ts` |

What does **not** change: the pipeline, the key scheme, the outbox, the
endpoints, the tiers, the TTL policy, and every call site. That is the whole
point of the port being six methods wide.

The one Supabase-specific thing worth flagging for a port: `exists()` uses `list`
with a prefix and an exact-name check, because Supabase has no HEAD equivalent.
S3 has `HeadObject`, which is cheaper and simpler — the adapter should use it
rather than reproducing this.

---

## 10. Gotchas

- **Supabase's `list` search is a substring match**, so `abc.jpg` would match
  `abc.jpg.thumb`. The adapter re-checks the exact name.
- **Storage errors are matched on message strings.** Unpleasant, and unavoidable
  without pinning behaviour the SDK does not document. What matters is that "not
  found" and "already exists" stay *distinguishable*, because `upload` and
  `download` callers respond to them completely differently.
- **`progress` is a `numeric` column read as a string** (§5.3's no-floats rule,
  enforced by a driver type override). Writing a JS number round-trips through a
  different type than it reads back.
