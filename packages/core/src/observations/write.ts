/**
 * The observation write path.
 *
 * Everything that turns submitted input into a row the database will accept,
 * with no IO and no framework. §5.0 puts it here so that the same function
 * validates a Daily Close, a wearable import, and a nightly derivation — one
 * definition of what a valid observation is, rather than three that drift.
 *
 * Six things are checked, in this order, and each maps to a specific promise
 * the blueprint makes:
 *
 *   1. The metric is registered.        §9.2 — "no free-floating numbers"
 *   2. The value matches its type.      §9.2 — the registry validates on write
 *   3. Units convert to canonical.      §6.2 — "no path by which mg become mcg"
 *   4. The value is within bounds.      §9.2 — `min_value` / `max_value`
 *   5. It fits `numeric(20, 6)`.        §5.3 — no silent rounding
 *   6. Subject, zone, confidence.       §9.3(3), §5.3, §9.2
 *
 * ## Why failure is a `Result` and not an exception
 *
 * §5.12: "Functions that can fail return an explicit `Result<T, DomainError>`.
 * Exceptions are reserved for genuine bugs, not for expected outcomes." A
 * bodyweight of 900 kg is an expected outcome of a phone keyboard.
 */

import { type Result, err, ok } from '@naitikos/shared';

import {
  type DomainError,
  type ValidationError,
  preconditionFailedError,
  validationError,
} from '../errors/domain-error';
import { parseInstant } from '../temporal/instant';
import { isIanaZone } from '../temporal/zone';
import {
  type Decimal,
  checkQuantityFit,
  compareDecimal,
  formatDecimal,
  parseDecimal,
  toQuantityString,
} from '../units/decimal';
import { type UnitCode, convertQuantity, isUnitCode } from '../units/quantity';
import { type ClockAnomaly, type HlcState, hlcTick } from './hlc';
import type { MetricDefinition, MetricKey, MetricRegistry } from './metric';
import {
  type Observation,
  type ObservationId,
  type ObservationInput,
  type ObservationSourceId,
  type ObservationValueInput,
  type Supersession,
  TEXT_VALUE_PLACEHOLDER,
} from './observation';

/* -------------------------------------------------------------------------
 * Value normalisation
 * ---------------------------------------------------------------------- */

/** A value that has passed the registry and is ready for the column. */
export type NormalisedValue = {
  /** Decimal string, at the column's scale. */
  readonly value: string;
  readonly valueText: string | null;
  readonly unit: string;
};

type Issue = ValidationError['issues'][number];

function issue(path: readonly (string | number)[], message: string): Issue {
  return { path, message };
}

/**
 * Check a submitted value against its metric, converting units if needed.
 *
 * Exported because the Daily Close and the quick-capture rail both want to
 * validate a single field before assembling a whole write — and because a
 * validation rule that can only be reached through a batch API is a validation
 * rule with no unit test.
 *
 * @param path - prefix for issue paths, so a batch can say which entry failed.
 */
