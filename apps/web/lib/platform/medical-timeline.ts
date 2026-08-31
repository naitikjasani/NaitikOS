/**
 * The medical timeline — §10.7, and §9.2's stated payoff.
 *
 *   "The medical timeline and the Consultation Pack are **a query over one
 *    table** rather than a ten-way union that has to be edited every time a
 *    clinical domain is added."
 *
 * This file is that claim collected. Every clinical write in the system inserts
 * a `medical_event` alongside its subtype row, and this reads the supertype —
 * so a tenth clinical domain appears here without a line changing.
 *
 * ## "As known on date X" is the reason bitemporality exists
 *
 * §4.4 is blunt about the alternative: a record that cannot answer what your
 * file said in March, after a correction in October, is one that "quietly lies
 * to a clinician". `asOfIso` is that query, and it is offered on the page
 * rather than buried in an export — the moment it matters is a consultation
 * where someone asks what you were told at the time.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import { isoFromMillis, systemClock } from '@naitikos/core';
import type { Database, MedicalTimelineRow } from '@naitikos/db';
import { createHealthRepository } from '@naitikos/db';

/**
 * §10.7's clinical rendering, as a shape rather than a chronology.
 *
 *   "Conditions as intervals, medications as bars with dose changes marked,
 *    labs as points with reference ranges, procedures as events, treatment
 *    courses as spans with outcomes."
 *
 * A span has an end or is ongoing; a point happened once. That distinction is
 * the whole difference between a clinical timeline and a list sorted by date,
 * and it is decided here rather than in the component so the print view and the
 * screen cannot disagree about it.
 */
export type TimelineShape = 'interval' | 'point';

export const SHAPE_BY_TYPE: Readonly<Record<string, TimelineShape>> = Object.freeze({
  condition: 'interval',
  medication: 'interval',
  medication_schedule: 'interval',
  treatment_course: 'interval',
  symptom: 'interval',
  side_effect: 'interval',
  lab_panel: 'point',
  appointment: 'point',
  procedure: 'point',
});

export type TimelineEntry = MedicalTimelineRow & {
  readonly shape: TimelineShape;
  /** True for an interval with no end. Rendered as continuing, never as closed. */
  readonly ongoing: boolean;
};

export type MedicalTimeline = {
  readonly entries: readonly TimelineEntry[];
  /** The date the record was reconstructed at, or `null` for current belief. */
  readonly asOfIso: string | null;
  /**
   * How many entries the reconstruction *hides* relative to today.
   *
   * Shown, because a past view silently containing less than the present one
   * would read as data loss. §9.5's point is that both views are true; a reader
   * needs to be told which one they are looking at and what it costs.
   */
  readonly hiddenByReconstruction: number;
};

export async function loadMedicalTimeline(
  db: Database,
  options: { readonly asOfIso?: string } = {},
): Promise<Result<MedicalTimeline, DomainError>> {
  const health = createHealthRepository(db);

  const current = await health.medicalTimeline();
  if (!current.ok) return current;

  if (options.asOfIso === undefined) {
    return ok({ entries: current.value.map(toEntry), asOfIso: null, hiddenByReconstruction: 0 });
  }

  const past = await health.medicalTimeline({ asOfIso: options.asOfIso });
  if (!past.ok) return past;

  return ok({
    entries: past.value.map(toEntry),
    asOfIso: options.asOfIso,
    hiddenByReconstruction: Math.max(0, current.value.length - past.value.length),
  });
}

function toEntry(row: MedicalTimelineRow): TimelineEntry {
  const shape = SHAPE_BY_TYPE[row.type] ?? 'point';
  return { ...row, shape, ongoing: shape === 'interval' && row.validTo === null };
}

/** Today, for the reconstruction control's upper bound. */
export function nowIso(): string {
  return isoFromMillis(systemClock.nowMillis());
}

export type { MedicalTimelineRow };
