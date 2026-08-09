/**
 * Turning a submitted Daily Close into writes.
 *
 * Pure. No IO, no framework, no clock — the caller supplies the day's current
 * state and the instant, and gets back a plan the repository executes in one
 * transaction. That split is what makes the interesting rules testable from a
 * literal instead of from a database, and the interesting rules here are all
 * about *repeat* submissions.
 *
 * ## The four rules, and why each exists
 *
 * 1. **A partial close is a close.** §4.0: "Every field is optional. A partial
 *    close counts as a close. This is deliberate: a system that rejects
 *    incomplete data trains you to skip it entirely on a bad day, and bad days
 *    are the most clinically interesting days you have."
 *
 * 2. **Re-submitting corrects; it does not duplicate.** The operator closes at
 *    21:00 with four fields, remembers the rest at 23:30, and submits again.
 *    §9.1 makes the second submission a *supersession* — a new observation with
 *    the old one pointing at it, both surviving — rather than an edit.
 *
 * 3. **An unchanged answer writes nothing.** Re-submitting an identical value
 *    would otherwise produce a correction chain of identical numbers, which
 *    turns "how many times did I revise this?" into noise and inflates the
 *    append-only log for no information.
 *
 * 4. **The completion marker is written once per day.** `system.daily_close.
 *    completed` is the North Star input (§1.5: "Compounding Days is the count
 *    of these in the trailing 90"), so a second marker on the same day would
 *    double-count that day forever.
 */

import { type Result, err, ok } from '@naitikos/shared';

import { type DomainError, preconditionFailedError, validationError } from '../errors/domain-error';
import { isoFromMillis, parseInstant } from '../temporal/instant';
import { isIanaZone, zonedDayBounds } from '../temporal/zone';
import { compareDecimal, parseDecimal } from '../units/decimal';
import type { MetricRegistry } from '../observations/metric';
import type { ObservationInput, ObservationValueInput } from '../observations/observation';
import { normaliseValue } from '../observations/write';
import { dayKeyInZone } from '../timeline/grouping';

/** The metric that marks a day as closed (§1.5). */
export const CLOSE_COMPLETION_METRIC = 'system.daily_close.completed';

/** Recorded on every correction the Close makes, so the chain explains itself. */
export const CLOSE_REVISION_REASON = 'Revised in a later Daily Close on the same day.';

/* -------------------------------------------------------------------------
 * Input
 * ---------------------------------------------------------------------- */

export type CloseAnswer =
  | { readonly kind: 'metric'; readonly metricKey: string; readonly value: ObservationValueInput }
  | { readonly kind: 'medication'; readonly medicationId: string; readonly taken: boolean }
  | { readonly kind: 'note'; readonly text: string };

export type CloseSubmission = {
  /** `YYYY-MM-DD`, in {@link CloseSubmission.zone}. */
  readonly dayKey: string;
  readonly zone: string;
  /** Only the fields the operator actually answered. */
  readonly answers: readonly CloseAnswer[];
};

/** One current, non-superseded observation already recorded for the day. */
export type ExistingObservation = {
  readonly id: string;
  readonly metricKey: string;
  readonly value: string;
  readonly valueText: string | null;
};

export type ExistingMedicationEvent = {
  readonly id: string;
  readonly medicationId: string;
  readonly kind: 'taken' | 'skipped' | 'delayed';
};

/** What the day already holds. Supplied by the repository. */
export type ExistingCloseState = {
  readonly observations: readonly ExistingObservation[];
  readonly medicationEvents: readonly ExistingMedicationEvent[];
  readonly note: { readonly id: string; readonly content: string } | null;
};

export type ClosePlanContext = {
  readonly registry: MetricRegistry;
  /** Now, as an ISO instant. */
  readonly now: string;
  readonly newId: () => string;
};

/* -------------------------------------------------------------------------
 * Output
 * ---------------------------------------------------------------------- */

export type MedicationEventWrite = {
  readonly id: string;
  readonly medicationId: string;
  readonly kind: 'taken' | 'skipped';
  readonly takenAt: string | null;
  readonly zone: string;
  /** Set when this replaces an existing event for the same day. */
  readonly replaces: string | null;
};

export type NoteWrite = {
  readonly id: string;
  readonly content: string;
  /** The observation this line belongs to — the day's completion marker. */
  readonly entityType: 'observation';
  readonly entityId: string;
  readonly isNew: boolean;
};

export type ClosePlan = {
  readonly dayKey: string;
  readonly zone: string;
  /** When the recorded facts were true. See {@link resolveObservedAt}. */
  readonly observedAt: string;
  /** Ready for `prepareObservations`; corrections already carry `supersedes`. */
  readonly observations: readonly ObservationInput[];
  readonly medicationEvents: readonly MedicationEventWrite[];
  readonly note: NoteWrite | null;
  /** Set when the operator cleared a note that existed. */
  readonly noteRemovalId: string | null;
  /** Metric keys whose submitted answer matched what was already recorded. */
  readonly unchanged: readonly string[];
  readonly isFirstCloseOfDay: boolean;
  /** The id of the day's completion marker, existing or newly minted. */
  readonly completionObservationId: string;
};

