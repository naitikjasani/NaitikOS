/**
 * Shared Vitest configuration.
 *
 * Blueprint §11.4 sets a weighted pyramid: packages/core is held to 95%
 * coverage because "it is the durable layer and its bugs are the expensive
 * kind — a wrong unit conversion or a broken correlation function corrupts
 * conclusions silently, for years". Per-package configs raise thresholds
 * above this floor; none may lower them.
 */

/** @type {import('vitest/config').ViteUserConfig} */
export const baseTestConfig = {
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/*.d.ts',
        '**/index.ts',
        '**/generated/**',
      ],
      thresholds: {
        // Floor for every package. core overrides upward to 95% (§11.4).
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
};

export default baseTestConfig;
