/**
 * Route-level loading state.
 *
 * Text rather than a spinner. §4.7 and P6 both push against motion that exists
 * to fill time, and a health tool that pulses at its user is imposing.
 * `aria-live` announces it without stealing focus.
 */

import type { ReactNode } from 'react';

export default function Loading(): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <p className="muted" role="status" aria-live="polite">
        Loading…
      </p>
    </main>
  );
}
