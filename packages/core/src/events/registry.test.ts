/**
 * The registry, and the ADR 0005 payload rule enforced structurally.
 *
 * ADR 0005's whole cost is that one discipline has to hold for twenty years:
 * **events reference, they do not restate.** A payload that carries a measured
 * value creates a second copy of a number, and §9.3 is explicit about what
 * happens next — "two sources of truth for the same fact, which drift."
 *
 * A rule that lives only in prose is a rule that will be broken by whoever adds
 * an event type at 11pm in year three, including me. So the checks below are
 * mechanical: a payload field that looks like a measurement fails CI, and a new
 * numeric field fails CI until someone adds it to the reviewed list below with a
 * reason. That is deliberately annoying. The annoyance is the enforcement.
 */

import { describe, expect, it } from 'vitest';

import {
  EVENT_CATEGORIES,
  EVENT_REGISTRY,
  EVENT_TYPES,
  clinicalEventTypes,
  currentVersion,
  describeEvent,
  eventsInCategory,
  isEventType,
} from './registry';
import type { EventType } from './registry';
import { allPayloadSpecs, payloadSpecFor } from './validate';
import { renderedEventTypes } from '../timeline/project';

/* =========================================================================
 * Coverage
 * ====================================================================== */

describe('registry completeness', () => {
  it('registers a non-trivial number of types', () => {
    // A guard against the registry being accidentally emptied by a bad merge —
    // every other test in this file passes vacuously over an empty list.
    expect(EVENT_TYPES.length).toBeGreaterThan(20);
  });

  it('gives every type a runtime payload spec', () => {
    // The specs duplicate the TypeScript payload types by necessity — TS types do
    // not exist at runtime. This is what keeps the two in step.
    const specs = allPayloadSpecs();
    for (const type of EVENT_TYPES) {
      expect(Object.hasOwn(specs, type), `no payload spec for ${type}`).toBe(true);
    }
  });

  it('has no spec for a type that is not registered', () => {
    for (const key of Object.keys(allPayloadSpecs())) {
      expect(isEventType(key), `${key} has a spec but is not registered`).toBe(true);
    }
  });

  it('gives every type a bespoke timeline renderer', () => {
    // The projector is total and falls back to the registry `describes` string, so
    // a missing renderer degrades visibly rather than dropping the row. This
    // asserts we have not actually shipped any of those fallbacks.
    const rendered = new Set(renderedEventTypes());
    const missing = EVENT_TYPES.filter((type) => !rendered.has(type));
    expect(missing, 'types falling back to the registry description').toEqual([]);
  });

  it('describes every type in a full sentence', () => {
    for (const type of EVENT_TYPES) {
      const { describes } = describeEvent(type);
      // `docs/events.md` is generated from these, and a maintainer in year six
      // reads them instead of the code.
      expect(describes.length, `${type}: describes too short`).toBeGreaterThan(15);
      expect(describes.endsWith('.'), `${type}: describes is not a sentence`).toBe(true);
    }
  });

  it('starts every type at version 1 or higher and declares a valid category', () => {
    for (const type of EVENT_TYPES) {
      expect(currentVersion(type)).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(currentVersion(type))).toBe(true);
      expect(EVENT_CATEGORIES).toContain(describeEvent(type).category);
    }
  });

  it('partitions every type into exactly one category', () => {
    const counted = EVENT_CATEGORIES.flatMap((category) => eventsInCategory(category));
    expect(counted).toHaveLength(EVENT_TYPES.length);
    expect(new Set(counted).size).toBe(EVENT_TYPES.length);
  });

  it('rejects a string that is not a registered type', () => {
    expect(isEventType('Medication.Taken')).toBe(true);
    expect(isEventType('Medication.Invented')).toBe(false);
    expect(isEventType('toString')).toBe(false);
    expect(isEventType(42)).toBe(false);
    expect(isEventType(undefined)).toBe(false);
  });
});

/* =========================================================================
 * Naming
 * ====================================================================== */

describe('naming', () => {
  it('names every type Domain.ThingHappened in the past tense', () => {
    // Past tense because an event is a record of something that already happened
    // and cannot be refused. A handler treating `WeightLogged` as a *request* to
    // log a weight has misunderstood the direction of the whole system.
    const shape = /^[A-Z][A-Za-z]+\.[A-Z][A-Za-z]+$/;
    for (const type of EVENT_TYPES) {
      expect(shape.test(type), `${type} is not Domain.ThingHappened`).toBe(true);

      const verb = type.split('.')[1] ?? '';
      const isPastTense = /(ed|Logged|Taken|Started|Imported)$/.test(verb);
      expect(isPastTense, `${type}: "${verb}" is not past tense`).toBe(true);
    }
  });
});

