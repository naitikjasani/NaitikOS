/**
 * /auth/error
 *
 * Where the OAuth and magic-link callback sends failures. Deliberately coarse:
 * the reasons are a closed set and none of them names an address or
 * distinguishes "unknown account" from "not permitted".
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { SIGN_IN_PATH } from '@/lib/auth/routes';

export const metadata = { title: 'Sign-in problem · NaitikOS' };

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
      <div className="auth-card">
        <h1>Sign-in problem</h1>
        <p className="alert" role="alert">
          {message}
        </p>
        <Link className="button" href={SIGN_IN_PATH} style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
