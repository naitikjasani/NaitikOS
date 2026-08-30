/**
 * The projector: `DomainEvent` → `TimelineEntry`.
 *
 * Pure, total, and the only place an event becomes a timeline row. Being pure is
 * what makes a rebuild trustworthy — replaying the log through this function
 * twice produces byte-identical entries, so truncating the timeline table and
 * rebuilding is a safe operation rather than a hopeful one.
 *
 * ## Total, deliberately
 *
 * Every registered event type produces an entry. There is no `null` return and
 * no "unknown event" branch that silently drops rows: an event that reaches here
 * and produces nothing is data the user created and cannot see, which is the
 * worst failure this system can have short of losing the row outright.
 *
 * A type with no bespoke renderer falls back to its registry `describes` string.
 * Ugly, and visible — which is the correct kind of wrong.
 */

import type { DomainEvent } from '../events/envelope';
import { describeEvent } from '../events/registry';
import type { EventType } from '../events/registry';
import type { TimelineEntry, TimelineLink, TimelineMedia } from './types';
import { dayKeyInZone } from './grouping';

/** A rendered summary. `detail` is the second line, or absent. */
type Rendered = { readonly title: string; readonly detail: string | null };

/**
 * Per-type renderers.
 *
 * Reading the payload only — never joining. That is the constraint that keeps a
 * timeline rebuild a single pass over one table.
 *
 * Phrasing rule: **descriptive, never evaluative.** §8.2 forbids colour
 * encoding valence and the same applies to language. "Dose skipped" is a fact;
 * "Missed dose" carries blame, and P6 rules out a tool that scolds.
 */
const RENDERERS: Partial<Record<EventType, (event: DomainEvent) => Rendered>> = {
  'Medication.Taken': (event) => {
    const p = event.payload as { substanceLabel: string };
    return { title: `${p.substanceLabel} taken`, detail: null };
  },
  'Medication.Skipped': (event) => {
    const p = event.payload as { substanceLabel: string };
    // "Skipped", not "missed". A skip is a decision the user made.
    return { title: `${p.substanceLabel} skipped`, detail: null };
  },
  'Medication.Delayed': (event) => {
    const p = event.payload as { substanceLabel: string };
    return { title: `${p.substanceLabel} taken late`, detail: null };
  },
  'Supplement.Taken': (event) => {
    const p = event.payload as { substanceLabel: string };
    return { title: `${p.substanceLabel} taken`, detail: null };
  },

  'Workout.Started': () => ({ title: 'Training session started', detail: null }),
  'Workout.Completed': (event) => {
    const p = event.payload as { setCount: number; exerciseCount: number; durationMinutes?: number };
    const parts = [
      `${String(p.exerciseCount)} exercise${p.exerciseCount === 1 ? '' : 's'}`,
      `${String(p.setCount)} set${p.setCount === 1 ? '' : 's'}`,
    ];
    if (p.durationMinutes !== undefined) parts.push(`${String(Math.round(p.durationMinutes))} min`);
    return { title: 'Training session completed', detail: parts.join(' · ') };
  },
  'Workout.SetLogged': (event) => {
    const p = event.payload as { exerciseLabel: string; isPersonalRecord: boolean };
    return {
      title: p.exerciseLabel,
      // A PR is a factual comparison against the user's own history, not a
      // judgement — so it is noted rather than celebrated (P6: no badges).
      detail: p.isPersonalRecord ? 'Personal record' : null,
    };
  },

  'Weight.Logged': () => ({ title: 'Bodyweight recorded', detail: null }),
  'BodyMeasurement.Recorded': (event) => {
    const p = event.payload as { site: string };
    return { title: `${p.site} measured`, detail: null };
  },
  'Sleep.Recorded': () => ({ title: 'Sleep recorded', detail: null }),

  'SkinRoutine.Completed': (event) => {
    const p = event.payload as { period: string; stepsCompleted: number; stepsRequired: number };
    return {
      title: `${p.period.toUpperCase()} skincare routine`,
      // A ratio of counts. Not scored, not coloured.
      detail: `${String(p.stepsCompleted)} of ${String(p.stepsRequired)} steps`,
    };
  },
  'SkinState.Logged': () => ({ title: 'Skin state recorded', detail: null }),
  /* No macro totals in the title. The timeline says a meal happened; what was
   * in it is a click away, in the table that actually holds it. */
  'Meal.Logged': () => ({ title: 'Meal logged', detail: null }),

  // Mood, journal, and anxiety render with NO content and no value.
  // §4.7 gives Mind the highest duty of care; a timeline that displays "Mood: 2"
  // in a list is a running commentary on the user's mental state, and §8.2
  // forbids rendering health data by valence. The value is one tap away in the
  // entity it links to.
  'Mood.Logged': () => ({ title: 'Mood recorded', detail: null }),
  'AnxietyEpisode.Logged': () => ({ title: 'Anxiety episode recorded', detail: null }),
  'Journal.Created': (event) => {
    const p = event.payload as { hasPrompt: boolean };
    return { title: 'Journal entry', detail: p.hasPrompt ? 'From a prompt' : null };
  },
  'Journal.Updated': () => ({ title: 'Journal entry edited', detail: null }),
  'Practice.Completed': () => ({ title: 'Practice session', detail: null }),

  'ProgressPhoto.Uploaded': (event) => {
    const p = event.payload as { region?: string };
    return {
      title: p.region === undefined ? 'Progress photo' : `Progress photo — ${p.region}`,
      detail: null,
    };
  },
  'Media.Uploaded': () => ({ title: 'Media added', detail: null }),
  'Document.Uploaded': (event) => {
    const p = event.payload as { documentKind: string; awaitingExtraction: boolean };
    return {
      title: `Document added — ${p.documentKind.replace(/_/g, ' ')}`,
      detail: p.awaitingExtraction ? 'Text extraction pending' : null,
    };
  },
  'Report.Imported': (event) => {
    const p = event.payload as { extractedRowCount: number; method: string };
    return {
      title: 'Report imported',
      detail: `${String(p.extractedRowCount)} row${p.extractedRowCount === 1 ? '' : 's'} via ${p.method}`,
    };
  },

  'Appointment.Created': (event) => {
    const p = event.payload as { specialty?: string };
    return {
      title: p.specialty === undefined ? 'Appointment scheduled' : `${p.specialty} appointment scheduled`,
      detail: null,
    };
  },
  'Appointment.Attended': (event) => {
    const p = event.payload as { specialty?: string };
    return {
      title: p.specialty === undefined ? 'Appointment attended' : `${p.specialty} appointment`,
      detail: null,
    };
  },

  'Goal.Completed': (event) => {
    const p = event.payload as { goalTitle: string };
    return { title: `Goal reached — ${p.goalTitle}`, detail: null };
  },
  'Task.Completed': (event) => {
    const p = event.payload as { taskTitle: string };
    return { title: p.taskTitle, detail: null };
  },

  'DailyClose.Completed': (event) => {
    const p = event.payload as { fieldsCompleted: number; fieldsAvailable: number };
    const isPartial = p.fieldsCompleted < p.fieldsAvailable;
    return {
      title: 'Daily Close',
      // §4.0: "A partial close counts as a close." Stated neutrally — the
      // alternative wording ("incomplete") implies a failure, and §4.0 is
      // explicit that partial closes are the clinically interesting days.
      detail: isPartial ? `${String(p.fieldsCompleted)} of ${String(p.fieldsAvailable)} recorded` : null,
    };
  },

  'Observation.Recorded': (event) => {
    const p = event.payload as { metricKey: string };
    return { title: p.metricKey, detail: null };
  },
};

