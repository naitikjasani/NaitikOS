'use client';

import { type ReactNode } from 'react';
import { Badge, Button, IconButton, Inline, Stack, Text } from '@naitikos/design-system';

import type { RestTimer as RestTimerState } from '../hooks/useRestTimer';

/**
 * The rest timer's face.
 *
 * Deliberately large and deliberately near the bottom of the screen: it is read
 * at arm's length, between sets, and adjusted one-handed. §8.13's 44px minimum
 * is a floor here rather than a target — the ±15 s controls are full-height
 * buttons because the alternative is missing them while out of breath.
 *
 * The overdue state is a *badge*, not a colour change on the number. §8.2 is
 * explicit that colour never carries meaning alone, and "your rest is over" is
 * meaning.
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
        iconStart="action.add"
        fullWidth
        onClick={() => {
          timer.start();
        }}
        className={className}
      >
        Start rest ({formatSeconds(timer.target)})
      </Button>
    );
  }

  return (
    <Stack gap="2" {...(className === undefined ? {} : { className })}>
      <Inline gap="3" align="center" justify="between">
        <Stack gap="1">
          <Text role="metric-l" as="p">
            {formatSeconds(timer.remaining ?? 0)}
          </Text>
          <Text role="caption" tone="tertiary">
            {timer.isOverdue
              ? `${formatSeconds(timer.elapsed ?? 0)} elapsed`
              : `of ${formatSeconds(timer.target)}`}
          </Text>
        </Stack>

        {timer.isOverdue && (
          <Badge tone="accent" icon="status.info">
            Rest is up
          </Badge>
        )}

        <Inline gap="1">
          <IconButton
            icon="action.remove"
            label="Fifteen seconds less"
            onClick={() => {
              timer.adjust(-15);
            }}
          />
          <IconButton
            icon="action.add"
            label="Fifteen seconds more"
            onClick={() => {
              timer.adjust(15);
            }}
          />
        </Inline>
      </Inline>

      <Button
        variant="ghost"
        fullWidth
        onClick={() => {
          timer.stop();
        }}
      >
        Skip rest
      </Button>
    </Stack>
  );
}
