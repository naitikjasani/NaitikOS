'use client';

import type { ReactNode } from 'react';
import { Badge, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { QUICK_CAPTURE_CHORDS } from '@/features/capture';

/**
 * `/settings/capture` — §3.2's "Quick-capture rail configuration".
 *
 * ## There is nothing to configure, and the page says so
 *
 * The rail is a constant — `KINDS` in `features/capture/components/QuickCapture.tsx`
 * — and it is hard-coded on purpose. §3.3(4) requires capture to be reachable
 * "from every route" without navigation, and §3.2 caps it at "≤3-tap logging".
 * A rail the operator can extend becomes a menu, and a menu is navigation.
 *
 * So this page is a **reference for what the rail contains**, not an editor.
 * Rendering five toggles that wrote a preference nothing reads would be worse
 * than the absence of the page: it would teach the operator that the system
 * lies about its own configuration.
 *
 * ## Why it is a client component with no interactivity
 *
 * `QUICK_CAPTURE_CHORDS` is exported from a module marked `'use client'`. A
 * Server Component importing it receives a client reference it cannot
 * dereference, so the alternative is a second copy of the list here — which
 * would drift from the rail within one change.
 */

export function CaptureSettingsScreen(): ReactNode {
  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                What is on the rail
              </Text>
              <Badge tone="neutral">{`${String(QUICK_CAPTURE_CHORDS.length)} entries`}</Badge>
            </Inline>

            <Stack gap="2">
              {QUICK_CAPTURE_CHORDS.map((entry) => (
                <Inline key={entry.metricKey} gap="3" align="center" justify="between">
                  <Stack gap="0">
                    <Text role="body" as="span">
                      {entry.label}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {entry.metricKey}
                    </Text>
                  </Stack>
                  <Text role="mono" tone="secondary" as="span">
                    {entry.chord}
                  </Text>
                </Inline>
              ))}
            </Stack>

            <Text role="caption" tone="tertiary">
              A leader key and a domain key. The chord disarms after two seconds, so a stray keystroke
              while reading does not leave the application waiting. The same entries appear in the command
              palette and in the floating capture action.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="2" align="center">
              <Text role="title-3" as="h2">
                Configuration
              </Text>
              <Badge tone="caution">not built</Badge>
            </Inline>
            <Text role="body-sm" tone="secondary">
              The rail cannot be edited. §3.2 names this route as its configuration surface, and no
              mechanism exists behind it — the list above is compiled in.
            </Text>
            {/*
              The gap is worth naming precisely, because it is not laziness: a
              configurable rail is a design decision with a cost, and the cost is
              the thing §3.3(4) is protecting.
            */}
            <Text role="caption" tone="tertiary">
              The constraint that makes it worth building carefully rather than quickly: five entries fit
              on one thumb-reachable sheet, and every entry added past that turns the fastest path in the
              application into a list to read. Meals are deliberately absent — the meal suggestion ranking
              is server data the capture sheet does not have, so <code>/body/nutrition/log</code> is the
              faster path and a slower one that looked faster would be a trap.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
