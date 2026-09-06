/**
 * Prettier configuration.
 *
 * ## This file pins a default; it does not declare the codebase formatted
 *
 * There was no configuration here until 7 September 2026, which meant
 * `pnpm format` — and the `prettier --write` in `lint-staged` — ran against
 * whatever the installed Prettier's defaults happened to be. Two consequences,
 * both bad: the defaults do not match how this repository is actually written,
 * so formatting a file fought the surrounding code; and the defaults drift
 * between Prettier releases, so the result was not even stable over time.
 *
 * The values below were chosen by measurement rather than taste. Every
 * combination was run against the 841 TypeScript files in `packages/` and
 * `apps/web/`, counting files whose formatting would change:
 *
 *   | config                          | files that would change |
 *   |---------------------------------|-------------------------|
 *   | Prettier defaults (no config)   | 822 of 841              |
 *   | 100 columns                     | 556                     |
 *   | **110 columns (this file)**     | **429**                 |
 *   | 120 columns                     | 469                     |
 *   | 110 + experimentalTernaries     | 501                     |
 *
 * ## The honest part
 *
 * 110 columns is the minimum, and it is still 429 files — roughly half the
 * repository. There is no configuration that makes adopting Prettier a no-op
 * here, because this code was written by hand and not by a formatter.
 *
 * **So the reformat has deliberately not been run.** Adopting it is a real
 * decision with a real cost: it would rewrite half the tree in one commit and
 * take `git blame` with it, which for a record intended to last twenty years
 * (C2) with a single maintainer (§13's solo bus factor) is a cost worth
 * choosing on purpose rather than absorbing as a side effect of a feature.
 *
 * Until that decision is made, `pnpm format:check` fails, and it is *supposed*
 * to fail — it is reporting a known state rather than a mystery. See
 * `docs/formatting.md` for the decision and the options.
 *
 * `experimentalTernaries` is off despite some newer JSX being written in that
 * style, because the measurement says it costs 72 additional files. The style
 * is mixed in the tree; the number is not.
 *
 * @type {import('prettier').Config}
 */
export default {
  singleQuote: true,
  printWidth: 110,
  trailingComma: 'all',
  semi: true,
  arrowParens: 'always',
};