/** Media referenced by an event, if any. */
function mediaFor(event: DomainEvent): readonly TimelineMedia[] {
  const payload = event.payload as Record<string, unknown>;
  const mediaObjectId = payload['mediaObjectId'];
  if (typeof mediaObjectId !== 'string') return [];

  const kind = typeof payload['kind'] === 'string' ? payload['kind'] : 'image';
  const complianceScore =
    typeof payload['complianceScore'] === 'number' ? payload['complianceScore'] : undefined;

  return [
    {
      mediaObjectId,
      kind,
      /**
       * Progress photos are always sensitive-tier (§5.5) and therefore
       * client-side encrypted. The timeline shows a placeholder rather than
       * requesting a signed URL it cannot decrypt.
       */
      isEncrypted: event.eventType === 'ProgressPhoto.Uploaded',
      ...(complianceScore === undefined ? {} : { complianceScore }),
    },
  ];
}

/** Links from an entry back to the rows it describes. */
function linksFor(event: DomainEvent): readonly TimelineLink[] {
  const links: TimelineLink[] = [
    { entityType: event.subject.type, entityId: event.subject.id, relation: 'subject' },
  ];

  // Reference ids in the payload become `related` links. Keyed on the `*Id`
  // convention, which `registry.test.ts` asserts the payload specs follow.
  const payload = event.payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (!key.endsWith('Id') || typeof value !== 'string') continue;
    const entityType = key.slice(0, -2).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (entityType === event.subject.type && value === event.subject.id) continue;
    links.push({ entityType, entityId: value, relation: 'related' });
  }

  return links;
}

/**
 * Project one event.
 *
 * @param event - already upcast to the current payload version.
 * @param profileZone - fallback when the event carries no capture zone.
 */
export function projectEvent(event: DomainEvent, profileZone: string): TimelineEntry {
  const descriptor = describeEvent(event.eventType);
  const renderer = RENDERERS[event.eventType];

  const rendered: Rendered =
    renderer === undefined
      ? // The visible fallback. See the header: no silent drop.
        { title: descriptor.describes, detail: null }
      : renderer(event);

  const zone = event.metadata.zone ?? null;

  return {
    eventId: event.eventId,
    // Projection requires an appended event. A caller passing an unsequenced one
    // has skipped the store, and 0 would silently sort it to the beginning of
    // history — so this is a programmer error worth being loud about.
    sequence: event.sequence ?? -1,
    eventType: event.eventType,
    category: descriptor.category,
    occurredAt: event.occurredAt,
    zone,
    /**
     * The day this belongs to, computed in the *capture* zone.
     *
     * §5.3: "A workout at '7am' during travel is a materially different fact
     * from one at 7am at home." Bucketing by UTC day would file a 23:30
     * Asia/Kolkata entry under the following date, which is the same bug the
     * design system's expression-index deviation avoided.
     */
    occurredOn: dayKeyInZone(event.occurredAt, zone ?? profileZone),
    title: rendered.title,
    detail: rendered.detail,
    significance: descriptor.significance,
    clinical: descriptor.clinical,
    correlationId: event.correlationId,
    links: linksFor(event),
    media: mediaFor(event),
    // Title and detail only. Never payload, never entity content (§4.7).
    searchText: [rendered.title, rendered.detail].filter((part) => part !== null).join(' '),
  };
}

/** Project a batch, preserving order. */
export function projectEvents(
  events: readonly DomainEvent[],
  profileZone: string,
): readonly TimelineEntry[] {
  return events.map((event) => projectEvent(event, profileZone));
}

/** Event types with a bespoke renderer. Exported so a test can assert coverage. */
export function renderedEventTypes(): readonly EventType[] {
  return Object.keys(RENDERERS) as EventType[];
}
