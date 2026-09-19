'use client';

import { type ReactNode } from 'react';
import { Badge, Button, Inline, Stack, Text } from '@naitikos/design-system';

import { REST_ADJUST_SECONDS, type RestTimer as RestTimerState } from '../hooks/useRestTimer';

/**
 * The rest timer's face.
 *
 * Read at arm's length, between sets, and adjusted one-handed while out of
 * breath. `SessionLoggerScreen` pins it to the bottom edge of the viewport, so
 * everything here is inside the thumb's arc by construction; what this file is
 * responsible for is that each control is *hittable* once the thumb gets there.
 *
 * ## Why the adjust controls carry words rather than a plus and a minus
 *
 * They were `IconButton`s — a `−` and a `+`, four pixels apart, with the amount
 * they moved living only in an `aria-label`. Two failures, both of which §8.13
 * names:
 *
 *   - **Separation.** "Touch targets ≥ 44×44px, with ≥ 8px separation.
 *     Non-negotiable for gym use." Adjacent icon buttons at `gap-1` are 4px
 *     apart, which is the distance at which a sweaty thumb takes fifteen seconds
 *     off a rest it meant to add fifteen seconds to.
 *   - **Colour and shape independence.** "No information conveyed by colour
 *     alone; every colour-coded state carries a shape, icon, or label." A bare
 *     `+` does not say *how much*, and the operator cannot hover a tooltip with
 *     a barbell in their other hand.
 *
 * Three equal-width buttons on one row is also the layout that survives 360px
 * without a media query — they divide whatever they are given.
 *
 * ## The overdue state is a badge, not a red number
 *
 * §8.2: colour never carries meaning alone, and "your rest is over" is meaning.
 * It is also emphatically not `--color-critical` — an overdue rest is not an
 * error, it is the timer doing its job, and §8.2's whole point is that a tool
 * which colours ordinary training states as faults becomes a critic.
 */

export type RestTimerProps = {
  readonly timer: RestTimerState;
  readonly className?: string;
};

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function RestTimer({ timer, className }: RestTimerProps): ReactNode {
  if (!timer.isResting) {
    return (
      <Button
        variant="secondary"
        size="lg"
        iconStart="action.add"
        fullWidth
        onClick={() => {
          timer.start();
        }}
        {...(className === undefined ? {} : { className })}
      >
        Start rest ({formatSeconds(timer.target)})
      </Button>
    );
  }

  return (
    <Stack gap="2" {...(className === undefined ? {} : { className })}>
      <Inline gap="3" align="center" justify="between">
        {/*
          No live region on the digits. A per-second clock announced politely is
          a screen reader reading a number aloud sixty times a minute, which
          drowns out everything else on the screen; the one announcement worth
          making is "rest is up", and the badge below carries it once.
        */}
        <Inline gap="2" align="baseline">
          <Text role="metric-l" as="p">
            {formatSeconds(timer.remaining ?? 0)}
          </Text>
          <Text role="caption" tone="tertiary">
            {timer.isOverdue
              ? `${formatSeconds(timer.elapsed ?? 0)} elapsed`
              : `of ${formatSeconds(timer.target)}`}
          </Text>
        </Inline>

        {timer.isOverdue && (
          <Badge tone="accent" icon="status.info">
            Rest is up
          </Badge>
        )}
      </Inline>

      {/*
        `wrap={false}` deliberately. `fullWidth` on a flex child sets a 100%
        basis, which under the default wrapping puts each button on its own row
        — three rows of controls in a bar pinned over the content the operator
        is trying to read. Without wrapping they shrink to equal thirds, which
        at 360px is ~100px each: comfortably past §8.13's 44px floor, and the
        labels are short enough that nothing is clipped.
      */}
      <Inline gap="2" align="center" wrap={false}>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          aria-label="Fifteen seconds less rest"
          onClick={() => {
            timer.adjust(-REST_ADJUST_SECONDS);
          }}
        >
          {`−${String(REST_ADJUST_SECONDS)} s`}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          aria-label="Fifteen seconds more rest"
          onClick={() => {
            timer.adjust(REST_ADJUST_SECONDS);
          }}
        >
          {`+${String(REST_ADJUST_SECONDS)} s`}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          onClick={() => {
            timer.stop();
          }}
        >
          Done
        </Button>
      </Inline>
    </Stack>
  );
}
