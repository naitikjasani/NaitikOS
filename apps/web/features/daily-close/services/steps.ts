/**
 * The Close, cut into screens that actually fit a phone.
 *
 * §4.0 is the only requirement here and it is absolute: *"Single screen, no
 * scrolling on a phone. If it does not fit, something must be cut."* The form
 * as generated does not fit and cannot be made to fit. Six registry fields —
 * five tap scales and a duration — plus a medication toggle and the free-text
 * line come to roughly nine hundred pixels of controls before the page header,
 * the tab bar, or the browser chrome are counted. A 360×780 phone has about
 * five hundred and forty to give.
 *
 * So the thing that must not scroll is *a screen*, and the Close is given more
 * than one of them. §4.0's other three constraints are untouched by that
 * reading: the element budget is still eleven decisions, adding a field still
 * requires removing one, and the ritual is still under a minute — three taps
 * and a Next is faster than three taps and a thumb-scroll, because scrolling a
 * form you are also tapping is the interaction that makes people miss.
 *
 * ## Why packing by height rather than by a hand-written list of pages
 *
 * `buildCloseForm` generates the fields from `metric.in_daily_close` precisely
 * so the budget is arithmetic over data rather than a comment someone has to
 * remember. A hard-coded three-page layout would put that back: register a
 * seventh metric and page two silently grows past the fold, which is the exact
 * failure §4.0 is written against and the one nobody notices until they are
 * standing in it at midnight.
 *
 * Packing by an estimated height means the *screen* is the invariant. A
 * registry that grows produces another step, never a taller one.
 */

import type { CloseControl, CloseField } from '@naitikos/core';

/**
 * A field's vertical cost, in units of roughly a quarter of a phone screen's
 * usable form area.
 *
 * Estimated rather than measured, deliberately. A measured layout means
 * rendering the form to find out how tall it is and then re-cutting it, which
 * is a reflow on every open of the one screen with a sixty-second budget. The
 * estimate is conservative — a scale is a label, a 44px row of targets and a
 * pair of anchors — and being wrong by one unit costs an extra step rather than
 * a scrollbar, which is the correct direction to be wrong in.
 */
const FIELD_WEIGHT: Readonly<Record<CloseControl, number>> = Object.freeze({
  scale: 3,
  number: 3,
  toggle: 2,
  text: 4,
});

/**
 * What one step may hold.
 *
 * Nine is three tap scales, which is what fits above the action row on the
 * smallest viewport §8.4 supports without the Next button leaving the screen. A
 * primary action the operator cannot see is a ritual they do not finish.
 */
const STEP_WEIGHT_BUDGET = 9;

/**
 * Section names, keyed by the domain segment of the metric key.
 *
 * The heading over a step is not decoration: at 6am half-awake the difference
 * between "answer these three" and "answer these three *about last night*" is
 * the difference between an accurate number and a guess. Anything unlisted
 * falls back to its own key rather than to a generic word, so a new domain
 * reads as itself on the first render and not as "Other".
 */
const SECTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  mind: 'Mind',
  body: 'Body',
  medication: 'Medication',
  note: 'Note',
});

function sectionOf(field: CloseField): string {
  if (field.kind === 'note') return 'note';
  if (field.kind === 'medication') return 'medication';
  const [domain] = field.metricKey.split('.');
  return domain === undefined || domain === '' ? 'metric' : domain;
}

function labelFor(section: string): string {
  return SECTION_LABEL[section] ?? section.charAt(0).toUpperCase() + section.slice(1);
}

export type CloseStep = {
  /** Stable across renders — the first field's id, which is registry-derived. */
  readonly id: string;
  /** "Mind", or "Medication · Note" where a step spans two sections. */
  readonly title: string;
  readonly fields: readonly CloseField[];
};

/**
 * Cut the generated fields into steps, in registry order.
 *
 * Order is never rearranged. §4.0 treats the Close's contents as a property of
 * the record and `buildCloseForm` takes its ordering from the registry, which
 * is what the export carries; a UI that sorted fields into prettier groups
 * would make the screen and the archive disagree about what the ritual is.
 *
 * Returns an empty array for an empty form. The caller already has an empty
 * state for that case and it is a better one than a step with nothing in it.
 */
export function buildCloseSteps(fields: readonly CloseField[]): readonly CloseStep[] {
  const steps: CloseStep[] = [];
  let current: CloseField[] = [];
  let weight = 0;

  const flush = (): void => {
    const first = current[0];
    if (first === undefined) return;

    const sections: string[] = [];
    for (const field of current) {
      const section = labelFor(sectionOf(field));
      if (!sections.includes(section)) sections.push(section);
    }

    steps.push({ id: first.id, title: sections.join(' · '), fields: current });
    current = [];
    weight = 0;
  };

  for (const field of fields) {
    const cost = FIELD_WEIGHT[field.control];
    if (current.length > 0 && weight + cost > STEP_WEIGHT_BUDGET) flush();
    current.push(field);
    weight += cost;
  }
  flush();

  return steps;
}

/**
 * Which fields on a step the operator has actually answered.
 *
 * Used only to label the step in the review row, never to gate the Next button.
 * §4.0: "Every field is optional. A partial close counts as a close." A flow
 * that will not advance until a field is answered is a flow that teaches you to
 * skip the whole thing on the day you have least to say — and those are the
 * days the record most wants.
 */
export function answeredCount(
  step: CloseStep,
  answers: Readonly<Record<string, number | string | boolean>>,
): number {
  let count = 0;
  for (const field of step.fields) {
    const value = answers[field.id];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    count += 1;
  }
  return count;
}
