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
];
