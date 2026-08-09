'use client';

import { type ReactNode } from 'react';
import { Text } from '@naitikos/design-system';

/**
 * The ghost overlay — §4.2's primary protocol mechanism.
 *
 * §14.2's Finding 9 is explicit that this, not the scoring, is what actually
 * works:
 *
 *   "The ghost overlay is the primary mechanism, because it actually works — it
 *    makes the correct behaviour easier than the incorrect one, which is the
 *    only reliable form of enforcement."
 *
 * So it is a component with almost nothing in it: the previous photo in the
 * series, at 35% opacity and desaturated, behind whatever the camera is
 * showing. Aligning to it is easier than not aligning to it, and that is the
 * whole design.
 *
 * ## Desaturated on purpose
 *
 * Grayscale, so the operator is aligning *edges* rather than comparing colour.
 * A full-colour ghost invites a judgement about whether today looks better than
 * last week, which is the comparison view's job and is exactly the judgement
 * that capture variance corrupts.
 *
 * ## The opacity is not adjustable
 *
 * A slider here is a setting nobody adjusts and everybody has to think about,
 * in a flow that has ten seconds before it stops happening daily.
 */
export function GhostOverlay({
  referenceUrl,
  currentUrl,
  regionLabel,
}: {
  /** The previous photo in this series. `null` for the first one. */
  readonly referenceUrl: string | null;
  /** What was just captured, if anything. */
  readonly currentUrl: string | null;
  readonly regionLabel: string;
}): ReactNode {
  return (
    <div className="nos-ghost">
      {referenceUrl !== null && (
        <img
          className="nos-ghost__layer nos-ghost__reference"
          src={referenceUrl}
          /*
           * Decorative in the accessibility sense: it is an alignment aid, and
           * its content is the same photograph the operator took last time. A
           * screen-reader description of it would be a description of the
           * operator's own skin, read aloud.
           */
          alt=""
          aria-hidden="true"
        />
      )}

      {currentUrl !== null && (
        <img className="nos-ghost__layer" src={currentUrl} alt={`Captured ${regionLabel} photo`} />
      )}

      {currentUrl === null && referenceUrl === null && (
        <div className="nos-ghost__empty">
          <Text role="body-sm" tone="tertiary" align="center">
            First photo of this series. It becomes the alignment reference for every one after it, so
            it is worth taking in indirect daylight.
          </Text>
        </div>
      )}
    </div>
  );
}
