/**
 * The Daily Close — its shape, and the budget that keeps it that shape.
 *
 * §4.0 is the whole specification, and it is unusually prescriptive because the
 * Close is the product:
 *
 *   "Capture the day's minimum viable record in under sixty seconds, every day,
 *    forever... Single screen, no scrolling on a phone. If it does not fit,
 *    something must be cut. Never more than eleven interactive elements. Adding
 *    a field requires removing a field. The Close is a fixed budget, not a
 *    growing form."
 *
 * ## Why the form is generated rather than written
 *
 * A hand-written screen with six hard-coded fields would be shorter today. It
 * would also make the budget unenforceable — the eleven-element cap becomes a
 * comment somebody has to remember, and comments lose to shipping pressure over
 * twenty years (C2, C3). Generating from `metric.in_daily_close` means the
 * budget is arithmetic over data, checked on every build, and adding a field is
 * a registry change that fails loudly when it does not fit.
 *
 * It also makes the medication toggles possible at all: §4.0 requires one per
 * *active* medication, which is not knowable at authoring time.
 *
 * ## What counts as an "interactive element"
 *
 * One **decision**, not one DOM node. A 1–5 tap scale renders five buttons and
 * costs one, because the operator makes one choice. The stricter reading —
 * counting rendered controls — would put the six MVP scales alone at thirty and
 * make §4.0 unsatisfiable, which cannot be what it means given it also lists
 * seven contents. Recorded here because the two readings differ by a factor of
 * five and a future reader deserves to know which one this code implements.
 */

import type { MetricDefinition, MetricRegistry } from '../observations/metric';
import { DAILY_CLOSE_ELEMENT_BUDGET } from '../observations/metric';
import { isTapScale } from '../observations/write';

export { DAILY_CLOSE_ELEMENT_BUDGET };

/** How a Close field is answered. Maps to a design-system control. */
export type CloseControl =
  /** The 1–5 tap used throughout the Close (§8.10's `ScaleField`). */
  | 'scale'
  /** A number with a unit — sleep duration. */
  | 'number'
  /** Taken / not taken. */
  | 'toggle'
  /** The one free-text line. */
  | 'text';

export type CloseField =
  | {
      readonly kind: 'metric';
      /** Stable within a form; also the DOM id prefix. */
      readonly id: string;
      readonly metricKey: string;
      readonly label: string;
      readonly description: string;
      readonly control: CloseControl;
      readonly unit: string;
      /** Present for `scale` and `number`. */
      readonly min: number | null;
      readonly max: number | null;
    }
  | {
      readonly kind: 'medication';
      readonly id: string;
      readonly medicationId: string;
      readonly label: string;
      readonly description: string;
      readonly control: 'toggle';
    }
  | {
      readonly kind: 'note';
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly control: 'text';
    };

/** The minimum a Close needs to know about a medication (§4.0: "reads the active register"). */
export type CloseMedication = {
  readonly id: string;
  /** `Venlafaxine XR 150 mg` — already assembled by the caller. */
  readonly label: string;
  /** `Once daily, morning`. May be empty. */
  readonly schedule: string;
};

export type CloseForm = {
  readonly dayKey: string;
  readonly zone: string;
  readonly fields: readonly CloseField[];
  /** One per decision the operator makes. See the note at the top of this file. */
  readonly elementCount: number;
  readonly budget: number;
  readonly withinBudget: boolean;
  /**
   * Fields dropped because the budget ran out.
   *
   * Never silently: §4.0's "if it does not fit, something must be cut" is a
   * *design* instruction to a person, not permission for the code to decide. So
   * the form still renders, and this list is what the UI surfaces so the
   * operator — who is also the maintainer — knows the registry has outgrown the
   * ritual.
   */
  readonly overflow: readonly CloseField[];
};

const NOTE_FIELD_ID = 'note';

/**
 * The one free-text line (§4.0).
 *
 * Last, always. It is the only field that requires composing a sentence rather
 * than making a choice, so putting it anywhere else turns a sixty-second ritual
 * into a writing task partway through.
 */
const NOTE_FIELD: CloseField = {
  kind: 'note',
  id: NOTE_FIELD_ID,
  label: 'Anything worth remembering',
  description: 'One line. Optional, like everything else here.',
  control: 'text',
};

function controlFor(metric: MetricDefinition): CloseControl {
  if (metric.valueType === 'boolean') return 'toggle';
  if (metric.valueType === 'text') return 'text';
  return isTapScale(metric) ? 'scale' : 'number';
}

function boundToNumber(bound: string | null): number | null {
  if (bound === null) return null;
  const parsed = Number(bound);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Assemble the Close for one local day.
 *
 * Field order is `metric.in_daily_close` in registration order, then medication
 * toggles, then the note. Registration order rather than a list in this file,
 * because §4.0 treats the Close's contents as a property of the record and the
 * registry is the record's vocabulary — two orderings would drift, and the one
 * in the database is the one the export carries.
 */
export function buildCloseForm(
  registry: MetricRegistry,
  medications: readonly CloseMedication[],
  dayKey: string,
  zone: string,
): CloseForm {
  const metricFields: CloseField[] = registry.dailyClose().map((metric) => ({
    kind: 'metric',
    id: metric.key,
    metricKey: metric.key,
    label: metric.displayName,
    description: metric.description,
    control: controlFor(metric),
    unit: metric.canonicalUnit,
    min: boundToNumber(metric.minValue),
    max: boundToNumber(metric.maxValue),
  }));

  const medicationFields: CloseField[] = medications.map((medication) => ({
    kind: 'medication',
    id: `medication:${medication.id}`,
    medicationId: medication.id,
    label: medication.label,
    description: medication.schedule,
    control: 'toggle',
  }));

  const all = [...metricFields, ...medicationFields, NOTE_FIELD];

  /*
   * The note survives an overflow even though it is last.
   *
   * It is the only field that captures something the registry cannot anticipate
   * — "woke at 3am, chest tight" — and on the days when the Close overflows,
   * that line is the most clinically interesting thing in it. So the budget is
   * spent on the ordered fields and the note is added back.
   */
  const budgeted = all.slice(0, DAILY_CLOSE_ELEMENT_BUDGET);
  const overflow = all.slice(DAILY_CLOSE_ELEMENT_BUDGET);
  const fields =
    budgeted.some((field) => field.kind === 'note') ? budgeted : [...budgeted.slice(0, -1), NOTE_FIELD];

  return {
    dayKey,
    zone,
    fields,
    elementCount: all.length,
    budget: DAILY_CLOSE_ELEMENT_BUDGET,
    withinBudget: all.length <= DAILY_CLOSE_ELEMENT_BUDGET,
    overflow: overflow.filter((field) => field.kind !== 'note'),
  };
}

/**
 * How many medications the Close has room for, given the current registry.
 *
 * Exported so the medication register can warn *before* a third or fourth
 * medication silently pushes the Close over. §4.0's "adding a field requires
 * removing a field" applies to medications too — they are just the fields the
 * operator's prescriptions add rather than the ones a developer does.
 */
export function medicationHeadroom(registry: MetricRegistry): number {
  const fixed = registry.dailyClose().length + 1; // + the note
  return Math.max(DAILY_CLOSE_ELEMENT_BUDGET - fixed, 0);
}