export function normaliseValue(
  metric: MetricDefinition,
  input: ObservationValueInput,
  path: readonly (string | number)[] = [],
): Result<NormalisedValue, readonly Issue[]> {
  const at = (...rest: (string | number)[]): readonly (string | number)[] => [...path, ...rest];

  /* --- 1. The value's shape must match the metric's declared type ------ */

  const expected = metric.valueType;
  const supplied = input.kind;

  const compatible =
    (expected === 'numeric' && supplied === 'number') ||
    (expected === 'duration' && supplied === 'number') ||
    // An integer metric accepts either form: a 1–5 tap arrives as an integer,
    // an import arrives as a decimal string. Both are checked for integrality
    // below, so the leniency costs nothing.
    (expected === 'integer' && (supplied === 'integer' || supplied === 'number')) ||
    (expected === 'boolean' && supplied === 'boolean') ||
    (expected === 'categorical' && supplied === 'category') ||
    (expected === 'text' && supplied === 'text');

  if (!compatible) {
    return err([issue(at('value'), `Metric ${metric.key} expects a ${expected} value, received ${supplied}.`)]);
  }

  /* --- 2. Text: no number, and no empty string ------------------------- */

  if (input.kind === 'text') {
    const trimmed = input.value.trim();
    if (trimmed === '') {
      // An empty text observation is not a fact. §4.0 makes Close fields
      // optional, and "optional" means the field is *omitted*, not written
      // blank — a blank row would count as a recorded answer forever.
      return err([issue(at('value'), 'A text observation cannot be empty. Omit the field instead.')]);
    }
    return ok({ value: TEXT_VALUE_PLACEHOLDER, valueText: trimmed, unit: metric.canonicalUnit });
  }

  /* --- 3. Boolean and categorical: fixed encodings --------------------- */

  /*
   * Note that both of the encodings below finish through `toQuantityString`,
   * exactly like a measured number.
   *
   * Not cosmetic. `numeric(20,6)` reads a stored `1` back as `1.000000`, so an
   * encoding that emitted a bare `'1'` here would make "is the submitted value
   * the same as the recorded one?" false for every boolean and every category
   * — and that comparison is what stops a re-submitted Daily Close writing a
   * pointless correction over an identical answer.
   */

  if (input.kind === 'boolean') {
    return ok({
      value: toQuantityString({ unscaled: input.value ? 1n : 0n, scale: 0 }),
      valueText: null,
      unit: metric.canonicalUnit,
    });
  }

  if (input.kind === 'category') {
    const allowed = metric.allowedValues;
    if (allowed === null || allowed.length === 0) {
      return err([
        issue(at('value'), `Metric ${metric.key} is categorical but registers no allowed values.`),
      ]);
    }
    const ordinal = allowed.indexOf(input.value);
    if (ordinal < 0) {
      // The submitted value is not echoed back. It is user content, and §5.13
      // forbids user content in an error message.
      return err([issue(at('value'), `Not one of the ${String(allowed.length)} permitted values.`)]);
    }
    /*
     * The *ordinal*, not the label. §9.2's single `value` column is what lets a
     * cross-domain query run without a COALESCE per value type, and the label
     * is recoverable from `metric.allowed_values` — which travels in the export
     * (§9.10), so the encoding stays legible without this application.
     */
    return ok({
      value: toQuantityString({ unscaled: BigInt(ordinal), scale: 0 }),
      valueText: input.value,
      unit: metric.canonicalUnit,
    });
  }

  /* --- 4. Numeric family: parse ---------------------------------------- */

  const parsed: Decimal | null =
    input.kind === 'integer'
      ? Number.isSafeInteger(input.value)
        ? { unscaled: BigInt(input.value), scale: 0 }
        : null
      : parseDecimal(input.value);

  if (parsed === null) {
    return err([issue(at('value'), 'Not a finite decimal number.')]);
  }

  /* --- 5. The submitted value must be storable *as submitted* ------------ */

  /*
   * Checked here, before any conversion, and this ordering is the whole point.
   *
   * A *submitted* value with seven decimal places is a claim to a precision the
   * record cannot hold, and Postgres would round it silently — so it is
   * rejected. A *converted* value with more places is not the same thing: 165 lb
   * is exactly 74.84274105 kg, the extra digits are an artifact of the ratio,
   * and rounding them at storage is both expected and honest.
   *
   * The first version of this checked only after conversion and therefore
   * refused every pound-to-kilogram bodyweight — a legitimate write, rejected
   * with a message about precision the user never asked for.
   */
  if (checkQuantityFit(parsed) === 'scale_exceeded') {
    return err([issue(at('value'), 'More precision than the record stores (six decimal places).')]);
  }

  /* --- 6. Convert to the metric's canonical unit ------------------------ */

  const suppliedUnit = input.kind === 'number' ? (input.unit ?? metric.canonicalUnit) : metric.canonicalUnit;

  let value = parsed;
  if (suppliedUnit !== metric.canonicalUnit) {
    if (!isUnitCode(suppliedUnit) || !isUnitCode(metric.canonicalUnit)) {
      return err([issue(at('unit'), `Unit ${suppliedUnit} is not registered.`)]);
    }
    const converted = convertQuantity(
      { value: parsed, unit: suppliedUnit },
      metric.canonicalUnit as UnitCode,
    );
    if (converted === null) {
      /*
       * A cross-dimension conversion. §6.2's whole point is that this is a
       * refusal rather than a number: `1 kg` submitted for a metric measured in
       * hours has no correct interpretation, and picking one is the documented
       * category of harm.
       */
      return err([
        issue(at('unit'), `Cannot convert ${suppliedUnit} to ${metric.canonicalUnit}; different quantities.`),
      ]);
    }
    value = converted.value;
  }

  /* --- 7. Integrality, for integer metrics ------------------------------ */

  if (metric.valueType === 'integer') {
    const truncated = { unscaled: value.unscaled / 10n ** BigInt(value.scale), scale: 0 };
    if (compareDecimal(truncated, value) !== 0) {
      return err([issue(at('value'), `Metric ${metric.key} is an integer metric.`)]);
    }
  }

  /* --- 8. Registry bounds ----------------------------------------------- */

  const issues: Issue[] = [];
  const min = metric.minValue === null ? null : parseDecimal(metric.minValue);
  const max = metric.maxValue === null ? null : parseDecimal(metric.maxValue);

  if (min !== null && compareDecimal(value, min) < 0) {
    issues.push(issue(at('value'), `Below the registered minimum of ${formatDecimal(min, { trim: true })}.`));
  }
  if (max !== null && compareDecimal(value, max) > 0) {
    issues.push(issue(at('value'), `Above the registered maximum of ${formatDecimal(max, { trim: true })}.`));
  }
  if (issues.length > 0) return err(issues);

  /* --- 9. Magnitude, after conversion ----------------------------------- */

  /*
   * Only magnitude, not scale — see step 5. A converted value's extra decimal
   * places are rounded by `toQuantityString`; a converted value that no longer
   * fits the column's fourteen integer digits is unstorable and must be
   * refused, because Postgres errors on that one rather than rounding it.
   */
  if (checkQuantityFit(value) === 'precision_exceeded') {
    return err([issue(at('value'), 'Larger than the record stores (fourteen digits before the point).')]);
  }

  return ok({ value: toQuantityString(value), valueText: null, unit: metric.canonicalUnit });
}

