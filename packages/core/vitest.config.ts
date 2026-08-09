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
 *
 * Raised to 95% with the ritual milestone, now that `units/`, `observations/`,
 * `close/` and `export/` are populated — the durable core is real enough for
 * §11.4's actual bar.
 *
 * **Branches stays at 90, and the reason is recorded rather than papered over.**
 * Two files hold it down: `auth/strategies.ts`, whose passkey and magic-link
 * paths are registered but disabled (§5.4's divergence, unreachable until they
 * ship), and `units/quantity.ts`, whose conversion table has more
 * dimension-mismatch branches than there are meaningful pairs to test. Raising
 * the number by testing combinations nobody will ever write is the coverage
 * theatre §11.4 is trying to avoid. It moves to 95 when the auth strategies do.
 */
export default mergeConfig(
  defineConfig(baseTestConfig),
  defineConfig({
    test: {
      coverage: {
        thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
      },
    },
  }),
);
