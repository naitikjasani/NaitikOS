/**
 * The crisis plan — §4.7's third design principle, and the most careful code in
 * the system.
 *
 *   "**Crisis-state awareness.** Sustained severe readings surface one thing
 *    only: the user's own pre-configured crisis plan and contacts, entered by
 *    them when well. Not an insight. Not a suggestion. Not a model-generated
 *    message. A stored plan, shown back."
 *
 * Read that as a specification and it says four things, all of which are
 * enforced here rather than in a component:
 *
 * **1. One thing only.** {@link CrisisSurface} has no room for anything else.
 * It carries the stored plan and the stored contacts. There is no `message`
 * field, no `suggestion`, no `severity` for a component to render a banner
 * from. If a future feature wants to add advice next to a crisis plan, it will
 * have to widen this type, which is exactly the amount of friction that
 * decision deserves.
 *
 * **2. Stored, not generated.** The strings that reach the screen are the ones
 * the operator typed. Nothing in this file composes prose.
 *
 * **3. Entered when well.** So when there is no plan, this surfaces *nothing*.
 * The obvious alternative — "you seem to be having a hard week, would you like
 * to write a crisis plan?" — is asking someone to do calm, careful, anticipatory
 * work at the exact moment they are least able to, and it converts a bad week
 * into a bad week plus a form. The invitation to write one belongs on a good
 * day; {@link shouldInvitePlanning} is that, and it is the mirror image of
 * {@link evaluateCrisisState} — it fires only when readings are *not* severe.
 *
 * **4. Sustained.** One severe day is a day. The threshold is consecutive
 * recorded days, and unrecorded days neither break the run nor extend it —
 * because a gap means the operator did not answer, which is not evidence either
 * way, and treating silence as "fine" is how a system misses the fortnight
 * somebody stopped opening it.
 */

import type { DailyEstimate } from '../../statistics/types';

/* -------------------------------------------------------------------------
 * The stored plan
 * ---------------------------------------------------------------------- */

/**
 * A contact, shaped so the UI can offer one tap.
 *
 * The schema comment says why the phone number is structured rather than free
 * text: "so the UI can offer a one-tap call without parsing free text at the
 * worst possible moment."
 */
export type CrisisContact = {
  readonly name: string;
  readonly relationship: string | null;
  readonly phone: string | null;
  readonly notes: string | null;
};

/** Mirrors `crisis_plan`. Every field is the operator's own prose. */
export type CrisisPlan = {
  readonly id: string;
  readonly isActive: boolean;
  /** Warning signs, in their own words. */
  readonly warningSigns: string | null;
  /** What has helped before. Their answer, not a computed one. */
  readonly copingStrategies: string | null;
  /** Reasons to stay safe, written when well. */
  readonly reasonsToLive: string | null;
  readonly contacts: readonly CrisisContact[];
  readonly professionalContacts: readonly CrisisContact[];
  readonly lastReviewedAt: string | null;
};

/**
 * Parse the jsonb contact arrays defensively.
 *
 * A row that has drifted — an old shape, a hand-edited column — must still
 * yield the contacts it can. Refusing the whole plan because one entry lost its
 * `notes` field would withhold a crisis plan at the moment it is needed, which
 * is the worst possible time to be strict about a schema.
 */
export function parseContacts(value: unknown): readonly CrisisContact[] {
  if (!Array.isArray(value)) return [];
  const contacts: CrisisContact[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    if (name.length === 0) continue;
    contacts.push({
      name,
      relationship: typeof record['relationship'] === 'string' ? record['relationship'] : null,
      phone: typeof record['phone'] === 'string' ? record['phone'] : null,
      notes: typeof record['notes'] === 'string' ? record['notes'] : null,
    });
  }
  return contacts;
}

/**
 * What a surface renders. Note what is absent.
 *
 * No message. No severity. No metric that triggered it. The operator does not
 * need to be told which number crossed which line about their own head; they
 * need their plan.
 */
export type CrisisSurface = {
  readonly plan: CrisisPlan;
};

/* -------------------------------------------------------------------------
 * When
 * ---------------------------------------------------------------------- */

/** Consecutive *recorded* days at a severe reading before the plan surfaces. */
export const CRISIS_CONSECUTIVE_DAYS = 3;

/** Anxiety at or above this, or mood at or below the mood bound, counts. */
export const SEVERE_ANXIETY = 4;
export const SEVERE_LOW_MOOD = 2;

export type CrisisEvaluation = {
  readonly surface: boolean;
  /** Length of the current run of severe recorded days. */
  readonly consecutiveDays: number;
  /**
   * Whether a plan exists to show.
   *
   * Separate from `surface` on purpose: a caller that conflates them cannot
   * tell "readings are fine" from "readings are not fine and there is nothing
   * stored to help", and those want different handling in a settings page.
   */
  readonly hasPlan: boolean;
};

/**
 * Evaluate the run of severe recorded days across mood and anxiety.
 *
 * Both series are day-indexed with gaps. A day counts as severe if *either*
 * reading is severe; it counts as not-severe if either reading exists and
 * neither is severe; and it is skipped entirely if neither reading exists.
 */
export function evaluateCrisisState(
  series: {
    readonly mood?: readonly DailyEstimate[];
    readonly anxiety?: readonly DailyEstimate[];
  },
  plan: CrisisPlan | null,
): CrisisEvaluation {
  const byDay = new Map<string, { mood: number | null; anxiety: number | null }>();

  for (const point of series.mood ?? []) {
    const entry = byDay.get(point.dayKey) ?? { mood: null, anxiety: null };
    byDay.set(point.dayKey, { ...entry, mood: point.value });
  }
  for (const point of series.anxiety ?? []) {
    const entry = byDay.get(point.dayKey) ?? { mood: null, anxiety: null };
    byDay.set(point.dayKey, { ...entry, anxiety: point.value });
  }

  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let run = 0;
  for (const [, reading] of days) {
    const recorded = reading.mood !== null || reading.anxiety !== null;
    if (!recorded) continue; // A gap is silence, not an answer. See the header.
    const severe =
      (reading.anxiety !== null && reading.anxiety >= SEVERE_ANXIETY) ||
      (reading.mood !== null && reading.mood <= SEVERE_LOW_MOOD);
    run = severe ? run + 1 : 0;
  }

  return {
    surface: run >= CRISIS_CONSECUTIVE_DAYS && plan !== null,
    consecutiveDays: run,
    hasPlan: plan !== null,
  };
}

/** The plan to show, or `null`. Kept separate so the surface stays trivial. */
export function crisisSurface(evaluation: CrisisEvaluation, plan: CrisisPlan | null): CrisisSurface | null {
  return evaluation.surface && plan !== null ? { plan } : null;
}

/**
 * Whether to invite the operator to write a plan.
 *
 * The inverse condition, deliberately. Asking for anticipatory work is
 * appropriate on a settled week and inappropriate on a severe one, so this
 * returns `false` for exactly the state {@link evaluateCrisisState} returns
 * `true` for — and also for a run that is building but has not reached the
 * threshold, because that is not a good week either.
 */
export function shouldInvitePlanning(evaluation: CrisisEvaluation): boolean {
  return !evaluation.hasPlan && evaluation.consecutiveDays === 0;
}
