/**
 * Focus sessions — §4.8.
 *
 * §4.8: "deep-work sessions and energy mapping across the day, cross-referenced
 * with sleep and mood."
 *
 * ## Interruptions are typed in, never detected
 *
 * A system that counted interruptions would have to watch what the operator was
 * doing — window focus, keystroke gaps, notification delivery. That is a
 * surveillance apparatus, and building one inside a system whose first principle
 * is that the record belongs to its subject would be a category error. The
 * number is entered afterwards, by the person who was there.
 *
 * ## Energy mapping reads observations rather than storing them
 *
 * `mind.energy` is already an observation on the substrate. This module records
 * when deep work happened; the energy it happened at is joined, not copied.
 * §9.3(4): derived state must not become a second, drifting source of truth.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';
import { minutesBetween } from './load';

export type FocusSession = {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly zone: string;
  readonly dayKey: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly label: string | null;
  readonly quality: number | null;
  readonly interruptions: number | null;
  readonly note: string | null;
};

export type FocusSessionInput = {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly zone: string;
  readonly dayKey: string;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly label?: string | null;
  readonly quality?: number | null;
  readonly interruptions?: number | null;
  readonly note?: string | null;
};

/**
 * A session shorter than this is not deep work.
 *
 * Fifteen minutes. Below that the setup cost dominates, and a list littered
 * with four-minute "sessions" makes the total meaningless — which matters
 * because the total is the number laid next to sleep and mood.
 */
export const MIN_FOCUS_MINUTES = 15;

export function validateFocusSession(input: FocusSessionInput): Result<FocusSessionInput, DomainError> {
  if (parseInstant(input.startedAt) === null) {
    return err(validationError('focus_started_invalid', 'startedAt must be an ISO-8601 instant.'));
  }

  const ended = input.endedAt ?? null;
  if (ended !== null) {
    if (parseInstant(ended) === null) {
      return err(validationError('focus_ended_invalid', 'endedAt must be an ISO-8601 instant.'));
    }
    if (ended < input.startedAt) {
      return err(validationError('focus_ends_before_start', 'A session cannot end before it started.'));
    }
    if (minutesBetween(input.startedAt, ended) < MIN_FOCUS_MINUTES) {
      return err(
        validationError(
          'focus_too_short',
          `A focus session shorter than ${String(MIN_FOCUS_MINUTES)} minutes is not deep work.`,
        ),
      );
    }
  }

  const quality = input.quality ?? null;
  if (quality !== null && (!Number.isInteger(quality) || quality < 1 || quality > 5)) {
    return err(validationError('focus_quality_range', 'Quality is 1–5, matching the Daily Close scale.'));
  }

  const interruptions = input.interruptions ?? null;
  if (interruptions !== null && (!Number.isInteger(interruptions) || interruptions < 0)) {
    return err(validationError('focus_interruptions_invalid', 'Interruptions must be zero or more.'));
  }

  return ok(input);
}

/** Total recorded deep-work minutes across a set of sessions. */
export function totalFocusMinutes(sessions: readonly FocusSession[]): number {
  return sessions.reduce((sum, session) => sum + minutesBetween(session.startedAt, session.endedAt), 0);
}

export type HourBand = {
  /** 0–23, in the zone the session was recorded in. */
  readonly hour: number;
  readonly minutes: number;
  readonly sessions: number;
};

/**
 * Minutes of deep work by hour of the day.
 *
 * §4.8's "energy mapping across the day". A session is attributed wholly to the
 * hour it *started* in, not spread across the hours it spans.
 *
 * That is a simplification and it is the right one: the question this answers is
 * "when do I start doing real work", and smearing a three-hour block across
 * three bars would make a single morning session look like a flat day. The
 * alternative also requires deciding what a session crossing midnight means,
 * which is a lot of arithmetic in service of a chart nobody would read
 * differently.
 */
export function focusByHour(
  sessions: readonly FocusSession[],
  hourOf: (instant: string, zone: string) => number,
): readonly HourBand[] {
  const bands = new Map<number, { minutes: number; sessions: number }>();
  for (let hour = 0; hour < 24; hour += 1) bands.set(hour, { minutes: 0, sessions: 0 });

  for (const session of sessions) {
    const hour = hourOf(session.startedAt, session.zone);
    const band = bands.get(hour);
    if (band === undefined) continue;
    band.sessions += 1;
    band.minutes += minutesBetween(session.startedAt, session.endedAt);
  }

  return [...bands.entries()].map(([hour, band]) => ({ hour, ...band }));
}

/**
 * The hours with the most recorded deep work, best first.
 *
 * Not "your peak hours". These are the hours the operator recorded the most
 * deep work in, which is a weaker statement — a morning they forgot to log is
 * not a morning they did nothing, and the difference matters for anyone
 * tempted to reschedule their life around this chart.
 */
export function busiestHours(bands: readonly HourBand[], limit = 3): readonly HourBand[] {
  return [...bands]
    .filter((band) => band.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || a.hour - b.hour)
    .slice(0, limit);
}
