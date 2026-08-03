/**
 * ESLint configuration for non-React workspace packages
 * (core, db, api, ai, shared).
 */

import { baseConfig } from './base.js';
import { boundariesConfig } from './boundaries.js';

export const libraryConfig = [
  ...baseConfig,

  /**
   * The §5.0 layering rules.
   *
   * Included here rather than left for each package to opt into. The rule that
   * matters most — `core` may not import a framework, which §5.0 calls "worth
   * more over twenty years than every other technical decision in this section
   * combined" — protects the package least likely to remember to enable it, and
   * an opt-in guard on the durable layer is not a guard.
   */
  ...boundariesConfig,

  {
    files: ['**/*.{ts,mts,cts}'],
    rules: {
      /* Blueprint §6.2: measured values are Quantity, never bare numbers.
       * Scoped to the packages where measured values actually live — a rule
       * that fires on `const timeout = 5000` in UI code is noise, and noisy
       * rules get disabled, taking the useful signal with them. */
      '@naitikos/no-bare-quantity': 'error',
    },
  },
];

export default libraryConfig;
