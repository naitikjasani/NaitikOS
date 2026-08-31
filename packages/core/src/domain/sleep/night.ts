/**
 * A night — §4.6.
 *
 * §4.6 asks for five things: "Duration, quality, timing, consistency, and
 * disturbances." Two of those have been observations since week one
 * (`body.sleep.duration`, `body.sleep.quality`) and stay there. The other three
 * need a row, because they are properties of a *night* rather than of a day:
 * timing is two endpoints, disturbances are a reason attached to those
 * endpoints, and consistency is the relationship between nights, which no
 * per-metric series can express. The schema's header states the same case at
 * length; this file is the validation and the arithmetic that go with it.
 *
 * ## The one rule that is not a range check
 *
 * A duration greater than the time in bed is refused. It is not a boundary
 * condition — it is the typo that a range check cannot see: 8.5 hours entered
 * against a 7-hour night reads as plausible everywhere, passes every column
 * constraint, and then silently lifts the mean, the efficiency, and every
 * correlation drawn against them. §4.6 calls sleep "the highest-leverage
 * cross-domain variable in the entire system", so a quiet distortion here
 * propagates further than one anywhere else.
 *
 * ## Nothing here computes a duration the operator did not give
 *
 * Time in bed and time asleep are different facts, and the schema stores them
 * separately for that reason. {@link timeInBedHours} reports the interval and
 * calls it what it is; {@link sleepEfficiency} refuses to produce a number
 * unless both halves are actually known. There is no default of 100%, no
 * assumed latency, and no sleep score (§10.0 — the system does not assert a
 * number it cannot defend).
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { dayKeyIndex, parseInstant } from '../../temporal/instant';
import {
  DECIMAL_ZERO,
  compareDecimal,
  decimalFromInteger,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
} from '../../units/decimal';

/** Mirrors the `sleep_disturbance` pgEnum exactly. */
export const SLEEP_DISTURBANCES = Object.freeze([
  'noise',
  'light',
  'temperature',
  'pain',
  'anxiety',
  'bathroom',
  'illness',
  'device',
  'other',
] as const);

export type SleepDisturbance = (typeof SLEEP_DISTURBANCES)[number];

export const SLEEP_DISTURBANCE_LABELS: Readonly<Record<SleepDisturbance, string>> = Object.freeze({
  noise: 'Noise',
  light: 'Light',
  temperature: 'Temperature',
  pain: 'Pain',
  /* The operator has a diagnosed anxiety disorder (§4.7), so this is the
   * disturbance most likely to be picked. It is named plainly and carries no
   * framing — §4.7's "no negative framing, ever" applies to a dropdown too. */
  anxiety: 'Anxiety',
  bathroom: 'Bathroom',
  illness: 'Illness',
  /* A phone, an alarm, a notification. Distinct from `noise` because the fix is
   * different and the operator already knows which one it was. */
  device: 'Device',
  other: 'Something else',
});

export type SleepNight = {
  readonly id: string;
  /** The morning this night ended, in {@link zone}. One night per day key. */
  readonly dayKey: string;
  readonly zone: string;
  readonly bedAt: string | null;
  readonly wokeAt: string | null;
  /** Hours slept, as a decimal string. Not derived from the endpoints. */
  readonly durationHours: string | null;
  readonly quality: number | null;
  readonly latencyMinutes: number | null;
  readonly wakings: number | null;
  readonly disturbance: SleepDisturbance | null;
  readonly disturbanceNote: string | null;
  readonly note: string | null;
};

export type SleepNightInput = {
  readonly id: string;
  readonly dayKey: string;
  readonly zone: string;
  readonly bedAt?: string | null;
  readonly wokeAt?: string | null;
  readonly durationHours?: string | null;
  readonly quality?: number | null;
  readonly latencyMinutes?: number | null;
  readonly wakings?: number | null;
  readonly disturbance?: SleepDisturbance | null;
  readonly disturbanceNote?: string | null;
  readonly note?: string | null;
};

/**
 * The column ranges, restated in the domain.
 *
 * The CHECK constraints in the schema are the guarantee; these are the same
 * numbers reached before a round trip, so a form can say which field is wrong
 * instead of surfacing a 23514. Duplicated deliberately, and the repository
 * integration test asserts the database still refuses what this refuses.
 */
const MAX_NIGHT_HOURS = 24;
const MAX_LATENCY_MINUTES = 600;
const MIN_QUALITY = 1;
const MAX_QUALITY = 5;

