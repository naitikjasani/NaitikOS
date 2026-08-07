/**
 * Timeline generation.
 *
 * Three properties are being defended here, in descending order of how bad it
 * would be to lose them:
 *
 *  1. **Totality.** Every registered event type produces a renderable entry.
 *     §3.3 R5 makes the timeline "the escape hatch"; an event that projects to
 *     nothing is data the user created and cannot see.
 *  2. **Privacy.** Mood, journal, and anxiety entries carry no values and no
 *     content. §4.7 gives Mind the highest duty of care and §8.2 forbids
 *     rendering health data by valence — a list reading "Mood: 2" is a running
 *     commentary on someone's mental state.
 *  3. **Purity.** The same event projects to the same entry every time, so
 *     truncate-and-rebuild is a safe operation rather than a hopeful one.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent, EventId, EventSequence } from '../events/envelope';
import { EVENT_TYPES, describeEvent } from '../events/registry';
import type { EventType } from '../events/registry';
import { projectEvent, projectEvents, renderedEventTypes } from './project';

const ZONE = 'Asia/Kolkata';

function event<T extends EventType>(
  eventType: T,
  payload: unknown,
  overrides: Partial<DomainEvent> = {},
): DomainEvent {
  return {
    eventId: 'evt-1' as EventId,
    eventType,
    occurredAt: '2026-08-03T12:00:00Z',
    capturedAt: '2026-08-03T12:00:01Z',
    createdAt: '2026-08-03T12:00:02Z',
    actorId: 'sub-1',
    source: 'user',
    version: 1,
    subject: { type: 'thing', id: 'thing-1' },
    payload,
    correlationId: 'corr-1' as never,
    causationId: null,
    metadata: { zone: ZONE },
    sequence: 1 as EventSequence,
    ...overrides,
  } as DomainEvent;
}

/**
 * A minimal valid payload per type.
 *
 * Hand-written rather than generated so the totality test below exercises real
 * shapes — a generated `{}` would take the fallback branch in every renderer and
 * prove nothing.
 */
