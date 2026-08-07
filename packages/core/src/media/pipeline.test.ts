/**
 * The media pipeline: upload lifecycle and duplicate detection.
 *
 * ## The stage order is the thing under test
 *
 * §5.5's order is a security property, not a preference — everything that needs
 * to read pixels must happen before encryption, because once a sensitive object
 * is encrypted the server holds ciphertext it cannot read. So the first suite
 * asserts the *order stages ran in*, not just their outputs. An implementation
 * that hashed before compressing would pass every output assertion and store a
 * digest of bytes that never existed in the bucket.
 *
 * The refusal test is the other load-bearing one: sensitive-tier media with no
 * encryptor configured must fail, not degrade. P7 says the architecture should
 * make the bad outcome impossible rather than prohibited.
 */

import { describe, expect, it } from 'vitest';
import type { Result } from '@naitikos/shared';
import { err, isErr, isOk, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { validationError } from '../errors/domain-error';
import {
  DEFAULT_LONG_EDGE,
  DEFAULT_THUMBNAIL_SIZES,
  MAX_OBJECT_BYTES,
  PERCEPTUAL_DUPLICATE_THRESHOLD,
  classifyDuplicate,
  hammingDistance,
  runPipeline,
} from './pipeline';
import type {
  Compressor,
  DedupeCandidate,
  Encryptor,
  Hasher,
  MediaMetadata,
  MetadataExtractor,
  PipelineStages,
  Thumbnail,
  Thumbnailer,
} from './pipeline';
import { BUCKET_FOR_TIER, PRIVATE_URL_TTL_SECONDS, SENSITIVE_URL_TTL_SECONDS, urlTtlForTier } from './storage';

const JPEG = 'image/jpeg';
const PDF = 'application/pdf';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/**
 * Stages that record what ran, in order, and on which bytes.
 *
 * `trace` is what the ordering assertions read. `sawBytes` per stage is what
 * proves each one operated on the output of the previous rather than the original.
 */
function tracingStages(options: {
  trace: string[];
  withCompressor?: boolean;
  withThumbnailer?: boolean;
  withEncryptor?: boolean;
  withPerceptualHash?: boolean;
  failAt?: 'metadata' | 'compress' | 'thumbnail' | 'encrypt';
}): PipelineStages & { readonly sawBytes: Record<string, Uint8Array> } {
  const sawBytes: Record<string, Uint8Array> = {};

  const metadata: MetadataExtractor = {
    extract(input: Uint8Array, mimeType: string): Promise<Result<MediaMetadata, DomainError>> {
      options.trace.push('metadata');
      sawBytes['metadata'] = input;
      if (options.failAt === 'metadata') {
        return Promise.resolve(err(validationError('exif_unreadable', 'Cannot read EXIF.')));
      }
      return Promise.resolve(
        ok({
          mimeType,
          byteSize: input.byteLength,
          // eslint-disable-next-line @naitikos/no-bare-quantity -- Pixel dimensions of an image file, not a measurement of the person. §6.2's unit-confusion harm does not apply: there is one unit for image extent and no conversion to get wrong.
          width: 4032,
          // eslint-disable-next-line @naitikos/no-bare-quantity -- As above.
          height: 3024,
          capturedAt: '2026-08-03T18:30:00Z',
          capturedZone: 'Asia/Kolkata',
        }),
      );
    },
  };

  const hasher: Hasher = {
    contentHash(input: Uint8Array): Promise<string> {
      options.trace.push('hash');
      sawBytes['hash'] = input;
      return Promise.resolve(`sha256:${String(input.byteLength)}:${input.join('-')}`);
    },
    ...(options.withPerceptualHash === true
      ? {
          perceptualHash(input: Uint8Array): Promise<string | undefined> {
            options.trace.push('phash');
            sawBytes['phash'] = input;
            return Promise.resolve('ffff0000');
          },
        }
      : {}),
  };

  const compressor: Compressor = {
    compress(input, mimeType, opts) {
      options.trace.push(`compress:${String(opts.longEdge)}`);
      sawBytes['compress'] = input;
      if (options.failAt === 'compress') {
        return Promise.resolve(err(validationError('decode_failed', 'Cannot decode image.')));
      }
      // Half the bytes and a format change, so downstream stages can be caught
      // reading the original.
      return Promise.resolve(
        ok({ bytes: input.slice(0, Math.ceil(input.byteLength / 2)), mimeType: 'image/webp' }),
      );
    },
  };

  const thumbnailer: Thumbnailer = {
    generate(input, mimeType, sizes) {
      options.trace.push(`thumbnails:${sizes.join(',')}`);
      sawBytes['thumbnails'] = input;
      if (options.failAt === 'thumbnail') {
        return Promise.resolve(err(validationError('thumbnail_failed', 'Cannot resize.')));
      }
      const generated: Thumbnail[] = sizes.map((longEdge) => ({
        longEdge,
        bytes: bytes(longEdge),
        mimeType,
      }));
      return Promise.resolve(ok(generated));
    },
  };

  const encryptor: Encryptor = {
    encrypt(input) {
      options.trace.push('encrypt');
      sawBytes['encrypt'] = input;
      if (options.failAt === 'encrypt') {
        return Promise.resolve(err(validationError('encrypt_failed', 'No key in memory.')));
      }
      // Longer than the plaintext, like a real AEAD with a nonce and a tag.
      return Promise.resolve(
        ok({
          bytes: new Uint8Array([...input, 0xaa, 0xbb, 0xcc, 0xdd]),
          wrappedKey: 'wrapped:dek',
          algorithm: 'AES-256-GCM',
        }),
      );
    },
  };

  return {
    metadata,
    hasher,
    sawBytes,
    ...(options.withCompressor === false ? {} : { compressor }),
    ...(options.withThumbnailer === false ? {} : { thumbnailer }),
    ...(options.withEncryptor === true ? { encryptor } : {}),
  };
}

/* =========================================================================
 * Stage order
 * ====================================================================== */

describe('upload lifecycle — stage order', () => {
  it('runs metadata, compress, thumbnails, hash, encrypt, in that order', async () => {
    const trace: string[] = [];
    const stages = tracingStages({
      trace,
      withEncryptor: true,
      withPerceptualHash: true,
    });

    const result = await runPipeline(bytes(1, 2, 3, 4, 5, 6, 7, 8), stages, {
      tier: 'sensitive',
      mimeType: JPEG,
    });

    expect(isOk(result)).toBe(true);
    expect(trace).toEqual([
      'metadata',
      `compress:${String(DEFAULT_LONG_EDGE)}`,
      `thumbnails:${DEFAULT_THUMBNAIL_SIZES.join(',')}`,
      'hash',
      'phash',
      'encrypt',
    ]);
  });

  it('extracts metadata before compression, so EXIF orientation survives', async () => {
    const trace: string[] = [];
    const stages = tracingStages({ trace });
    const original = bytes(1, 2, 3, 4);

    await runPipeline(original, stages, { tier: 'private', mimeType: JPEG });

    // A re-encode commonly strips the orientation tag; reading it afterwards leaves
    // a rotated photo permanently sideways.
    expect(stages.sawBytes['metadata']).toEqual(original);
  });

  it('thumbnails from the compressed bytes, so they inherit the orientation fix', async () => {
    const trace: string[] = [];
    const stages = tracingStages({ trace });

    await runPipeline(bytes(1, 2, 3, 4), stages, { tier: 'private', mimeType: JPEG });

    expect(stages.sawBytes['thumbnails']).toEqual(bytes(1, 2));
  });

  it('hashes what is actually stored, not the original', async () => {
    const trace: string[] = [];
    const stages = tracingStages({ trace });

    await runPipeline(bytes(1, 2, 3, 4), stages, { tier: 'private', mimeType: JPEG });

    // Hashing the original would mean §9.8's nightly integrity check compares a
    // digest against bytes that never existed in the bucket — a check that fails
    // on every object, which is a check that gets switched off.
    expect(stages.sawBytes['hash']).toEqual(bytes(1, 2));
  });

  it('encrypts last, on the compressed bytes', async () => {
    const trace: string[] = [];
    const stages = tracingStages({ trace, withEncryptor: true });

    await runPipeline(bytes(1, 2, 3, 4), stages, { tier: 'sensitive', mimeType: JPEG });

    expect(stages.sawBytes['encrypt']).toEqual(bytes(1, 2));
  });

  it('honours a custom long edge and thumbnail sizes', async () => {
    const trace: string[] = [];
    await runPipeline(bytes(1, 2, 3, 4), tracingStages({ trace }), {
      tier: 'private',
      mimeType: JPEG,
      longEdge: 1024,
      thumbnailSizes: [64],
    });

    expect(trace).toContain('compress:1024');
    expect(trace).toContain('thumbnails:64');
  });
});

/* =========================================================================
 * Outputs
 * ====================================================================== */

describe('upload lifecycle — outputs', () => {
  it('reports the byte size of what will be stored', async () => {
    const trace: string[] = [];
    const result = await runPipeline(
      bytes(1, 2, 3, 4),
      tracingStages({ trace, withEncryptor: true }),
      { tier: 'sensitive', mimeType: JPEG },
    );
    if (isErr(result)) throw new Error('expected ok');

    // Ciphertext length, not plaintext: 2 compressed bytes + 4 of nonce/tag. The
    // row's `byteSize` has to match the object or the integrity sweep flags it.
    expect(result.value.bytes.byteLength).toBe(6);
    expect(result.value.metadata.byteSize).toBe(6);
  });

  it('reports the post-compression mime type', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2, 3, 4), tracingStages({ trace }), {
      tier: 'private',
      mimeType: JPEG,
    });
    if (isErr(result)) throw new Error('expected ok');

    // The extractor reported image/jpeg; the compressor produced webp. Storing the
    // input type would make every signed URL serve the wrong Content-Type.
    expect(result.value.metadata.mimeType).toBe('image/webp');
  });

  it('preserves EXIF capture time and zone', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2), tracingStages({ trace }), {
      tier: 'private',
      mimeType: JPEG,
    });
    if (isErr(result)) throw new Error('expected ok');

    // §5.3: the zone is information that cannot be recovered once discarded.
    expect(result.value.metadata.capturedAt).toBe('2026-08-03T18:30:00Z');
    expect(result.value.metadata.capturedZone).toBe('Asia/Kolkata');
    expect(result.value.metadata.width).toBe(4032);
  });

  it('carries the capture protocol through untouched', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2), tracingStages({ trace, withEncryptor: true }), {
      tier: 'sensitive',
      mimeType: JPEG,
      protocol: { region: 'face', poseId: 'front', complianceScore: 0.87, medianLuminance: 132 },
    });
    if (isErr(result)) throw new Error('expected ok');

    // §4.2: photos under inconsistent conditions "are not merely lower quality —
    // they are actively misleading". The protocol block is what makes a series
    // comparable, so it must survive the pipeline.
    expect(result.value.protocol?.complianceScore).toBe(0.87);
    expect(result.value.protocol?.region).toBe('face');
  });

  it('marks an encrypted object with its wrapped key and algorithm', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2), tracingStages({ trace, withEncryptor: true }), {
      tier: 'sensitive',
      mimeType: JPEG,
    });
    if (isErr(result)) throw new Error('expected ok');

    // The presence of `wrappedKey` is how everything downstream knows `bytes` is
    // ciphertext and must not be inspected.
    expect(result.value.wrappedKey).toBe('wrapped:dek');
    expect(result.value.encryptionAlgorithm).toBe('AES-256-GCM');
  });

  it('leaves a private-tier object unencrypted with no key', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2), tracingStages({ trace, withEncryptor: true }), {
      tier: 'private',
      mimeType: PDF,
    });
    if (isErr(result)) throw new Error('expected ok');

    // A lab PDF is `private`, and the server is allowed to read it — that is what
    // makes §4.11's "lab PDF becomes structured lab observations" possible.
    expect(result.value.wrappedKey).toBeUndefined();
    expect(trace).not.toContain('encrypt');
  });
});