/* `decimalFromInteger` is nullable only for a non-safe integer, and these are
 * literals. The fallback is unreachable and exists to keep the type honest. */
const MILLIS_IN_HOUR = 3_600_000;
const HOURS_CEILING = decimalFromInteger(MAX_NIGHT_HOURS) ?? DECIMAL_ZERO;
const MILLIS_IN_HOUR_EXACT = decimalFromInteger(MILLIS_IN_HOUR) ?? DECIMAL_ZERO;

export function validateSleepNight(input: SleepNightInput): Result<SleepNightInput, DomainError> {
  if (dayKeyIndex(input.dayKey) === null) {
    return err(validationError('sleep_day_key_invalid', 'dayKey must be a YYYY-MM-DD day key.'));
  }

  const bedAt = input.bedAt ?? null;
  if (bedAt !== null && parseInstant(bedAt) === null) {
    return err(validationError('sleep_bed_at_invalid', 'bedAt must be an ISO-8601 instant.'));
  }

  const wokeAt = input.wokeAt ?? null;
  if (wokeAt !== null && parseInstant(wokeAt) === null) {
    return err(validationError('sleep_woke_at_invalid', 'wokeAt must be an ISO-8601 instant.'));
  }

  /*
   * Either endpoint may be absent — a night captured through the Daily Close
   * has a duration and no timing, and that is a complete record of what the
   * operator knows. Only the pair is ordered, and only when both are present.
   */
  const bed = bedAt === null ? null : parseInstant(bedAt);
  const woke = wokeAt === null ? null : parseInstant(wokeAt);
  if (bed !== null && woke !== null && bed.getTime() >= woke.getTime()) {
    return err(validationError('sleep_not_ordered', 'bedAt must be strictly before wokeAt.'));
  }

  const quality = input.quality ?? null;
  if (quality !== null && (!Number.isInteger(quality) || quality < MIN_QUALITY || quality > MAX_QUALITY)) {
    return err(validationError('sleep_quality_range', 'Quality is 1–5, matching the Daily Close scale.'));
  }

  const latency = input.latencyMinutes ?? null;
  if (latency !== null && (!Number.isInteger(latency) || latency < 0 || latency > MAX_LATENCY_MINUTES)) {
    return err(
      validationError(
        'sleep_latency_range',
        `Latency is 0–${String(MAX_LATENCY_MINUTES)} minutes, as estimated on waking.`,
      ),
    );
  }

  const wakings = input.wakings ?? null;
  if (wakings !== null && (!Number.isInteger(wakings) || wakings < 0)) {
    return err(validationError('sleep_wakings_invalid', 'Wakings must be zero or more.'));
  }

  const durationHours = input.durationHours ?? null;
  if (durationHours !== null) {
    /* Parsed as an exact decimal rather than through `Number`. The column is
     * `numeric(20,6)` for §5.3's reason, and a value the application accepts by
     * float rules and Postgres then rejects is a worse outcome than either. */
    const duration = parseDecimal(durationHours);
    if (duration === null) {
      return err(validationError('sleep_duration_invalid', 'durationHours must be a decimal string.'));
    }
    if (compareDecimal(duration, DECIMAL_ZERO) < 0 || compareDecimal(duration, HOURS_CEILING) > 0) {
      return err(
        validationError(
          'sleep_duration_range',
          `durationHours must be between 0 and ${String(MAX_NIGHT_HOURS)}.`,
        ),
      );
    }

    /*
     * You cannot sleep longer than you were in bed.
     *
     * The check no column constraint can express, because it spans three of
     * them. A record that claims 8.5 hours of sleep inside a 7-hour night is a
     * typo, not a finding, and every figure downstream — the mean, the
     * efficiency, the sleep-versus-mood correlation §4.6 exists to enable —
     * absorbs it without complaint. Refusing it at the door is the only place
     * it is still visible.
     *
     * Compared in milliseconds, exactly. The endpoints are integers and the
     * duration is a decimal, so scaling the decimal up beats floating the
     * interval down: no epsilon, and a night recorded as exactly its time in
     * bed is accepted rather than lost to a representation error.
     */
    if (bed !== null && woke !== null) {
      const inBedMillis = decimalFromInteger(woke.getTime() - bed.getTime());
      const durationMillis = multiplyDecimal(duration, MILLIS_IN_HOUR_EXACT);
      if (inBedMillis !== null && compareDecimal(durationMillis, inBedMillis) > 0) {
        return err(
          validationError(
            'sleep_duration_exceeds_bed',
            'durationHours cannot exceed the time between bedAt and wokeAt.',
          ),
        );
      }
    }
  }

  return ok(input);
}

