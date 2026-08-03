/**
 * /today — the default authenticated route (§3.2).
 *
 * **A placeholder, deliberately.** The milestone scope is "no application
 * features, no dashboard, no UI beyond what authentication requires", and the
 * Daily Close is Week 2's deliverable (§12). This page exists because
 * authentication needs somewhere to land, and it renders only what proves the
 * session resolved: who you are, and a way out.
 */

import type { ReactNode } from 'react';

import { SignedInPanel } from '@/components/SignedInPanel';

export const metadata = { title: 'Today · NaitikOS' };
export const dynamic = 'force-dynamic';

export default function TodayPage(): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <div className="auth-card">
        <h1>Signed in</h1>
        <p className="subtitle">
          The identity layer is in place. Today is Week 2 of the roadmap.
        </p>
        <SignedInPanel />
      </div>
    </main>
  );
}
