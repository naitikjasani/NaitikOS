/**
 * The upload outbox — §5.7's durability requirement, for bytes.
 *
 * §5.7 is unusually direct about the stakes:
 *
 *   "**Outbox durability is a hard requirement.** A failed drain must never
 *    silently discard a write. Entries persist until acknowledged; entries that
 *    fail repeatedly surface in a visible 'unsynced' state with a manual retry.
 *    Losing a logged workout because the drain failed quietly would end the
 *    user's trust in the system, and trust is the whole product."
 *
 * So every method here is written so the *absence* of a call leaves the row in a
 * state that is visible rather than lost. There is no path that removes a row —
 * `abandon` sets a reason, matching §9.4's "nothing is hard-deleted."
 *
 * ## The asymmetry worth knowing about
 *
 * This table holds the metadata and the intent; the bytes live in IndexedDB on the
 * device. A row is created on the first successful contact with the server, which
 * means **a photo taken fully offline has no row here until the device reaches the
 * network.** Until then the device's own queue is the only record of it. That is
 * inherent — a 12 MB body in a Postgres row over an unreliable connection defeats
 * the point — and it is why the client-side queue is itself durable. See
 * docs/storage.md.
 */

import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  BodyRegion,
  CaptureDistance,
  CaptureLighting,
  CaptureTimeBucket,
  DomainError,
  FlashState,
  StorageTier,
} from '@naitikos/core';
import { parseInstant } from '@naitikos/core';

import type { Database } from '../client';
import { mediaObject } from '../schema/crosscutting';
import { uploadOutbox } from '../schema/events';

export type OutboxStatus = (typeof uploadOutbox.status.enumValues)[number];

export type OutboxEntry = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly status: OutboxStatus;
  readonly storageKey: string;
  readonly tier: string;
  readonly contentType: string;
  readonly expectedByteSize: number | null;
  readonly expectedContentHash: string | null;
  readonly mediaObjectId: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly lastErrorCode: string | null;
  readonly deviceId: string | null;
  readonly abandonedReason: string | null;
};

function toEntry(row: typeof uploadOutbox.$inferSelect): OutboxEntry {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    storageKey: row.storageKey,
    tier: row.tier,
    contentType: row.contentType,
    expectedByteSize: row.expectedByteSize,
    expectedContentHash: row.expectedContentHash,
    mediaObjectId: row.mediaObjectId,
    attempts: row.attempts,
    createdAt: row.createdAt,
    lastErrorCode: row.lastErrorCode,
    deviceId: row.deviceId,
    abandonedReason: row.abandonedReason,
  };
}

export type EnqueueUploadInput = {
  /** Client-generated. §5.7: "Idempotency keys on every mutation." */
  readonly idempotencyKey: string;
  readonly storageKey: string;
  readonly tier: StorageTier;
  readonly contentType: string;
  readonly expectedByteSize?: number;
  readonly expectedContentHash?: string;
  readonly deviceId?: string;
};

/** §5.16's sync-health reading. */
export type OutboxHealth = {
  readonly pending: number;
  readonly failed: number;
  /**
   * Age of the oldest unfinished entry, in seconds. `null` when the outbox is
   * clear.
   *
   * §5.16: "An outbox entry older than 24 hours is an alert, because it means data
   * the user believes is saved is not."
   */
  readonly oldestAgeSeconds: number | null;
};

export type UploadOutboxRepository = {
  /** Idempotent on `idempotencyKey`. A replayed request returns the same row. */
  enqueue(input: EnqueueUploadInput): Promise<Result<OutboxEntry, DomainError>>;

  byIdempotencyKey(key: string): Promise<OutboxEntry | null>;

  /** Claim entries to upload, oldest first. */
  claimPending(limit: number, now: string): Promise<Result<readonly OutboxEntry[], DomainError>>;

  /** The upload succeeded and the media row exists. */
  markUploaded(id: string, mediaObjectId: string): Promise<Result<void, DomainError>>;

  /** The upload failed. Stays visible; never removed. */
  markFailed(id: string, errorCode: string, now: string): Promise<Result<void, DomainError>>;

  /** Progress 0–1, for a resumable upload's indicator. */
  recordProgress(id: string, progress: number): Promise<Result<void, DomainError>>;

  /** The user gave up. Stops it being an alert without deleting the record. */
  abandon(id: string, reason: string): Promise<Result<void, DomainError>>;

  /** Return a stuck `uploading` entry to `pending`. */
  recoverStale(olderThan: string): Promise<Result<number, DomainError>>;

  /** §5.7's "visible unsynced state with a manual retry". */
  unsynced(limit?: number): Promise<readonly OutboxEntry[]>;

  health(now: string): Promise<OutboxHealth>;
};

