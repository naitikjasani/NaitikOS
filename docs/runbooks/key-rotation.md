# Runbook — Key Rotation

**Status:** written 7 September 2026, against a system that has **no encrypted objects and no key**. Not executable today — read §1 before anything else. · **Blueprint sections:** §5.4, §5.5, §5.14, §9.4, §9.8, §9.10, §13.8
**Related:** [restore-drill.md](restore-drill.md) · [../media.md](../media.md) · [../storage.md](../storage.md) · [../export.md](../export.md)

---

## 1. Stop. There is nothing to rotate yet

This runbook exists because §13.8's risk register promises it:

> | Encryption scheme obsolescence | Algorithm identifier stored per object; a re-encryption path exists from day one; key rotation runbook. |

That row makes three promises. One of them is true, one is false, and the third
is this file. §3 checks each against the code.

The part that matters before you read another line: **as of 7 September 2026 the
sensitive-tier encryption path is not wired.** There is no encryptor
implementation, no key-derivation flow, no key, and no encrypted object. A
query against the live database returns:

```
$ docker exec naitikos-postgres psql -U naitikos -d naitikos \
    -c "select count(*) media_object_rows,
               count(wrapped_key) with_wrapped_key,
               count(encryption_algorithm) with_algorithm
        from media_object;"

 media_object_rows | with_wrapped_key | with_algorithm
-------------------+------------------+----------------
                 0 |                0 |              0
```

`media_thumbnail` is likewise empty. So is every path that would fill them.

Executing a rotation procedure against that state is not merely pointless — it
is dangerous, because the procedure would appear to succeed. Zero rows re-wrap
cleanly. Zero rows verify. An operator who ran this and saw green would
reasonably conclude the library had been rotated, and the first real photograph
uploaded afterwards would be the only object in the system, under a key nobody
recorded.

**Everything from §5 onwards is therefore a design, not a procedure.** It is
written now so that the encryption path is built with rotation in mind rather
than retrofitted around a scheme that cannot be rotated. §12 lists exactly what
has to exist before any of it can be run.

**Said once, plainly, because it is the fact that shapes every decision below:
under §5.5 the master key is derived from a passphrase and held only in browser
memory. Lose it and the server cannot recover sensitive-tier media. Not
"slowly", not "with effort" — not at all. There is no escrow, no server-side
copy, and no provider who can help.** §5.5 accepts this deliberately, and names
the only mitigation: "the recovery path is a user-printed recovery code stored
offline, established at first setup." That recovery code does not exist in the
code either.

---

## 2. How claims in this document are marked

Accuracy is the whole point of the file, so the distinction is made inline and
without exception:

| Marker | Meaning |
|---|---|
| **[verified]** | Read in the code, the schema, or returned by a read-only query. A file and line, or the query, is given. |
| **[derived]** | Reasoned from what is there. Sound, but nobody has executed it and no test covers it. |
| **[absent]** | There is no code for this. Where a step is marked absent, no command is given, because inventing one is how a runbook becomes a trap. |

Nothing below is marked verified on the strength of a comment alone. Comments in
this repository are unusually good, and two of them are wrong — see §14.

---

## 3. The three promises in §13.8, checked

### 3.1 "Algorithm identifier stored per object" — **true**

**[verified]** `media_object.encryption_algorithm text` exists in the schema
(`packages/db/src/schema/crosscutting.ts:381`), in the initial migration
(`packages/db/migrations/0000_init.sql:1020`), and in the live database. The
pipeline produces it (`packages/core/src/media/pipeline.ts:348`) and the wire
contract accepts it (`packages/api/src/contracts/timeline.ts:286`).

Two caveats, both real:

- The column is nullable and has no check constraint. `wrapped_key` has one —
  `media_object_sensitive_encrypted`, which requires a wrapped key on the
  sensitive tier **[verified]** — but nothing requires the algorithm beside it.
  A sensitive object with a wrapped key and a null algorithm is a legal row.
