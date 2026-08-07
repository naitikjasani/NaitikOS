/**
 * Payload validation.
 *
 * ## Why this is hand-rolled rather than Zod
 *
 * `packages/core` declares exactly one runtime dependency — `@naitikos/shared` —
 * because §5.0 makes it "the only part of the system intended to survive two
 * decades" and every dependency shortens that. Zod lives in `packages/api`,
 * where the *wire* contracts are, and that is the right place for parsing
 * untrusted input from a client.
 *
 * This is a different job: an internal structural assertion that an event
 * emitted by our own code matches its registered shape. It runs on every
 * publish, it must run in `core` because the bus is in `core`, and it is about
 * eighty lines.
 *
 * The two layers are complementary, not redundant. `packages/api` validates what
 * arrives over HTTP; this validates what the domain constructs. A bug in a
 * service produces a malformed event that never touched the wire, and only this
 * catches it.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError, ValidationError } from '../errors/domain-error';
import { validationError } from '../errors/domain-error';
import type { EventType } from './registry';

/** What a payload field may be. */
type FieldKind = 'string' | 'number' | 'boolean';

type FieldSpec = {
  readonly kind: FieldKind;
  readonly required: boolean;
  /**
   * True when this field names or references something rather than measuring it.
   *
   * The ADR 0005 discriminator. A `number` field that is not a reference must be
   * a **count** — `setCount`, `stepsCompleted` — never a measured value.
   * `registry.test.ts` asserts the naming convention that makes this checkable.
   */
  readonly isReference?: boolean;
};

type PayloadSpec = Readonly<Record<string, FieldSpec>>;

const ref = (kind: FieldKind, required = true): FieldSpec => ({ kind, required, isReference: true });
const field = (kind: FieldKind, required = true): FieldSpec => ({ kind, required });

const OBSERVATION_SPEC: PayloadSpec = {
  metricKey: ref('string'),
  supersedesObservationId: ref('string', false),
};

const MEDICATION_SPEC: PayloadSpec = {
  medicationId: ref('string'),
  scheduleId: ref('string', false),
  substanceLabel: ref('string'),
};

const MEDIA_SPEC: PayloadSpec = {
  mediaObjectId: ref('string'),
  kind: ref('string'),
  complianceScore: field('number', false),
  region: ref('string', false),
};

const EMPTY_SPEC: PayloadSpec = {};

/**
 * The specs, keyed by event type.
 *
 * Duplicated from the TypeScript payload types by necessity — TS types do not
 * exist at runtime, and this check must run at runtime. `registry.test.ts`
 * asserts the two stay in step by requiring a spec for every registered type.
 */
const PAYLOAD_SPECS: Readonly<Record<EventType, PayloadSpec>> = Object.freeze({
  'Observation.Recorded': OBSERVATION_SPEC,

  'Medication.Taken': MEDICATION_SPEC,
  'Medication.Skipped': MEDICATION_SPEC,
  'Medication.Delayed': MEDICATION_SPEC,
  'Supplement.Taken': MEDICATION_SPEC,
  'Appointment.Created': { medicalEventId: ref('string'), specialty: ref('string', false) },
  'Appointment.Attended': { medicalEventId: ref('string'), specialty: ref('string', false) },
  'Report.Imported': {
    documentId: ref('string'),
    extractedRowCount: field('number'),
    method: ref('string'),
  },

  'Workout.Started': { programId: ref('string', false), programBlockLabel: ref('string', false) },
  'Workout.Completed': {
    setCount: field('number'),
    exerciseCount: field('number'),
    durationMinutes: field('number', false),
  },
  'Workout.SetLogged': {
    sessionId: ref('string'),
    exerciseId: ref('string'),
    exerciseLabel: ref('string'),
    orderIndex: field('number'),
    isPersonalRecord: field('boolean'),
  },
  'Weight.Logged': OBSERVATION_SPEC,
  'BodyMeasurement.Recorded': { site: ref('string') },
  'Sleep.Recorded': EMPTY_SPEC,
  'SkinRoutine.Completed': {
    routineId: ref('string'),
    period: ref('string'),
    stepsCompleted: field('number'),
    stepsRequired: field('number'),
  },
  'SkinState.Logged': OBSERVATION_SPEC,

  'Mood.Logged': OBSERVATION_SPEC,
  'Journal.Created': { hasPrompt: field('boolean') },
  'Journal.Updated': { hasPrompt: field('boolean') },
  'AnxietyEpisode.Logged': EMPTY_SPEC,
  'Practice.Completed': EMPTY_SPEC,

  'ProgressPhoto.Uploaded': MEDIA_SPEC,
  'Media.Uploaded': MEDIA_SPEC,
  'Document.Uploaded': {
    documentId: ref('string'),
    documentKind: ref('string'),
    awaitingExtraction: field('boolean'),
  },

  'Goal.Completed': { goalId: ref('string'), goalTitle: ref('string') },
  'Task.Completed': { taskId: ref('string'), taskTitle: ref('string') },

  'DailyClose.Completed': {
    closedOn: ref('string'),
    fieldsCompleted: field('number'),
    fieldsAvailable: field('number'),
  },
});

/** The spec for an event type. Exported so tests can assert coverage. */
export function payloadSpecFor(type: EventType): PayloadSpec {
  return PAYLOAD_SPECS[type];
}

export function allPayloadSpecs(): Readonly<Record<EventType, PayloadSpec>> {
  return PAYLOAD_SPECS;
}

/**
 * Validate a payload against its registered spec.
 *
 * Rejects unknown keys as well as missing ones. That is deliberate and slightly
 * unusual: an extra field is how an authoritative value sneaks into a payload,
 * and ADR 0005's whole cost is that the discipline has to hold. Silently
 * accepting `{ weightKg: 74.2 }` because it was not in the spec is exactly the
 * failure mode.
 */
export function validateEventPayload(
  type: EventType,
  payload: unknown,
): Result<void, DomainError> {
  const spec = PAYLOAD_SPECS[type];
  const issues: { path: readonly string[]; message: string }[] = [];

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return err(
      validationError('event_payload_invalid', `Payload for ${type} must be an object.`, [
        { path: ['payload'], message: 'Expected an object.' },
      ]),
    );
  }

  const record = payload as Record<string, unknown>;

  for (const [key, fieldSpec] of Object.entries(spec)) {
    const value = record[key];

    if (value === undefined) {
      if (fieldSpec.required) {
        issues.push({ path: ['payload', key], message: 'Required.' });
      }
      continue;
    }

    if (typeof value !== fieldSpec.kind) {
      issues.push({
        path: ['payload', key],
        message: `Expected ${fieldSpec.kind}, received ${typeof value}.`,
      });
      continue;
    }

    // A number that is not finite would serialise to `null` in JSON and reappear
    // as a missing field on replay.
    if (fieldSpec.kind === 'number' && !Number.isFinite(value)) {
      issues.push({ path: ['payload', key], message: 'Must be a finite number.' });
    }
  }

  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(spec, key)) {
      issues.push({
        path: ['payload', key],
        message:
          'Not in this event type\'s payload spec. Events reference, they do not restate (ADR 0005) — add the field to the spec deliberately, or point at the row instead.',
      });
    }
  }

  if (issues.length > 0) {
    return err(
      validationError(
        'event_payload_invalid',
        `Payload for ${type} does not match its registered shape.`,
        issues as ValidationError['issues'],
      ),
    );
  }

  return ok(undefined);
}
