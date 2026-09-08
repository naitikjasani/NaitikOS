/**
 * Cross-cutting — §9.2, §9.8, §9.9.
 *
 * §9.3's fourth load-bearing property governs every table here:
 *
 *   "Cross-cutting entities read widely and write narrowly. Goals own
 *    definitions, not progress. Insights own findings, not data. This is what
 *    stops derived state from becoming a second, drifting source of truth."
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import {
  bodyRegion,
  captureDistance,
  captureLighting,
  captureTimeBucket,
  consentScope,
  documentKind,
  extractionMethod,
  flashState,
  goalStatus,
  insightDisposition,
  mediaKind,
  reviewKind,
  reviewState,
  storageTier,
} from './enums';
import {
  confidence,
  entityColumns,
  ianaZone,
  instant,
  primaryKey,
  quantity,
  reference,
  rowTimestamps,
  searchVector,
} from './columns';

/* =========================================================================
 * Goals (§4.10)
 * ====================================================================== */

/**
 * A goal is a declaration plus a projection — it owns no progress data.
 *
 * §4.10 is explicit: "Recording progress separately from the underlying
 * observations would create two sources of truth and guarantee drift."
 * `goal_target` names a metric and a number; progress is computed from
 * observations that Gym and Composition already write.
 */
export const goal = pgTable(
  'goal',
  {
    ...entityColumns,

    title: text().notNull(),
    description: text(),
    status: goalStatus().notNull().default('active'),

    startedAt: instant(),
    horizonAt: instant(),
    achievedAt: instant(),

    /** Why it stopped mattering — §4.10's "goal archaeology". */
    closingNote: text(),
    /** Set when this goal replaced an earlier one. */
    supersedesGoalId: reference(),
  },
  (t) => [
    index('goal_status_idx').on(t.status).where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** A measurable target attached to a goal. */
export const goalTarget = pgTable(
  'goal_target',
  {
    ...entityColumns,

    goalId: reference()
      .notNull()
      .references(() => goal.id),

    /** The registry key progress is computed from. */
    metricKey: text().notNull(),
    /** `at_least`, `at_most`, `rate_of_change`. */
    comparator: text().notNull(),
    targetValue: quantity().notNull(),
    unit: text().notNull(),
    /** For rate targets: the window, in days. */
    windowDays: integer(),
  },
  (t) => [index('goal_target_goal_idx').on(t.goalId)],
);

/**
 * A point-in-time snapshot of believed progress.
 *
 * §9.2 gives the reason these are stored despite progress being derivable:
 * "Snapshots exist so the *trajectory as it was believed at the time* is
 * preserved even after the underlying data is corrected." A correction in
 * March should not rewrite what the trajectory looked like in January.
 */
export const goalProgressSnapshot = pgTable(
  'goal_progress_snapshot',
  {
    id: primaryKey(),
    ...rowTimestamps,

    goalId: reference()
      .notNull()
      .references(() => goal.id),
    goalTargetId: reference().references(() => goalTarget.id),

    takenAt: instant().notNull(),
    currentValue: quantity(),
    /** 0–1 against the target, as computed on `takenAt`. */
    progressRatio: quantity(),
    /** Projected completion, with honest uncertainty (§4.10). */
    projectedAt: instant(),
    projectionConfidence: confidence(),
  },
  (t) => [index('goal_progress_snapshot_goal_idx').on(t.goalId, t.takenAt.desc())],
);

/* =========================================================================
 * Insights (§4.13) — V2
 * ====================================================================== */

/**
 * A surfaced finding.
 *
 * §4.13 requires every insight to carry "its evidence, its method, its
 * confidence, and a plain statement of what it does *not* prove", because "an
 * insight the user cannot audit is an insight they should not trust."
 *
 * P4 draws the hard line this table sits on: statistics are computed by code,
 * and "language models explain, rank, and narrate — they never discover a
 * correlation, never compute a number." So `method` records the deterministic
 * detector that found this, and `narrative` is the only column a model may
 * write.
 */
export const insight = pgTable(
  'insight',
  {
    ...entityColumns,

    /** The deterministic detector that produced this. Never a model. */
    method: text().notNull(),
    detectorVersion: text(),

    title: text().notNull(),
    /** Model-authored prose, explaining a finding it did not discover (P4). */
    narrative: text(),
    /** What this does *not* prove. Mandatory — §4.13. */
    limitations: text(),

    confidence: confidence(),
    /** Statistical significance where the method produces one. */
    pValue: quantity(),
    effectSize: quantity(),

    disposition: insightDisposition().notNull().default('new'),
    surfacedAt: instant(),
    actedOnAt: instant(),
    dismissedAt: instant(),
    /** Dismissals train the ranking (§4.13). */
    dismissReason: text(),
  },
  (t) => [
    index('insight_disposition_idx').on(t.disposition, t.surfacedAt.desc()),
    index('insight_queue_idx')
      .on(t.confidence.desc())
      .where(sql`${t.disposition} = 'new' AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * The observations an insight rests on.
 *
 * This table is what makes an insight auditable. Without it a finding is an
 * assertion; with it the user can follow every number back to the rows that
 * produced it.
 */
export const insightEvidence = pgTable(
  'insight_evidence',
  {
    id: primaryKey(),
    ...rowTimestamps,

    insightId: reference()
      .notNull()
      .references(() => insight.id),
    observationId: reference(),
    /** For evidence that is an entity rather than an observation. */
    entityType: text(),
    entityId: reference(),

    /** What this row contributes — `exposure`, `outcome`, `confounder`. */
    role: text(),
    note: text(),
  },
  (t) => [index('insight_evidence_insight_idx').on(t.insightId)],
);

/* =========================================================================
 * Reviews (§4.12) — V3
 * ====================================================================== */

/**
 * Weekly, monthly, and annual reviews.
 *
 * §4.12: "A review the user did not edit is a review they did not do, and the
 * system should treat an unedited draft as incomplete rather than as a
 * completed review." Hence `state` and a separate `editedContent` — a draft
 * that was never touched is visibly distinct from one that was.
 */
export const review = pgTable(
  'review',
  {
    ...entityColumns,

    kind: reviewKind().notNull(),
    periodStart: instant().notNull(),
    periodEnd: instant().notNull(),

    /** Model-drafted from the record. The labour-saving part. */
    draftContent: text(),
    /** Human-edited. The valuable part. */
    editedContent: text(),
    state: reviewState().notNull().default('drafted'),
    completedAt: instant(),

    searchVector: searchVector('draft_content', 'edited_content'),
  },
  (t) => [
    uniqueIndex('review_period_unique').on(t.kind, t.periodStart),
    index('review_search_idx').using('gin', t.searchVector),
    check('review_complete_requires_edit', sql`${t.state} <> 'complete' OR ${t.editedContent} IS NOT NULL`),
    check('review_period_ordered', sql`${t.periodStart} <= ${t.periodEnd}`),
  ],
);

/* =========================================================================
 * Documents (§9.9, §4.11) — V2
 * ====================================================================== */

/**
 * The document vault.
 *
 * §9.9's design goal: "a lab PDF dropped into the vault becomes structured lab
 * observations with the source document permanently attached as evidence — so
 * the number in your chart can always be traced back to the piece of paper it
 * came from. Provenance is not optional in a medical record."
 */
export const document = pgTable(
  'document',
  {
    ...entityColumns,

    kind: documentKind().notNull(),
    title: text().notNull(),
    issuer: text(),
    issuedAt: instant(),
    expiresAt: instant(),

    mediaObjectId: reference(),
    note: text(),
  },
  (t) => [
    index('document_kind_idx').on(t.kind, t.issuedAt.desc()),
    index('document_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/**
 * Extracted text and structured fields, with per-field confidence (§9.9).
 *
 * Confidence is retained rather than discarded after extraction. A number
 * pulled from a blurry scan at 0.6 confidence is usable, but only if the system
 * remembers it was 0.6 — and P4 forbids presenting a model extraction with the
 * same authority as a typed value.
 */
export const documentExtraction = pgTable(
  'document_extraction',
  {
    ...entityColumns,

    documentId: reference()
      .notNull()
      .references(() => document.id),

    method: extractionMethod().notNull(),
    /** Model or OCR engine identity and version, where applicable. */
    engine: text(),
    engineVersion: text(),

    extractedText: text(),
    /** `[{ field, value, confidence, page, bbox }]`. */
    structuredFields: jsonb().notNull().default(sql`'[]'::jsonb`),
    overallConfidence: confidence(),

    searchVector: searchVector('extracted_text'),
  },
  (t) => [
    index('document_extraction_document_idx').on(t.documentId),
    index('document_extraction_search_idx').using('gin', t.searchVector),
  ],
);

/* =========================================================================
 * Media (§9.8, §5.5)
 * ====================================================================== */

/**
 * Every stored object, plus the capture-protocol block for governed photography.
 *
 * ## Encryption
 *
 * §5.5 puts skin and physique photos in the sensitive tier: "Client-side
 * envelope encryption before upload. The storage provider holds ciphertext it
 * cannot read." Only `wrappedKey` is stored — the master key is derived from the
 * user's passphrase via Argon2id and never transmitted. The consequence is
 * accepted deliberately: "lose the passphrase and the photos are
 * unrecoverable."
 *
 * ## The protocol block
 *
 * §4.2 argues that inconsistent photographs "are not merely lower quality — they
 * are *actively misleading*, because apparent change is dominated by capture
 * variance rather than skin change." `complianceScore` is what lets comparison
 * views default to compliant photos only:
 *
 *   "A series where lighting varies more than skin does is a series that will
 *    produce confident, wrong conclusions."
 */
export const mediaObject = pgTable(
  'media_object',
  {
    ...entityColumns,

    kind: mediaKind().notNull(),
    tier: storageTier().notNull(),

    /** Path in the bucket. Never a public URL — access is server-mediated (§5.5). */
    storageKey: text().notNull(),
    mimeType: text().notNull(),
    byteSize: bigint({ mode: 'number' }),
    width: integer(),
    height: integer(),

    /** Perceptual hash, for duplicate detection in the pipeline (§5.5). */
    perceptualHash: text(),
    /**
     * SHA-256 of the **plaintext**, after compression and before encryption.
     *
     * This comment previously said "of the ciphertext, for the nightly
     * integrity check (§9.8)", and was wrong twice over — see
     * `docs/adr/0006-media-key-derivation-and-content-hash.md`.
     *
     * Wrong about the value: `runPipeline` computes it at stage 5, before
     * encryption at stage 6, and the decryption guide that ships in every
     * export documents it as `checksum of the PLAINTEXT, for verification`.
     * The code and the archive already agreed; only this line dissented.
     *
     * Wrong about the capability, which matters more. §5.5 leaves the server
     * holding bytes it has no key for, so **no server-side sweep can verify a
     * plaintext digest** — the integrity check this comment promised is
     * impossible by construction. What a server can check is that the object
     * exists, that its length is as recorded, and that rows and stored objects
     * correspond. Verifying content needs either a second ciphertext-hash
     * column or a client-side sweep with the passphrase in memory; ADR 0006
     * takes neither.
     */
    contentHash: text(),

    capturedAt: instant(),
    capturedZone: ianaZone(),
    deviceIdentity: text(),

    /**
     * The AES-256-GCM data key, wrapped with the passphrase-derived master key.
     * Null for tiers that are not client-side encrypted.
     */
    wrappedKey: text(),
    encryptionAlgorithm: text(),

    /* --- Capture protocol (§9.8) — null for non-governed media --------- */
    protocolRegion: bodyRegion(),
    /** Stable identifier for the pose, so a series compares like with like. */
    poseId: text(),
    distance: captureDistance(),
    lighting: captureLighting(),
    flash: flashState(),
    timeBucket: captureTimeBucket(),
    /** The previous photo in the series, used for the ghost-overlay alignment. */
    alignmentReferenceId: reference(),
    /** Median luminance of the fixed reference region, for the lighting check. */
    medianLuminance: quantity(),
    /** 0–1. Below threshold, excluded from comparison views by default. */
    complianceScore: confidence(),
    complianceNotes: text(),

    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [
    uniqueIndex('media_object_storage_key_unique').on(t.storageKey),
    index('media_object_series_idx').on(t.protocolRegion, t.poseId, t.capturedAt.desc()),
    index('media_object_hash_idx').on(t.perceptualHash).where(sql`${t.perceptualHash} IS NOT NULL`),
    /* Sensitive-tier objects must carry a wrapped key — §5.5 makes leakage
     * impossible rather than prohibited, and this is where that is checked. */
    check(
      'media_object_sensitive_encrypted',
      sql`${t.tier} <> 'sensitive' OR ${t.wrappedKey} IS NOT NULL`,
    ),
  ],
);

/** Free-form note, attachable to any entity (§9.2). Polymorphic, like §9.3(3). */
export const note = pgTable(
  'note',
  {
    ...entityColumns,

    entityType: text(),
    entityId: reference(),

    content: text().notNull(),
    searchVector: searchVector('content'),
    aiConsent: consentScope().notNull().default('none'),
  },
  (t) => [
    index('note_entity_idx').on(t.entityType, t.entityId),
    index('note_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * Link between a media object and whatever it documents.
 *
 * Separate from `media_object` so one photo can evidence several things — a
 * skin photo belongs to a day's `skin_region_state` and to a treatment course
 * simultaneously, and duplicating the encrypted object to express that would be
 * both wasteful and a second thing to keep in sync.
 */
export const mediaAttachment = pgTable(
  'media_attachment',
  {
    id: primaryKey(),
    ...rowTimestamps,

    mediaObjectId: reference()
      .notNull()
      .references(() => mediaObject.id),
    entityType: text().notNull(),
    entityId: reference().notNull(),
    /** Ordering within a set, where it matters. */
    orderIndex: integer(),
    caption: text(),
  },
  (t) => [
    uniqueIndex('media_attachment_unique').on(t.mediaObjectId, t.entityType, t.entityId),
    index('media_attachment_entity_idx').on(t.entityType, t.entityId),
  ],
);

/** Whether a sensitive object has ever been decrypted for an inference call. */
export const mediaAccessLog = pgTable(
  'media_access_log',
  {
    id: primaryKey(),
    mediaObjectId: reference()
      .notNull()
      .references(() => mediaObject.id),
    accessedAt: instant().notNull().default(sql`now()`),
    /** `view`, `export`, `inference`. The last one is the one that matters (P7). */
    purpose: text().notNull(),
    grantedConsent: consentScope(),
    isDecrypted: boolean().notNull().default(false),
  },
  (t) => [index('media_access_log_object_idx').on(t.mediaObjectId, t.accessedAt.desc())],
);
