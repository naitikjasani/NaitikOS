/**
 * The offline shell — what the service worker serves when a navigation fails.
 *
 * Static, and it has to be. Every other route in this app is `force-dynamic`
 * because it reads the record and re-checks authorisation; this one is the only
 * page that can be pre-cached, which is exactly why it is the fallback.
 *
 * ## The message matters more than the page
 *
 * §5.7's failure mode is not a blank screen, it is a *loss of trust*: "Losing a
 * logged workout because the drain failed quietly would end the user's trust in
 * the system." An operator who reaches this page mid-ritual needs to be told, in
 * the first sentence, that nothing they recorded is gone.
 */

import type { ReactNode } from 'react';
import { Card, CardBody, Stack, Text } from '@naitikos/design-system';

export const metadata = { title: 'Offline · Ekayu' };

/*
 * Static, so the service worker can pre-cache it. Marked explicitly rather than
 * left to inference — the `(public)` group's siblings are dynamic and a future
 * edit that made this one dynamic would silently break the offline fallback.
 */
export const dynamic = 'force-static';

export default function OfflinePage(): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <Card className="auth-card">
        <CardBody>
          <Stack gap="4">
            <Text role="title-1" as="h1">
              No connection
            </Text>

            <Text role="body" tone="secondary">
              Anything you recorded is stored on this device and will sync by itself. Nothing has
              been lost.
            </Text>

            <Text role="body-sm" tone="tertiary">
              This page is the only one available offline — the rest read your record, which lives
              on the server.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </main>
  );
}
