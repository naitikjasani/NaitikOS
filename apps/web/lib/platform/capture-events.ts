/**
 * Turning captured observations into domain events.
 *
 * This file is the payoff of the event backbone milestone. ADR 0005's promise
 * was that "every future module appears on the timeline automatically, because
 * it emits events and the projector consumes them" — and the Daily Close is the
 * first module to test that claim. There is no timeline code in this milestone.
 * The Close emits; the projector already registered in `createPlatformContext`
 * does the rest.
 *
 * ## Events reference, they do not restate
 *
 * ADR 0005's rule, and it constrains every draft below: a payload carries
 * *identifiers* and *counts*, never measured values. `Mood.Logged` says which
 * metric was recorded and which observation holds it; it does not say the mood
 * was 4. The observation is the fact and the event is the announcement, and
 * duplicating the value would create a second source of truth that drifts the
 * first time a correction is written.
 *
 * The practical consequence for the timeline: an entry renders "Mood recorded"
 * and links to the observation, rather than rendering the number. Reading the
 * number is a join, on purpose.
 */

import 'server-only';

import type { EventDraft, EventType, Observation } from '@naitikos/core';

/**
 * Which event type announces a given metric.
 *
 * A table rather than a rule, because the mapping is a *product* decision and
 * not a derivation: `body.weight` is `Weight.Logged` because weight has its own
 * timeline treatment (§4.6's seven-day trend), while `mind.anxiety` folds into
 * `Mood.Logged` because a day's anxiety baseline is part of the same daily
 * emotional record. A metric with no entry falls back to `Observation.Recorded`,
 * which is the correct default rather than a gap — the timeline still shows it.
 */
const EVENT_FOR_METRIC: Readonly<Record<string, EventType>> = {
  'mind.mood': 'Mood.Logged',
  'mind.energy': 'Mood.Logged',
  'mind.anxiety': 'Mood.Logged',
  'body.sleep.duration': 'Sleep.Recorded',
  'body.sleep.quality': 'Sleep.Recorded',
  'body.skin.state': 'SkinState.Logged',
  'body.skin.region.state': 'SkinState.Logged',
  'body.weight': 'Weight.Logged',
};

function eventTypeFor(metricKey: string): EventType {
  return Object.hasOwn(EVENT_FOR_METRIC, metricKey)
    ? (EVENT_FOR_METRIC[metricKey] as EventType)
    : 'Observation.Recorded';
}

/**
 * One draft per observation written.
 *
 * The completion marker is skipped — it gets its own `DailyClose.Completed`
 * event, and emitting both would put two entries on the timeline for one act.
 */
export function draftsForObservations(
  observations: readonly Observation[],
  actorId: string,
): readonly EventDraft[] {
  return observations
    .filter((observation) => observation.metricKey !== 'system.daily_close.completed')
    .map((observation) => {
      const eventType = eventTypeFor(observation.metricKey);

      /*
       * `Sleep.Recorded` takes no payload fields at all (its spec is empty), and
       * `Weight.Logged` takes only `metricKey`. Passing extra keys would fail
       * `validateEventPayload`, which rejects unknown fields precisely so a
       * measured value cannot be smuggled into an event.
       */
      const payload =
        eventType === 'Sleep.Recorded'
          ? {}
          : {
              metricKey: observation.metricKey,
              ...(observation.supersededById === null
                ? {}
                : { supersedesObservationId: observation.supersededById }),
            };

      return {
        eventType,
        occurredAt: observation.observedAt,
        actorId,
        source: 'user',
        // The observation, not the metric. §9.3's reference rule: an event names
        // the row it describes so the timeline can link straight to it.
        subject: { type: 'observation', id: observation.id },
        payload,
      } as EventDraft;
    });
}

/**
 * The Close's own event — §1.5's North Star, announced.
 *
 * Emitted only on the *first* close of a day. A second close is a correction to
 * an existing record, and putting a second "day closed" entry on the timeline
 * would make a revised day look like two days.
 */
export function draftForClose(
  dayKey: string,
  observedAt: string,
  completionObservationId: string,
  fieldsCompleted: number,
  fieldsAvailable: number,
  actorId: string,
): EventDraft {
  return {
    eventType: 'DailyClose.Completed',
    occurredAt: observedAt,
    actorId,
    source: 'user',
    subject: { type: 'observation', id: completionObservationId },
    payload: {
      closedOn: dayKey,
      // Counts, not values. ADR 0005 permits a `number` field only when it is a
      // count — which is exactly what these two are.
      fieldsCompleted,
      fieldsAvailable,
    },
  } as EventDraft;
}