/* -------------------------------------------------------------------------
 * observedAt
 * ---------------------------------------------------------------------- */

/**
 * When the recorded facts were true.
 *
 * §9.5 splits *when it happened* from *when the system was told*, and the Close
 * is the case where they routinely differ: a close submitted at 00:40 is
 * usually about yesterday. So:
 *
 * - closing the current local day → **now**, which is both true and precise;
 * - closing an earlier day → the **last instant of that day**, which is the
 *   latest moment the answers could describe.
 *
 * The alternative, local noon, was rejected: it puts a fact in the middle of a
 * day that had not finished when the fact was formed, and it would sort a
 * back-filled close *before* observations genuinely captured that evening.
 *
 * `recordedAt` is always now, so the divergence stays visible rather than being
 * flattened into one timestamp.
 */
export function resolveObservedAt(dayKey: string, zone: string, now: string): string | null {
  /*
   * The zone gate comes first, and it has to.
   *
   * `dayKeyInZone` is deliberately tolerant — a bad zone mis-files one entry
   * rather than blanking the timeline — and `Intl` accepts `IST`. So without
   * this line the "same day" short-circuit below answers before
   * `zonedDayBounds` ever gets a chance to refuse, and an invalid zone returns
   * a plausible instant. `planDailyClose` validates separately, but this
   * function is exported and must not depend on its caller for correctness.
   */
  if (!isIanaZone(zone)) return null;

  if (dayKeyInZone(now, zone) === dayKey) return now;

  const bounds = zonedDayBounds(dayKey, zone);
  if (bounds === null) return null;

  const end = parseInstant(bounds.end);
  if (end === null) return null;

  // One millisecond inside the half-open interval. Using `end` itself would
  // file the observation on the following day, which is the bug this whole
  // function exists to avoid.
  const lastMillis = end.getTime() - 1;

  const nowInstant = parseInstant(now);
  if (nowInstant === null) return null;

  // A close for a *future* day cannot claim a future observedAt. Clamped here,
  // and rejected outright by the guard in `planDailyClose`.
  return lastMillis > nowInstant.getTime() ? now : isoFromMillis(lastMillis);
}

/* -------------------------------------------------------------------------
 * The plan
 * ---------------------------------------------------------------------- */

/**
 * Compare a submitted value against one already recorded.
 *
 * By decimal value rather than by string, because `numeric(20,6)` reads `1`
 * back as `1.000000`. A string comparison here would find every boolean and
 * every category "changed" on a re-submission and write a correction chain of
 * identical answers.
 */
function sameValue(recorded: ExistingObservation, value: string, valueText: string | null): boolean {
  if (recorded.valueText !== valueText) return false;
  const a = parseDecimal(recorded.value);
  const b = parseDecimal(value);
  if (a === null || b === null) return recorded.value === value;
  return compareDecimal(a, b) === 0;
}

