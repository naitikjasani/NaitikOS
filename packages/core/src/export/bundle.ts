/**
 * The export bundle — §9.10, the P2 obligation.
 *
 *   "A complete export produces: every table as newline-delimited JSON with a
 *    documented schema; all media, decrypted, with a manifest; a human-readable
 *    Markdown rendering of the medical timeline; a `schema.json` describing
 *    every table, column, and metric with its semantics; and a `README`
 *    explaining the format to a person who has never seen this system."
 *
 * This file assembles that. The two properties §9.10 says make it "a real exit
 * rather than a gesture" are both structural here rather than aspirational:
 *
 * 1. **Self-describing.** The metric registry travels *inside* the archive, so
 *    every number carries its meaning. `schema.json` is generated from the same
 *    definitions the application validates against, not hand-maintained beside
 *    them — a hand-written copy would be wrong within a year and nobody would
 *    find out until 2046.
 * 2. **Decryptable without this application.** The decryption utility ships in
 *    the archive as readable source, not as a binary.
 *
 * ## Why this is in `core`
 *
 * It has no IO. The caller supplies rows; this produces bytes. That is what
 * lets the whole format be tested without a database, and it is why the export
 * is verifiable at all — §9.10's quarterly drill re-imports an export and
 * "asserts row-count and checksum equality", which needs the format to be a
 * pure function of its input.
 */

import type { MetricDefinition } from '../observations/metric';
import { parseInstant } from '../temporal/instant';
import { type ZipEntry, buildZip, crc32 } from './zip';

/** The MS-DOS epoch floor, used when `generatedAt` cannot be parsed. */
const EPOCH = parseInstant('1980-01-01T00:00:00.000Z') as Date;

/** The format's own version. Bumped when the layout changes, never reused. */
export const EXPORT_FORMAT_VERSION = 1;

export type ExportTable = {
  /** Physical table name, as it appears in `schema.json`. */
  readonly name: string;
  /** What this table holds, for a reader who has never seen the system. */
  readonly description: string;
  /** Rows, already plain JSON. One JSON object per line in the output. */
  readonly rows: readonly Record<string, unknown>[];
};

export type ExportMedia = {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly originalName: string | null;
};

export type ExportInput = {
  /** ISO instant the export was produced. */
  readonly generatedAt: string;
  readonly tables: readonly ExportTable[];
  readonly metrics: readonly MetricDefinition[];
  readonly media: readonly ExportMedia[];
  /** Markdown rendering of the medical timeline (§9.10). */
  readonly medicalTimelineMarkdown: string;
};

/* -------------------------------------------------------------------------
 * NDJSON
 * ---------------------------------------------------------------------- */

/**
 * Newline-delimited JSON, one object per line.
 *
 * NDJSON rather than a JSON array, and §9.10 names the format for a reason: an
 * array must be parsed whole, so a twenty-year `observation` table cannot be
 * read on a machine with less memory than the file. NDJSON streams, and a
 * single corrupt line costs one row rather than the table.
 *
 * A trailing newline on the last line, so `wc -l` reports the row count and
 * `cat a.ndjson b.ndjson` concatenates correctly.
 */
export function toNdjson(rows: readonly Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/* -------------------------------------------------------------------------
 * schema.json
 * ---------------------------------------------------------------------- */

type SchemaDocument = {
  readonly formatVersion: number;
  readonly generatedAt: string;
  readonly conventions: Readonly<Record<string, string>>;
  readonly tables: readonly {
    readonly name: string;
    readonly description: string;
    readonly rowCount: number;
    readonly file: string;
  }[];
  readonly metrics: readonly Record<string, unknown>[];
};

/**
 * The physical conventions a reader needs before the first row makes sense.
 *
 * These are the four decisions from §5.3 plus the two encodings that would
 * otherwise be unguessable. Every one of them is something a person in 2046
 * would get wrong by assumption: that `value` is a float, that `1` in a boolean
 * column is a measurement, that a categorical's number is meaningful on its own,
 * that a `0` on a text observation means anything at all.
 */
const CONVENTIONS: Readonly<Record<string, string>> = {
  time: 'Every timestamp is UTC, ISO 8601, with the IANA zone it was captured in stored alongside in a separate column. The zone is not redundant: a workout at 7am during travel is a different fact from one at 7am at home.',
  numbers:
    'Every measured quantity is a decimal STRING, never a JSON number. They are stored as SQL numeric(20,6). Parsing them as floating point will introduce rounding errors in dosages and lab values.',
  ids: 'UUIDv7. The first 48 bits are a millisecond timestamp, so ids sort chronologically.',
  money: 'Integer minor units in one column and an ISO-4217 currency code in another. 1250 + INR is Rs 12.50.',
  observations:
    'The observation table is append-only. A correction is a NEW row; the old row has superseded_by_id pointing at it and both are kept forever. To see current values only, filter superseded_by_id IS NULL.',
  observationValues:
    'observation.value is always numeric. For a boolean metric it is 0 or 1. For a categorical metric it is the zero-based INDEX into that metric\'s allowed_values array in metrics.json. For a text metric it is a meaningless 0 and the content is in value_text.',
  units:
    'observation.unit is copied from the metric at write time and is deliberately redundant. If a metric\'s canonical unit was ever changed, historical rows still say what they meant when recorded.',
  hlc: 'The hlc column is a hybrid logical clock: 12 hex digits of milliseconds, 4 of a counter, a dash, then 12 identifying the device. It sorts lexicographically in causal order. Use it, not observed_at, to order two writes that claim the same instant.',
};

export function buildSchemaDocument(input: ExportInput): SchemaDocument {
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    generatedAt: input.generatedAt,
    conventions: CONVENTIONS,
    tables: input.tables.map((table) => ({
      name: table.name,
      description: table.description,
      rowCount: table.rows.length,
      file: `tables/${table.name}.ndjson`,
    })),
    /*
     * The registry travels whole, including each metric's `description`.
     *
     * §9.10's first property depends on exactly this: "The metric registry
     * travels with the data, so every number carries its meaning." A bare
     * `74.2` is nothing; joined to its metric row it is a complete fact.
     */
    metrics: input.metrics.map((metric) => ({ ...metric })),
  };
}

