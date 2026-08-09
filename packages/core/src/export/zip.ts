/**
 * A minimal ZIP writer.
 *
 * §9.10 makes the export a real exit rather than a gesture, and the first of its
 * two properties is that "someone in 2046 with the archive and no application
 * can understand it". A bespoke container would fail that on the first sentence,
 * so the archive is a ZIP — the one general-purpose format that every operating
 * system since 1995 has opened without software being installed.
 *
 * ## Store-only, no compression
 *
 * Every entry is written with method 0 (stored). Deflate would shrink the
 * archive by perhaps 80%, and it would cost a compression implementation that
 * has to still be correct in twenty years. The trade is decided by what the
 * archive *contains*: media dominates the size and is already compressed, so
 * deflating the NDJSON saves a few megabytes against an archive measured in
 * gigabytes.
 *
 * A stored ZIP is also the one variant that can be read by hand. The bytes
 * between the local header and the next signature are the file, verbatim —
 * which means that if every ZIP tool has vanished, the data is still recoverable
 * with a hex editor and this comment.
 *
 * ## What is deliberately not implemented
 *
 * **ZIP64.** The classic format caps an archive at 4 GiB and 65,535 entries.
 * {@link MAX_ARCHIVE_BYTES} refuses rather than silently producing a corrupt
 * archive — a truncated export that looks fine is worse than a failed one,
 * because it would only be discovered on the day it was needed.
 *
 * **Encryption.** §9.10 requires "a decryption utility" for encrypted *media*,
 * which is a per-object concern handled by the media pipeline. Encrypting the
 * container as well would put a second key in the path of the same data.
 */

/** 4 GiB, minus a margin for the central directory. Beyond this, ZIP64 is required. */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 - 1024 * 1024;

/** The classic format's entry count ceiling. */
export const MAX_ARCHIVE_ENTRIES = 65_535;

export type ZipEntry = {
  /** Path within the archive. Forward slashes, no leading slash. */
  readonly path: string;
  readonly data: Uint8Array;
};

/* -------------------------------------------------------------------------
 * CRC-32
 * ---------------------------------------------------------------------- */

/**
 * The standard CRC-32 table (polynomial 0xEDB88320).
 *
 * Built once, lazily. A literal 256-entry table would be faster to load and
 * impossible to verify by eye; generating it from the polynomial means the
 * constant that matters is the one visible in the code.
 */
let crcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (crcTable !== null) return crcTable;

  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  crcTable = table;
  return table;
}

/**
 * CRC-32 of a byte array.
 *
 * Not a security property — it is what makes a ZIP tool report a *corrupt*
 * archive rather than silently handing back damaged data. §9.10's quarterly
 * drill "asserts row-count and checksum equality", and this is the checksum a
 * third-party tool can verify without any of our code.
 */