/** Entries that are neither finished nor abandoned. The ones that still owe work. */
const UNFINISHED: readonly OutboxStatus[] = ['pending', 'uploading', 'failed'];

export function createUploadOutboxRepository(db: Database): UploadOutboxRepository {
  return {
    async enqueue(input) {
      await db
        .insert(uploadOutbox)
        .values({
          id: crypto.randomUUID(),
          idempotencyKey: input.idempotencyKey,
          storageKey: input.storageKey,
          tier: input.tier,
          contentType: input.contentType,
          ...(input.expectedByteSize === undefined ? {} : { expectedByteSize: input.expectedByteSize }),
          ...(input.expectedContentHash === undefined
            ? {}
            : { expectedContentHash: input.expectedContentHash }),
          ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        })
        // The dedupe. A replayed enqueue must not create a second row, or the
        // drain uploads the same photo twice and §5.16's depth metric double-counts.
        .onConflictDoNothing({ target: uploadOutbox.idempotencyKey });

      const rows = await db
        .select()
        .from(uploadOutbox)
        .where(eq(uploadOutbox.idempotencyKey, input.idempotencyKey))
        .limit(1);

      const row = rows[0];
      if (row === undefined) {
        // Should be unreachable: the insert either created the row or a conflicting
        // one exists. Reaching here means the row was deleted concurrently, which
        // nothing in this codebase does.
        return ok({
          id: '',
          idempotencyKey: input.idempotencyKey,
          status: 'pending' as OutboxStatus,
          storageKey: input.storageKey,
          tier: input.tier,
          contentType: input.contentType,
          expectedByteSize: input.expectedByteSize ?? null,
          expectedContentHash: input.expectedContentHash ?? null,
          mediaObjectId: null,
          attempts: 0,
          createdAt: '',
          lastErrorCode: null,
          deviceId: input.deviceId ?? null,
          abandonedReason: null,
        });
      }

      return ok(toEntry(row));
    },

    async byIdempotencyKey(key) {
      const rows = await db
        .select()
        .from(uploadOutbox)
        .where(eq(uploadOutbox.idempotencyKey, key))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toEntry(row);
    },

    async claimPending(limit, now) {
      // Same one-statement claim as the task table, for the same reason: a manual
      // drain must take different rows from a concurrent one rather than the same.
      const claimed = await db
        .update(uploadOutbox)
        .set({ status: 'uploading', lastAttemptAt: now, updatedAt: sql`now()` })
        .where(
          inArray(
            uploadOutbox.id,
            db
              .select({ id: uploadOutbox.id })
              .from(uploadOutbox)
              // `failed` too: a failed entry is retried, because §5.7 says entries
              // "persist until acknowledged". Only `abandoned` stops.
              .where(
                and(
                  inArray(uploadOutbox.status, ['pending', 'failed']),
                  isNull(uploadOutbox.abandonedReason),
                ),
              )
              .orderBy(asc(uploadOutbox.createdAt))
              .limit(limit)
              .for('update', { skipLocked: true }),
          ),
        )
        .returning();

      return ok(
        claimed
          .map(toEntry)
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)),
      );
    },

    async markUploaded(id, mediaObjectId) {
      await db
        .update(uploadOutbox)
        .set({
          status: 'uploaded',
          mediaObjectId,
          progress: '1',
          // Cleared, so a previously-failed entry that eventually succeeded does not
          // keep showing a stale error in `/settings/developer`.
          lastErrorCode: null,
          updatedAt: sql`now()`,
        })
        .where(eq(uploadOutbox.id, id));
      return ok(undefined);
    },

    async markFailed(id, errorCode, now) {
      await db
        .update(uploadOutbox)
        .set({
          status: 'failed',
          // Incremented in SQL rather than read-then-write: two concurrent drains
          // would otherwise both read 2 and both write 3.
          attempts: sql`${uploadOutbox.attempts} + 1`,
          lastAttemptAt: now,
          lastErrorCode: errorCode,
          updatedAt: sql`now()`,
        })
        .where(eq(uploadOutbox.id, id));

      // Deliberately no attempt cap. §5.7 requires entries to "persist until
      // acknowledged" and surface for manual retry — giving up automatically is
      // what "silently discard a write" looks like from the user's side.
      return ok(undefined);
    },

    async recordProgress(id, progress) {
      const clamped = Math.min(Math.max(progress, 0), 1);
      await db
        .update(uploadOutbox)
        // `numeric` as a string: the driver returns numerics as strings and passing
        // a float here would round-trip through a different type than it reads back.
        .set({ progress: String(clamped), updatedAt: sql`now()` })
        .where(eq(uploadOutbox.id, id));
      return ok(undefined);
    },

    async abandon(id, reason) {
      // §9.4: "Nothing is hard-deleted. Deletion sets a deleted-at timestamp and a
      // reason." The row remains, so the record of an upload the user gave up on
      // still exists — which matters when the same photo appears to be missing from
      // a series six months later.
      await db
        .update(uploadOutbox)
        .set({ status: 'abandoned', abandonedReason: reason, updatedAt: sql`now()` })
        .where(eq(uploadOutbox.id, id));
      return ok(undefined);
    },

    async recoverStale(olderThan) {
      const recovered = await db
        .update(uploadOutbox)
        .set({ status: 'pending', updatedAt: sql`now()` })
        .where(and(eq(uploadOutbox.status, 'uploading'), lte(uploadOutbox.lastAttemptAt, olderThan)))
        .returning({ id: uploadOutbox.id });
      return ok(recovered.length);
    },

    async unsynced(limit = 100) {
      const rows = await db
        .select()
        .from(uploadOutbox)
        .where(and(ne(uploadOutbox.status, 'uploaded'), isNull(uploadOutbox.abandonedReason)))
        .orderBy(asc(uploadOutbox.createdAt))
        .limit(limit);
      return rows.map(toEntry);
    },

    async health(now) {
      const rows = await db
        .select({
          status: uploadOutbox.status,
          count: sql<number>`count(*)::int`,
          oldest: sql<string | null>`min(${uploadOutbox.createdAt})`,
        })
        .from(uploadOutbox)
        .where(and(inArray(uploadOutbox.status, [...UNFINISHED]), isNull(uploadOutbox.abandonedReason)))
        .groupBy(uploadOutbox.status);

      let pending = 0;
      let failed = 0;
      let oldest: string | null = null;

      for (const row of rows) {
        if (row.status === 'failed') failed += row.count;
        else pending += row.count;
        if (row.oldest !== null && (oldest === null || row.oldest < oldest)) oldest = row.oldest;
      }

      // Computed against the caller's `now` rather than `now()` in SQL, so the
      // nightly run's health snapshot uses the same instant as everything else in
      // that run's completion record.
      //
      // Through `parseInstant` rather than `Date.parse`, which returns NaN for a
      // malformed string and would report an age of NaN seconds — a value that
      // compares false against the 24-hour threshold and silences the alert.
      const nowMillis = parseInstant(now)?.getTime() ?? null;
      const oldestMillis = oldest === null ? null : (parseInstant(oldest)?.getTime() ?? null);

      return {
        pending,
        failed,
        oldestAgeSeconds:
          oldestMillis === null || nowMillis === null
            ? null
            : Math.max(0, Math.round((nowMillis - oldestMillis) / 1000)),
      };
    },
  };
}

