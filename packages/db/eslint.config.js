import { libraryConfig } from '@naitikos/config/eslint/library';

export default [
  ...libraryConfig,

  /**
   * CLI entry points may write to stdout.
   *
   * `no-sensitive-log` bans `console.*` because §5.13 requires structured JSON
   * with a traceId, and because "a stray console call is how a journal entry
   * reaches a hosting provider's log aggregator". That reasoning is about
   * *application* code running in a hosted process.
   *
   * These two files are operator-facing commands run from a terminal, and
   * stdout is their entire interface. §5.15 requires migrations to be "a
   * discrete, gated step" whose output a human reads before deploying — piping
   * structured JSON at them would make that harder, not safer. Neither script
   * ever touches user content: `migrate.ts` prints a hostname and a status,
   * `seed/index.ts` prints row counts.
   *
   * Only the console ban is relaxed. The rule's second and more important
   * enforcement — flagging sensitive-looking values on their way into a log
   * call — stays active here.
   */
  {
    files: ['src/migrate.ts', 'src/seed/**/*.ts'],
    rules: {
      '@naitikos/no-sensitive-log': ['error', { allowConsole: true }],
    },
  },
];
