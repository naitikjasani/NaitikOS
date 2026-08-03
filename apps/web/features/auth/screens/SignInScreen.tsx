/**
 * The sign-in screen.
 *
 * §7.3: screens are "the only components `app/` imports. Assemble components,
 * wire hooks, handle layout." A server component — the form inside it is the
 * only part that needs to be interactive.
 */

import type { ReactNode } from 'react';

import { SignInForm } from '../components/SignInForm';

export type SignInScreenProps = {
  readonly redirectTo: string;
};

export function SignInScreen({ redirectTo }: SignInScreenProps): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <div className="auth-card">
        <h1>NaitikOS</h1>
        <p className="subtitle">Sign in to your record.</p>
        <SignInForm redirectTo={redirectTo} />
      </div>
    </main>
  );
}
