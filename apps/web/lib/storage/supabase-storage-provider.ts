/**
 * `StorageProvider` against Supabase Storage.
 *
 * The only file in the repo that knows object storage is Supabase. §5.4's
 * migration promise — "migrating to any other Postgres host becomes a
 * connection-string change plus an auth swap, rather than a rewrite" — has to
 * hold for the bucket layer too, or the media library welds the application to
 * one vendor. An S3 adapter is a second file implementing the same port, not a
 * refactor of this one.
 *
 * ## Why the service-role key
 *
 * §5.4 forbids client-direct-to-database access and the same argument applies to
 * buckets: every read and write here is server-mediated, so the browser never
 * holds a storage credential and never talks to the bucket except through a
 * signed URL this file minted.
 *
 * That means the alternative — anon key plus Supabase Storage RLS policies — buys
 * nothing and costs a policy surface. §5.4's stance on database RLS is the same
 * one: "RLS is enabled on every table with **zero policies**", because the
 * application is the authorization boundary and a provider policy is a second
 * place for that decision to live and disagree.
 *
 * The consequence is stated rather than assumed: **this module must never be
 * imported from a client component.** `server-only` enforces it at build time,
 * which is the only enforcement that survives a refactor.
 *
 * ## What is in the bucket
 *
 * For the sensitive tier, ciphertext. §5.5: "the storage provider holds
 * ciphertext it cannot read." Nothing in this file decrypts, thumbnails, or
 * inspects an object — the pipeline in `@naitikos/core` did all of that before
 * the bytes arrived, client-side. This adapter moves opaque bytes.
 */

import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  Clock,
  DomainError,
  SignedUrl,
  StorageKey,
  StorageProvider,
  StorageTier,
  UploadRequest,
  UploadResult,
} from '@naitikos/core';
import {
  BUCKET_FOR_TIER,
  conflictError,
  isoAfterSeconds,
  notFoundError,
  preconditionFailedError,
  systemClock,
  tierFromKey,
} from '@naitikos/core';

import { clientEnv, serverEnv } from '../env';

/**
 * `sensitive/2026/08/ab/cd/<hash>.jpg` → bucket + path within it.
 *
 * The tier comes from the key's own prefix (`tierFromKey`, alongside
 * `buildStorageKey` in `core`), not from a parameter. Threading the tier through
 * every call means a caller eventually passes the wrong one and reads a sensitive
 * object out of the private bucket — a cross-tier access no policy would catch,
 * because both buckets are ours.
 */
function locate(key: StorageKey): Result<{ bucket: string; path: string }, DomainError> {
  const tier: StorageTier | null = tierFromKey(key);
  if (tier === null) {
    return err(
      preconditionFailedError(
        'storage_key_tiered',
        `Storage key "${key}" does not start with a tier. Keys are built by buildStorageKey, which always prefixes one.`,
        'untiered_key',
      ),
    );
  }

  const path = key.slice(tier.length + 1);
  if (path === '') {
    return err(
      preconditionFailedError('storage_key_tiered', `Storage key "${key}" has no path.`, 'empty_key'),
    );
  }

  return ok({ bucket: BUCKET_FOR_TIER[tier], path });
}

/**
 * Map a Supabase storage error onto a `DomainError`.
 *
 * The SDK reports failures as loosely-typed objects with a `message` and
 * sometimes a numeric `statusCode`, so this is string matching — unpleasant, and
 * unavoidable without pinning behaviour the SDK does not document. The important
 * part is that "not found" and "already exists" become *distinguishable*, because
 * the callers of `upload` and `download` respond to them completely differently.
 */
function toDomainError(
  operation: string,
  key: StorageKey,
  // `| undefined` on each member, not just optional: the SDK's `StorageError`
  // declares `statusCode?: string | undefined`, and under
  // `exactOptionalPropertyTypes` an optional property is not the same type as one
  // that may hold `undefined`.
  cause: { message?: string | undefined; statusCode?: string | number | undefined } | null,
): DomainError {
  const message = cause?.message ?? 'Unknown storage error.';
  const status = String(cause?.statusCode ?? '');
  const lowered = message.toLowerCase();

  if (status === '404' || lowered.includes('not found') || lowered.includes('does not exist')) {
    return notFoundError('media_object', key);
  }

  if (status === '409' || lowered.includes('already exists') || lowered.includes('duplicate')) {
    return conflictError('media_object', 'duplicate', {
      code: 'storage_object_exists',
      message: `An object already exists at "${key}".`,
    });
  }

  return conflictError('media_object', 'invalid_state', {
    // Developer-facing. §5.13 — the message is the provider's, never user content,
    // and an object key is an identifier rather than a value.
    code: `storage_${operation}_failed`,
    message: `Storage ${operation} failed for "${key}": ${message}`,
  });
}

export type SupabaseStorageOptions = {
  /**
   * Overrides the module-level client. For tests, and for a future job runner
   * that constructs its own.
   */
  readonly client?: SupabaseClient;
  readonly clock?: Clock;
};

