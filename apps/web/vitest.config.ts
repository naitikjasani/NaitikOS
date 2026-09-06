import { fileURLToPath } from 'node:url';

import { baseTestConfig } from '@naitikos/config/vitest/base';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the web layer.
 *
 * Scoped to `lib/` and `features/` — the parts that are plain TypeScript.
 * Component tests need Testing Library and a DOM environment, which §11.4 puts
 * at "Component | Testing Library | Critical paths"; the critical path here is
 * the Daily Close capture flow, which does not exist yet. Adding jsdom now to
 * assert that a form renders would be coverage theatre.
 *
 * Route handlers are covered indirectly: their logic lives in `lib/auth/`, and
 * §5.2 requires the handlers themselves to be transport with zero business
 * rules. Testing them directly would mean testing Next's request plumbing.
 *
 * Composed with an explicit spread rather than `mergeConfig`. Under this app's
 * `nextjs.json` tsconfig, `mergeConfig`'s overloads resolve to `never` and the
 * file fails to typecheck — the library packages use it happily because they
 * extend `library.json`. A spread is clearer here anyway: the two overrides are
 * visible rather than merged somewhere out of sight.
 */
export default defineConfig({
  ...baseTestConfig,
  /* `@/` is a tsconfig path, which Vitest does not read. Without it a test
   * importing a module that imports `@/...` fails to resolve at run time even
   * though it typechecks — a mismatch that only appears once a tested module
   * has a non-relative dependency. */
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: {
    ...baseTestConfig.test,
    include: ['lib/**/*.{test,spec}.ts', 'features/**/*.{test,spec}.ts'],
    // The app is mostly React and route handlers, neither of which this suite
    // covers. A threshold here would measure the wrong thing.
    coverage: { ...baseTestConfig.test?.coverage, thresholds: undefined },
  },
});
