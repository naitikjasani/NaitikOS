/**
 * The sign-in screen.
 *
 * §7.3: screens are "the only components `app/` imports. Assemble components,
 * wire hooks, handle layout." A server component — the form inside it is the
 * only part that needs to be interactive.
 *
 * ## Why this was unstyled until now
 *
 * It was written in the identity milestone, before the design system existed,
 * against placeholder class names (`auth-card`, `subtitle`) that were never
 * defined anywhere. The design system landed a milestone later and nobody came
 * back to the one screen that predated it, so this page rendered as raw HTML on
 * a dark background — the tokens were loading fine, nothing was consuming them.
 *
 * It now composes the same `Card` / `Text` / `Stack` primitives as everything
 * behind the app shell. The only bespoke CSS is the centring wrapper in
 * `styles/auth.css`, because a full-viewport centred layout is a *page* concern
 * and §8.1 keeps page layout out of the component library.
 */

import type { ReactNode } from 'react';
import { Card, CardBody, Stack, Text } from '@naitikos/design-system';

import { SignInForm } from '../components/SignInForm';

export type SignInScreenProps = {
  readonly redirectTo: string;
};

export function SignInScreen({ redirectTo }: SignInScreenProps): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <Card className="auth-card">
        <CardBody>
          <Stack gap="6">
            <Stack gap="2">
              {/*
                `title-1` for the visual scale, `h1` for the document outline.
                §8.3 keeps those two decisions separate — this is the page's only
                heading, so it is an h1 regardless of how large it renders.
              */}
              <Text role="title-1" as="h1">
                Ekayu
              </Text>
              <Text role="body" tone="secondary">
                Sign in to your record.
              </Text>
            </Stack>

            <SignInForm redirectTo={redirectTo} />
          </Stack>
        </CardBody>
      </Card>
    </main>
  );
}
