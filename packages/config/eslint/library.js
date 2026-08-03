/**
 * ESLint configuration for non-React workspace packages
 * (core, db, api, ai, shared).
 */

import { baseConfig } from './base.js';

export const libraryConfig = [
  ...baseConfig,
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