const SAMPLE_PAYLOADS: Readonly<Record<EventType, unknown>> = Object.freeze({
  'Observation.Recorded': { metricKey: 'body.weight' },
  'Medication.Taken': { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' },
  'Medication.Skipped': { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' },
  'Medication.Delayed': { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' },
  'Supplement.Taken': { medicationId: 'sup-1', substanceLabel: 'Vitamin D3' },
  'Appointment.Created': { medicalEventId: 'me-1', specialty: 'Dermatology' },
  'Appointment.Attended': { medicalEventId: 'me-1', specialty: 'Dermatology' },
  'Report.Imported': { documentId: 'doc-1', extractedRowCount: 14, method: 'pdf_text' },
  'Workout.Started': { programId: 'prog-1' },
  // eslint-disable-next-line @naitikos/no-bare-quantity -- `durationMinutes` names its unit and is reviewed in registry.test.ts as a session-level fact rather than a measurement of the body. A Quantity cannot round-trip through the event log's jsonb payload without becoming a nested object the payload spec would then have to permit.
  'Workout.Completed': { setCount: 12, exerciseCount: 4, durationMinutes: 63 },
  'Workout.SetLogged': {
    sessionId: 'sess-1',
    exerciseId: 'ex-1',
    exerciseLabel: 'Barbell squat',
    orderIndex: 3,
    isPersonalRecord: true,
  },
  'Weight.Logged': { metricKey: 'body.weight' },
  'BodyMeasurement.Recorded': { site: 'waist' },
  'Sleep.Recorded': {},
  'SkinRoutine.Completed': { routineId: 'rt-1', period: 'pm', stepsCompleted: 4, stepsRequired: 5 },
  'SkinState.Logged': { metricKey: 'skin.state' },
  'Mood.Logged': { metricKey: 'mind.mood' },
  'Journal.Created': { hasPrompt: true },
  'Journal.Updated': { hasPrompt: false },
  'AnxietyEpisode.Logged': {},
  'Practice.Completed': {},
  'ProgressPhoto.Uploaded': { mediaObjectId: 'mo-1', kind: 'image', region: 'face', complianceScore: 0.92 },
  'Media.Uploaded': { mediaObjectId: 'mo-2', kind: 'image' },
  'Document.Uploaded': { documentId: 'doc-1', documentKind: 'lab_report', awaitingExtraction: true },
  'Goal.Completed': { goalId: 'goal-1', goalTitle: 'Sub-75kg' },
  'Task.Completed': { taskId: 'task-1', taskTitle: 'Book dermatology follow-up' },
  'DailyClose.Completed': { closedOn: '2026-08-03', fieldsCompleted: 5, fieldsAvailable: 7 },
});

/* =========================================================================
 * Totality
 * ====================================================================== */

describe('every event type projects', () => {
  it('covers every registered type in this file, so the loop below is honest', () => {
    // Without this, adding an event type and forgetting a sample would make the
    // totality test skip it silently.
    for (const type of EVENT_TYPES) {
      expect(Object.hasOwn(SAMPLE_PAYLOADS, type), `no sample payload for ${type}`).toBe(true);
    }
  });

  it('produces a non-empty title for every type', () => {
    for (const type of EVENT_TYPES) {
      const entry = projectEvent(event(type, SAMPLE_PAYLOADS[type]), ZONE);

      expect(entry.title.trim(), `${type} produced an empty title`).not.toBe('');
      // No placeholder ever reaches the UI.
      expect(entry.title).not.toContain('undefined');
      expect(entry.detail ?? '').not.toContain('undefined');
      expect(entry.detail ?? '').not.toContain('NaN');
    }
  });

  it('carries the registry classification onto every entry', () => {
    for (const type of EVENT_TYPES) {
      const entry = projectEvent(event(type, SAMPLE_PAYLOADS[type]), ZONE);
      const descriptor = describeEvent(type);

      // The timeline's category/significance/clinical filters are indexes on these
      // columns, so a projector that computed them independently would let the two
      // disagree.
      expect(entry.category).toBe(descriptor.category);
      expect(entry.significance).toBe(descriptor.significance);
      expect(entry.clinical).toBe(descriptor.clinical);
      expect(entry.eventType).toBe(type);
    }
  });

  it('links every entry back to its subject (§3.3 R5)', () => {
    for (const type of EVENT_TYPES) {
      const entry = projectEvent(event(type, SAMPLE_PAYLOADS[type]), ZONE);
      const subjectLinks = entry.links.filter((link) => link.relation === 'subject');

      expect(subjectLinks, `${type} has no subject link`).toHaveLength(1);
      expect(subjectLinks[0]?.entityId).toBe('thing-1');
    }
  });

  it('reports which types have a bespoke renderer', () => {
    expect(new Set(renderedEventTypes()).size).toBe(renderedEventTypes().length);
  });
});

/* =========================================================================
 * Purity
 * ====================================================================== */

describe('purity', () => {
  it('projects the same event to the same entry twice', () => {
    // The property that makes `clear()` + replay safe. If this were false, a
    // rebuild would produce a subtly different timeline than the original.
    const source = event('Workout.Completed', SAMPLE_PAYLOADS['Workout.Completed']);
    expect(projectEvent(source, ZONE)).toEqual(projectEvent(source, ZONE));
  });

  it('does not mutate the event', () => {
    const source = event('Medication.Taken', { medicationId: 'med-1', substanceLabel: 'Escitalopram' });
    const before = JSON.stringify(source);
    projectEvent(source, ZONE);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('preserves order across a batch', () => {
    const entries = projectEvents(
      [
        event('Weight.Logged', SAMPLE_PAYLOADS['Weight.Logged'], { sequence: 1 as EventSequence }),
        event('Mood.Logged', SAMPLE_PAYLOADS['Mood.Logged'], { eventId: 'evt-2' as EventId, sequence: 2 as EventSequence }),
      ],
      ZONE,
    );

    // Re-sorting here would silently override a `direction=forward` query.
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it('marks an unappended event with sequence -1 rather than 0', () => {
    // Built by omission, not by setting `sequence: undefined` — under
    // `exactOptionalPropertyTypes` those are different types, and only the
    // omission models an event that has not reached the store.
    const { sequence: _omitted, ...unappended } = event('Sleep.Recorded', {});
    const entry = projectEvent(unappended as DomainEvent, ZONE);
    // 0 would sort it silently to the beginning of history. -1 is a programmer
    // error that shows up as an obviously wrong row.
    expect(entry.sequence).toBe(-1);
  });
});

/* =========================================================================
 * Privacy
 * ====================================================================== */

describe('the mind domain renders no values and no content', () => {
  it('renders a mood entry with no number', () => {
    const entry = projectEvent(event('Mood.Logged', { metricKey: 'mind.mood' }), ZONE);

    expect(entry.title).toBe('Mood recorded');
    expect(entry.detail).toBeNull();
    // Not even the metric key, which would read "mind.mood" in a list.
    expect(entry.searchText).toBe('Mood recorded');
  });

  it('renders a journal entry with no text', () => {
    const entry = projectEvent(event('Journal.Created', { hasPrompt: true }), ZONE);

    expect(entry.title).toBe('Journal entry');
    expect(entry.detail).toBe('From a prompt');
    expect(entry.searchText).not.toContain('hasPrompt');
  });

  it('renders an anxiety episode without severity', () => {
    const entry = projectEvent(event('AnxietyEpisode.Logged', {}), ZONE);
    expect(entry.title).toBe('Anxiety episode recorded');
    expect(entry.detail).toBeNull();
  });

  it('never puts payload values into searchText', () => {
    // §4.7's journal text must not become searchable through the timeline. Title
    // and detail only — asserted for every type, not just the mind ones.
    for (const type of EVENT_TYPES) {
      const entry = projectEvent(event(type, SAMPLE_PAYLOADS[type]), ZONE);
      const expected = [entry.title, entry.detail].filter((part) => part !== null).join(' ');
      expect(entry.searchText, `${type} searchText diverged from title/detail`).toBe(expected);
    }
  });
});

/* =========================================================================
 * Phrasing
 * ====================================================================== */

describe('phrasing is descriptive, never evaluative', () => {
  it('says "skipped", not "missed"', () => {
    const entry = projectEvent(
      event('Medication.Skipped', { medicationId: 'med-1', substanceLabel: 'Venlafaxine XR' }),
      ZONE,
    );
    // A skip is a decision the user made. P6 rules out a tool that scolds.
    expect(entry.title).toBe('Venlafaxine XR skipped');
    expect(entry.title.toLowerCase()).not.toContain('missed');
  });

  it('states a partial Daily Close as a count, not a shortfall', () => {
    const entry = projectEvent(
      event('DailyClose.Completed', { closedOn: '2026-08-03', fieldsCompleted: 3, fieldsAvailable: 7 }),
      ZONE,
    );
    // §4.0: "A partial close counts as a close."
    expect(entry.title).toBe('Daily Close');
    expect(entry.detail).toBe('3 of 7 recorded');
    expect((entry.detail ?? '').toLowerCase()).not.toContain('incomplete');
  });

  it('omits the detail line on a complete Daily Close', () => {
    const entry = projectEvent(
      event('DailyClose.Completed', { closedOn: '2026-08-03', fieldsCompleted: 7, fieldsAvailable: 7 }),
      ZONE,
    );
    expect(entry.detail).toBeNull();
  });

  it('notes a personal record without celebrating it', () => {
    const entry = projectEvent(event('Workout.SetLogged', SAMPLE_PAYLOADS['Workout.SetLogged']), ZONE);
    expect(entry.title).toBe('Barbell squat');
    expect(entry.detail).toBe('Personal record');
  });

  it('pluralises counts correctly', () => {
    const many = projectEvent(
      // eslint-disable-next-line @naitikos/no-bare-quantity -- As at SAMPLE_PAYLOADS above.
      event('Workout.Completed', { setCount: 12, exerciseCount: 4, durationMinutes: 63 }),
      ZONE,
    );
    expect(many.detail).toBe('4 exercises · 12 sets · 63 min');

    const one = projectEvent(event('Workout.Completed', { setCount: 1, exerciseCount: 1 }), ZONE);
    expect(one.detail).toBe('1 exercise · 1 set');
  });

  it('humanises a snake_case document kind', () => {
    const entry = projectEvent(
      event('Document.Uploaded', { documentId: 'doc-1', documentKind: 'lab_report', awaitingExtraction: false }),
      ZONE,
    );
    expect(entry.title).toBe('Document added — lab report');
    expect(entry.detail).toBeNull();
  });
});

/* =========================================================================
 * Media
 * ====================================================================== */

describe('media', () => {
  it('attaches the referenced object', () => {
    const entry = projectEvent(event('Media.Uploaded', { mediaObjectId: 'mo-2', kind: 'image' }), ZONE);

    expect(entry.media).toHaveLength(1);
    expect(entry.media[0]?.mediaObjectId).toBe('mo-2');
  });

  it('marks a progress photo encrypted so the timeline shows a placeholder', () => {
    const entry = projectEvent(event('ProgressPhoto.Uploaded', SAMPLE_PAYLOADS['ProgressPhoto.Uploaded']), ZONE);

    // §5.5 sensitive tier: the server holds ciphertext. Requesting a signed URL
    // would render a broken image for every skin photo, which looks like a bug.
    expect(entry.media[0]?.isEncrypted).toBe(true);
    expect(entry.media[0]?.complianceScore).toBe(0.92);
  });

  it('does not mark an ordinary media object encrypted', () => {
    const entry = projectEvent(event('Media.Uploaded', { mediaObjectId: 'mo-2', kind: 'image' }), ZONE);
    expect(entry.media[0]?.isEncrypted).toBe(false);
  });

  it('attaches nothing when the payload references no object', () => {
    expect(projectEvent(event('Sleep.Recorded', {}), ZONE).media).toEqual([]);
  });
});

/* =========================================================================
 * Links
 * ====================================================================== */

describe('links', () => {
  it('turns payload reference ids into related links', () => {
    const entry = projectEvent(
      event('Workout.SetLogged', SAMPLE_PAYLOADS['Workout.SetLogged'], {
        subject: { type: 'workout_set', id: 'set-1' },
      }),
      ZONE,
    );

    const related = entry.links.filter((link) => link.relation === 'related');
    expect(related).toEqual([
      { entityType: 'session', entityId: 'sess-1', relation: 'related' },
      { entityType: 'exercise', entityId: 'ex-1', relation: 'related' },
    ]);
  });

  it('converts a camelCase reference key to a snake_case entity type', () => {
    const entry = projectEvent(
      event('Appointment.Created', { medicalEventId: 'me-1' }, { subject: { type: 'x', id: 'y' } }),
      ZONE,
    );

    expect(entry.links.map((link) => link.entityType)).toContain('medical_event');
  });

  it('does not duplicate the subject as a related link', () => {
    const entry = projectEvent(
      event('Document.Uploaded', { documentId: 'doc-1', documentKind: 'lab_report', awaitingExtraction: false }, {
        subject: { type: 'document', id: 'doc-1' },
      }),
      ZONE,
    );

    expect(entry.links).toHaveLength(1);
    expect(entry.links[0]?.relation).toBe('subject');
  });
});

/* =========================================================================
 * Zone bucketing
 * ====================================================================== */

describe('the day an entry belongs to', () => {
  it('uses the capture zone, not UTC', () => {
    // 23:30 in Asia/Kolkata is 18:00 UTC the same day — but an entry captured at
    // 00:30 IST is 19:00 UTC the *previous* day, and bucketing by UTC would file
    // it under yesterday.
    const entry = projectEvent(
      event('Weight.Logged', { metricKey: 'body.weight' }, {
        occurredAt: '2026-08-03T19:00:00Z',
        metadata: { zone: 'Asia/Kolkata' },
      }),
      'UTC',
    );

    expect(entry.occurredOn).toBe('2026-08-04');
    expect(entry.zone).toBe('Asia/Kolkata');
  });

  it('falls back to the profile zone when the event carries none', () => {
    const entry = projectEvent(
      event('Weight.Logged', { metricKey: 'body.weight' }, {
        occurredAt: '2026-08-03T19:00:00Z',
        metadata: {},
      }),
      'Asia/Kolkata',
    );

    expect(entry.occurredOn).toBe('2026-08-04');
    // Null, not the fallback: the event genuinely did not record a zone, and
    // §5.3's information loss should be visible rather than papered over.
    expect(entry.zone).toBeNull();
  });

  it('files a late-evening entry under the local date, not the next UTC day', () => {
    const entry = projectEvent(
      event('Journal.Created', { hasPrompt: false }, {
        occurredAt: '2026-08-03T18:00:00Z',
        metadata: { zone: 'Asia/Kolkata' },
      }),
      'UTC',
    );

    // 23:30 IST. The Daily Close happens here, so getting this wrong would file
    // most of the user's closes under the following day.
    expect(entry.occurredOn).toBe('2026-08-03');
  });

  it('preserves occurredAt as the instant, untouched', () => {
    const entry = projectEvent(
      event('Weight.Logged', { metricKey: 'body.weight' }, { occurredAt: '2026-08-03T19:00:00Z' }),
      ZONE,
    );
    expect(entry.occurredAt).toBe('2026-08-03T19:00:00Z');
  });
});