/**
 * Build the provider.
 *
 * A factory rather than a module-level singleton, matching every repository in
 * `packages/db` and for the same reason: a serverless invocation must not inherit
 * another request's client.
 */
export function createSupabaseStorageProvider(
  options: SupabaseStorageOptions = {},
): StorageProvider {
  const clock = options.clock ?? systemClock;

  const client =
    options.client ??
    (() => {
      const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();

      if (SUPABASE_SERVICE_ROLE_KEY === undefined) {
        /**
         * Fail at construction, not at first upload.
         *
         * The failure mode this avoids: the app boots, the user takes a progress
         * photo, the pipeline encrypts it, and *then* the upload fails — so the
         * plaintext is gone from the capture screen and the ciphertext went
         * nowhere. §5.12 says failure never loses user input; the cheapest way to
         * honour that is to not start.
         */
        throw new Error(
          'SUPABASE_SERVICE_ROLE_KEY is required for storage. Media access is entirely ' +
            'server-mediated (§5.4), so there is no anon-key path — set the key or do not ' +
            'construct the storage provider.',
        );
      }

      return createClient(clientEnv.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          // No user session on this client. It exists to hold a service credential,
          // and persisting or refreshing a session would be a second auth path
          // alongside the one in `lib/auth`.
          persistSession: false,
          autoRefreshToken: false,
        },
      });
    })();

  return {
    name: 'supabase-storage',

    async upload(request: UploadRequest): Promise<Result<UploadResult, DomainError>> {
      const located = locate(request.key);
      if (!located.ok) return located;

      const { error } = await client.storage.from(located.value.bucket).upload(
        located.value.path,
        // A `Uint8Array` view may be a window onto a larger buffer; `Blob` copies
        // the view's own range. Passing the raw array risks uploading the whole
        // backing buffer, which for a slice of a decoded image is the entire image.
        new Blob([new Uint8Array(request.body)], { type: request.contentType }),
        {
          contentType: request.contentType,
          // Default false: media keys are content-addressed, so a collision means
          // either a genuine duplicate the dedupe check should have caught, or a
          // key-generation bug. Overwriting destroys the original in both cases.
          upsert: request.failIfExists === false,
        },
      );

      if (error !== null) {
        return err(toDomainError('upload', request.key, error));
      }

      return ok({
        key: request.key,
        byteSize: request.body.byteLength,
      });
    },

    async download(key: StorageKey): Promise<Result<Uint8Array, DomainError>> {
      const located = locate(key);
      if (!located.ok) return located;

      const { data, error } = await client.storage.from(located.value.bucket).download(located.value.path);

      if (error !== null || data === null) {
        return err(toDomainError('download', key, error));
      }

      return ok(new Uint8Array(await data.arrayBuffer()));
    },

    async exists(key: StorageKey): Promise<Result<boolean, DomainError>> {
      const located = locate(key);
      if (!located.ok) return located;

      const { bucket, path } = located.value;
      // `list` on the parent prefix with an exact search, rather than a download.
      // §9.8's nightly sweep asserts "every storage object has a row and every row
      // has an object" across the whole library; doing that by downloading would
      // pull every photo the user has ever taken through the server every night.
      const lastSlash = path.lastIndexOf('/');
      const directory = lastSlash === -1 ? '' : path.slice(0, lastSlash);
      const filename = lastSlash === -1 ? path : path.slice(lastSlash + 1);

      const { data, error } = await client.storage
        .from(bucket)
        .list(directory, { limit: 1, search: filename });

      if (error !== null) {
        return err(toDomainError('exists', key, error));
      }

      // `search` is a substring match, so an exact-name check is still required —
      // otherwise `abc.jpg` would report `abc.jpg.thumb` as itself.
      return ok((data ?? []).some((entry) => entry.name === filename));
    },

    async createSignedUrl(
      key: StorageKey,
      urlOptions: { readonly expiresInSeconds: number },
    ): Promise<Result<SignedUrl, DomainError>> {
      const located = locate(key);
      if (!located.ok) return located;

      const { data, error } = await client.storage
        .from(located.value.bucket)
        .createSignedUrl(located.value.path, urlOptions.expiresInSeconds);

      if (error !== null || data === null) {
        return err(toDomainError('sign', key, error));
      }

      return ok({
        url: data.signedUrl,
        /**
         * Computed locally rather than parsed out of the JWT in the URL.
         *
         * The caller needs this to decide when to re-sign, and reading the token's
         * `exp` would mean trusting a claim to tell us when to stop trusting it.
         * A local clock plus the TTL we asked for is both simpler and honest about
         * where the number came from.
         */
        expiresAt: isoAfterSeconds(clock.nowMillis(), urlOptions.expiresInSeconds),
      });
    },

    async remove(key: StorageKey): Promise<Result<void, DomainError>> {
      const located = locate(key);
      if (!located.ok) return located;

      const { error } = await client.storage.from(located.value.bucket).remove([located.value.path]);

      if (error !== null) {
        return err(toDomainError('remove', key, error));
      }

      return ok(undefined);
    },
  };
}