/* -------------------------------------------------------------------------
 * The write
 * ---------------------------------------------------------------------- */

export type ObservationWriteContext = {
  readonly registry: MetricRegistry;
  /** Provenance for this batch. Every row in one write shares a source (§9.2). */
  readonly sourceId: ObservationSourceId;
  /** UUIDv7 factory, for inputs that did not bring their own id. */
  readonly newId: () => string;
  /** `recordedAt` for the batch — when the *system* was told (§9.5). */
  readonly recordedAt: string;
  /** Physical clock reading, for the HLC. Not the same thing as `recordedAt`. */
  readonly physicalMillis: number;
};

export type PreparedWrite = {
  readonly observations: readonly Observation[];
  /** Corrections to apply to existing rows (§9.1). */
  readonly supersessions: readonly Supersession[];
  /** The advanced clock. The caller must persist this. */
  readonly hlcState: HlcState;
  /** Anything worth putting in diagnostics (§5.8). */
  readonly anomalies: readonly ClockAnomaly[];
};

/**
 * Validate and prepare a batch of observations.
 *
 * ## Two failure modes, deliberately different
 *
 * An **unregistered metric key** fails fast with a `precondition_failed`. It is
 * not a form error — no amount of retyping fixes it — and §5.12 reserves
 * `precondition_failed` for exactly this: "the input is well-formed, but the
 * system is not in a state where the operation makes sense — an unregistered
 * metric key (§9.2)".
 *
 * Everything else **accumulates**, and the whole batch is rejected with every
 * issue at once. A Daily Close submits seven fields; returning them one per
 * round trip would turn a sub-sixty-second ritual into a conversation.
 *
 * ## All-or-nothing
 *
 * A partially-accepted batch is not offered. The caller writes in one
 * transaction, and an outbox entry that half-succeeded is one the client cannot
 * safely retry — §5.7's "the outbox may replay any request any number of times"
 * depends on the request being a single unit.
 */