/* =========================================================================
 * Non-images
 * ====================================================================== */

describe('non-image objects', () => {
  it('skips compression, thumbnails, and the perceptual hash for a PDF', async () => {
    const trace: string[] = [];
    const result = await runPipeline(
      bytes(1, 2, 3, 4),
      tracingStages({ trace, withPerceptualHash: true }),
      { tier: 'private', mimeType: PDF },
    );
    if (isErr(result)) throw new Error('expected ok');

    // A perceptual hash of a PDF is meaningless, and downscaling one destroys it.
    expect(trace).toEqual(['metadata', 'hash']);
    expect(result.value.thumbnails).toEqual([]);
    expect(result.value.hashes.perceptualHash).toBeUndefined();
  });

  it('recognises the image types §5.5 actually receives', async () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']) {
      const trace: string[] = [];
      await runPipeline(bytes(1, 2), tracingStages({ trace }), { tier: 'private', mimeType });
      // HEIC especially: it is what an iPhone produces by default, and treating it
      // as a non-image would store every photo uncompressed and thumbnail-less.
      expect(trace, `${mimeType} was not treated as an image`).toContain('compress:2048');
    }
  });

  it('skips stages that are not configured', async () => {
    const trace: string[] = [];
    const result = await runPipeline(
      bytes(1, 2, 3, 4),
      tracingStages({ trace, withCompressor: false, withThumbnailer: false }),
      { tier: 'private', mimeType: JPEG },
    );
    if (isErr(result)) throw new Error('expected ok');

    // The same pipeline runs in a browser and on a server with different stages
    // wired. An unconfigured optional stage is skipped, not an error.
    expect(trace).toEqual(['metadata', 'hash']);
    expect(result.value.bytes).toEqual(bytes(1, 2, 3, 4));
  });
});

