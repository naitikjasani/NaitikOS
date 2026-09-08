/**
 * /auth/error
 *
 * Where the OAuth and magic-link callback sends failures. Deliberately coarse:
 * the reasons are a closed set and none of them names an address or
 * distinguishes "unknown account" from "not permitted".
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Card, CardBody, Stack, Text } from '@naitikos/design-system';

import { SIGN_IN_PATH } from '@/lib/auth/routes';

export const metadata = { title: 'Sign-in problem · Ekayu' };

const MESSAGES: Readonly<Record<string, string>> = {
  invalid_code: 'That sign-in link has expired or was already used. Request a new one.',
  not_permitted: 'This account is not permitted to sign in.',
  provider_error: 'The sign-in provider could not be reached. Try again shortly.',
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const params = await searchParams;
  const reason = params['reason'];

  // Any unrecognised reason collapses to the generic message. A reflected
  // arbitrary string here would be a content-injection surface.
  const message =
    typeof reason === 'string' && reason in MESSAGES
      ? MESSAGES[reason]
      : 'Sign-in could not be completed.';

  return (
    <main className="auth-shell" id="main">
      <Card className="auth-card">
        <CardBody>
          <Stack gap="6">
            <Stack gap="2">
              <Text role="title-1" as="h1">
                Sign-in problem
              </Text>
              {/* The ARIA role goes on the wrapper — `Text`'s `role` is typography. */}
              <div role="alert">
                <Text role="body" tone="secondary">
                  {message}
                </Text>
              </div>
            </Stack>

            {/*
              `asChild` so this stays an anchor. A `<button>` that navigates
              breaks middle-click, "open in new tab", and the browser's own link
              affordances — which is exactly why `Button` has the prop.
            */}
            <Button asChild variant="primary" fullWidth>
              <Link href={SIGN_IN_PATH}>Back to sign in</Link>
            </Button>
          </Stack>
        </CardBody>
      </Card>
    </main>
  );
}
