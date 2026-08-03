import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig } from 'vitest/config';

/**
 * Token tests only, for now.
 *
 * The high-value assertions here are not "does this component render" — they
 * are §8.13's contrast requirements over the full token matrix, which are pure
 * computation and need no DOM. §11.4 puts component tests at "critical paths",
 * and the critical path is the Daily Close, which does not exist yet.
 */
export default defineConfig({
  ...baseTestConfig,
  test: {
    ...baseTestConfig.test,
    include: ['src/**/*.{test,spec}.ts'],
    coverage: { ...baseTestConfig.test?.coverage, thresholds: undefined },
  },
});