export function crc32(data: Uint8Array): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (table[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------
 * Writing
 * ---------------------------------------------------------------------- */

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/** Version 2.0 — the minimum that supports directories and UTF-8 names. */
const VERSION_NEEDED = 20;

/**
 * Bit 11 of the general-purpose flags: filenames are UTF-8.
 *
 * Without it a path with a non-ASCII character is interpreted as CP437 and a
 * document titled with a Devanagari filename comes out of the archive as
 * mojibake — which for an export whose whole point is legibility is not a
 * cosmetic failure.
 */
const FLAG_UTF8 = 0x0800;

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

/**
 * MS-DOS date and time, which is what the format stores.
 *
 * Two-second resolution and a 1980 epoch. Both are limitations of ZIP itself
 * rather than choices — and neither matters, because every timestamp that *is*
 * data lives in the NDJSON as a full ISO instant with its zone (§5.3). This is
 * metadata for the file browser, nothing more.
 */
function dosDateTime(instant: Date): { readonly date: number; readonly time: number } {
  const year = Math.max(instant.getUTCFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
    time:
      (instant.getUTCHours() << 11) | (instant.getUTCMinutes() << 5) | Math.floor(instant.getUTCSeconds() / 2),
  };
}

export type ZipFailure = 'too_large' | 'too_many_entries' | 'duplicate_path' | 'invalid_path';

/**
 * Build a ZIP archive.
 *
 * Returns the failure rather than throwing, because every one of them is a
 * condition the caller can act on: split the export, or fix the path.
 */
export function buildZip(
  entries: readonly ZipEntry[],
  modifiedAt: Date,
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly failure: ZipFailure } {
  if (entries.length > MAX_ARCHIVE_ENTRIES) return { ok: false, failure: 'too_many_entries' };

  const seen = new Set<string>();
  for (const entry of entries) {
    // A leading slash or a `..` segment lets an archive write outside the
    // directory it is extracted into — the "zip slip" traversal. This export is
    // ours and the paths are generated, but an archive is a thing other people
    // extract, and generating a well-formed one is free.
    if (entry.path === '' || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      return { ok: false, failure: 'invalid_path' };
    }
    if (seen.has(entry.path)) return { ok: false, failure: 'duplicate_path' };
    seen.add(entry.path);
  }

  const encoder = new TextEncoder();
  const { date, time } = dosDateTime(modifiedAt);

  const prepared = entries.map((entry) => {
    const name = encoder.encode(entry.path);
    return { name, data: entry.data, crc: crc32(entry.data) };
  });

  const localSize = prepared.reduce((total, entry) => total + 30 + entry.name.length + entry.data.length, 0);
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const totalSize = localSize + centralSize + 22;

  if (totalSize > MAX_ARCHIVE_BYTES) return { ok: false, failure: 'too_large' };

  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  /* --- Local file headers, each followed by its data ------------------- */

  const offsets: number[] = [];

  for (const entry of prepared) {
    offsets.push(offset);

    writeUint32(view, offset, LOCAL_HEADER_SIGNATURE);
    writeUint16(view, offset + 4, VERSION_NEEDED);
    writeUint16(view, offset + 6, FLAG_UTF8);
    // Method 0: stored. See the file header for why.
    writeUint16(view, offset + 8, 0);
    writeUint16(view, offset + 10, time);
    writeUint16(view, offset + 12, date);
    writeUint32(view, offset + 14, entry.crc);
    // Compressed and uncompressed sizes are equal, because nothing is
    // compressed. Writing both is required even so.
    writeUint32(view, offset + 18, entry.data.length);
    writeUint32(view, offset + 22, entry.data.length);
    writeUint16(view, offset + 26, entry.name.length);
    writeUint16(view, offset + 28, 0);
    offset += 30;

    bytes.set(entry.name, offset);
    offset += entry.name.length;

    bytes.set(entry.data, offset);
    offset += entry.data.length;
  }

  /* --- The central directory ------------------------------------------- */

  const centralStart = offset;

  for (const [index, entry] of prepared.entries()) {
    writeUint32(view, offset, CENTRAL_HEADER_SIGNATURE);
    // "Version made by": 20, MS-DOS. The high byte identifies the source
    // filesystem, and 0 (MS-DOS/FAT) is the value that keeps the archive
    // portable — a Unix value makes some tools expect permission bits.
    writeUint16(view, offset + 4, VERSION_NEEDED);
    writeUint16(view, offset + 6, VERSION_NEEDED);
    writeUint16(view, offset + 8, FLAG_UTF8);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, time);
    writeUint16(view, offset + 14, date);
    writeUint32(view, offset + 16, entry.crc);
    writeUint32(view, offset + 20, entry.data.length);
    writeUint32(view, offset + 24, entry.data.length);
    writeUint16(view, offset + 28, entry.name.length);
    writeUint16(view, offset + 30, 0);
    writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0);
    writeUint16(view, offset + 36, 0);
    writeUint32(view, offset + 38, 0);
    writeUint32(view, offset + 42, offsets[index] ?? 0);
    offset += 46;

    bytes.set(entry.name, offset);
    offset += entry.name.length;
  }

  /* --- End of central directory ---------------------------------------- */

  writeUint32(view, offset, END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(view, offset + 4, 0);
  writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, prepared.length);
  writeUint16(view, offset + 10, prepared.length);
  writeUint32(view, offset + 12, offset - centralStart);
  writeUint32(view, offset + 16, centralStart);
  writeUint16(view, offset + 20, 0);

  return { ok: true, bytes };
}
