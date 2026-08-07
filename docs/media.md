# Media Pipeline

**Status:** implemented, Week 2 · **Blueprint sections:** §4.2, §5.5, §9.8, §9.9, §9.10
**Related:** [storage.md](storage.md) · [background-jobs.md](background-jobs.md)

---

## 1. The stage order is a security property

§5.5 specifies the pipeline:

> "capture → client-side EXIF normalisation and orientation fix → downscale to a
> fixed long-edge → derive a perceptual hash for duplicate detection → encrypt →
> upload → store the metadata row with dimensions, capture time, zone,
> protocol-compliance flags, and the wrapped key."

**Encryption is second-to-last, and everything that needs to read the pixels
happens before it.** Once a sensitive object is encrypted the server holds
ciphertext it cannot read — so thumbnailing, hashing, and dimension extraction
are all client-side at capture, or they are impossible.

```
 1. size guard      ── before any decode, so a 200 MB file costs nothing
 2. metadata + EXIF ── BEFORE compression: a re-encode strips orientation
 3. compress        ── images only, to a fixed long edge
 4. thumbnails      ── from the COMPRESSED bytes, inheriting the rotation fix
 5. hash            ── AFTER compression, so it identifies what is stored
 6. encrypt         ── last
```

Each of those "before"s is load-bearing:

- **Metadata before compression.** EXIF orientation is commonly stripped by a
  re-encode, and a rotated photo silently becomes permanently sideways.
- **Hash after compression.** Hashing the original means §9.8's nightly integrity
  check compares a digest against bytes that never existed in the bucket — a
  check that fails on every object, which is a check that gets switched off.
- **Encrypt last.** Everything above needs readable pixels.

`pipeline.test.ts` asserts the *order stages ran in*, not just their outputs. An
implementation that hashed before compressing would pass every output assertion.

---

## 2. Where the pipeline runs

The same function runs in the browser for a skin photo and on the server for a
lab PDF. The only difference is which stages are configured — every optional
stage that is absent is skipped rather than being an error.

That is why it is pure and lives in `core`. A pipeline that assumed a server
would rewrite every skin photo.

| Tier | Contents | Where the pipeline runs | Server can read it? |
|---|---|---|---|
| `public` | app assets, icons | build | yes |
| `private` | documents, receipts, non-body imagery | server or client | **yes** |
| `sensitive` | skin, physique, medical imaging, journal attachments | **client only** | **no** |

The `private` tier being server-readable is what makes §4.11's "lab PDF becomes
structured lab observations" possible at all.

---

## 3. Refusing rather than degrading

```ts
if (options.tier === 'sensitive' && stages.encryptor === undefined) {
  return err(preconditionFailedError(
    'encryptor_configured',
    'Sensitive-tier media requires an encryptor. Refusing to store plaintext (§5.5).',
    'encryptor_missing',
  ));
}
```

This is the most important line in the file. Storing plaintext because the
encryptor was not wired is exactly the outcome P7 says the architecture must make
**impossible rather than prohibited**.

The same rule is enforced at three boundaries, and the redundancy is the point —
each is a place a plaintext body photo could otherwise cross:

| Boundary | Mechanism |
|---|---|
| The pipeline | refuses to produce the object |
| The wire | `requestUploadSchema` requires `wrappedKey` for the sensitive tier |
| The database | `media_object_sensitive_encrypted` check constraint |

The third one rejected the first version of the integration-test fixture, which
is the constraint doing its job.

---

## 4. Hashes: two, doing different jobs

Conflating them is a real bug.

| | `contentHash` (SHA-256) | `perceptualHash` |
|---|---|---|
| For | **integrity** | **deduplication** |
| Exact? | yes | no |
| Detects | a byte that changed in storage | the same photo re-encoded or resized |
| Used by | §9.8's nightly check, the storage key | `classifyDuplicate` |

A perceptual hash cannot verify integrity, and a SHA-256 cannot spot a re-encode.
§5.5 asks for the perceptual hash specifically for duplicate detection.

### Deduplication is reported, never acted on

```ts
type DuplicateVerdict =
  | { kind: 'unique' }
  | { kind: 'exact'; existingMediaObjectId }
  | { kind: 'near';  existingMediaObjectId; distance };
```

The threshold is **5 of 64 bits**, chosen conservatively and in one direction on
purpose. §4.2's photo series is *supposed* to contain near-identical photos taken
weeks apart under an alignment overlay. A false "unique" costs a wasted object; a
false "duplicate" costs a data point in a longitudinal series, and offers to
delete a photo the user took deliberately.

`hammingDistance` returns `null` for incomparable hashes (different lengths,
non-hex) rather than a large number — otherwise a truncated hash silently counts
as unique.

---

## 5. Capture protocol (§9.8)

§4.2 is blunt about why this exists: photographs under inconsistent conditions
"are not merely lower quality — they are **actively misleading**, because
apparent change is dominated by capture variance rather than skin change."

