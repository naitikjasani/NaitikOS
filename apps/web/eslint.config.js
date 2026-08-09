import { reactConfig } from '@naitikos/config/eslint/react';
import { boundariesConfig } from '@naitikos/config/eslint/boundaries';

/**
 * Blueprint §7.4 R1 — a feature is importable only through its `index.ts` — is
 * enforced by `boundariesConfig`, which also carries the §5.0 layering rules.
 * It is included here rather than in the shared react config because the
 * feature-slice rules are specific to this app's directory shape.
 */
export default [
  ...reactConfig,
  ...boundariesConfig,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'coverage/**'],
  },

  /**
   * The service worker runs in its own global scope.
   *
   * `self`, `caches`, `fetch` and `Response` are all defined there and in no
   * other file in this app, so the globals are scoped to that one path rather
   * than declared app-wide — declaring them globally would stop `no-undef` from
   * catching a genuine typo anywhere else.
   *
   * Declared here rather than with an `/* eslint-env serviceworker *\/`
   * comment, which flat config removed support for in ESLint 9 and now reports
   * as an error itself.
   */
  {
    files: ['public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
      },
    },
  },
];
