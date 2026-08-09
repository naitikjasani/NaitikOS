'use client';

/**
 * The unsynced banner — §5.7's "visible unsynced state with a manual retry".
 *
 * The section it implements does not treat this as a nicety:
 *
 *   "Losing a logged workout because the drain failed quietly would end the
 *    user's trust in the system, and trust is the whole product."
 *
 * ## Three states, and why the quiet one is quiet
 *
 * - **Nothing queued** — renders nothing at all. A permanent "all synced" chip
 *   is a notification the operator learns to stop reading, and then does not
 *   read the one time it says something else.
 * - **Queued** — a neutral line. Being offline is the expected state in a gym
 *   basement, not an error, and colouring it red would train the operator to
 *   dismiss red.
 * - **Blocked** — critical, with a retry. This is the only state that needs a
 *   person, so it is the only one that shouts.
 */

import type { ReactNode } from 'react';
import { Badge, Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { useOutbox } from '../hooks/useOutboxHealth';

/** "4 minutes", "2 hours". Coarse on purpose — the exact figure is not the point. */
function describeAge(ms: number | null): string | null {
  if (ms === null) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

export function SyncBanner(): ReactNode {
  const outbox = useOutbox();
  const { blocked, pending, sending, oldestPendingAgeMs } = outbox.health;

  // The common case, and it renders nothing. See the header.
  if (blocked === 0 && pending === 0 && sending === 0) return null;

  if (blocked > 0) {
    return (
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2">
              <Badge tone="critical">Not synced</Badge>
              <Text role="body-sm" tone="critical">
                {blocked} {blocked === 1 ? 'entry has' : 'entries have'} failed repeatedly.
              </Text>
            </Inline>

            {/*
              The reassurance is the substance, not the padding. An operator
              seeing "failed" assumes the data is gone; §5.7's guarantee is
              precisely that it is not, and saying so is what preserves the
              trust the section is about.
            */}
            <Text role="body-sm" tone="secondary">
              Nothing has been lost — the entries are stored on this device until they send.
            </Text>

            <Inline gap="2">
              <Button
                variant="secondary"
                onClick={() => {
                  outbox.unblock();
                }}
              >
                Try again
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>
    );
  }

  const age = describeAge(oldestPendingAgeMs);

  return (
    <Card variant="outlined">
      <CardBody>
        <Inline gap="2">
          <Badge tone="neutral">{outbox.isOnline ? 'Syncing' : 'Offline'}</Badge>
          <Text role="body-sm" tone="secondary">
            {pending + sending} {pending + sending === 1 ? 'entry' : 'entries'} waiting
            {age === null ? '' : `, oldest from ${age}`}.
          </Text>
        </Inline>
      </CardBody>
    </Card>
  );
}