/* =========================================================================
 * The payload rule (ADR 0005)
 * ====================================================================== */

/**
 * Field names that would mean a payload carries an authoritative value.
 *
 * Not exhaustive and cannot be — this catches the shapes that actually get
 * written by someone in a hurry. `weightKg` is the canonical example from the
 * ADR itself.
 */
const MEASUREMENT_NAME_PATTERNS: readonly { pattern: RegExp; why: string }[] = Object.freeze([
  { pattern: /(kg|Kg|lb|Lb|cm|Cm|mm|Mm|ml|Ml|mg|Mg|bpm|Bpm|mmhg|MmHg)$/, why: 'a unit suffix means a measured value' },
  { pattern: /^(value|amount|reading|measurement|result)/i, why: 'names the value itself' },
  { pattern: /(Value|Amount|Reading|Measurement|Result)$/, why: 'names the value itself' },
  { pattern: /^(weight|height|mood|energy|anxiety|sleep|dose|dosage|bloodPressure|heartRate)$/i, why: 'a metric, not a reference to one' },
]);

/**
 * Field names that would leak user content into the log.
 *
 * §4.7 gives Mind the highest duty of care, and §5.11 states the principle for
 * telemetry in a form that applies here verbatim: "The schema cannot represent
 * user content, which makes leakage impossible rather than prohibited." The event
 * log is scanned by the timeline, replayed, and read by job handlers — it is the
 * last place journal text should be able to reach.
 */
const CONTENT_NAME_PATTERNS: readonly RegExp[] = Object.freeze([
  /^(text|body|content|note|notes|entry|transcript|message|summary|description|comment)$/i,
  /(Text|Body|Content|Note|Notes|Transcript|Message|Summary|Description|Comment)$/,
]);

/**
 * Non-reference numeric fields that have been reviewed and accepted.
 *
 * Every entry is a **count, an index, a duration, or a derived quality score** —
 * never a measurement of the user. Adding a numeric payload field means adding it
 * here, which means someone has to write down why it is not a measurement.
 */
const REVIEWED_NUMERIC_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  setCount: 'Count of sets in a session. A fact about the session, not a load.',
  exerciseCount: 'Count of exercises. As above.',
  durationMinutes: 'Session length. Derived from start/end, not measured of the body.',
  orderIndex: 'Position of a set within a session. Ordering, not magnitude.',
  stepsCompleted: 'Count of completed routine steps.',
  stepsRequired: 'Count of required routine steps. Denominator of a ratio of counts.',
  extractedRowCount: 'How many rows an import produced. A fact about the import.',
  fieldsCompleted: 'How many Daily Close fields were filled (§4.0 permits a partial close).',
  fieldsAvailable: 'Denominator of the above.',
  complianceScore:
    '§9.8 capture-protocol compliance, 0–1. A property of the photograph, not of the person — and the timeline filters comparison views on it.',
});

describe('the payload rule — events reference, they do not restate', () => {
  const specs = allPayloadSpecs();

  it('has no field whose name implies a measured value', () => {
    for (const type of EVENT_TYPES) {
      for (const field of Object.keys(specs[type])) {
        for (const { pattern, why } of MEASUREMENT_NAME_PATTERNS) {
          expect(
            pattern.test(field),
            `${type}.${field}: ${why}. Carry a reference (an id, or a metric key) and let the row hold the number — ADR 0005.`,
          ).toBe(false);
        }
      }
    }
  });

  it('has no field that could carry user content', () => {
    for (const type of EVENT_TYPES) {
      for (const field of Object.keys(specs[type])) {
        for (const pattern of CONTENT_NAME_PATTERNS) {
          expect(
            pattern.test(field),
            `${type}.${field}: the event log must not be able to represent user content (§4.7, §5.11).`,
          ).toBe(false);
        }
      }
    }
  });

  it('accepts a numeric field only if it has been reviewed as a count', () => {
    for (const type of EVENT_TYPES) {
      for (const [field, spec] of Object.entries(specs[type])) {
        if (spec.kind !== 'number' || spec.isReference === true) continue;

        expect(
          Object.hasOwn(REVIEWED_NUMERIC_FIELDS, field),
          `${type}.${field} is a new numeric payload field. Add it to REVIEWED_NUMERIC_FIELDS in this file with a note on why it is a count and not a measurement — or reference the row that holds the number.`,
        ).toBe(true);
      }
    }
  });

  it('does not review a numeric field that no longer exists', () => {
    const live = new Set(
      EVENT_TYPES.flatMap((type) =>
        Object.entries(specs[type])
          .filter(([, spec]) => spec.kind === 'number' && spec.isReference !== true)
          .map(([field]) => field),
      ),
    );

    for (const field of Object.keys(REVIEWED_NUMERIC_FIELDS)) {
      // Keeps the list honest. A stale entry is a standing exemption for a field
      // name nobody is using, which is how the next one slips through.
      expect(live.has(field), `${field} is reviewed but no longer in any payload spec`).toBe(true);
    }
  });

  it('names every reference field so the projector can link it', () => {
    // `linksFor` in the projector keys on the `*Id` convention to build §3.3 R5's
    // "links back to every entity". A reference named otherwise is invisible to it.
    const nonIdReferences = ['metricKey', 'substanceLabel', 'exerciseLabel', 'goalTitle', 'taskTitle', 'site', 'period', 'kind', 'documentKind', 'method', 'specialty', 'region', 'closedOn', 'programBlockLabel'];

    for (const type of EVENT_TYPES) {
      for (const [field, spec] of Object.entries(specs[type])) {
        if (spec.isReference !== true || spec.kind !== 'string') continue;
        if (field.endsWith('Id')) continue;

        expect(
          nonIdReferences,
          `${type}.${field} is a string reference that is neither an id nor a known label field. Either suffix it \`Id\` so the projector links it, or add it to this list.`,
        ).toContain(field);
      }
    }
  });
});

