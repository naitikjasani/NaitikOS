/**
 * Rendering a narration — the second half of §10.10's central control.
 *
 *   "**Numeric fields are references, not values.** The model emits an
 *    observation ID; the application renders the number from the database. The
 *    model is never the source of a figure the user reads."
 *
 * `schemas/references.ts` is the first half: it makes a narration *unable* to
 * carry a number. This file is the half that makes that useful, by putting the
 * stored figure back in. Until it existed, every Ask answer rendered with
 * visible `{0}` slots — which was the honest failure, and an unsatisfying one.
 *
 * ## The output is segments, not a string
 *
 * A rendered narration comes back as a list of pieces, each labelled as prose,
 * a resolved value, or a reference that could not be resolved. That costs the
 * caller a `.map` and buys two things worth more:
 *
 *   1. The UI can mark a figure as coming from the record. §10.10's guarantee
 *      is invisible if a resolved number looks exactly like a written one, and
 *      "this came from your data" is the single most useful thing the interface
 *      can say about a sentence a model produced.
 *   2. A reference that cannot be resolved is *distinguishable*. It renders as
 *      an explicit gap rather than as a plausible-looking number, which is the
 *      whole point of the exercise.
 *
 * ## An unresolvable reference is never silently dropped
 *
 * The model points at an observation; the observation has since been deleted,
 * or the id was hallucinated outright. Both are real. Substituting nothing
 * would produce a sentence that reads as complete and is missing its subject —
 * "has been below on most days" — which is worse than either the slot or an
 * error, because it looks fine.
 *
 * So an unresolved reference becomes a segment the caller must render, and
 * {@link isFullyResolved} lets a screen decline to show the paragraph at all.
 * §8.9: missing data is shown as missing.
 */

import type { Reference } from '../schemas/references';
import { slotsIn } from '../schemas/references';
import type { Narration } from '../schemas/references';

/**
 * A stable string for a reference, so resolved values can travel in a `Map`.
 *
 * Structural rather than positional. Two paragraphs pointing at the same
 * observation produce the same key, which is what lets a screen fetch each
 * distinct reference once regardless of how often the model named it.
 */
export function referenceKey(reference: Reference): string {
  switch (reference.kind) {
    case 'observation':
      return `observation:${reference.observationId}`;
    case 'statistic':
      /* The field is part of the key: `r` and `n` of one finding are two
       * different figures, and a map keyed on the finding alone would render
       * whichever was fetched last for both. */
      return `statistic:${reference.findingId}:${reference.field}`;
    case 'metric':
      return `metric:${reference.metricKey}`;
    case 'entity':
      return `entity:${reference.nodeId}`;
    default:
      return `document:${reference.documentId}`;
  }
}

/** Resolved display text, keyed by {@link referenceKey}. */
export type ReferenceValues = ReadonlyMap<string, string>;

export type RenderedSegment =
  | { readonly kind: 'text'; readonly text: string }
  /** A figure or label read from the database. Mark it in the UI. */
  | { readonly kind: 'value'; readonly text: string; readonly reference: Reference }
  /** The reference could not be resolved. Render as a gap, never as a number. */
  | { readonly kind: 'unresolved'; readonly reference: Reference }
  /**
   * A slot with no reference behind it at all.
   *
   * `narrationSchema` refuses this, so it should be unreachable — but the
   * schema guards the model's output, and a stored answer read back from a
   * table three years from now has not been through it. Treated as a gap
   * rather than trusted.
   */
  | { readonly kind: 'orphan'; readonly slot: number };

export type RenderedNarration = {
  readonly segments: readonly RenderedSegment[];
  /** References the caller could not supply a value for. */
  readonly unresolved: readonly Reference[];
  /** Slots pointing past the end of the reference list. Should be empty. */
  readonly orphanSlots: readonly number[];
};

const SLOT = /\{(\d+)\}/gu;

/**
 * Substitute resolved values into a template.
 *
 * Slots may repeat and may appear out of order; both are legitimate prose.
 * `{0} rose, then {0} fell` names one figure twice, and rendering it twice from
 * one reference is correct — the alternative would force the model to emit the
 * same reference under two indices to say an ordinary English sentence.
 */
export function renderNarration(narration: Narration, values: ReferenceValues): RenderedNarration {
  const segments: RenderedSegment[] = [];
  const unresolved: Reference[] = [];
  const orphanSlots: number[] = [];

  let cursor = 0;
  for (const match of narration.template.matchAll(SLOT)) {
    const at = match.index;
    const raw = match[1];
    if (at === undefined || raw === undefined) continue;

    if (at > cursor) {
      segments.push({ kind: 'text', text: narration.template.slice(cursor, at) });
    }
    cursor = at + match[0].length;

    const index = Number.parseInt(raw, 10);
    const reference = narration.references[index];
    if (reference === undefined) {
      segments.push({ kind: 'orphan', slot: index });
      orphanSlots.push(index);
      continue;
    }

    const value = values.get(referenceKey(reference));
    if (value === undefined) {
      segments.push({ kind: 'unresolved', reference });
      unresolved.push(reference);
      continue;
    }

    segments.push({ kind: 'value', text: value, reference });
  }

  if (cursor < narration.template.length) {
    segments.push({ kind: 'text', text: narration.template.slice(cursor) });
  }

  return { segments, unresolved, orphanSlots };
}

/** Whether every slot in a rendered narration found its value. */
export function isFullyResolved(rendered: RenderedNarration): boolean {
  return rendered.unresolved.length === 0 && rendered.orphanSlots.length === 0;
}

/**
 * Every distinct reference across a set of narrations, in order of first use.
 *
 * What a screen passes to its resolver. Deduplicated, because a model naming
 * one observation in four paragraphs should cost one row read, and ordered so
 * a resolver that batches by kind still produces a stable plan.
 */
export function referencesIn(narrations: readonly Narration[]): readonly Reference[] {
  const seen = new Set<string>();
  const found: Reference[] = [];

  for (const narration of narrations) {
    /*
     * Iterating `references` rather than the slots. A reference the template
     * never names is unused prose furniture and resolving it is one wasted
     * read; a slot whose reference is missing is a bug the renderer reports.
     * Fetching the declared list is the shape that cannot under-fetch.
     */
    for (const reference of narration.references) {
      const key = referenceKey(reference);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(reference);
    }
  }

  return found;
}

/** The plain-text rendering, for an export or a log. Gaps become a marker. */
export const UNRESOLVED_MARKER = '[unavailable]';

export function renderedToText(rendered: RenderedNarration): string {
  return rendered.segments
    .map((segment) => {
      if (segment.kind === 'text' || segment.kind === 'value') return segment.text;
      return UNRESOLVED_MARKER;
    })
    .join('');
}

/** Slots a template declares, re-exported so a caller needs one import. */
export { slotsIn };
