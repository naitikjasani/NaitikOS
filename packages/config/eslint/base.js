/**
 * Base ESLint configuration — applies to every TypeScript file in the repo.
 *
 * Blueprint §11.3. Formatting is Prettier's job and is explicitly disabled here
 * (`eslint-config-prettier` last) so the two never argue.
 */

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { naitikosPlugin } from './rules/index.js';

/**
 * Paths permitted to construct dates directly — the helpers themselves, and tests.
 *
 * **`'**\/temporal/**'`, not `'**\/packages/core/src/temporal/**'`.** The
 * longer form was here first and it never matched anything. ESLint's flat
 * config resolves `files` patterns relative to the config's base directory, and
 * `turbo run lint` runs eslint *inside each package*, so the path this pattern
 * was tested against is `src/temporal/zone.ts` — no `packages/core` prefix to
 * match. The allowlist was inert, which is why `instant.ts` needed an inline
 * `eslint-disable` to say the thing this list already said.
 *
 * Every other entry here starts with `**\/` and a directory name, which is why
 * they worked and this one did not.
 */
const TEMPORAL_ALLOWLIST = [
  '**/temporal/**',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/tests/**',
  '**/scripts/**',
  '**/seed/**',
];

/**
 * Blueprint §11.3: "No raw `Date` arithmetic — the timezone-aware helpers in
 * `core/temporal` are mandatory."
 *
 * Every observation stores the IANA zone it was captured in (§5.3), because a
 * workout at "7am" during travel is a materially different fact from one at 7am
 * at home. `new Date()` silently discards that, so it is banned outside the
 * temporal helpers that handle it correctly.
 */
const NO_RAW_DATE = [
  {
    selector: "NewExpression[callee.name='Date']",
    message:
      'Do not construct Date directly. Blueprint §5.3/§11.3: use the timezone-aware helpers in @naitikos/core/temporal — every observation must carry the IANA zone it was captured in, and `new Date()` discards it.',
  },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      'Do not use Date.now(). Blueprint §5.3/§11.3: use the clock from @naitikos/core/temporal, which is injectable and therefore testable.',
  },
];

export const baseConfig = tseslint.config(
  // ---------------------------------------------------------------- ignores
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },

  // ------------------------------------------------------------ ts baseline
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    plugins: {
      '@naitikos': naitikosPlugin,
    },
    rules: {
      // --- Correctness ------------------------------------------------------
      'no-restricted-syntax': ['error', ...NO_RAW_DATE],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // --- Project invariants (blueprint §11.3) -----------------------------
      '@naitikos/no-sensitive-log': 'error',

      // --- TypeScript -------------------------------------------------------
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // `any` defeats the type system, which is the durability mechanism (§5.1).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },

  // ------------------------------------------------------ temporal allowlist
  {
    files: TEMPORAL_ALLOWLIST,
    rules: { 'no-restricted-syntax': 'off' },
  },

  // -------------------------------------------------- scripts and tooling
  // Operational scripts run in a terminal where console IS the interface.
  {
    files: ['**/scripts/**', '**/*.config.ts', '**/seed/**'],
    rules: {
      '@naitikos/no-sensitive-log': ['error', { allowConsole: true }],
    },
  },

  // --------------------------------------------------------------- prettier
  prettier,
);

export default baseConfig;