/* =========================================================================
 * Stored media, read back (§9.8)
 * ====================================================================== */

/**
 * Why this read lives beside the outbox rather than in a vault of its own.
 *
 * The outbox is where a `media_object` row comes from — {@link
 * UploadOutboxRepository.markUploaded} is the moment an intent becomes an
 * object. This is the other end of that same lifecycle, and keeping the two
 * within sight of each other is what stops the second one being written as
 * though the first did not exist. The document vault is a different table
 * about a different thing.
 *
 * ## It is a read and only a read
 *
 * Nothing in this repository writes `media_object`, because nothing in the
 * system does yet: §5.5's client-side encryption needs a passphrase-derived key
 * flow that has not been built, and §14.4 is explicit that deferring photography
 * is acceptable while deferring encryption is not. A gallery that reads an empty
 * table is honest. A writer that stored plaintext "for now" would not be.
 */
export type ProtocolPhotoRow = {
  readonly mediaObjectId: string;
  readonly tier: StorageTier;
  readonly mimeType: string;
  readonly byteSize: number | null;
  readonly width: number | null;
  readonly height: number | null;

  /**
   * Nullable, and deliberately not defaulted to the row's `created_at`.
   *
   * A photo whose capture time was never recorded cannot be placed in a
   * chronological series, and substituting the upload time would place it
   * confidently in the wrong week. §8.9(3) — the gap is the fact.
   */
  readonly capturedAt: string | null;
  readonly capturedZone: string | null;
  readonly deviceIdentity: string | null;

  /* The capture-protocol block (§9.8). Every field independently nullable,
   * because a photo captured before a field existed is not a photo with that
   * field set to a default. */
  readonly region: string | null;
  readonly poseId: string | null;
  readonly distance: CaptureDistance | null;
  readonly lighting: CaptureLighting | null;
  readonly flash: FlashState | null;
  readonly timeBucket: CaptureTimeBucket | null;
  readonly alignmentReferenceId: string | null;
  readonly medianLuminance: number | null;
  readonly complianceScore: number | null;
  readonly complianceNotes: string | null;

  /**
   * The bytes are client-side encrypted and the server cannot read them (§5.5).
   *
   * Derived from the presence of a wrapped key rather than from the tier, so it
   * answers "can this be rendered" rather than "was it filed correctly". The
   * `media_object_sensitive_encrypted` check constraint makes the two agree for
   * the sensitive tier; this column is what a caller should branch on.
   */
  readonly isEncrypted: boolean;
};

