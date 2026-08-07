/**
 * Storage keys.
 *
 * Three properties, each defended below because each has a specific way of
 * failing silently:
 *
 *  - **The tier is in the key.** If it were not, a caller could read a sensitive
 *    object out of the private bucket — a cross-tier access no policy would catch
 *    because both buckets are ours (§5.5 separates them precisely so a policy
 *    mistake cannot span them).
 *  - **Content-addressed.** The same bytes always produce the same key, so a
 *    retried upload from the offline outbox overwrites itself rather than
 *    creating a second object.
 *  - **Rejects rather than normalises.** A truncated or non-hex hash returns
 *    `null` instead of producing a short key that collapses the fan-out.
 */

import { describe, expect, it } from 'vitest';

import {
  buildStorageKey,
  contentHashFromKey,
  isThumbnailKey,
  thumbnailKey,
  tierFromKey,
} from './keys';

const HASH = 'a'.repeat(64);
const REAL_HASH = '3b1f4c9d8e2a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c';

function key(overrides: Partial<Parameters<typeof buildStorageKey>[0]> = {}): string | null {
  return buildStorageKey({
    tier: 'sensitive',
    contentHash: REAL_HASH,
    capturedOn: '2026-08-03',
    extension: 'jpg',
    ...overrides,
  });
}

describe('buildStorageKey', () => {
  it('puts the tier first, then the capture date, then a hash fan-out', () => {
    expect(key()).toBe(
      `sensitive/2026/08/3b/1f/${REAL_HASH}.jpg`,
    );
  });

  it('is content-addressed: identical bytes give an identical key', () => {
    // What makes a retried upload idempotent (§5.7's outbox "may replay any
    // request any number of times").
    expect(key()).toBe(key());
  });

  it('separates the tiers', () => {
    expect(key({ tier: 'private' })?.startsWith('private/')).toBe(true);
    expect(key({ tier: 'public' })?.startsWith('public/')).toBe(true);
  });

  it('partitions by the capture date, so a series stays physically together', () => {
    // §9.10's export is the one operation that reads many objects at once.
    expect(key({ capturedOn: '2027-01-09' })).toContain('/2027/01/');
  });

  it('accepts an algorithm-prefixed hash and normalises case', () => {
    // Two call sites must not produce two keys for one set of bytes.
    expect(key({ contentHash: `sha256:${REAL_HASH}` })).toBe(key());
    expect(key({ contentHash: REAL_HASH.toUpperCase() })).toBe(key());
  });

  it('accepts an extension with or without a leading dot', () => {
    expect(key({ extension: '.JPG' })).toBe(key({ extension: 'jpg' }));
  });

  it('rejects a truncated hash rather than shortening the fan-out', () => {
    // A 16-character hash raises the collision probability by many orders of
    // magnitude, and collisions in a content-addressed store are silent overwrites.
    expect(key({ contentHash: 'abc123' })).toBeNull();
    expect(key({ contentHash: HASH.slice(0, 63) })).toBeNull();
  });

  it('rejects a non-hex hash', () => {
    expect(key({ contentHash: 'z'.repeat(64) })).toBeNull();
    expect(key({ contentHash: '' })).toBeNull();
  });

  it('rejects a malformed capture date', () => {
    for (const capturedOn of ['2026-8-3', '03/08/2026', '2026-08-03T12:00:00Z', '']) {
      expect(key({ capturedOn }), `${capturedOn} should be rejected`).toBeNull();
    }
  });

  it('rejects an extension containing a path separator', () => {
    // The traversal case. A key is a path, and `../` in one is a write outside the
    // intended prefix.
    expect(key({ extension: '../../etc/passwd' })).toBeNull();
    expect(key({ extension: 'jp g' })).toBeNull();
    expect(key({ extension: '' })).toBeNull();
  });

  it('produces a key with no path traversal or double slash', () => {
    const built = key();
    expect(built).not.toContain('..');
    expect(built).not.toContain('//');
  });
});

describe('thumbnailKey', () => {
  it('sits beside the original', () => {
    // So §9.8's integrity sweep sees an object and its derivatives in one listing,
    // and a prefix purge cannot leave orphaned thumbnails of a deleted photo.
    const original = key() as string;
    const thumb = thumbnailKey(original, 512);

    expect(thumb).toBe(`sensitive/2026/08/3b/1f/${REAL_HASH}.t512.jpg`);
    expect(thumb.slice(0, thumb.lastIndexOf('/'))).toBe(original.slice(0, original.lastIndexOf('/')));
  });

  it('gives each size its own key', () => {
    const original = key() as string;
    expect(thumbnailKey(original, 128)).not.toBe(thumbnailKey(original, 512));
  });

  it('defaults to webp for a key with no extension', () => {
    expect(thumbnailKey('private/2026/08/ab/cd/noext', 128)).toBe('private/2026/08/ab/cd/noext.t128.webp');
  });

  it('is recognisable as a thumbnail', () => {
    const original = key() as string;
    expect(isThumbnailKey(thumbnailKey(original, 128))).toBe(true);
    expect(isThumbnailKey(original)).toBe(false);
  });
});

describe('tierFromKey', () => {
  it('recovers the tier', () => {
    expect(tierFromKey(key() as string)).toBe('sensitive');
    expect(tierFromKey(key({ tier: 'private' }) as string)).toBe('private');
  });

  it('returns null for a key with no tier prefix', () => {
    // The adapter turns this into a `precondition_failed` rather than guessing a
    // bucket.
    expect(tierFromKey('2026/08/ab/cd/file.jpg')).toBeNull();
    expect(tierFromKey('secret/whatever')).toBeNull();
    expect(tierFromKey('')).toBeNull();
  });
});

describe('contentHashFromKey', () => {
  it('recovers the hash without a database round-trip', () => {
    // §9.8's nightly check walks the bucket and needs to know what each object
    // should hash to; a per-object query would make the sweep a scan of the library
    // in both directions.
    expect(contentHashFromKey(key() as string)).toBe(REAL_HASH);
  });

  it('returns null for a key that is not content-addressed', () => {
    expect(contentHashFromKey('private/2026/08/ab/cd/receipt.pdf')).toBeNull();
    expect(contentHashFromKey('')).toBeNull();
  });

  it('recovers the hash from a thumbnail key too', () => {
    expect(contentHashFromKey(thumbnailKey(key() as string, 128))).toBe(REAL_HASH);
  });
});
