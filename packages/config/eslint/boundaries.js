/**
 * @fileoverview Mechanical enforcement of blueprint §5.0 — the layering rule.
 *
 *   "Domain logic must be able to compile and run with zero framework imports."
 *
 * §5.0 calls this "worth more over twenty years than every other technical
 * decision in this section combined", because it is what makes the eventual
 * Next.js rewrite a UI rewrite rather than a product rewrite. A rule that
 * important cannot be a code-review convention in a one-engineer project
 * (§11.7) — it has to fail the build.
 *
 *              ┌──────────────────────────────────────┐
 *   app     ──▶│ everything                           │  replaceable
 *   api/ai  ──▶│ core, db, shared                     │  replaceable
 *   db      ──▶│ core, shared                         │  semi-durable
 *   core    ──▶│ shared only, ZERO frameworks         │  ★ DURABLE
 *   shared  ──▶│ nothing internal                     │  ★ DURABLE
 *              └──────────────────────────────────────┘
 *
 * Note this is the *second* line of defence. The first is dependency
 * declaration: `packages/core/package.json` simply does not list react, so the
 * import fails to resolve before ESLint ever runs (see .npmrc — hoisting is
 * disabled precisely so that guarantee holds). Both are cheap; both are kept.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import boundaries from 'eslint-plugin-boundaries';

/**
 * The monorepo root, resolved from this file's own location.
 *
 * Load-bearing. The element patterns below (`packages/core/**`) are matched
 * against paths relative to `boundaries/root-path`, which defaults to the
 * ESLint working directory. Turborepo runs `eslint .` *inside each package*, so
 * with the default the patterns match nothing and every rule in this file
 * silently passes — which is exactly what was happening before this line
 * existed: the config was written, exported by nobody, and imported by nobody.
 *
 * Deriving the root from `import.meta.url` means it is correct whether ESLint
 * runs from the repo root, from a package, or from an editor.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Frameworks that must never reach the durable layer. */
const FRAMEWORK_PACKAGES = [
  'react',
  'react-dom',
  'react/*',
  'next',
  'next/*',
  'zustand',
  '@tanstack/*',
  'drizzle-orm',
  'drizzle-orm/*',
  '@supabase/*',
  'postgres',
  'tailwindcss',
  'lucide-react',
];

export const boundariesConfig = [
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    plugins: { boundaries },
    settings: {
      'boundaries/root-path': REPO_ROOT,
      'boundaries/include': ['apps/**/*', 'packages/**/*'],
      'boundaries/elements': [
        { type: 'shared', partialMatch: false, pattern: 'packages/shared/**/*' },
        { type: 'core', partialMatch: false, pattern: 'packages/core/**/*' },
        { type: 'db', partialMatch: false, pattern: 'packages/db/**/*' },
        { type: 'api', partialMatch: false, pattern: 'packages/api/**/*' },
        { type: 'ai', partialMatch: false, pattern: 'packages/ai/**/*' },
        { type: 'design-system', partialMatch: false, pattern: 'packages/design-system/**/*' },
        { type: 'config', partialMatch: false, pattern: 'packages/config/**/*' },
        { type: 'app', partialMatch: false, pattern: 'apps/web/**/*' },
      ],
    },
    rules: {
      /* ---------------------------------------------------------------
       * Internal layering. Default disallow — every edge is explicit.
       * ------------------------------------------------------------- */
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          message:
            '${file.type} may not import ${dependency.type}. Blueprint §5.0 defines the layering: app → api/ai → db → core → shared. Move the shared logic down a layer rather than importing sideways or upward.',
          rules: [
            // shared is the floor — it imports nothing internal by design.
            { from: ['shared'], allow: [] },

            // ★ core is the durable layer. shared only, forever.
            {
              from: ['core'],
              allow: ['shared'],
              message:
                'packages/core is the DURABLE layer (blueprint §5.0) — it must compile and run with zero framework imports so it survives the framework rewrites the next twenty years will bring. It may import @naitikos/shared and nothing else.',
            },

            { from: ['db'], allow: ['shared', 'core'] },
            { from: ['api'], allow: ['shared', 'core', 'db'] },
            { from: ['ai'], allow: ['shared', 'core', 'db'] },

            // The design system is domain-agnostic: it renders values, it does
            // not know what a medication is. Keeping it off `core` is what lets
            // it be restyled or replaced without touching domain logic (§6.2).
            {
              from: ['design-system'],
              allow: ['shared'],
              message:
                'packages/design-system must stay domain-agnostic (blueprint §6.2). It renders values; it does not know what a medication is. If you need domain knowledge here, the component belongs in a feature slice instead.',
            },

            { from: ['config'], allow: [] },
            // 'app' includes itself: a layout importing a stylesheet, a page
            // importing a feature. Intra-app structure is governed by §7.4 R1
            // below (features are reachable only through their index), not by
            // the layering rule.
            { from: ['app'], allow: ['app', 'shared', 'core', 'db', 'api', 'ai', 'design-system'] },
          ],
        },
      ],

      /* ---------------------------------------------------------------
       * The framework ban. This is the rule §5.0 actually cares about.
       * ------------------------------------------------------------- */
      'boundaries/external': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              from: ['core'],
              disallow: FRAMEWORK_PACKAGES,
              message:
                '★ packages/core may not import "${dependency.source}". Blueprint §5.0: the durable layer must compile and run with zero framework imports — it is the only part of this system intended to survive twenty years, and every framework dependency shortens that. Put the framework binding in packages/api, packages/db, or the app.',
            },
            {
              from: ['shared'],
              disallow: FRAMEWORK_PACKAGES,
              message:
                'packages/shared is universal utility code (blueprint §6.2) and must stay framework-free. If "${dependency.source}" is genuinely needed, this utility belongs in a higher layer.',
            },
            {
              from: ['design-system'],
              disallow: ['drizzle-orm', 'drizzle-orm/*', '@supabase/*', 'postgres'],
              message:
                'The design system must not reach the database. It receives data as props.',
            },
          ],
        },
      ],
    },
  },

  /* -------------------------------------------------------------------
   * Blueprint §7.4 R1 — feature slices expose exactly one public API.
   *
   * "import { SkinOverviewScreen } from '@/features/skin'" is legal.
   * "import { photoProtocolService } from '@/features/skin/services/…'"
   * is not. Without this the boundary is decorative.
   * ----------------------------------------------------------------- */
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/features/*/*', '@/features/*/**'],
              message:
                'Import a feature only through its public API: `@/features/<name>`. Blueprint §7.4 R1 — reaching into a feature’s internals makes the boundary decorative, and a boundary you can bypass is a boundary you do not have.',
            },
            {
              group: ['../../features/*', '../features/*'],
              message:
                'Use the `@/features/<name>` alias rather than a relative path, so the public-API boundary (§7.4 R1) is enforceable.',
            },
          ],
        },
      ],
    },
  },

  /* A feature's own index.ts is what defines the public API, so it is the one
   * file permitted to reach into its own internals. */
  {
    files: ['apps/web/features/*/index.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];

export default boundariesConfig;
