/**
 * Storage abstraction.
 *
 * §5.5 defines three tiers by sensitivity and §5.4 explains why the provider
 * sits behind a port: Supabase is used as "hosted Postgres with auth and
 * storage", so "migrating to any other Postgres host becomes a connection-string
 * change plus an auth swap, rather than a rewrite." The same has to be true of
 * object storage, or the media library welds the application to one vendor.
 *
 * Exactly one file implements this against Supabase. S3 compatibility is a second
 * adapter, not a refactor.
 */

import type { Result } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';

/**
 * Sensitivity tier (§5.5).
 *
 * | Tier | Contents | Treatment |
 * |---|---|---|
 * | `public` | App assets, icons | CDN, cacheable |
 * | `private` | Documents, receipts, non-body imagery | Private bucket, short-lived signed URLs, server-mediated |
 * | `sensitive` | Skin photos, physique photos, medical imaging, journal attachments | **Client-side encrypted before upload** |
 *
 * The `sensitive` tier is the one that constrains the design: §5.5 says "the
 * storage provider holds ciphertext it cannot read", which means the server
 * cannot generate thumbnails, cannot run OCR, and cannot inspect dimensions.
 * Every one of those has to happen client-side at capture, and the pipeline is
 * shaped around that rather than treating it as an exception.
 */
export type StorageTier = 'public' | 'private' | 'sensitive';

/** A location in a bucket. Opaque to callers. */
export type StorageKey = string;

export type UploadRequest = {
  readonly key: StorageKey;
  readonly tier: StorageTier;
  readonly contentType: string;
  readonly body: Uint8Array;
  /**
   * Fail if an object already exists at this key.
   *
   * Default true. Media keys are content-addressed (see `keys.ts`), so a
   * collision means either a genuine duplicate — which the dedupe check should
   * already have caught — or a key-generation bug. Overwriting silently would
   * destroy the original in either case.
   */
  readonly failIfExists?: boolean;
};

export type UploadResult = {
  readonly key: StorageKey;
  readonly byteSize: number;
  /** Provider's own integrity tag, where it exposes one. */
  readonly etag?: string;
};

/**
 * A time-limited download URL.
 *
 * §5.5 caps these at 60 seconds for the private tier. Short because the URL is
 * a bearer credential: anyone holding it can read the object, and a URL pasted
 * into a chat or captured in a screenshot outlives the intent behind it.
 */
export type SignedUrl = {
  readonly url: string;
  readonly expiresAt: string;
};

export type StorageProvider = {
  /** Provider name, for logs and for the migration audit. */
  readonly name: string;

  upload(request: UploadRequest): Promise<Result<UploadResult, DomainError>>;

  /**
   * Read an object back.
   *
   * Used by the nightly integrity check (§9.8: "every storage object has a row
   * and every row has an object") and by export (§9.10). Not used to serve
   * media — that is what signed URLs are for.
   */
  download(key: StorageKey): Promise<Result<Uint8Array, DomainError>>;

  /** Whether an object exists. Cheaper than a download for the integrity sweep. */
  exists(key: StorageKey): Promise<Result<boolean, DomainError>>;

  createSignedUrl(
    key: StorageKey,
    options: { readonly expiresInSeconds: number },
  ): Promise<Result<SignedUrl, DomainError>>;

  /**
   * Remove an object.
   *
   * **Not part of ordinary deletion.** §9.4: "Nothing is hard-deleted. Deletion
   * sets a deleted-at timestamp and a reason." A deleted photo keeps its bytes so
   * the undo toast (§8.12) can actually undo. This exists for the explicit,
   * audited purge path and for cleaning up a failed upload.
   */
  remove(key: StorageKey): Promise<Result<void, DomainError>>;
};

/** Maximum signed-URL lifetime for the private tier (§5.5). */
export const PRIVATE_URL_TTL_SECONDS = 60;

/**
 * Signed-URL lifetime for the sensitive tier.
 *
 * Longer than private, which looks backwards and is not: the object is
 * ciphertext. The URL grants access to bytes that are useless without the
 * passphrase-derived key, and a client decrypting a 12 MB photo on a slow
 * connection needs more than sixty seconds to finish the fetch.
 */
export const SENSITIVE_URL_TTL_SECONDS = 300;

export function urlTtlForTier(tier: StorageTier): number {
  switch (tier) {
    case 'sensitive':
      return SENSITIVE_URL_TTL_SECONDS;
    case 'private':
      return PRIVATE_URL_TTL_SECONDS;
    case 'public':
      // Public objects are served from a CDN and never signed. Returning a TTL
      // rather than throwing keeps the function total; callers should not be
      // signing these at all.
      return PRIVATE_URL_TTL_SECONDS;
  }
}

/** Bucket per tier. Separate buckets so a policy mistake cannot span tiers. */
export const BUCKET_FOR_TIER: Readonly<Record<StorageTier, string>> = Object.freeze({
  public: 'public-assets',
  private: 'private-documents',
  sensitive: 'sensitive-media',
});
