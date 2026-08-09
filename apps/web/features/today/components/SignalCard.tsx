import type { ReactNode } from 'react';
import type { BaselineState, Finding, InsufficientData } from '@naitikos/core';
import { Badge, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * Today's signal — §3.2's "at most ONE insight card".
 *
 * ## The cap is not enforced here
 *
 * `topFinding` in `lib/platform/insights.ts` returns one, server-side. This
 * component renders whatever it is handed and could not render two if it wanted
 * to, which is the right place for a product rule that a tidy-up would
 * otherwise delete.
 *
 * ## Every §10.6 display field, on the card
 *
 * "Every insight displays its n, its effect size, its confidence, and — as a
 * required field in the output schema — **an explicit statement of what it does
 * not prove.** An insight the user cannot audit is an insight they should not
 * act on."
 *
 * So the caveat is not behind a disclosure. It is the last line of the card, in
 * the same type size as the rest, and it is there on a descriptive count as much
 * as on an inference — because "this counts what was logged" is exactly the
 * thing a person forgets when they read a number.
 *
 * ## When there is nothing, it says why
 *
 * §10.6 control 1: "Below the gate, the detector reports *insufficient data* —
 * which is itself displayed, because 'not enough data yet' is honest and builds
 * trust." A card that rendered nothing would be indistinguishable from a broken
 * one, and the baseline message says how many days are left.
 */

export type SignalCardProps = {
  readonly finding: Finding | null;
  readonly insufficient: readonly InsufficientData[];
  readonly baseline: BaselineState;
};

const CONFIDENCE_LABEL: Readonly<Record<Finding['confidence'], string>> = Object.freeze({
  descriptive: 'A count',
  exploratory: 'Exploratory',
  confirmed: 'Confirmed over two windows',
});

export function SignalCard({ finding, insufficient, baseline }: SignalCardProps): ReactNode {
  if (finding === null) {
    const first = insufficient[0];
    return (
      <Card variant="flat">
        <CardBody>
          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              Today’s signal
            </Text>
            <Text role="body-sm" tone="secondary">
              {first?.message ?? baseline.message}
            </Text>
          </Stack>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline justify="between" align="center">
            <Text role="caption" tone="tertiary">
              Today’s signal
            </Text>
            <Badge tone="neutral">{CONFIDENCE_LABEL[finding.confidence]}</Badge>
          </Inline>

          <Text role="body">{finding.headline}</Text>
          <Text role="body-sm" tone="secondary">
            {finding.detail}
          </Text>

          <Inline gap="2" wrap>
            <Text role="caption" tone="tertiary" as="span">
              n = {String(finding.n)}
            </Text>
            <Text role="caption" tone="tertiary" as="span">
              · {finding.effect}
            </Text>
            {finding.pValue !== null && (
              <Text role="caption" tone="tertiary" as="span">
                · p = {finding.pValue.toPrecision(2)}
              </Text>
            )}
          </Inline>

          {/* Required by §10.6. Not behind a disclosure, not in smaller type. */}
          <Text role="caption" tone="tertiary">
            {finding.doesNotProve}
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}