/* -------------------------------------------------------------------------
 * README
 * ---------------------------------------------------------------------- */

/**
 * The README, written for a person who has never seen this system.
 *
 * Not for a developer of it. That distinction is the whole instruction in
 * §9.10, and it is why this text explains what NDJSON is and why the numbers
 * are strings rather than describing the codebase.
 */
export function buildReadme(input: ExportInput): string {
  const totalRows = input.tables.reduce((sum, table) => sum + table.rows.length, 0);

  return `# NaitikOS export

Generated ${input.generatedAt}
Format version ${String(EXPORT_FORMAT_VERSION)}

This archive is a complete copy of one person's health and life record. It was
produced by an application called NaitikOS, and **you do not need that
application to read it**. That is the point of the format.

## What is in here

    README.md              this file
    schema.json            every table and every metric, described
    metrics.json           the metric registry on its own, for convenience
    tables/*.ndjson        the data, one file per table
    media/                 photographs and documents, decrypted
    media/manifest.json    what each media file is, and its checksum
    medical-timeline.md    the clinical history, readable as prose
    decrypt.md             how to decrypt media, if you ever have encrypted files

${String(input.tables.length)} tables, ${String(totalRows)} rows, ${String(input.media.length)} media files.

## How to read the data

Each \`.ndjson\` file is **newline-delimited JSON**: one JSON object per line,
one line per row. It is not a JSON array — there are no enclosing brackets and
no commas between lines. This is deliberate, so that a file with millions of
rows can be read a line at a time rather than loaded whole.

To look at one:

    head -n 5 tables/observation.ndjson

To load one in Python:

    import json
    with open('tables/observation.ndjson') as f:
        rows = [json.loads(line) for line in f]

## Six things that will surprise you

1. **Numbers are strings.** \`"value": "74.200000"\`, not \`74.2\`. Reading them
   as floating point introduces rounding errors, which in a medication dosage
   is not acceptable. Parse them as decimals.

2. **Nothing was ever edited.** The observation table is append-only. When a
   value was corrected, a *new* row was written and the old one had
   \`superseded_by_id\` set to point at it. Both are still here. For the record
   as it stands today, filter \`superseded_by_id\` to null.

3. **Every number needs its metric.** \`"value": "4.000000"\` means nothing until
   you join \`metric_key\` against \`metrics.json\`, which will tell you it is a
   self-reported mood on a 1–5 scale where 5 is best. Every metric carries a
   plain-English description written for you.

4. **Booleans and categories are numbers.** A boolean metric stores 0 or 1. A
   categorical metric stores the *index* into its \`allowedValues\` list. A text
   metric stores a meaningless 0 and puts the content in \`value_text\`.

5. **Timestamps carry a zone.** \`observed_at\` is UTC; \`observed_zone\` is the
   IANA zone it was recorded in. Both matter — 7am in one place is a different
   fact from 7am in another, and discarding the zone destroys information you
   cannot recover.

6. **\`hlc\` is the ordering column.** When two rows claim the same instant, the
   hybrid logical clock in \`hlc\` breaks the tie correctly. It is a fixed-width
   string, so ordinary string sorting works.

## If something here is unreadable

The archive is a standard ZIP with no compression, so the file contents sit
verbatim between the entry headers. If every ZIP tool has somehow vanished, the
data is still recoverable with a hex editor: each entry begins with the four
bytes \`PK\\x03\\x04\`, and the filename follows 30 bytes later.
`;
}

/* -------------------------------------------------------------------------
 * The decryption utility
 * ---------------------------------------------------------------------- */

/**
 * §9.10's second property, discharged.
 *
 *   "The export includes a decryption utility. Encrypted media that can only be
 *    read by an application that no longer runs is not exported data. A
 *    standalone script plus the passphrase must be sufficient."
 *
 * Shipped as documented source rather than as a binary, because a binary is
 * exactly the thing that stops running. The algorithm is named precisely enough
 * that the file could be reimplemented from this text if the code below no
 * longer runs on anything.
 */
