import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * Blueprint §11.4 holds packages/core to 95% coverage — the highest bar in the
 * repo — because "it is the durable layer and its bugs are the expensive kind:
 * a wrong unit conversion or a broken correlation function corrupts conclusions
 * silently, for years".
 *
 * The threshold is raised progressively as the durable modules land, so the
 * gate stays truthful rather than being satisfied by an almost-empty package.
 * Target: 95% once units/, statistics/, and detectors/ are populated (§12).
 */
export default mergeConfig(
  defineConfig(baseTestConfig),
  defineConfig({
    test: {
      coverage: {
        thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
      },
    },
  }),
);
