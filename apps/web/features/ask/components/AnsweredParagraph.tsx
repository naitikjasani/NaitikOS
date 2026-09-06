'use client';

import type { ReactNode } from 'react';
import { Stack, Text } from '@naitikos/design-system';

import type { RenderedParagraph } from '@/lib/platform/references';

/**
 * One answered paragraph, with its figures marked as coming from the record.
 *
 * Shared by `/ask` and `/ask/:threadId`, and that sharing is the reason it is a
 * component rather than a helper in one screen. §10.10's guarantee — "the model
 * is never the source of a figure the user reads" — has to look the same in
 * both places, and two renderers would drift on exactly the detail that matters
 * (whether a resolved figure is distinguishable from a written one).
 *
 * The `<mark>` is not decoration: it is the interface saying *this came from
 * your data* about the one part of the sentence where that is load-bearing.
 *
 * An unresolved reference renders as an explicit gap. The model named an
 * observation that is not there — deleted, or invented — and a hole in the
 * sentence is the honest output. Substituting nothing would leave "has been
 * below on most days", which reads as complete and is missing its subject.
 */
export function AnsweredParagraph({ paragraph }: { readonly paragraph: RenderedParagraph }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="body" as="p">
        {paragraph.rendered.segments.map((segment, index) => {
          if (segment.kind === 'text') return <span key={index}>{segment.text}</span>;
          if (segment.kind === 'value') {
            return (
              <mark key={index} className="nos-ask__figure" title="Read from your record">
                {segment.text}
              </mark>
            );
          }
          return (
            <span key={index} className="nos-ask__gap" title="This reference could not be resolved">
              &mdash;
            </span>
          );
        })}
      </Text>

      {paragraph.hasSuperseded && (
        <Text role="caption" tone="tertiary">
          {/*
            §9.1 makes a correction a supersession rather than an edit, so this
            answer still shows the figure it was written about. Rendering the
            correction in its place would make a saved answer say something the
            model never said — which matters most here, on a thread whose whole
            purpose is returning to an old answer.
          */}
          A figure here has been corrected since this was written. The value shown is the one the answer was
          about.
        </Text>
      )}
    </Stack>
  );
}

/** The line under an answer when some references could not be resolved. */
export function UnresolvedNote({ count }: { readonly count: number }): ReactNode {
  if (count === 0) return null;

  return (
    <Text role="caption" tone="tertiary">
      {count === 1 ?
        'One figure could not be found in your record and is shown as a gap.'
      : `${String(count)} figures could not be found in your record and are shown as gaps.`}
    </Text>
  );
}