- There is no closed vocabulary. `requestUploadSchema` accepts any string up to
  64 characters **[verified]**. The one value that appears anywhere is
  `'AES-256-GCM'`, and only in a test fixture and the export guide.

### 3.2 "A re-encryption path exists from day one" — **false**

**[verified]** There is no re-encryption code anywhere in the repository, and
the reason is structural rather than an oversight:

- The `Encryptor` port (`packages/core/src/media/pipeline.ts:166`) declares
  exactly one method, `encrypt`. **There is no `decrypt`, and no `Decryptor`
  port.** Nothing in `core` can turn ciphertext back into bytes.
- No implementation of `Encryptor` exists. The only object satisfying the
  interface is a fake in `pipeline.test.ts:139` returning the literal string
  `'wrapped:dek'`.
- `runPipeline` is called from `pipeline.test.ts` and nowhere else.
- No environment variable holds or derives a key. `apps/web/lib/env.ts`
  validates seven variables and none of them is a key or a passphrase.

Re-encryption requires decryption. An interface that cannot decrypt cannot
re-encrypt, so the promise is not partially kept — it is unstarted.

### 3.3 "Key rotation runbook" — **this file**

With a second, unmet half. §6.2 lists the scripts the blueprint expects:

> Seed, export, import, backup, restore-drill, key-rotation, migration-generation, embedding-backfill, health-check. Every recurring manual operation becomes a script the first time it is performed twice. Under C3, a documented manual procedure will be executed wrongly; a script will not.

**[verified]** There is no `scripts/` directory in the repository. By the
blueprint's own argument the document you are reading is the weaker artefact,
and it says so.

---

## 4. What is encrypted, and what is not

Three tiers (§5.5), and only one of them is in scope here.

| Tier | Bucket | Contents | Application-level encryption | In scope |
|---|---|---|---|---|
| `public` | `public-assets` | app assets, icons | none | no |
| `private` | `private-documents` | lab reports, receipts, non-body imagery | **none** — server-readable on purpose | no |
| `sensitive` | `sensitive-media` | skin photos, physique photos, medical imaging, journal attachments | client-side envelope encryption | **yes** |

**[verified]** `BUCKET_FOR_TIER` in `packages/core/src/media/storage.ts`.

The private tier being readable is not a weakness; it is what makes §4.11's "lab
PDF becomes structured lab observations" possible at all. There is no
application-level key over it, so there is nothing there to rotate. Provider
at-rest encryption (§5.14) is the provider's key on the provider's schedule, and
this runbook has no reach into it.

The database itself is out of scope for the same reason. §5.14 lists "provider
encryption for the whole database" separately from "additional application-level
encryption for the sensitive tier". Rotating the former is a Supabase operation
against a key the application never sees.

---

## 5. Two keys, two completely different operations

§5.5 specifies envelope encryption:

> A per-object AES-256-GCM data key is generated client-side, the object is encrypted in the browser, the data key is wrapped with a master key derived from the user's passphrase via Argon2id, and only the wrapped key is stored. The master key is held in memory for the session and never transmitted.

So "rotate the key" is ambiguous, and the two readings differ by orders of
magnitude in cost and in risk. Decide which one you are doing before you start.

| | **A. Master key** | **B. Data keys / algorithm** |
|---|---|---|
| What it is | the wrapping key, derived from the passphrase | one random AES-256-GCM key per object |
| Where it lives | browser memory, never stored | `media_object.wrapped_key`, encrypted |
| What changes | the `wrapped_key` column, one row at a time | every stored byte |
| Ciphertext | **untouched** | rewritten in full |
| Cost | one small update per row | download, decrypt, re-encrypt, upload, per object |
| Bandwidth | none | the entire library, twice |
| Interruptible | yes, cheaply | yes, but see §10.3 |
| Resumable today | **no** — see §5.1 | yes, via `encryption_algorithm` |

### 5.1 The master-key rotation has no progress marker, and that is a schema gap

**[verified]** The full column list of `media_object` contains `wrapped_key` and
`encryption_algorithm` and no third encryption column. There is no
`key_version`, no `master_key_id`, no `wrapped_at`.

