'use client';

import { type ReactNode } from 'react';
import type { ProtocolVerdict } from '@naitikos/core';
import { COMPLIANCE_THRESHOLD } from '@naitikos/core';
import { Badge, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * The protocol result — advisory, and it says so.
 *
 * §14.2 Finding 9 governs every word in this component:
 *
 *   "A warning that is wrong even twenty percent of the time is a warning that
 *    gets ignored within a fortnight, taking the credible warnings with it.
 *    *Fixed:* §4.2 and §9.8 now make protocol checks **advisory and recorded,
 *    never blocking**."
 *
 * Three consequences visible here:
 *
 * - **Amber, never red.** An advisory is not a failure. The dot for an
 *   advisory check uses a data colour, not a status colour.
 * - **Nothing is phrased as an instruction.** "Previous photo in this series
 *   was indirect daylight; this one is warm artificial" states the difference.
 *   It does not say "retake".
 * - **No score at all on the first photo.** `complianceScore: null` means there
 *   was nothing to be consistent *with*. Rendering "0%" there would be the
 *   first thing the operator saw on their first ever capture.
 */
export function ProtocolChecklist({ verdict }: { readonly verdict: ProtocolVerdict }): ReactNode {
  const percent = verdict.complianceScore === null ? null : Math.round(verdict.complianceScore * 100);

  return (
    <Stack gap="3">
      <Inline justify="between" align="center">
        <Text role="title-3" as="h2">
          Capture protocol
        </Text>
        {percent === null ? (
          <Badge tone="neutral">Reference photo</Badge>
        ) : (
          <Badge tone={verdict.isCompliant ? 'accent' : 'caution'}>{String(percent)}% consistent</Badge>
        )}
      </Inline>

      <ul className="nos-protocol">
        {verdict.checks.map((check) => (
          <li className="nos-protocol__item" key={check.id}>
            <span className={`nos-protocol__dot nos-protocol__dot--${check.status}`} aria-hidden="true" />
            <Stack gap="0">
              <Text role="body-sm" as="span">
                {/* The status is in the text, not only in the colour (§8.13). */}
                {check.label} — {check.status === 'pass' ? 'consistent' : check.status === 'advisory' ? 'differs' : 'not assessed'}
              </Text>
              <Text role="caption" tone="tertiary">
                {check.detail}
              </Text>
            </Stack>
          </li>
        ))}
      </ul>

      <Text role="caption" tone="tertiary">
        {percent === null
          ? 'Nothing to compare against yet. This photo becomes the reference for the series.'
          : verdict.isCompliant
            ? 'Included in comparison views by default.'
            : `Below ${String(Math.round(COMPLIANCE_THRESHOLD * 100))}%, so comparison views hide it unless you ask for it. It is stored either way — the photo is never refused.`}
      </Text>
    </Stack>
  );
}
