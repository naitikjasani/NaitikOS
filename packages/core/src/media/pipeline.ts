/**
 * The media pipeline.
 *
 * §5.5 specifies the stages:
 *
 *   "capture → client-side EXIF normalisation and orientation fix → downscale to
 *    a fixed long-edge → derive a perceptual hash for duplicate detection →
 *    encrypt → upload → store the metadata row with dimensions, capture time,
 *    zone, protocol-compliance flags, and the wrapped key."
 *
 * ## The stage order is a security property, not a preference
 *
 * **Encryption is second-to-last, and everything that needs to read the pixels
 * happens before it.** Once a sensitive object is encrypted the server holds
 * ciphertext it cannot read (§5.5), so thumbnailing, hashing, and dimension
 * extraction are all client-side at capture or they are impossible.
 *
 * That is why this file is pure and lives in `core`: the same pipeline runs in
 * the browser for a skin photo and on the server for a lab PDF, and the only
 * difference is which stages are configured. A pipeline that assumed a server
 * would rewrite every skin photo.
 *
 * ## Hooks that are hooks, not stubs
 *
 * OCR (§9.9) and AI vision (§4.2's future lesion counting) are declared as
 * optional stages with real types. Neither is implemented — §10 is V2 and there
 * is no AI in this milestone. Declaring the shape now means adding them later is
 * an implementation rather than a pipeline redesign.
 */