The consequence is severe and specific: **you cannot ask the database which
objects are still wrapped under the old master key.** A re-wrap that stops
halfway leaves a table in which every row looks identical, satisfies the check
constraint, and is half unreadable. The only way to distinguish them is to
attempt an unwrap of each, in the browser, with both keys.

Fix this before building the rotation, not during it. §12 lists it.

### 5.2 Why the algorithm identifier is stored per object

The B-kind rotation is the reason that column exists, and it is worth
understanding rather than accepting.

A data-key or algorithm rotation cannot be atomic. It moves every byte of the
library through a browser tab, over minutes or hours, and it can be interrupted
by a closed laptop, an expired signed URL, or a two-month gap in attention (C3).
So there is a long interval during which **some objects are under the old scheme
and some are under the new one, and both are correct**.

A single global "current algorithm" setting cannot express that. The moment it
flipped, every object not yet migrated would be read with the wrong parameters —
which for AES-GCM means an authentication failure, indistinguishable from
corruption. The per-object identifier is what turns a half-finished migration
from a corrupt state into a *valid* one, and it is simultaneously the resume
marker: the set of objects still to do is a `where` clause, not a bookkeeping
file someone has to not lose.

That is the whole argument for the column, and it is the argument §5.1 shows
was never applied to the master key.

### 5.3 What a master-key rotation does and does not achieve

Re-wrapping changes which passphrase opens the library going forward. It does
**not** un-leak anything already copied. An adversary holding a copy of the
bucket plus the old `wrapped_key` values plus the old passphrase can still read
every object they copied, for ever, because the ciphertext did not change and
the old wrapping still opens the old copies of the wrapped keys.

If the ciphertext is believed copied, only a full B-kind rotation helps, and
only for objects re-encrypted after the copy was taken. Say this out loud before
choosing procedure A under time pressure — A is the cheap one, and it is the one
that feels like it fixed the problem.

---

## 6. The stage-order constraint: re-encryption cannot run on the server

This is the single most important constraint in the document.

[../media.md](../media.md) §1 states the pipeline's stage order as a security
property, not a preference:

> **Encryption is second-to-last, and everything that needs to read the pixels happens before it.** Once a sensitive object is encrypted the server holds ciphertext it cannot read — so thumbnailing, hashing, and dimension extraction are all client-side at capture, or they are impossible.

Follow that forward into rotation:

1. Re-encryption requires the plaintext.
2. The plaintext requires the data key.
3. The data key is wrapped with the master key.
4. The master key is derived from the passphrase and "held in memory for the
   session and never transmitted" (§5.5).

Therefore **the server cannot re-encrypt sensitive-tier media, and neither can
anything holding only `DATABASE_URL`.** Not the nightly job. Not a Node script.
Not a `psql` session. This is not a policy that could be relaxed; the key is
not reachable from any of them at all.

**Both procedures must run in an authenticated browser tab with the passphrase
entered** — procedure A as well, because unwrapping a data key needs the old
master key exactly as decrypting an object does. **[derived]**

Consequences that shape everything in §9 and §10:

- The server's entire role is to hand out signed URLs and accept an updated
  `wrapped_key`. It never sees a key or a plaintext byte.
- Sensitive signed URLs live 300 seconds (`SENSITIVE_URL_TTL_SECONDS`,
  `packages/core/src/media/storage.ts`) **[verified]**. Every object must be
  fetched and finished inside its own window, so the unit of work is one object,
  not one batch.
- The operation is bounded by a tab staying open. It must be resumable and each
  object's step must be idempotent, or a closed laptop is a partial rotation.
- §5.4 requires step-up re-authentication for "encryption-key access". The
  permission for it exists — `security:manage` is in `STEP_UP_PERMISSIONS`
  (`packages/core/src/auth/roles.ts:154`) **[verified]** — and is referenced by
  no route in the application **[verified]**.

---

## 7. When to rotate

These have different urgencies and different procedures. Reaching for the wrong
one wastes hours or, worse, provides false comfort (§5.3).

