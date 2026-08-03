/**
 * Root layout.
 *
 * §6.2: "`app/` contains routing and nothing else." This is the minimum a
 * document needs — everything visual belongs to a screen in a feature.
 */

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'NaitikOS',
  description: 'A personal operating system. One substrate, many lenses.',
  // P7: this application must never be indexed. It is one person's medical
  // record, and a crawler reaching a sign-in page is the first step toward a
  // search result that confirms the account exists.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is not disabled. Restricting it is an accessibility failure, and
  // §11.4 makes accessibility a blocking gate.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#121214' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en-GB">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
