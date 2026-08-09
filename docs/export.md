# Export — the P2 obligation

> Blueprint §9.10, §2.1, §5.4. Code: `packages/core/src/export/`,
> `packages/db/src/repositories/export.repository.ts`,
> `apps/web/app/api/export/route.ts`.

> "Export is a first-class feature with a schema of its own, shipped in the MVP."

§12 puts it in week two rather than later, with a reason: "it is the P2
obligation and it is easiest to build while the schema is small." That is the
only window in which the format can be got right cheaply.

## What an export contains

```
naitikos-export-2026-08-03.zip
├── README.md              written for a person who has never seen this system
├── schema.json            every table and every metric, described
├── metrics.json           the registry alone, for convenience
├── decrypt.md             how to decrypt media, if any is encrypted
├── medical-timeline.md    the clinical history, as prose
├── tables/
│   └── *.ndjson           one file per table
└── media/
    ├── manifest.json      what each file is, and its checksum
    └── ...
```

## The two properties that make it a real exit

§9.10 names both, and both are structural here rather than aspirational.

### 1. It is self-describing

> "Someone in 2046 with the archive and no application can understand it. The
> metric registry travels with the data, so every number carries its meaning."

`schema.json` is *generated* from the same `MetricDefinition` values the
application validates against — not hand-maintained beside them. A hand-written
copy would be wrong within a year and nobody would find out until the day it
mattered.

It also carries a `conventions` block, which is the part that is easy to skip
and expensive to omit. Every entry in it is an assumption a reader would
otherwise make that produces a wrong answer *silently*:

- that `value` is a float — it is a decimal string, and parsing it as a double
  reintroduces the rounding §5.3 bans;
- that a `1` in a boolean column is a measurement;
- that a categorical's number means something on its own, rather than being an
  index into `allowed_values`;
- that a `0` on a text observation means anything at all;
- that the record was edited in place — it is append-only, and a "current"
  reading requires filtering `superseded_by_id`;
- that `observed_at` alone locates the fact — the zone is in a separate column
  and is not redundant.

### 2. It is decryptable without this application

> "Encrypted media that can only be read by an application that no longer runs
> is not exported data. A standalone script plus the passphrase must be
> sufficient."

`decrypt.md` ships in the archive as readable source, not as a binary — a binary
is exactly the thing that stops running. It names the algorithm and its
parameters precisely enough (AES-256-GCM, PBKDF2-HMAC-SHA256, 600,000
iterations, per-object salt and IV) that the utility could be reimplemented from
the text alone, and it ends with a checksum assertion so a recovered file can be
*proved* intact.

## Why NDJSON

§9.10 names the format. A JSON array must be parsed whole, so a twenty-year
`observation` table could not be read on a machine with less memory than the
file. NDJSON streams, and a single corrupt line costs one row rather than the
table.

A trailing newline on the last line, so `wc -l` reports the row count and
concatenation works.

## Why ZIP, and why store-only

ZIP is the one general-purpose container every operating system since 1995 has
opened without software being installed. A bespoke format would fail §9.10's
first sentence.

Every entry is written with **method 0 (stored)**. Deflate would shrink the
archive and cost a compression implementation that has to still be correct in
twenty years. The trade is decided by what the archive contains: media dominates
the size and is already compressed, so deflating the NDJSON saves a few
megabytes against an archive measured in gigabytes.

A stored ZIP is also the only variant readable by hand. The bytes between the
local header and the next signature are the file, verbatim — so if every ZIP
tool has vanished, the data is recoverable with a hex editor and the README's
last paragraph.

`buildZip` refuses rather than producing something that needs ZIP64 (over 4 GiB
or 65,535 entries). A truncated archive that looks fine is worse than a failed
one, because it is only discovered on the day it is needed.

## Every table, discovered rather than listed

`allTableNames()` reads the schema module and collects everything that is
`instanceof PgTable`. §9.10 promises "every table", and a hand-written list is
one that silently stops being complete the first time a table is added — many
times over twenty years, each omission discovered by a person who no longer has
the application.

The cost is that a new table appears in the export before anybody has written a
description for it, and gets a generated placeholder. That is the right
direction to fail in.

Operational tables (`idempotency_record`, `schema_migration`, `app_event`) are
excluded by default. An idempotency key is not a fact about the person. The flag
exists because a full-fidelity backup drill wants everything, and that is a
different job from an export.

## Verification

`buildExportBundle` returns the manifest **alongside** the bytes, not only
inside them. §9.10's drill "asserts row-count and checksum equality", and a
checksum that only exists inside the thing it is checking is not a check.

The manifest is also returned on the `X-Export-Manifest` header, so a caller can
verify an archive without unzipping it.

The bundle is a pure function of its input, so it is deterministic — the same
record produces byte-identical archives, which is what makes a checksum
comparison meaningful at all.

## Step-up authentication

§5.4: "sensitive operations — export, encryption-key access, deletion — require
step-up re-authentication regardless of session age." Export is named first, and
the reason is what the endpoint returns: one request yields the entire medical
history in a form that needs no credentials to read.

**There is no explicit step-up check in the route handler**, and that is
deliberate. `export:execute` is in `STEP_UP_PERMISSIONS`, and `core`'s
`authorize` checks the fifteen-minute window as part of granting it — so the
ordinary guard already refuses a stale session. A second check in the handler
would be a second authorization site, which §5.4 permits exactly one of, and the
second one would be the one that drifted.

The response carries `Cache-Control: no-store` rather than `no-cache`: the
second permits storing and revalidating, and a complete medical record in a
shared proxy's disk cache is precisely the disclosure §5.14 exists to prevent.

## What is not built

**Media in the archive.** `/api/export` sends `media: []`. The bundle format
supports media fully — paths, manifest, checksums — but streaming gigabytes
through a serverless response is the wrong shape. §9.10's monthly automated
export runs as a job with a filesystem, and that is where media belongs. This
endpoint is the operator asking for their record now.

**The monthly automated export to independent storage**, and **the quarterly
re-import drill**. Both are §9.10 operational commitments that need a scheduler
and a second storage target. The format is ready for them; the runbook is not
written.

**Import.** Export is an exit, not a round trip. The drill needs an importer and
it does not exist yet.
