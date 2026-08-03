/**
 * ESLint configuration for React surfaces — apps/web and the design system.
 */

import reactHooks from 'eslint-plugin-react-hooks';

import { baseConfig } from './base.js';

export const reactConfig = [
  ...baseConfig,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /* Blueprint §5.1: "Zustand never holds server data. That boundary is
       * enforced in review; violating it produces two sources of truth and is
       * the most common way this pairing goes wrong." There is no review
       * (§11.7), so it is enforced here instead. */
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zustand',
              importNames: ['default'],
              message:
                'Create Zustand stores only under a feature’s store/ directory, and only for EPHEMERAL UI state (blueprint §5.1/§7.3). If a value could be refetched from the server it belongs in TanStack Query — two sources of truth is how this pairing goes wrong.',
            },
          ],
        },
      ],
    },
  },
  {
    // Store files are the legitimate home for Zustand.
    files: ['**/store/**/*.{ts,tsx}', '**/stores/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default reactConfig;