/* -------------------------------------------------------------------------
 * Derived quantities
 *
 * Both return `number`, and both are the boundary §5.3 permits: these are read
 * on a screen, not written back. Nothing in this section is persisted, and
 * nothing rounds a stored value.
 * ---------------------------------------------------------------------- */

/**
 * Hours between lights-out and out-of-bed.
 *
 * `null` unless both endpoints exist. Not a substitute for the duration: this
 * is how long the operator was in bed, which includes the latency and the
 * wakings, and presenting it as sleep would overstate every night.
 */
export function timeInBedHours(night: SleepNight): number | null {
  const bed = night.bedAt === null ? null : parseInstant(night.bedAt);
  const woke = night.wokeAt === null ? null : parseInstant(night.wokeAt);
  if (bed === null || woke === null) return null;
  return (woke.getTime() - bed.getTime()) / MILLIS_IN_HOUR;
}

/**
 * Time asleep over time in bed, `0`–`1`.
 *
 * **`null` unless both are known, never a default.** An efficiency of 1.0 for a
 * night with no endpoints would be indistinguishable from a genuinely perfect
 * night on every chart that plots it, and the operator would have no way to
 * tell which nights the system had made up.
 */
export function sleepEfficiency(night: SleepNight): number | null {
  const inBed = timeInBedHours(night);
  if (inBed === null || inBed <= 0) return null;

  const duration = night.durationHours === null ? null : parseDecimal(night.durationHours);
  if (duration === null) return null;

  /* The one place a stored decimal becomes a float, and it is a ratio drawn on
   * a screen rather than a value written back. `validateSleepNight` has already
   * refused a duration longer than the interval, so this cannot exceed 1 for a
   * record this system wrote. */
  const asleep = Number(formatDecimal(duration));
  return Number.isFinite(asleep) ? asleep / inBed : null;
}

/* -------------------------------------------------------------------------
 * Description
 * ---------------------------------------------------------------------- */

function hoursLabel(value: string): string {
  const parsed = parseDecimal(value);
  /* Trimmed for display only. `7.500000` is what the column holds and `7.5` is
   * what a person reads; nothing that writes may trim. */
  return parsed === null ? value : formatDecimal(parsed, { trim: true });
}

/**
 * One sentence describing what was actually recorded.
 *
 * **It never invents.** A night with only a duration says only the duration; a
 * night with endpoints and no duration says how long the operator was in bed
 * and says that the time asleep is not recorded. The absence is part of the
 * record (§10.9), and a description that smoothed over it would be the first
 * place the system started guessing on the operator's behalf.
 *
 * Clock times are deliberately absent: rendering `23:10` requires the zone
 * formatter, which lives at the presentation edge. This function is given a
 * night and nothing else, so it says nothing that needs one.
 */
export function describeNight(night: SleepNight): string {
  const parts: string[] = [];

  const inBed = timeInBedHours(night);
  if (night.durationHours !== null) {
    parts.push(`${hoursLabel(night.durationHours)} h asleep`);
  } else if (inBed !== null) {
    parts.push(`${inBed.toFixed(1)} h in bed, time asleep not recorded`);
  }

  if (night.quality !== null) parts.push(`quality ${String(night.quality)}/5`);
  if (night.latencyMinutes !== null) parts.push(`${String(night.latencyMinutes)} min to fall asleep`);
  if (night.wakings !== null && night.wakings > 0) {
    parts.push(night.wakings === 1 ? '1 waking' : `${String(night.wakings)} wakings`);
  }
  if (night.disturbance !== null) {
    parts.push(`disturbed by ${SLEEP_DISTURBANCE_LABELS[night.disturbance].toLowerCase()}`);
  }

  const first = parts[0];
  /* A row can exist with nothing but a day key — the operator opened the ritual
   * and closed it. Saying so is more useful than an empty string, which reads
   * as a rendering bug. */
  if (first === undefined) return 'Nothing recorded for this night.';

  return `${first.charAt(0).toUpperCase()}${first.slice(1)}${parts.slice(1).map((part) => `, ${part}`).join('')}.`;
}
