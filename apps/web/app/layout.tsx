/**
 * Root layout.
 *
 * §6.2: "`app/` contains routing and nothing else." This is the document, the
 * pre-paint theme stamp, and the two providers that must wrap everything.
 */

import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider, TooltipProvider } from '@naitikos/design-system';

import { AppearanceProvider, ThemeScript } from '@/lib/providers/AppearanceProvider';
import { ServiceWorkerRegistrar } from '@/lib/offline/ServiceWorkerRegistrar';
import { NONCE_HEADER } from '@/proxy';

import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'Ekayu',
  description: 'A personal operating system. One substrate, many lenses.',
  // P7: never indexed. A crawler confirming the account exists is step one.
  robots: { index: false, follow: false, nocache: true },
  applicationName: 'Ekayu',
  appleWebApp: { capable: true, title: 'Ekayu', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Zoom is NOT disabled. §8.13 requires layout to survive 200% zoom, and
  // `maximumScale: 1` is an accessibility failure that also breaks that.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#080b0e' },
    { media: '(prefers-color-scheme: light)', color: '#f8f9fb' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }): Promise<ReactNode> {
  // The per-request CSP nonce, set by the proxy. Required on the inline theme
  // script — §5.14's CSP forbids `unsafe-inline`, so an unnonced script is
  // silently blocked and the theme flashes.
  const nonce = (await headers()).get(NONCE_HEADER) ?? '';

  return (
    // `suppressHydrationWarning` because ThemeScript mutates these attributes
    // before React hydrates. It is scoped to <html> and covers exactly that.
    <html lang="en-GB" data-theme="dark" data-density="comfortable" suppressHydrationWarning>
      <head>
        <ThemeScript nonce={nonce} />
      </head>
      <body>
        <AppearanceProvider>
          <TooltipProvider>
            <ToastProvider>{children}</ToastProvider>
            {/*
              Mounted in the root layout rather than the protected one: the
              offline shell has to be cached before sign-in, or a signed-out
              visitor with no signal gets the browser's error page instead of
              this app's.
            */}
            <ServiceWorkerRegistrar />
          </TooltipProvider>
        </AppearanceProvider>
      </body>
    </html>
  );
}