| Trigger | Procedure | Urgency | Note |
|---|---|---|---|
| Passphrase seen, typed into the wrong field, or entered on a machine you do not control | **A**, then consider **B** | immediately | A alone does not protect anything already copied |
| Bucket contents believed copied | **B** | immediately | A achieves nothing here |
| Algorithm obsolescence — AES-256-GCM deprecated, or a better construction becomes standard | **B** | planned, over weeks | this is the case §13.8 names |
| Device lost or stolen | usually neither | same day | see below |
| Routine interval | — | — | see below |

**Device loss.** The master key exists only in the memory of a browser session,
so a powered-off lost device holds no key **[derived, from §5.5's "held in memory
for the session and never transmitted"]**. The first action is to revoke
sessions, not to rotate: §5.4 sets a 30-day sliding session, so a live session on
a stolen unlocked device is the actual exposure. Rotate the master key only if
the passphrase itself was stored on the device — written in a note, or saved in
a password manager that was unlocked. In that case it is a compromise, and the
row above applies.

**Routine interval.** There is none. **[verified]** Neither the blueprint nor
the code specifies a rotation interval anywhere, and inventing one here would be
exactly the fabrication this document is trying to avoid. If you want one, the
natural anchor is §5.15's exit plan, "documented and tested annually", so that
the rotation and the restore drill are the same afternoon rather than two
commitments that each get skipped. Record the choice as a decision in
`docs/decisions/` if you make it; do not let this table become the record.

---

## 8. The failure that must never happen

**A partial rotation that leaves objects wrapped under a key nobody has.**

It is not a dramatic failure. It is quiet. The row is present, `wrapped_key` is
non-null, the check constraint is satisfied, the gallery lists the photograph and
its capture date, and the bytes are in the bucket. Everything looks correct.
The photograph is gone, and you find out months later.

The mechanism is always the same: **the old key was discarded before every object
was confirmed re-wrapped.** Under C3 this is what a stressed operator does at the
end of a long procedure — the loop finished, the count matched, and destroying
the old key feels like the responsible last step. It is the one irreversible
action in the whole document.

### The ordering rule

Follow it exactly. It is short on purpose.

1. **Record the new master key before touching a single row.** §5.5's printed
   recovery code, offline, on paper. A rotation that generates a key you have not
   yet written down has a window in which both keys are only in RAM.
2. **Keep the old key available for the entire operation** — the same passphrase,
   entered, in the same session. Not "retrievable"; present.
3. **Re-wrap object by object, and verify each one before writing it.** Details in
   §9.
4. **Do not discard the old key when the loop finishes.** Finishing is not
   evidence.
5. **Discard it only after** a full verification pass over the whole population
   succeeds (§11), **and** a backup taken after the rotation has been restored and
   read under the new key (§13, [restore-drill.md](restore-drill.md)), **and**
   every backup still within your restore horizon has been either re-taken or
   accepted as unreadable.

Step 5 is the rule the whole runbook exists to state. The old key is destroyed
last, and only against evidence — not against a completed loop.

Note what step 5 implies and instinct resists: **for as long as you would ever
restore a pre-rotation backup, you must keep the old key.** Rotation does not
reach into backups (§13). Destroying the old key on rotation day silently
converts every existing backup into ciphertext with no opener.

---

## 9. Procedure A — rotating the master key (re-wrap)

**Status: not executable. [absent]** No key-derivation flow, no unwrap function,
no rotation surface. What follows is the shape the implementation should take,
derived from the interfaces that do exist.

### 9.1 Before

- Take a backup and confirm it. [restore-drill.md](restore-drill.md).
- Establish and print the new recovery code (§8, step 1).
- Enumerate the population, both tables (§11.1). Write the two numbers down.

### 9.2 Per object, in the browser

**[derived]** For each row with a non-null `wrapped_key`:

1. Unwrap the data key with the **old** master key.
2. Wrap that same data key with the **new** master key.
3. Unwrap the result with the new master key and compare it, byte for byte, to
   the data key from step 1. A wrap that does not round-trip must abort the whole
   run, not skip the object.
4. Only then write the new value to `wrapped_key`.

Step 3 is what makes the operation safe. Without it, a subtly wrong wrap
produces a column update that reports success and an object that never opens
again. With it, the write is only ever reached by a value already proven to
unwrap.

Nothing else changes. Not `storage_key`, not `content_hash`, not
`encryption_algorithm`, not `byte_size`, and not a single byte in the bucket.
If a procedure claiming to be A touches any of those, it is not A.

### 9.3 Both tables

`media_thumbnail` carries its own `wrapped_key`, one per thumbnail
(`packages/db/src/schema/events.ts`) **[verified]**, and the schema comment
explains why it is a table rather than columns: §5.5 requires sensitive-tier
thumbnails to be "generated client-side at capture and stored encrypted
alongside", each its own encrypted object with its own key.

**Rotating `media_object` and forgetting `media_thumbnail` is the most likely
form of the §8 failure**, because the originals will all verify and the library
will look fine right up to the point where every thumbnail is a broken frame.
Two tables. Always.

### 9.4 After

§11, in full, before anything is discarded.

---

## 10. Procedure B — rotating data keys, or the algorithm

**Status: not executable. [absent]** In addition to everything missing from
procedure A, there is no decrypt path at all (§3.2).

### 10.1 Selection

**[derived]** The set of work is a query, which is the payoff from §5.2:

```sql
select id, storage_key, encryption_algorithm, byte_size
from media_object
where wrapped_key is not null
  and encryption_algorithm = '<old algorithm>'
order by created_at;
```

Re-running it after an interruption returns exactly the remaining work, because
each object's algorithm changes only when its rotation completes. That is the
resumability property, and it holds only if the row update is the last step.

### 10.2 Per object

**[derived]**

1. Request a signed URL for `storage_key` (300 s).
2. Download the ciphertext.
3. Unwrap the data key with the master key; decrypt.
4. Verify the plaintext against `content_hash` — but read §10.4 first, because
   what that column contains is currently undecided.
5. Generate a **new** random data key. Re-encrypt under the new algorithm.
6. Upload.
7. Update `wrapped_key`, `encryption_algorithm`, and `byte_size` in one
   statement. `byte_size` is the size of what is stored, i.e. the ciphertext
   ([../media.md](../media.md) §11), and a changed algorithm changes it.

The row update is last so that an interruption anywhere before it leaves the
object exactly where it was, still selected by §10.1's query.

### 10.3 The unresolved question: does re-encryption change the storage key?

This is not a detail. It decides whether procedure B is an overwrite or a
copy-then-delete, and it cannot be answered from the code as it stands.

**[verified]** `buildStorageKey` derives the path from the content hash
(`packages/core/src/media/keys.ts`), and in `runPipeline` the hash is taken at
stage 5, **before** encryption, over the compressed plaintext
(`packages/core/src/media/pipeline.ts`). On that reading the key is a function of
the plaintext, so re-encryption produces the same key, and procedure B is an
in-place overwrite.

**[verified]** But the schema says the opposite: `media_object.content_hash` is
documented as "SHA-256 of the ciphertext, for the nightly integrity check (§9.8)"
(`packages/db/src/schema/crosscutting.ts:369`). On that reading the key changes
with every re-encryption, and procedure B must write a new object and remove the
old one.

Nothing writes the row, so neither reading has been made real yet. Two knock-on
facts, both **[verified]**, for whoever settles it:

- `UploadRequest.failIfExists` defaults to true
  (`packages/core/src/media/storage.ts`), so the overwrite reading requires the
  caller to pass `failIfExists: false` explicitly — and doing that discards the
  protection that catches a key-generation bug.
- `StorageProvider.remove()` is documented as "**not** part of ordinary
  deletion", reserved for the audited purge path. A copy-then-delete rotation is
  a legitimate second caller, and should be recorded as one rather than quietly
  added.

Do not begin procedure B until this is decided and written down.

### 10.4 The key-derivation function is also undecided, and it is not covered by the algorithm column

**[verified]** Two different master-key derivations are described in the
repository today:

- §5.5, the schema comment, and the pipeline comment all say **Argon2id**.
- The decryption guide that actually ships inside every export
  (`packages/core/src/export/bundle.ts:267`) says **PBKDF2-HMAC-SHA256, 600,000
  iterations**, with a per-object `keySalt`.

These are not the same master key. Whichever is chosen, note that
`encryption_algorithm` names the *object* cipher, not the KDF — so the §5.2
argument for a per-object identifier applies equally to the derivation and there
is no column for it. Change the KDF later and every object encrypted before the
change becomes unopenable by the current code, with nothing on the row to say so.

The same guide names two fields, `keySalt` and `iv`, that have **no columns in
`media_object`** **[verified]**. AES-GCM requires an IV per encryption. Either
the IV is carried inside the `wrapped_key` blob — which is undocumented and
would need to be specified — or objects encrypted under the current schema
cannot be decrypted at all. Settle this before the first photograph is stored,
not during a rotation.

---

## 11. Verification

The goal is not "the loop finished". It is **every object opens under the new
key, and no object still needs the old one**. Nothing short of that licenses
step 5 of §8.

### 11.1 Establish the population — and include deleted rows

```sql
select count(*) from media_object    where wrapped_key is not null;
select count(*) from media_thumbnail where wrapped_key is not null;
```

**No `deleted_at is null` filter.** §9.4: "Nothing is hard-deleted. Deletion sets
a deleted-at timestamp and a reason", and [../media.md](../media.md) §10 explains
that a deleted photo keeps its bytes precisely so §8.12's undo can undo it. A
soft-deleted photograph whose wrapped key was skipped is still a lost
photograph — you do not find out until the day you undo the delete. Rotate
the tombstones too.

### 11.2 Prove readability, not row counts

**[derived]** A count of updated rows cannot detect a row written with a
corrupted wrap, which is the failure that matters. The pass must, for every row
in the §11.1 population, in the browser, under the **new** key only:

1. Unwrap the data key. A failure here is an object still under the old key, or a
   broken wrap. Either way, stop.
2. For procedure B, additionally decrypt and compare the plaintext digest against
   `content_hash` — subject to §10.3's ambiguity about what that column holds.

The pass must run under the new key **alone**, in a session where the old
passphrase has not been entered. A verification that silently falls back to the
old key verifies nothing, and it is an easy accident when both are in memory.

### 11.3 Prove the negative

The stronger claim — "no object is still under the old key" — is what licenses
destroying it, and today it can only be established by exhaustion: every row in
§11.1's population unwrapped under the new key, with the counts matching the
numbers written down before the run.

**[verified]** With a `key_version` column it would instead be one query, which
is why §12 lists it first. Without one there is no cheap check and no way to
notice drift later.

### 11.4 Do not expect the nightly job to catch this

**[verified]** The nightly step named `verify-media-integrity` does not verify
media integrity. Its implementation
(`apps/web/app/api/jobs/nightly/route.ts:96`) reads outbox health and recovers
stale entries; its own `describes` string says "Reports outbox health, which
§5.16 alerts on."

§9.8's promised sweep — "every storage object has a row and every row has an
object" — is not implemented. Nothing will notice an un-rewrapped object on your
behalf, tonight or ever. §11.2 is the only check there is.

---

## 12. What must exist before this runbook can be run

In rough dependency order. Every item is **[absent]** unless noted.

1. **A `key_version` (or `master_key_id`) column on `media_object` and
   `media_thumbnail`.** First, because without it a master-key rotation has no
   resume marker and no verification query (§5.1, §11.3), and adding it after
   objects exist means backfilling a value you have to infer.
2. **A decision on the IV and any KDF salt, with columns for them** (§10.4).
   Without this nothing can be decrypted, rotation or otherwise.
3. **A decision on Argon2id versus PBKDF2**, recorded, with a per-object marker
   for it (§10.4).
4. **A decision on whether `content_hash` is the plaintext or the ciphertext
   digest** (§10.3). It settles the pipeline, the storage key, the integrity
   sweep, and the shape of procedure B.
5. **The key-derivation flow** — passphrase to master key, plus §5.5's printed
   recovery code at first setup.
6. **A concrete `Encryptor`,** and **a decrypt counterpart**, since the port has
   only `encrypt` (§3.2).
7. **A writer for `media_object`.** Nothing writes it today, and the code says so
   in as many words (`packages/db/src/repositories/upload-outbox.repository.ts`,
   the "It is a read and only a read" comment) **[verified]**.
8. **Carry `wrappedKey` and `encryptionAlgorithm` from the upload request through
   to storage.** See §14 — they are currently accepted and dropped.
9. **§9.8's real integrity sweep**, so §11.4 stops being true.
10. **A rotation surface gated on `security:manage`,** which already requires
    step-up and is wired to nothing (§6).
11. **`scripts/key-rotation`**, which §6.2 promises and which, by the blueprint's
    own C3 argument, matters more than this document (§3.3).

---

## 13. Backups hold the old ciphertext and the old wrapped keys

Rotation is not retroactive, in either direction.

- **A backup taken before a rotation contains pre-rotation state**: the old
  ciphertext in the bucket, and the old `wrapped_key` values in the dump. It is
  opened by the **old** key, and rotating does nothing to it.
- **Restoring a pre-rotation backup after a rotation reintroduces old-key rows.**
  They will pass every constraint and look entirely healthy. If the old key is
  gone, they are gone.

Two things follow, and the second is the one people get wrong:

1. A rotation is not complete until a backup taken *after* it has been restored
   and read under the new key. See [restore-drill.md](restore-drill.md) for the
   drill itself; this runbook does not repeat it.
2. **Keep the old key for at least as long as your oldest restorable backup.**
   Directly contrary to instinct, and it is §8 step 5.

§5.15's exit plan is "`pg_dump` + storage sync", so the bucket and the database
are two separate backup axes taken at two different moments. A rotation
interrupted between them produces a dump and a bucket that disagree — the class
of skew §9.8's absent integrity sweep exists to find (§11.4). Take both, after
the rotation, close together.

---

## 14. Problems found while writing this, which are not fixed here

Recorded so that they are findable, and deliberately not repaired in a document.

- **The upload endpoint validates a wrapped key and then discards it.**
  `requestUploadSchema` requires `wrappedKey` for the sensitive tier and calls
  the refusal one of three boundaries enforcing §5.5. But the POST handler
  (`apps/web/app/api/media/uploads/route.ts`) never passes it to
  `outbox.enqueue`, `EnqueueUploadInput` has no field for it, and `upload_outbox`
  has no `wrapped_key` column **[verified, including `\d upload_outbox`]**. The
  wrapped key is validated and dropped on the floor. Since nothing creates the
  `media_object` row either, there is currently no path by which a wrapped key
  reaches storage at all.
- **`verify-media-integrity` does not verify media integrity** (§11.4).
- **`content_hash` is documented as the ciphertext digest and computed as the
  plaintext digest** (§10.3).
- **The shipped export decryption guide describes a different KDF from §5.5**
  (§10.4), and names two fields with no columns behind them.
- **`/settings/privacy` describes the sensitive tier in the present tense.** The
  page states that photographs are "Encrypted in the browser before it is
  uploaded. The key never leaves this device" **[verified]**, of a tier holding
  zero objects. The page's own header — "Nothing on this page is a switch" — is a
  good argument, honestly made, but §3.2 lists this route as "Encryption, media
  keys, redaction" and there is no media-key surface on it. An operator returning
  after two months would read that page and conclude their photographs are
  encrypted. They would be reading a design commitment written as a running
  state.
- **`/api/media/uploads` has no caller.** No client code in `apps/web` requests
  an upload slot **[verified]**. The one row in `upload_outbox` is an `abandoned`
  sensitive-tier entry from a development session, with a null
  `media_object_id`.

None of these is a bug in the sense of something that misbehaves today, because
none of the code runs. They are all the same bug: a set of parts that were built
to fit an encryption path, and never met each other.
