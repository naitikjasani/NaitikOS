/**
 * Storage keys.
 *
 * A key is the object's address in a bucket, and it is generated here rather than
 * by the caller so that three properties hold for every object in the system.
 *
 * ## 1. The tier is in the key
 *
 * `sensitive/2026/08/ab/cd/<hash>` — so a key alone is enough to find its bucket.
 * The alternative is threading the tier through every storage call, which means a
 * caller eventually passes the wrong one and reads a sensitive object out of the
 * private bucket. Buckets are separated per tier precisely so a policy mistake
 * cannot span them (§5.5); a key that does not name its tier undoes that.
 *
 * ## 2. Content-addressed
 *
 * The path is derived from the content hash, so the same bytes always land on the
 * same key. That makes `upload` naturally idempotent — a retried upload from the
 * offline outbox (§5.7) overwrites itself with identical bytes rather than
 * creating a second object — and it means a key collision is *information*: the
 * dedupe check missed a duplicate, or the hash function changed.
 *
 * The media object id is deliberately **not** in the key. Two rows can legitimately
 * reference one object (a photo the user re-added after undoing a delete), and
 * keying on the row id would store the bytes twice.
 *
 * ## 3. Date-partitioned and fanned out
 *
 * `2026/08/` then two levels of hash prefix. Supabase Storage lists a prefix by
 * scanning it, and §9.7 projects a five-year library in the low tens of
 * thousands of objects. Flat, that is one directory the nightly integrity sweep
 * has to page through; partitioned, each leaf holds a handful.
 *
 * The date is the *capture* date, so a series stays physically together — which
 * matters for the one operation that reads many objects at once (§9.10's export).
 */

import type { StorageTier } from './storage';

/** Characters permitted in a key segment. Anything else is a bug upstream. */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

export type StorageKeyInput = {
  readonly tier: StorageTier;
  /** SHA-256 content hash, hex. `sha256:` prefix optional. */
  readonly contentHash: string;
  /** Capture date as `YYYY-MM-DD`, in the capture zone (§5.3). */
  readonly capturedOn: string;
  /** `jpg`, `webp`, `pdf`. No leading dot. */
  readonly extension: string;
};

/**
 * Strip an algorithm prefix and normalise to lowercase hex.
 *
 * `sha256:ab12…` and `AB12…` must produce the same key, or the same bytes hashed
 * by two call sites land in two places and the content-addressing guarantee is
 * quietly false.
 */
function normaliseHash(contentHash: string): string | null {
  const withoutAlgorithm = contentHash.includes(':')
    ? (contentHash.split(':').pop() ?? '')
    : contentHash;
  const lowered = withoutAlgorithm.toLowerCase();

  // 64 hex characters. Shorter is a truncated hash, which would collapse the
  // fan-out and raise the collision probability by orders of magnitude.
  return /^[0-9a-f]{64}$/.test(lowered) ? lowered : null;
}

/**
 * Build a storage key. `null` when any input is unusable.
 *
 * Returns `null` rather than throwing so the caller decides — an upload with a
 * malformed hash should fail as a validated error, not as an exception from three
 * frames down.
 */
export function buildStorageKey(input: StorageKeyInput): string | null {
  const hash = normaliseHash(input.contentHash);
  if (hash === null) return null;

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.capturedOn);
  if (dateMatch === null) return null;

  const extension = input.extension.replace(/^\./, '').toLowerCase();
  if (!SAFE_SEGMENT.test(extension)) return null;

  const [, year, month] = dateMatch;

  return [
    input.tier,
    year,
    month,
    // Two levels of two hex characters: 256 first-level, 65,536 leaves.
    hash.slice(0, 2),
    hash.slice(2, 4),
    `${hash}.${extension}`,
  ].join('/');
}

/**
 * The thumbnail key for an object at `key`.
 *
 * Beside the original rather than in a parallel tree, so the integrity sweep sees
 * an object and its derivatives in one listing — and so a purge that removes a
 * prefix cannot leave orphaned thumbnails of a deleted photo behind.
 */
export function thumbnailKey(key: string, longEdge: number): string {
  const dot = key.lastIndexOf('.');
  const stem = dot === -1 ? key : key.slice(0, dot);
  const extension = dot === -1 ? 'webp' : key.slice(dot + 1);
  return `${stem}.t${String(longEdge)}.${extension}`;
}

/** Whether a key names a thumbnail rather than an original. */
export function isThumbnailKey(key: string): boolean {
  return /\.t\d+\.[a-z0-9]+$/.test(key);
}

/** The tier named by a key, or `null` if it does not name one. */
export function tierFromKey(key: string): StorageTier | null {
  const prefix = key.split('/')[0];
  return prefix === 'public' || prefix === 'private' || prefix === 'sensitive' ? prefix : null;
}

/**
 * The content hash a key was built from, or `null`.
 *
 * §9.8's integrity check needs this: it walks the bucket, and for each object has
 * to know what the bytes should hash to without a database round-trip per object.
 */
export function contentHashFromKey(key: string): string | null {
  const filename = key.split('/').pop() ?? '';
  const match = /^([0-9a-f]{64})\./.exec(filename);
  return match?.[1] ?? null;
}