```ts
type CaptureProtocol = {
  region, poseId, distance, lighting, flash, timeBucket;
  alignmentReferenceId?;   // previous photo, for the ghost overlay
  medianLuminance?;        // of the fixed reference region
  complianceScore?;        // 0–1; below threshold, excluded from comparisons
};
```

`complianceScore` is the one numeric field in a media event payload that is not a
count. It is reviewed and justified in `registry.test.ts`: it is a property of
the *photograph*, not of the person, and the timeline filters comparison views on
it.

---

## 6. Hooks that are hooks, not stubs

Two future stages are declared with real types and no implementation:

- **`TextExtractor`** (§9.9's OCR). When it lands it runs **before** encryption
  for the sensitive tier, and server-side for the private tier.
- **`VisionAnalyser`** (§4.2's future lesion counting). §4.2 constrains it before
  it exists: "deterministic CV, computed locally, **never a generative model**."
  The port is declared so that constraint is recorded next to the type rather
  than discovered later.

Neither is implemented. §10 is V2, and there is no AI in this milestone.

---

## 7. Limits

| Constant | Value | Why |
|---|---|---|
| `MAX_OBJECT_BYTES` | 25 MB | Generous for a photo, tight for video |
| `DEFAULT_LONG_EDGE` | 2048 px | §5.5's fixed long edge |
| `DEFAULT_THUMBNAIL_SIZES` | 128, 512 | A list row and a grid cell |

25 MB is deliberate: §5.5 lists video as future, and a 500 MB upload on a phone in
a gym basement (§5.7) would sit in the outbox for hours and fail. **Raising this
needs the resumable upload path, not just a bigger number.**

---

## 8. Storage keys

```
sensitive/2026/08/3b/1f/3b1f4c9d….jpg
└── tier ┘└ date ┘└hash┘└─ content hash ─┘
```

Three properties, each defended by a test:

1. **The tier is in the key**, so a key alone finds its bucket. Threading the tier
   through every call means a caller eventually passes the wrong one and reads a
   sensitive object out of the private bucket — a cross-tier access no policy
   catches, because both buckets are ours.
2. **Content-addressed.** The same bytes always land on the same key, which makes
   a retried upload from the offline outbox overwrite itself with identical bytes
   rather than creating a second object. A collision is *information*: either the
   dedupe check missed a duplicate, or the hash function changed.
3. **Date-partitioned and fanned out** (two levels of two hex characters, 65,536
   leaves). Flat, §9.8's nightly sweep would page through one enormous directory.

The media object id is deliberately **not** in the key: two rows can legitimately
reference one object (a photo re-added after undoing a delete), and keying on the
row id would store the bytes twice.

Thumbnails sit *beside* the original — `….t512.jpg` — so the integrity sweep sees
an object and its derivatives in one listing, and a prefix purge cannot leave
orphaned thumbnails of a deleted photo behind.

---

## 9. Upload lifecycle end to end

```
client                                    server
  │
  ├─ runPipeline() ─────────────────────► (nothing; this is local)
  │
  ├─ POST /api/media/uploads ───────────► reserve outbox row + signed URL
  │     { idempotencyKey, tier,               ▲
  │       contentHash, byteSize,              │ row created BEFORE the upload,
  │       capturedOn, wrappedKey }            │ so a death mid-flight is visible
  │
  ├─ PUT <signed url> ──────────────────► Supabase Storage
  │
  └─ PATCH /api/media/uploads ──────────► markUploaded | markFailed
        { idempotencyKey, mediaObjectId }
```

A replayed POST for an already-uploaded key returns `already_uploaded` rather
than a second signed URL. §5.7 replays freely, so that is the normal path.

See [storage.md](storage.md) for the outbox's durability guarantees and the
offline asymmetry.

---

## 10. Deletion

`StorageProvider.remove()` exists, and it is **not part of ordinary deletion**.

§9.4: "Nothing is hard-deleted. Deletion sets a deleted-at timestamp and a
reason." A deleted photo keeps its bytes so the undo toast (§8.12) can actually
undo. `remove()` is for the explicit, audited purge path and for cleaning up a
failed upload.

---

## 11. Gotchas

- **`byteSize` in the metadata is the size of what will be stored**, i.e.
  ciphertext for the sensitive tier. It has to match the object or §9.8's sweep
  flags every encrypted row.
- **The mime type may change during the pipeline** — the extractor reports
  `image/jpeg`, the compressor produces `image/webp`. Storing the input type
  makes every signed URL serve the wrong `Content-Type`.
- **HEIC is in the image list.** It is what an iPhone produces by default, and
  treating it as a non-image would store every photo uncompressed and
  thumbnail-less.
- **A `Uint8Array` view may window a larger buffer.** The Supabase adapter wraps
  it in `new Uint8Array(body)` before making a `Blob`, because passing the raw
  view can upload the entire backing buffer.
