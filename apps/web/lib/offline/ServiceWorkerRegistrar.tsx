'use client';

/**
 * Registers the service worker.
 *
 * A component rather than a script tag, so registration is tied to a React
 * lifecycle and can be reasoned about — and so it can be excluded from
 * development, where a cached shell is the single most confusing thing that can
 * happen to someone editing a page.
 */

import { useEffect, type ReactNode } from 'react';

export function ServiceWorkerRegistrar(): ReactNode {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    /*
     * Not in development.
     *
     * A worker that caches the shell survives a rebuild, so an edit appears not
     * to take effect and the next twenty minutes are spent looking for the bug
     * in the wrong file. Production is where offline matters; development is
     * where fast feedback does.
     */
    if (process.env.NODE_ENV !== 'production') return;

    /*
     * After `load`, not immediately.
     *
     * Registration competes with the page's own requests for bandwidth, and on
     * the connection this app is designed for — a phone on mobile data — that
     * competition is measured in visible milliseconds against §11.5's budget.
     */
    const register = (): void => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        // A failed registration means no offline shell. The app is otherwise
        // fine, and a toast about it would be noise the operator cannot act on.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }

    window.addEventListener('load', register);
    return () => {
      window.removeEventListener('load', register);
    };
  }, []);

  return null;
}