export function prepareObservations(
  inputs: readonly ObservationInput[],
  hlcState: HlcState,
  context: ObservationWriteContext,
): Result<PreparedWrite, DomainError> {
  if (inputs.length === 0) {
    return ok({ observations: [], supersessions: [], hlcState, anomalies: [] });
  }

  /* --- Pass 1: registry lookup, fail fast ------------------------------ */

  const metrics: MetricDefinition[] = [];
  for (const [index, input] of inputs.entries()) {
    const metric = context.registry.get(input.metricKey);
    if (metric === null) {
      return err(
        preconditionFailedError(
          'metric_registered',
          `Metric ${input.metricKey} is not registered (input ${String(index)}).`,
          'metric_not_registered',
        ),
      );
    }
    metrics.push(metric);
  }

  /* --- Pass 2: validate everything, accumulating ----------------------- */

  const issues: Issue[] = [];
  const normalised: NormalisedValue[] = [];

  for (const [index, input] of inputs.entries()) {
    const metric = metrics[index] as MetricDefinition;

    const value = normaliseValue(metric, input.value, [index]);
    if (value.ok) {
      normalised.push(value.value);
    } else {
      issues.push(...value.error);
      // A placeholder keeps the arrays index-aligned for the rest of the pass.
      normalised.push({ value: '0', valueText: null, unit: metric.canonicalUnit });
    }

    if (parseInstant(input.observedAt) === null) {
      issues.push(issue([index, 'observedAt'], 'Not a valid instant.'));
    }

    if (!isIanaZone(input.observedZone)) {
      /*
       * Strict here, tolerant in `dayKeyInZone`. The asymmetry is intentional:
       * on read, a bad zone should mis-file one row rather than blank the
       * timeline; on write, accepting it persists the fault so that every
       * future read inherits it.
       */
      issues.push(issue([index, 'observedZone'], 'Not a recognised IANA time zone.'));
    }

    const subject = input.subject;
    if (subject !== undefined && subject !== null) {
      // §9.3(3) and the `observation_subject_paired` check constraint.
      if (subject.type.trim() === '' || subject.id.trim() === '') {
        issues.push(issue([index, 'subject'], 'A subject needs both a type and an id.'));
      }
    }

    const confidence = input.confidence;
    if (confidence !== undefined && confidence !== null) {
      const parsedConfidence = parseDecimal(confidence);
      if (
        parsedConfidence === null ||
        compareDecimal(parsedConfidence, { unscaled: 0n, scale: 0 }) < 0 ||
        compareDecimal(parsedConfidence, { unscaled: 1n, scale: 0 }) > 0
      ) {
        issues.push(issue([index, 'confidence'], 'Confidence must be a number between 0 and 1.'));
      }
    }

    const supersedes = input.supersedes;
    if (supersedes !== undefined && supersedes !== null && supersedes.reason.trim() === '') {
      /*
       * §9.1 keeps both rows forever precisely so the record explains itself.
       * A supersession with no reason is a silent edit wearing a paper trail,
       * which is the thing the append-only rule exists to prevent.
       */
      issues.push(issue([index, 'supersedes', 'reason'], 'A correction must say why.'));
    }
  }

  if (issues.length > 0) {
    return err(validationError('observation_invalid', 'One or more observations are invalid.', issues));
  }

  /* --- Pass 3: build ---------------------------------------------------- */

  const observations: Observation[] = [];
  const supersessions: Supersession[] = [];
  const anomalies: ClockAnomaly[] = [];
  let clock = hlcState;

  for (const [index, input] of inputs.entries()) {
    const metric = metrics[index] as MetricDefinition;
    const value = normalised[index] as NormalisedValue;

    // One tick per observation, so two facts written in the same millisecond
    // still have a total order.
    const tick = hlcTick(clock, context.physicalMillis);
    clock = tick.state;
    anomalies.push(...tick.anomalies);

    const id = (input.id ?? context.newId()) as ObservationId;
    const subject = input.subject ?? null;

    observations.push({
      id,
      metricKey: metric.key as MetricKey,
      value: value.value,
      valueText: value.valueText,
      unit: value.unit,
      observedAt: input.observedAt,
      observedZone: input.observedZone,
      recordedAt: context.recordedAt,
      sourceId: context.sourceId,
      confidence: input.confidence ?? null,
      subjectType: subject === null ? null : subject.type,
      subjectId: subject === null ? null : subject.id,
      context: input.context ?? null,
      // A new row is never born superseded. The correction points backwards.
      supersededById: null,
      supersededAt: null,
      supersedeReason: null,
      hlc: tick.hlc,
    });

    const supersedes = input.supersedes;
    if (supersedes !== undefined && supersedes !== null) {
      supersessions.push({
        observationId: supersedes.id as ObservationId,
        supersededById: id,
        supersededAt: context.recordedAt,
        supersedeReason: supersedes.reason,
      });
    }
  }

  return ok({ observations, supersessions, hlcState: clock, anomalies });
}