/* =========================================================================
 * Refusals
 * ====================================================================== */

describe('refusals', () => {
  it('refuses sensitive-tier media with no encryptor configured', async () => {
    const trace: string[] = [];
    const result = await runPipeline(bytes(1, 2), tracingStages({ trace }), {
      tier: 'sensitive',
      mimeType: JPEG,
    });

    // The most important assertion in this file. Storing plaintext because the
    // encryptor was not wired is exactly the outcome P7 says the architecture must
    // make impossible rather than merely prohibited.
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('precondition_failed');
      expect(result.error.code).toBe('encryptor_missing');
      expect(result.error.message).toContain('Refusing to store plaintext');
    }
  });

  it('refuses an empty file', async () => {
    const trace: string[] = [];
    const result = await runPipeline(new Uint8Array(0), tracingStages({ trace }), {
      tier: 'private',
      mimeType: JPEG,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe('media_empty');
    // Rejected before any stage ran.
    expect(trace).toEqual([]);
  });

  it('refuses an oversized file before decoding it', async () => {
    const trace: string[] = [];
    const result = await runPipeline(new Uint8Array(MAX_OBJECT_BYTES + 1), tracingStages({ trace }), {
      tier: 'private',
      mimeType: JPEG,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('media_too_large');
      // The message states both numbers, because "too large" with no limit is a
      // dead end for the user.
      expect(result.error.message).toContain('25 MB');
    }
    expect(trace).toEqual([]);
  });

  it('accepts a file exactly at the limit', async () => {
    const trace: string[] = [];
    const result = await runPipeline(
      new Uint8Array(MAX_OBJECT_BYTES),
      tracingStages({ trace, withCompressor: false, withThumbnailer: false }),
      { tier: 'private', mimeType: JPEG },
    );
    expect(isOk(result)).toBe(true);
  });

  it('propagates a stage failure instead of storing a partial object', async () => {
    for (const failAt of ['metadata', 'compress', 'thumbnail', 'encrypt'] as const) {
      const trace: string[] = [];
      const result = await runPipeline(
        bytes(1, 2, 3, 4),
        tracingStages({ trace, withEncryptor: true, failAt }),
        { tier: 'sensitive', mimeType: JPEG },
      );

      expect(isErr(result), `failure at ${failAt} was swallowed`).toBe(true);
    }
  });
});

/* =========================================================================
 * Duplicate detection
 * ====================================================================== */

describe('hammingDistance', () => {
  it('is zero for identical hashes', () => {
    expect(hammingDistance('ffff0000', 'ffff0000')).toBe(0);
  });

  it('counts differing bits, not differing characters', () => {
    // 0x0 vs 0x1 is one bit; 0x0 vs 0xf is four. A character-wise comparison would
    // score both as 1 and make the threshold meaningless.
    expect(hammingDistance('0', '1')).toBe(1);
    expect(hammingDistance('0', 'f')).toBe(4);
    expect(hammingDistance('00', 'ff')).toBe(8);
  });

  it('is symmetric', () => {
    expect(hammingDistance('a1b2', '3c4d')).toBe(hammingDistance('3c4d', 'a1b2'));
  });

  it('returns null for hashes of different lengths', () => {
    // Incomparable, not "very different". Returning a large number would let a
    // truncated hash silently count as unique.
    expect(hammingDistance('ffff', 'ff')).toBeNull();
  });

  it('returns null for a non-hex character', () => {
    expect(hammingDistance('zzzz', 'ffff')).toBeNull();
  });

  it('is case-insensitive, because hex is', () => {
    expect(hammingDistance('ABCD', 'abcd')).toBe(0);
  });
});

describe('classifyDuplicate', () => {
  const candidate = (overrides: Partial<DedupeCandidate> = {}): DedupeCandidate => ({
    mediaObjectId: 'mo-1',
    contentHash: 'sha256:aaa',
    perceptualHash: 'ffff0000',
    ...overrides,
  });

  it('reports unique against no candidates', () => {
    expect(classifyDuplicate({ contentHash: 'sha256:new' }, [])).toEqual({ kind: 'unique' });
  });

  it('reports an exact match on the content hash', () => {
    const verdict = classifyDuplicate({ contentHash: 'sha256:aaa' }, [candidate()]);
    expect(verdict).toEqual({ kind: 'exact', existingMediaObjectId: 'mo-1' });
  });

  it('prefers an exact match over a near one', () => {
    const verdict = classifyDuplicate(
      { contentHash: 'sha256:aaa', perceptualHash: 'ffff0001' },
      [candidate({ mediaObjectId: 'near', contentHash: 'sha256:other', perceptualHash: 'ffff0000' }), candidate({ mediaObjectId: 'exact' })],
    );

    expect(verdict.kind).toBe('exact');
    if (verdict.kind === 'exact') expect(verdict.existingMediaObjectId).toBe('exact');
  });

  it('reports a near match for a re-encoded image', () => {
    // The case the perceptual hash exists for: the same photo saved by a different
    // app has a different SHA-256 and nearly the same perceptual hash.
    const verdict = classifyDuplicate(
      { contentHash: 'sha256:reencoded', perceptualHash: 'ffff0001' },
      [candidate({ contentHash: 'sha256:original' })],
    );

    expect(verdict).toEqual({ kind: 'near', existingMediaObjectId: 'mo-1', distance: 1 });
  });

  it('treats the threshold as inclusive and stops one bit past it', () => {
    const at = classifyDuplicate(
      { contentHash: 'sha256:x', perceptualHash: 'fffff000' },
      [candidate({ contentHash: 'sha256:y', perceptualHash: 'ffff0000' })],
    );
    // 0xf vs 0x0 in one nibble = 4 bits, within the threshold of 5.
    expect(at.kind).toBe('near');

    const past = classifyDuplicate(
      { contentHash: 'sha256:x', perceptualHash: 'fffff800' },
      [candidate({ contentHash: 'sha256:y', perceptualHash: 'ffff0000' })],
    );
    // 4 + 1 = 5 bits... one more takes it to 6.
    expect(hammingDistance('fffff800', 'ffff0000')).toBe(5);
    expect(past.kind).toBe('near');

    const beyond = classifyDuplicate(
      { contentHash: 'sha256:x', perceptualHash: 'fffff900' },
      [candidate({ contentHash: 'sha256:y', perceptualHash: 'ffff0000' })],
    );
    expect(hammingDistance('fffff900', 'ffff0000')).toBe(6);
    expect(beyond.kind).toBe('unique');
  });

  it('keeps the threshold conservative', () => {
    // §4.2's photo series is *supposed* to contain near-identical photos taken
    // weeks apart under an alignment overlay. A false "duplicate" costs a data
    // point in a longitudinal series; a false "unique" costs a wasted object.
    expect(PERCEPTUAL_DUPLICATE_THRESHOLD).toBeLessThanOrEqual(8);
  });

  it('picks the closest candidate when several are near', () => {
    const verdict = classifyDuplicate(
      { contentHash: 'sha256:x', perceptualHash: 'ffff0000' },
      [
        candidate({ mediaObjectId: 'far', contentHash: 'a', perceptualHash: 'ffff0007' }),
        candidate({ mediaObjectId: 'close', contentHash: 'b', perceptualHash: 'ffff0001' }),
      ],
    );

    if (verdict.kind !== 'near') throw new Error('expected near');
    expect(verdict.existingMediaObjectId).toBe('close');
    expect(verdict.distance).toBe(1);
  });

  it('ignores candidates with no perceptual hash', () => {
    // A PDF alongside a photo. `exactOptionalPropertyTypes` is why this is built
    // literally rather than overriding with `undefined`: an absent field and a
    // field set to undefined are different types in this repo, and the dedupe
    // check must treat only the former as "cannot compare".
    const verdict = classifyDuplicate({ contentHash: 'sha256:x', perceptualHash: 'ffff0000' }, [
      { mediaObjectId: 'mo-pdf', contentHash: 'sha256:y' },
    ]);
    expect(verdict.kind).toBe('unique');
  });

  it('reports unique when the new object has no perceptual hash', () => {
    // A PDF. Exact matching still applies; near matching cannot.
    const verdict = classifyDuplicate({ contentHash: 'sha256:x' }, [candidate({ contentHash: 'sha256:y' })]);
    expect(verdict.kind).toBe('unique');
  });

  it('ignores an incomparable hash rather than treating it as distant', () => {
    const verdict = classifyDuplicate({ contentHash: 'sha256:x', perceptualHash: 'ffff' }, [
      candidate({ contentHash: 'sha256:y', perceptualHash: 'ffff0000' }),
    ]);
    expect(verdict.kind).toBe('unique');
  });
});

/* =========================================================================
 * Storage tiers
 * ====================================================================== */

describe('storage tiers', () => {
  it('gives the sensitive tier a longer signed-URL life than the private tier', () => {
    // Looks backwards and is not: the sensitive object is ciphertext, useless
    // without the passphrase-derived key, and a client decrypting a 12 MB photo on
    // a slow connection needs more than sixty seconds to finish the fetch.
    expect(urlTtlForTier('sensitive')).toBe(SENSITIVE_URL_TTL_SECONDS);
    expect(urlTtlForTier('private')).toBe(PRIVATE_URL_TTL_SECONDS);
    expect(urlTtlForTier('sensitive')).toBeGreaterThan(urlTtlForTier('private'));
  });

  it('caps the private tier at the sixty seconds §5.5 specifies', () => {
    // The URL is a bearer credential: anyone holding it can read the object, and
    // one pasted into a chat outlives the intent behind it.
    expect(PRIVATE_URL_TTL_SECONDS).toBe(60);
  });

  it('is total over the tiers', () => {
    for (const tier of ['public', 'private', 'sensitive'] as const) {
      expect(urlTtlForTier(tier)).toBeGreaterThan(0);
    }
  });

  it('puts each tier in its own bucket', () => {
    const buckets = Object.values(BUCKET_FOR_TIER);
    // Separate buckets so a policy mistake cannot span tiers — a wrong public-read
    // rule on one bucket must not expose skin photos.
    expect(new Set(buckets).size).toBe(buckets.length);
  });
});