export type MediaRepository = {
  /**
   * Protocol-governed photography for the given regions, newest first.
   *
   * Region-parameterised rather than hard-coded to skin or physique: §9.8
   * describes one protocol block serving both, and the caller is the layer that
   * knows which regions constitute which gallery. Undated rows sort last rather
   * than being dropped.
   */
  protocolPhotos(
    regions: readonly BodyRegion[],
    limit?: number,
  ): Promise<Result<readonly ProtocolPhotoRow[], DomainError>>;
};

function toProtocolPhoto(row: typeof mediaObject.$inferSelect): ProtocolPhotoRow {
  return {
    mediaObjectId: row.id,
    tier: row.tier,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    capturedAt: row.capturedAt,
    capturedZone: row.capturedZone,
    deviceIdentity: row.deviceIdentity,
    region: row.protocolRegion,
    poseId: row.poseId,
    distance: row.distance,
    lighting: row.lighting,
    flash: row.flash,
    timeBucket: row.timeBucket,
    alignmentReferenceId: row.alignmentReferenceId,
    /* `numeric` reads back as a string. `Number` on a null would be zero, and a
     * luminance of zero is a black frame rather than an unrecorded one. */
    medianLuminance: row.medianLuminance === null ? null : Number(row.medianLuminance),
    complianceScore: row.complianceScore === null ? null : Number(row.complianceScore),
    complianceNotes: row.complianceNotes,
    isEncrypted: row.wrappedKey !== null,
  };
}

export function createMediaRepository(db: Database): MediaRepository {
  return {
    async protocolPhotos(regions, limit = 200) {
      if (regions.length === 0) return ok([]);

      const rows = await db
        .select()
        .from(mediaObject)
        .where(and(isNull(mediaObject.deletedAt), inArray(mediaObject.protocolRegion, [...regions])))
        /* `nulls last` explicitly. Postgres sorts nulls first under `desc`, which
         * would open a physique gallery with the one photo that has no date. */
        .orderBy(sql`${mediaObject.capturedAt} desc nulls last`, desc(mediaObject.createdAt))
        .limit(limit);

      return ok(rows.map(toProtocolPhoto));
    },
  };
}