/* -------------------------------------------------------------------------
 * Reading a value back
 * ---------------------------------------------------------------------- */

/** An observation's value, decoded according to its metric's declared type. */
export type DecodedValue =
  | { readonly kind: 'number'; readonly value: Decimal; readonly unit: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'category'; readonly value: string; readonly ordinal: number }
  | { readonly kind: 'text'; readonly value: string };

/**
 * Turn a stored row back into something a UI can render.
 *
 * The inverse of {@link normaliseValue}, and the reason both live in this file:
 * an encoding whose decoder is elsewhere is an encoding that will be decoded
 * two different ways within a year.
 *
 * Returns `null` when the row and its metric disagree — a categorical ordinal
 * past the end of `allowedValues`, say, which happens if a value is retired
 * from the list without migrating the rows that used it. `null` is the honest
 * answer; a guess would put a wrong label on a real observation.
 */
export function decodeValue(
  metric: MetricDefinition,
  observation: Pick<Observation, 'value' | 'valueText' | 'unit'>,
): DecodedValue | null {
  if (metric.valueType === 'text') {
    return observation.valueText === null ? null : { kind: 'text', value: observation.valueText };
  }

  const parsed = parseDecimal(observation.value);
  if (parsed === null) return null;

  if (metric.valueType === 'boolean') {
    const zero = compareDecimal(parsed, { unscaled: 0n, scale: 0 });
    return { kind: 'boolean', value: zero !== 0 };
  }

  if (metric.valueType === 'categorical') {
    const allowed = metric.allowedValues;
    if (allowed === null) return null;
    const ordinal = Number(formatDecimal(parsed));
    const label = Number.isInteger(ordinal) ? allowed[ordinal] : undefined;
    return label === undefined ? null : { kind: 'category', value: label, ordinal };
  }

  if (metric.valueType === 'integer') {
    const asNumber = Number(formatDecimal(parsed));
    return Number.isSafeInteger(asNumber) ? { kind: 'integer', value: asNumber } : null;
  }

  return { kind: 'number', value: parsed, unit: observation.unit };
}

/**
 * Is this metric's value one a person taps rather than types?
 *
 * Used by the Close and the capture rail to pick a control. It lives here
 * rather than in the UI because the answer follows from the registry — a
 * bounded integer metric spanning at most seven steps is a
 * {@link https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/radiogroup_role radiogroup},
 * and that inference should not be re-derived per screen.
 */
export function isTapScale(metric: MetricDefinition): boolean {
  if (metric.valueType !== 'integer') return false;
  if (metric.minValue === null || metric.maxValue === null) return false;
  const min = parseDecimal(metric.minValue);
  const max = parseDecimal(metric.maxValue);
  if (min === null || max === null) return false;
  const span = Number(formatDecimal(max)) - Number(formatDecimal(min));
  return Number.isInteger(span) && span > 0 && span <= 6;
}

