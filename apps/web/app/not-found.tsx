import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata = { title: 'Not found · NaitikOS' };

export default function NotFound(): ReactNode {
  return (
    <main className="auth-shell" id="main">
      <div className="auth-card">
        <h1>Not found</h1>
        <p className="subtitle">That page does not exist.</p>
        <Link className="button" href="/" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
          Go to Today
        </Link>
      </div>
    </main>
  );
}