export function buildDecryptionGuide(): string {
  return `# Decrypting media

Media in this archive has already been decrypted — the files under \`media/\`
are readable as they are. This document exists so that an archive containing
*encrypted* files can still be opened, and so that the scheme is recorded
somewhere other than in an application.

## The scheme

Each media object is encrypted with its own random 256-bit key using
**AES-256-GCM**. That per-object key is then wrapped (encrypted) with a master
key derived from a passphrase using **PBKDF2-HMAC-SHA256, 600,000 iterations**,
with a per-object random salt.

Each encrypted object therefore carries, in \`media/manifest.json\`:

    wrappedKey            the object key, encrypted with the master key (base64)
    keySalt               the PBKDF2 salt for that object (base64)
    iv                    the AES-GCM initialisation vector (base64)
    encryptionAlgorithm   "AES-256-GCM"
    sha256                checksum of the PLAINTEXT, for verification

## Recovering a file

    import base64, hashlib, json
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    entry = ...            # the object's row from media/manifest.json
    passphrase = b'...'    # your passphrase

    master = hashlib.pbkdf2_hmac(
        'sha256', passphrase, base64.b64decode(entry['keySalt']), 600_000, 32
    )
    object_key = AESGCM(master).decrypt(
        base64.b64decode(entry['iv']), base64.b64decode(entry['wrappedKey']), None
    )
    plaintext = AESGCM(object_key).decrypt(
        base64.b64decode(entry['iv']), open(entry['path'], 'rb').read(), None
    )

    assert hashlib.sha256(plaintext).hexdigest() == entry['sha256']

The final assertion is the point: if it holds, the file is byte-for-byte what
was originally stored, and no amount of missing software changes that.
`;
}

/* -------------------------------------------------------------------------
 * Assembly
 * ---------------------------------------------------------------------- */

export type ExportManifest = {
  readonly formatVersion: number;
  readonly generatedAt: string;
  readonly tables: readonly { readonly name: string; readonly rows: number; readonly crc32: string }[];
  readonly media: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly totalRows: number;
};

export type ExportBundle = {
  readonly bytes: Uint8Array;
  readonly manifest: ExportManifest;
};

/**
 * Assemble the archive.
 *
 * The manifest is returned alongside the bytes rather than only written into
 * them, because §9.10's verification step needs it *outside* the archive to
 * compare against: "a quarterly drill re-imports an export into a scratch
 * database and asserts row-count and checksum equality". A checksum that only
 * exists inside the thing it is checking is not a check.
 */
export function buildExportBundle(input: ExportInput): { ok: true; bundle: ExportBundle } | { ok: false; failure: string } {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];

  const tableSummaries = input.tables.map((table) => {
    const data = encoder.encode(toNdjson(table.rows));
    entries.push({ path: `tables/${table.name}.ndjson`, data });
    return {
      name: table.name,
      rows: table.rows.length,
      crc32: crc32(data).toString(16).padStart(8, '0'),
    };
  });

  entries.push({
    path: 'schema.json',
    data: encoder.encode(JSON.stringify(buildSchemaDocument(input), null, 2)),
  });

  // The registry twice: inside `schema.json` for completeness, and alone for a
  // reader who only wants to know what the numbers mean. Duplication in an
  // archive costs kilobytes and saves the reader a step.
  entries.push({
    path: 'metrics.json',
    data: encoder.encode(JSON.stringify(input.metrics, null, 2)),
  });

  entries.push({ path: 'README.md', data: encoder.encode(buildReadme(input)) });
  entries.push({ path: 'decrypt.md', data: encoder.encode(buildDecryptionGuide()) });
  entries.push({
    path: 'medical-timeline.md',
    data: encoder.encode(input.medicalTimelineMarkdown),
  });

  for (const item of input.media) {
    entries.push({ path: `media/${item.path}`, data: item.bytes });
  }

  entries.push({
    path: 'media/manifest.json',
    data: encoder.encode(
      JSON.stringify(
        input.media.map((item) => ({
          path: item.path,
          sha256: item.sha256,
          bytes: item.bytes.length,
          originalName: item.originalName,
        })),
        null,
        2,
      ),
    ),
  });

  /*
   * The archive's file timestamps. `parseInstant` rather than `new Date` —
   * §11.3's rule — and the epoch as the fallback rather than "now", so a
   * malformed `generatedAt` produces an archive that is visibly wrong instead
   * of one that quietly claims to have been made today.
   */
  const modifiedAt = parseInstant(input.generatedAt) ?? EPOCH;
  const archive = buildZip(entries, modifiedAt);
  if (!archive.ok) return { ok: false, failure: archive.failure };

  return {
    ok: true,
    bundle: {
      bytes: archive.bytes,
      manifest: {
        formatVersion: EXPORT_FORMAT_VERSION,
        generatedAt: input.generatedAt,
        tables: tableSummaries,
        media: input.media.map((item) => ({
          path: item.path,
          sha256: item.sha256,
          bytes: item.bytes.length,
        })),
        totalRows: tableSummaries.reduce((sum, table) => sum + table.rows, 0),
      },
    },
  };
}