export function planDailyClose(
  submission: CloseSubmission,
  existing: ExistingCloseState,
  context: ClosePlanContext,
): Result<ClosePlan, DomainError> {
  const { dayKey, zone } = submission;

  /* --- Shape of the day itself ----------------------------------------- */

  if (!isIanaZone(zone)) {
    return err(
      validationError('close_zone_invalid', 'The Close needs a recognised IANA time zone.', [
        { path: ['zone'], message: 'Not a recognised IANA time zone.' },
      ]),
    );
  }

  if (zonedDayBounds(dayKey, zone) === null) {
    return err(
      validationError('close_day_invalid', 'The Close needs a YYYY-MM-DD day key.', [
        { path: ['dayKey'], message: 'Not a valid calendar day.' },
      ]),
    );
  }

  const today = dayKeyInZone(context.now, zone);
  if (dayKey > today) {
    /*
     * A future close is refused rather than clamped. §9.1's append-only record
     * has no mechanism for un-recording a day that has not happened, and the
     * plausible cause — a phone whose clock is set wrong — is exactly what the
     * HLC's drift ceiling is also guarding against.
     */
    return err(
      preconditionFailedError(
        'close_day_not_in_past',
        'Cannot close a day that has not happened yet.',
        'close_future_day',
      ),
    );
  }

  const observedAt = resolveObservedAt(dayKey, zone, context.now);
  if (observedAt === null) {
    return err(
      validationError('close_day_invalid', 'The Close needs a resolvable day.', [
        { path: ['dayKey'], message: 'Could not resolve this day in this zone.' },
      ]),
    );
  }

  /* --- Index what the day already holds --------------------------------- */

  const recorded = new Map<string, ExistingObservation>();
  for (const observation of existing.observations) recorded.set(observation.metricKey, observation);

  const existingCompletion = recorded.get(CLOSE_COMPLETION_METRIC) ?? null;
  const isFirstCloseOfDay = existingCompletion === null;

  const medicationEventsById = new Map<string, ExistingMedicationEvent>();
  for (const event of existing.medicationEvents) medicationEventsById.set(event.medicationId, event);

  /* --- Walk the answers -------------------------------------------------- */

  const observations: ObservationInput[] = [];
  const medicationEvents: MedicationEventWrite[] = [];
  const unchanged: string[] = [];
  const issues: { path: readonly (string | number)[]; message: string }[] = [];
  const seenMetrics = new Set<string>();
  let noteText: string | null = null;

  for (const [index, answer] of submission.answers.entries()) {
    if (answer.kind === 'note') {
      if (noteText !== null) {
        issues.push({ path: [index], message: 'The Close has one note line, not several.' });
        continue;
      }
      noteText = answer.text.trim();
      continue;
    }

    if (answer.kind === 'medication') {
      const previous = medicationEventsById.get(answer.medicationId) ?? null;
      const kind = answer.taken ? 'taken' : 'skipped';

      if (previous !== null && previous.kind === kind) continue;

      medicationEvents.push({
        id: context.newId(),
        medicationId: answer.medicationId,
        kind,
        // The check constraint `medication_event_taken_paired` requires this.
        takenAt: answer.taken ? observedAt : null,
        zone,
        replaces: previous === null ? null : previous.id,
      });
      continue;
    }

    /* --- A metric answer ------------------------------------------------- */

    if (seenMetrics.has(answer.metricKey)) {
      issues.push({ path: [index, 'metricKey'], message: 'Answered twice in one Close.' });
      continue;
    }
    seenMetrics.add(answer.metricKey);

    const metric = context.registry.get(answer.metricKey);
    if (metric === null) {
      return err(
        preconditionFailedError(
          'metric_registered',
          `Metric ${answer.metricKey} is not registered.`,
          'metric_not_registered',
        ),
      );
    }

    if (!metric.inDailyClose) {
      /*
       * The Close writes Close metrics. Accepting anything else would make the
       * eleven-element budget meaningless — the form would stay small while the
       * endpoint let any metric in through the same door.
       */
      issues.push({ path: [index, 'metricKey'], message: `${metric.key} is not a Daily Close metric.` });
      continue;
    }

    const normalised = normaliseValue(metric, answer.value, [index]);
    if (!normalised.ok) {
      issues.push(...normalised.error);
      continue;
    }

    const previous = recorded.get(metric.key) ?? null;
    if (previous !== null && sameValue(previous, normalised.value.value, normalised.value.valueText)) {
      unchanged.push(metric.key);
      continue;
    }

    observations.push({
      id: context.newId(),
      metricKey: metric.key,
      value: answer.value,
      observedAt,
      observedZone: zone,
      ...(previous === null ? {} : { supersedes: { id: previous.id, reason: CLOSE_REVISION_REASON } }),
    });
  }

  if (issues.length > 0) {
    return err(validationError('close_invalid', 'The Daily Close could not be recorded.', issues));
  }

  /* --- The completion marker -------------------------------------------- */

  const completionObservationId = existingCompletion?.id ?? context.newId();

  if (isFirstCloseOfDay) {
    observations.push({
      id: completionObservationId,
      metricKey: CLOSE_COMPLETION_METRIC,
      value: { kind: 'boolean', value: true },
      observedAt,
      observedZone: zone,
    });
  }

  /* --- The note ---------------------------------------------------------- */

  let note: NoteWrite | null = null;
  let noteRemovalId: string | null = null;

  if (noteText !== null) {
    if (noteText === '') {
      // Submitting a blank line clears the note. Tombstoned, not erased (§9.4).
      noteRemovalId = existing.note?.id ?? null;
    } else if (existing.note === null) {
      note = {
        id: context.newId(),
        content: noteText,
        entityType: 'observation',
        entityId: completionObservationId,
        isNew: true,
      };
    } else if (existing.note.content !== noteText) {
      /*
       * The note is an entity, not an observation, so it is edited in place and
       * its prior text is preserved in `audit_log` (§9.4) rather than in a
       * supersession chain. Two mechanisms for history would be one too many.
       */
      note = {
        id: existing.note.id,
        content: noteText,
        entityType: 'observation',
        entityId: completionObservationId,
        isNew: false,
      };
    }
  }

  return ok({
    dayKey,
    zone,
    observedAt,
    observations,
    medicationEvents,
    note,
    noteRemovalId,
    unchanged,
    isFirstCloseOfDay,
    completionObservationId,
  });
}

/**
 * Whether a plan would change anything.
 *
 * The route handler uses this to answer a repeat submission with "nothing to
 * do" rather than opening a transaction. Worth having explicitly: the offline
 * outbox replays, and a replay that reaches the database and writes nothing is
 * still a replay that took a connection and a round trip.
 */
export function isEmptyPlan(plan: ClosePlan): boolean {
  return (
    plan.observations.length === 0 &&
    plan.medicationEvents.length === 0 &&
    plan.note === null &&
    plan.noteRemovalId === null
  );
}
