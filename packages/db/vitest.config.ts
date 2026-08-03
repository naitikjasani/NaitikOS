import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig, mergeConfig } from 'vitest/config';

/**
 * These are integration tests: they need the real Postgres from
 * docker-compose, because every invariant they cover is enforced by the
 * database rather than by TypeScript. A mock would test nothing.
 *
 * Coverage thresholds are disabled here rather than inherited. §11.4's pyramid
 * puts the high bar on `core`, the durable layer whose "bugs are the expensive
 * kind". This package is mostly declarative schema — statement coverage over a
 * table definition measures nothing useful, and a threshold that can be
 * satisfied by importing a file is a gate that lies.
 */
export default mergeConfig(
  defineConfig(baseTestConfig),
  defineConfig({
    test: {
      // Migrations take locks and the tests share one connection; parallel
      // files would deadlock against each other.
      fileParallelism: false,
      coverage: { thresholds: undefined },
    },
  }),
);