/* =========================================================================
 * Mind, specifically
 * ====================================================================== */

describe('the mind domain carries nothing', () => {
  it('gives a journal event a single boolean and no content', () => {
    // Not even a character count. §4.7 classifies journal text as the most
    // sensitive data in the system, and a length is a weak signal that is still a
    // signal — mood correlates with how much people write.
    expect(Object.keys(payloadSpecFor('Journal.Created'))).toEqual(['hasPrompt']);
    expect(Object.keys(payloadSpecFor('Journal.Updated'))).toEqual(['hasPrompt']);
  });

  it('gives a mood event a metric key and no value', () => {
    const spec = payloadSpecFor('Mood.Logged');
    expect(Object.keys(spec).sort()).toEqual(['metricKey', 'supersedesObservationId']);
    expect(spec['metricKey']?.isReference).toBe(true);
  });

  it('gives an anxiety episode nothing beyond the envelope subject', () => {
    expect(Object.keys(payloadSpecFor('AnxietyEpisode.Logged'))).toEqual([]);
  });

  it('marks every mind event clinical', () => {
    // Except `Practice.Completed` — a meditation session is not a psychiatric
    // record, and marking it clinical would pull it into the Consultation Pack
    // and behind the §10.10 consent boundary for no benefit.
    const nonClinical = eventsInCategory('mind').filter((type) => !EVENT_REGISTRY[type].clinical);
    expect(nonClinical).toEqual(['Practice.Completed']);
  });
});

describe('clinical classification', () => {
  it('includes the domains the Consultation Pack needs', () => {
    const clinical = new Set<EventType>(clinicalEventTypes());

    // §2.2's Consultation Pack and §10.10's consent layer both read this set. A
    // clinical event omitted here crosses an inference boundary without a grant.
    for (const type of ['Medication.Taken', 'Medication.Skipped', 'Mood.Logged', 'Journal.Created', 'Report.Imported', 'SkinState.Logged', 'ProgressPhoto.Uploaded'] as const) {
      expect(clinical.has(type), `${type} should be clinical`).toBe(true);
    }
  });

  it('does not mark ordinary training or life events clinical', () => {
    for (const type of ['Workout.Completed', 'Workout.SetLogged', 'Task.Completed', 'Goal.Completed', 'DailyClose.Completed'] as const) {
      expect(EVENT_REGISTRY[type].clinical, `${type} should not be clinical`).toBe(false);
    }
  });
});

describe('significance', () => {
  it('marks the high-volume types as detail', () => {
    // A session of forty sets emits forty `Workout.SetLogged` events. A collapsed
    // timeline showing all of them buries the rest of the day.
    expect(EVENT_REGISTRY['Workout.SetLogged'].significance).toBe('detail');
    expect(EVENT_REGISTRY['Observation.Recorded'].significance).toBe('detail');
    expect(EVENT_REGISTRY['Media.Uploaded'].significance).toBe('detail');
  });

  it('marks the ritual and the clinical decisions as primary', () => {
    expect(EVENT_REGISTRY['DailyClose.Completed'].significance).toBe('primary');
    expect(EVENT_REGISTRY['Medication.Taken'].significance).toBe('primary');
    expect(EVENT_REGISTRY['Medication.Skipped'].significance).toBe('primary');
  });
});