import type { Result } from '@naitikos/shared';
import { err, isErr, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { preconditionFailedError, validationError } from '../errors/domain-error';
import type { StorageTier } from './storage';

/* =========================================================================
 * Metadata
 * ====================================================================== */

/**
 * What the pipeline knows about an object.
 *
 * Mirrors §9.8's `media_object` columns. Notably absent: anything derived from
 * pixel content beyond dimensions and hashes, because for the sensitive tier
 * that is all the server will ever legitimately have.
 */
export type MediaMetadata = {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width?: number;
  readonly height?: number;
  /** When the camera captured it, from EXIF where available. */
  readonly capturedAt?: string;
  /** IANA zone of capture (§5.3). Never an offset. */
  readonly capturedZone?: string;
  readonly deviceIdentity?: string;
};

/**
 * Content hashes.
 *
 * Two, doing different jobs — conflating them is a real bug:
 *
 * - `contentHash` (SHA-256) is for **integrity**. Exact. Detects a byte that
 *   changed in storage, and is what §9.8's nightly integrity check compares.
 * - `perceptualHash` is for **deduplication**. Approximate. Detects the same
 *   photo re-encoded, resized, or re-saved by a different app.
 *
 * A perceptual hash cannot verify integrity, and a SHA-256 cannot spot a
 * re-encode. §5.5 asks for the perceptual hash specifically for duplicate
 * detection.
 */
export type MediaHashes = {
  readonly contentHash: string;
  readonly perceptualHash?: string;
};

/**
 * §9.8's capture protocol block, for governed photography.
 *
 * §4.2 is blunt about why this exists: photographs under inconsistent conditions
 * "are not merely lower quality — they are *actively misleading*, because
 * apparent change is dominated by capture variance rather than skin change."
 */
export type CaptureProtocol = {
  readonly region?: string;
  readonly poseId?: string;
  readonly distance?: string;
  readonly lighting?: string;
  readonly flash?: string;
  readonly timeBucket?: string;
  /** Previous photo in the series, for the ghost-overlay alignment. */
  readonly alignmentReferenceId?: string;
  /** Median luminance of the fixed reference region, for the lighting check. */
  readonly medianLuminance?: number;
  /** 0–1. Below threshold, excluded from comparison views by default (§9.8). */
  readonly complianceScore?: number;
};

/* =========================================================================
 * Stage ports
 * ====================================================================== */

export type Thumbnail = {
  readonly longEdge: number;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
};

/**
 * A processed, ready-to-store object.
 *
 * `bytes` is ciphertext when `wrappedKey` is present. Nothing downstream should
 * inspect it in that case, and the presence of the wrapped key is how it knows.
 */
export type ProcessedMedia = {
  readonly bytes: Uint8Array;
  readonly metadata: MediaMetadata;
  readonly hashes: MediaHashes;
  /** Encrypted alongside the object, for the sensitive tier (§5.5). */
  readonly thumbnails: readonly Thumbnail[];
  readonly protocol?: CaptureProtocol;
  /** AES-256-GCM data key, wrapped with the passphrase-derived master key. */
  readonly wrappedKey?: string;
  readonly encryptionAlgorithm?: string;
};

/** Reads EXIF, fixes orientation, and reports dimensions. */
export type MetadataExtractor = {
  extract(bytes: Uint8Array, mimeType: string): Promise<Result<MediaMetadata, DomainError>>;
};

export type Hasher = {
  contentHash(bytes: Uint8Array): Promise<string>;
  /** Absent for non-images — a perceptual hash of a PDF is meaningless. */
  perceptualHash?(bytes: Uint8Array, mimeType: string): Promise<string | undefined>;
};

/** Downscales to the configured long edge (§5.5). */
export type Compressor = {
  compress(
    bytes: Uint8Array,
    mimeType: string,
    options: { readonly longEdge: number },
  ): Promise<Result<{ bytes: Uint8Array; mimeType: string }, DomainError>>;
};

export type Thumbnailer = {
  generate(
    bytes: Uint8Array,
    mimeType: string,
    sizes: readonly number[],
  ): Promise<Result<readonly Thumbnail[], DomainError>>;
};

/**
 * Envelope encryption (§5.5).
 *
 * A port because the master key is derived from the user's passphrase via
 * Argon2id and "is held in memory for the session and never transmitted" — so
 * the implementation only exists in the browser, and `core` must not assume
 * otherwise.
 */
export type Encryptor = {
  encrypt(
    bytes: Uint8Array,
  ): Promise<Result<{ bytes: Uint8Array; wrappedKey: string; algorithm: string }, DomainError>>;
};

/**
 * OCR hook (§9.9). Not implemented.
 *
 * When it lands it runs **before** encryption for the sensitive tier and
 * server-side for the private tier — a lab PDF is `private`, so the server may
 * read it, which is what makes §4.11's "lab PDF becomes structured lab
 * observations" possible at all.
 */
export type TextExtractor = {
  extractText(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<Result<{ text: string; confidence: number }, DomainError>>;
};

/**
 * AI vision hook (§4.2's future lesion counting). Not implemented.
 *
 * §4.2 constrains it before it exists: "automated lesion counting on
 * standardised photos (**deterministic CV, computed locally, never a generative
 * model**)". The port is declared so that constraint is recorded next to the
 * type rather than discovered later.
 */
export type VisionAnalyser = {
  analyse(
    bytes: Uint8Array,
    protocol: CaptureProtocol,
  ): Promise<Result<Record<string, number>, DomainError>>;
};

/* =========================================================================
 * The pipeline
 * ====================================================================== */

export type PipelineStages = {
  readonly metadata: MetadataExtractor;
  readonly hasher: Hasher;
  readonly compressor?: Compressor;
  readonly thumbnailer?: Thumbnailer;
  readonly encryptor?: Encryptor;
  /** Declared, unused. See the type. */
  readonly textExtractor?: TextExtractor;
  readonly vision?: VisionAnalyser;
};

export type PipelineOptions = {
  readonly tier: StorageTier;
  readonly mimeType: string;
  /** §5.5's "downscale to a fixed long-edge". */
  readonly longEdge?: number;
  readonly thumbnailSizes?: readonly number[];
  readonly protocol?: CaptureProtocol;
};

/** §5.5's fixed long edge for governed photography. */
export const DEFAULT_LONG_EDGE = 2048;

/** Thumbnail sizes: a list row and a grid cell. */
export const DEFAULT_THUMBNAIL_SIZES: readonly number[] = Object.freeze([128, 512]);

/**
 * 25 MB.
 *
 * Generous for a photo and tight for a video, which is deliberate — §5.5 lists
 * video as future, and a 500 MB upload on a phone in a gym basement (§5.7) would
 * sit in the outbox for hours and fail. Raising this needs the resumable upload
 * path, not just a bigger number.
 */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME = /^image\/(jpeg|png|webp|heic|heif|avif)$/i;

/**
 * Run the pipeline.
 *
 * Stage order, and why each is where it is:
 *
 *   1. **Size guard.** Before any work, so a 200 MB file is rejected without
 *      being decoded.
 *   2. **Metadata + orientation.** Must precede compression: EXIF orientation is
 *      commonly stripped by a re-encode, and a rotated photo silently becomes
 *      permanently sideways.
 *   3. **Compress.** Images only.
 *   4. **Thumbnails.** From the *compressed* bytes, so they inherit the
 *      orientation fix.
 *   5. **Hash.** After compression, so the hash identifies what is actually
 *      stored. Hashing the original would mean the integrity check compares a
 *      digest against bytes that never existed in the bucket.
 *   6. **Encrypt.** Last. Everything above needs readable pixels.
 */
export async function runPipeline(
  bytes: Uint8Array,
  stages: PipelineStages,
  options: PipelineOptions,
): Promise<Result<ProcessedMedia, DomainError>> {
  /* --- 1. Size ------------------------------------------------------- */
  if (bytes.byteLength === 0) {
    return err(validationError('media_empty', 'The file is empty.'));
  }
  if (bytes.byteLength > MAX_OBJECT_BYTES) {
    return err(
      validationError(
        'media_too_large',
        `File is ${String(Math.round(bytes.byteLength / 1_048_576))} MB; the limit is ${String(MAX_OBJECT_BYTES / 1_048_576)} MB.`,
      ),
    );
  }

  const isImage = IMAGE_MIME.test(options.mimeType);

  /* --- 2. Metadata --------------------------------------------------- */
  const metadataResult = await stages.metadata.extract(bytes, options.mimeType);
  if (isErr(metadataResult)) return metadataResult;
  const metadata = metadataResult.value;

  /* --- 3. Compress --------------------------------------------------- */
  let working = bytes;
  let workingMime = options.mimeType;

  if (isImage && stages.compressor !== undefined) {
    const compressed = await stages.compressor.compress(working, workingMime, {
      longEdge: options.longEdge ?? DEFAULT_LONG_EDGE,
    });
    if (isErr(compressed)) return compressed;
    working = compressed.value.bytes;
    workingMime = compressed.value.mimeType;
  }

  /* --- 4. Thumbnails ------------------------------------------------- */
  let thumbnails: readonly Thumbnail[] = [];
  if (isImage && stages.thumbnailer !== undefined) {
    const generated = await stages.thumbnailer.generate(
      working,
      workingMime,
      options.thumbnailSizes ?? DEFAULT_THUMBNAIL_SIZES,
    );
    if (isErr(generated)) return generated;
    thumbnails = generated.value;
  }

  /* --- 5. Hash ------------------------------------------------------- */
  const contentHash = await stages.hasher.contentHash(working);
  const perceptualHash =
    isImage && stages.hasher.perceptualHash !== undefined
      ? await stages.hasher.perceptualHash(working, workingMime)
      : undefined;

  /* --- 6. Encrypt ---------------------------------------------------- */
  let finalBytes = working;
  let wrappedKey: string | undefined;
  let encryptionAlgorithm: string | undefined;

  if (options.tier === 'sensitive') {
    if (stages.encryptor === undefined) {
      /**
       * Refuse rather than degrade.
       *
       * §5.5 puts skin and physique photos in this tier and requires that "the
       * storage provider holds ciphertext it cannot read". Storing plaintext
       * because the encryptor was not wired would silently produce exactly the
       * outcome P7 says the architecture must make *impossible* rather than
       * prohibited.
       */
      return err(
        preconditionFailedError(
          'encryptor_configured',
          'Sensitive-tier media requires an encryptor. Refusing to store plaintext (§5.5).',
          'encryptor_missing',
        ),
      );
    }

    const encrypted = await stages.encryptor.encrypt(working);
    if (isErr(encrypted)) return encrypted;
    finalBytes = encrypted.value.bytes;
    wrappedKey = encrypted.value.wrappedKey;
    encryptionAlgorithm = encrypted.value.algorithm;
  }

  return ok({
    bytes: finalBytes,
    metadata: { ...metadata, mimeType: workingMime, byteSize: finalBytes.byteLength },
    hashes: { contentHash, ...(perceptualHash === undefined ? {} : { perceptualHash }) },
    thumbnails,
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    ...(wrappedKey === undefined ? {} : { wrappedKey }),
    ...(encryptionAlgorithm === undefined ? {} : { encryptionAlgorithm }),
  });
}

/* =========================================================================
 * Deduplication
 * ====================================================================== */

export type DuplicateVerdict =
  | { readonly kind: 'unique' }
  /** Byte-identical to an existing object. */
  | { readonly kind: 'exact'; readonly existingMediaObjectId: string }
  /** Visually the same but re-encoded. Surfaced, never auto-merged. */
  | { readonly kind: 'near'; readonly existingMediaObjectId: string; readonly distance: number };

/**
 * Hamming distance below which two perceptual hashes are the same image.
 *
 * 5 of 64 bits. Chosen conservatively: §4.2's photo series is *supposed* to
 * contain near-identical photos taken weeks apart under an alignment overlay, so
 * a loose threshold would flag genuine progress shots as duplicates and offer to
 * discard them. A false "unique" costs a wasted object; a false "duplicate"
 * costs a data point in a longitudinal series.
 */
export const PERCEPTUAL_DUPLICATE_THRESHOLD = 5;

/** Hamming distance between two hex hashes. `null` if incomparable. */
export function hammingDistance(a: string, b: string): number | null {
  if (a.length !== b.length) return null;

  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = Number.parseInt(a[i] as string, 16);
    const right = Number.parseInt(b[i] as string, 16);
    if (Number.isNaN(left) || Number.isNaN(right)) return null;

    let xor = left ^ right;
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

/** An existing object to compare against. */
export type DedupeCandidate = {
  readonly mediaObjectId: string;
  readonly contentHash: string;
  readonly perceptualHash?: string;
};

/**
 * Classify a new object against existing ones.
 *
 * Exact match wins over near match, and both are *reported* rather than acted
 * on. §9.4's "nothing is hard-deleted" means the caller decides — and for a
 * progress photo the right answer is usually to keep both and let the user
 * choose, because the alternative is silently dropping a photo they took
 * deliberately.
 */
export function classifyDuplicate(
  hashes: MediaHashes,
  candidates: readonly DedupeCandidate[],
): DuplicateVerdict {
  for (const candidate of candidates) {
    if (candidate.contentHash === hashes.contentHash) {
      return { kind: 'exact', existingMediaObjectId: candidate.mediaObjectId };
    }
  }

  if (hashes.perceptualHash !== undefined) {
    let closest: { id: string; distance: number } | null = null;

    for (const candidate of candidates) {
      if (candidate.perceptualHash === undefined) continue;
      const distance = hammingDistance(hashes.perceptualHash, candidate.perceptualHash);
      if (distance === null) continue;
      if (distance <= PERCEPTUAL_DUPLICATE_THRESHOLD && (closest === null || distance < closest.distance)) {
        closest = { id: candidate.mediaObjectId, distance };
      }
    }

    if (closest !== null) {
      return { kind: 'near', existingMediaObjectId: closest.id, distance: closest.distance };
    }
  }

  return { kind: 'unique' };
}
