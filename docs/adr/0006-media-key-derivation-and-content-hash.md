# ADR 0006 — Record the key-derivation function per object, and hash the plaintext

- **Status:** Proposed
- **Date:** 8 September 2026
- **Supersedes:** nothing
- **Blueprint sections:** §5.5 (envelope encryption), §9.8 (media integrity), §13.8 (algorithm obsolescence), P2, C2

## Context

The media pipeline is not wired: there is no `Encryptor` implementation, nothing
inserts `media_object`, and no key exists anywhere. Before any of that is built,
two contradictions in the specification have to be settled, because both are the
kind that produce data nobody can recover and nothing that flags it.

### Contradiction 1 — the key-derivation function

Three places in the repository state the scheme, and they do not agree.

§5.5, in `docs/BLUEPRINT.md`:

> A per-object AES-256-GCM data key is generated client-side, the object is
> encrypted in the browser, the data key is wrapped with a master key derived
> from the user's passphrase via **Argon2id**, and only the wrapped key is
> stored.

`packages/db/src/schema/crosscutting.ts` and `packages/core/src/media/pipeline.ts`
both restate Argon2id.

`packages/core/src/export/bundle.ts`, in `buildDecryptionGuide` — the document
that **ships inside every export**:

> That per-object key is then wrapped (encrypted) with a master key derived from
> a passphrase using **PBKDF2-HMAC-SHA256, 600,000 iterations**, with a
> per-object random salt.

This is not a documentation nit. That guide is the instruction a person follows
to recover their own record from an archive, possibly decades later and possibly
without this application. P2 makes the export format a durable artefact and C2
sets the horizon at twenty years. **A guide naming the wrong KDF is an archive
that cannot be opened by following its own instructions**, and the failure
surfaces at the worst possible moment — when the application is gone and the
archive is all that is left.

There is a real trade underneath the disagreement, which is presumably why two
different answers were written by two different authors:

| | Argon2id (§5.5) | PBKDF2-HMAC-SHA256 (the guide) |
|---|---|---|
| Resistance to offline brute force | Memory-hard; the intended defence against exactly this threat | Weaker per unit of work; GPU-friendly |
| Availability in the browser | Needs a WASM dependency | Native in Web Crypto |
| Availability to a recovery tool in 2046 | A package that must still resolve and still build | OpenSSL, and every language's standard library |

Both arguments are correct. The threat model wants Argon2id; C2's durability
wants PBKDF2. Choosing one and writing it into three files is what produced this
situation in the first place.

### Contradiction 2 — what `content_hash` hashes

`packages/db/src/schema/crosscutting.ts`:

> `/** SHA-256 of the ciphertext, for the nightly integrity check (§9.8). */`
> `contentHash: text(),`

`packages/core/src/media/pipeline.ts` computes it at stage 5, **before**
encryption at stage 6, and says so:

> `5. **Hash.** After compression, so the hash identifies what is actually`
> stored.

The export guide agrees with the pipeline:

>     sha256   checksum of the PLAINTEXT, for verification

So the schema comment is the outlier, two against one — and the pipeline is the
code that actually runs.

But the schema comment is not merely wrong about the value; it is wrong about a
capability. Its stated purpose is §9.8's nightly integrity check, and **a
plaintext hash cannot serve one server-side**. §5.5 is explicit that once a
sensitive object is encrypted the server holds bytes it cannot read, so a
process with no key cannot verify a plaintext digest. The comment describes a
sweep that is impossible by construction.

## Decision

**1. Record the KDF identity and its parameters per object, alongside the
algorithm identifier already promised.**

§13.8 already commits to this shape for the cipher:

> Algorithm identifier stored per object; a re-encryption path exists from day
> one; key rotation runbook.

Extending it to the KDF resolves the contradiction rather than picking a side.
The KDF stops being a constant compiled into three files and becomes a property
of the object, which means:

- Argon2id can be used now, honouring §5.5 and the stronger threat model.
- An object wrapped under a different KDF remains readable, because it carries
  the answer with it. That is the same property that makes a half-finished
  rotation a *valid* state rather than corruption — see
  `docs/runbooks/key-rotation.md`.
- The 2046 recovery tool is told what to do by the data, not by a sentence
  somebody wrote in 2026.

**2. `buildDecryptionGuide` must be generated from the recorded values, not
hard-coded.**

This is the load-bearing half. A hard-coded guide was the defect; a guide that
reads the manifest cannot drift from the objects it describes. Where a value is
uniform across the archive it may be stated in prose, but it must come from the
rows.

**3. `content_hash` is the SHA-256 of the plaintext.** The schema comment is
corrected. Two of three sources and the executing code already agree, and it is
the semantically useful value: you verify what you recovered.

**4. §9.8's server-side integrity sweep is redefined, not repaired.** With a
plaintext hash and no key, a server can verify that an object *exists*, that its
byte length is as recorded, and that every `media_object` row has a stored
object and vice versa. It cannot verify content. If content verification is
wanted it needs either a second, ciphertext-hash column or a client-side sweep
that runs when the passphrase is in memory — both are larger decisions and
neither is taken here.

## Consequences

- **A migration is required** before any encryption is written:
  `media_object` has 31 columns and the only crypto ones are `wrapped_key` and
  `encryption_algorithm`. AES-GCM cannot function without an **IV**, and a
  wrapped key cannot be unwrapped without the **KDF salt** — the export guide
  already names both (`iv`, `keySalt`) and there is nowhere to put either.
  A KDF identifier and its parameters join them. §13.2 keeps that migration in
  its own commit.
- **`upload_outbox` cannot carry the wrapped key.** `requestUploadSchema`
  *requires* `wrappedKey` for the sensitive tier, `apps/web/app/api/media/uploads/route.ts`
  never reads it, `EnqueueUploadInput` has no field for it, and the table has no
  column. The client is made to send the one secret that matters and the server
  drops it. Same migration.
- **`verify-media-integrity` is misnamed** and its own `describes` string admits
  it: it reports outbox health. Under decision 4 it can honestly become an
  existence-and-length sweep.
- Argon2id brings a WASM dependency into the browser bundle. That cost is
  accepted here and should be measured against §2.2's budgets when it lands.

## What this ADR does not decide

Whether the master key is derived from a passphrase entered per session, held in
a platform keychain, or something else. §5.5 says "held in memory for the session
and never transmitted", which constrains storage but not entry. That is the next
decision and it is a usability question as much as a security one — a record the
operator cannot open because they are asked for a passphrase every time is a
record that stops being written to.
