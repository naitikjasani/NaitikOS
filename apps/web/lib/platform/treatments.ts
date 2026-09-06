/**
 * Treatment courses — §3.2's `/body/skin/treatments`.
 *
 * ## Why a course is not filtered to Skin, and why that is stated
 *
 * `treatment_course` is a `medical_event` subtype and carries no pillar. It
 * points at a condition, and a condition is not tagged Skin either — §9.3's
 * whole design is that pillars are queries over one record rather than separate
 * databases, so there is no `is_dermatological` column to filter on and adding
 * one would be inventing a taxonomy to make a page tidier.
 *
 * So this lists every course and names the condition each treats. The page says
 * so. A filter that guessed which courses were dermatological would eventually
 * hide one, and a treatment silently missing from a treatment page is worse
 * than a treatment that is not strictly about skin appearing on it.
 *
 * ## Cumulative dose is the reason this page exists
 *
 * `cumulative_dose` is on the table for one clinical reason, recorded in the
 * schema: a course of isotretinoin is dosed to a lifetime cumulative total, and
 * "how much have I had, in mg/kg, across every course" is a question a
 * dermatologist asks and a person cannot answer from memory five years later.
 * That figure is the deliverable here; everything else is context for it.
 *
 * The system does **not** compute a per-kilogram figure or compare it against a
 * target. Both depend on a weight at the time of dosing and on guidance that
 * differs by jurisdiction and by year — §10.0 keeps the application out of
 * clinical judgement, and a number carrying an implied threshold is a judgement
 * whatever the label says.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import type { Database, TreatmentCourseRow } from '@naitikos/db';
import { createHealthRepository } from '@naitikos/db';

export type TreatmentView = {
  readonly course: TreatmentCourseRow;
  /** The condition's label, or `null` when the course names none. */
  readonly conditionName: string | null;
  /** True while `endedAt` is unset — a course being run right now. */
  readonly isCurrent: boolean;
};

export type TreatmentsBoard = {
  /** Most recently started first. Current courses are the ones with no end. */
  readonly treatments: readonly TreatmentView[];
  /**
   * Cumulative dose summed per unit, across every course that records one.
   *
   * Keyed by unit rather than totalled, because summing mg and g would be the
   * §6.2 failure this system exists to avoid. Two units means two lines, and
   * the operator can see that they are two.
   */
  readonly cumulativeByUnit: readonly { readonly unit: string; readonly total: string }[];
};

export async function loadTreatments(db: Database): Promise<Result<TreatmentsBoard, DomainError>> {
  const health = createHealthRepository(db);

  const [courses, conditions] = await Promise.all([health.treatmentCourses(), health.conditions()]);
  if (!courses.ok) return courses;
  if (!conditions.ok) return conditions;

  const conditionName = new Map(conditions.value.map((condition) => [condition.id, condition.name]));

  const totals = new Map<string, number>();
  for (const course of courses.value) {
    if (course.cumulativeDose === null || course.cumulativeDoseUnit === null) continue;
    const value = Number(course.cumulativeDose);
    if (!Number.isFinite(value)) continue;
    totals.set(course.cumulativeDoseUnit, (totals.get(course.cumulativeDoseUnit) ?? 0) + value);
  }

  return ok({
    treatments: courses.value.map((course) => ({
      course,
      conditionName: course.conditionId === null ? null : (conditionName.get(course.conditionId) ?? null),
      isCurrent: course.endedAt === null,
    })),
    /*
     * Formatted here rather than in the component, and trimmed rather than
     * rounded. §5.3 stores these as `numeric`; a display that rounded 12.5 to
     * 13 would be the only place in the system where a dose loses precision on
     * the way to a person's eyes.
     */
    cumulativeByUnit: [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([unit, total]) => ({ unit, total: trimZeros(total.toFixed(6)) })),
  });
}

/** `12.500000` → `12.5`, `40.000000` → `40`. Display only. */
function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/u, '').replace(/\.$/u, '') : value;
}
