/**
 * Design-token generator.
 *
 * Blueprint §8.1:
 *
 *   "Tokens are authored as JSON and generated into CSS custom properties,
 *    TypeScript constants, and the Tailwind preset. One source, three
 *    consumers, no drift. Under P2 the JSON is the portable artifact —
 *    readable by whatever styling technology exists in 2038."
 *
 * Inputs   src/tokens/{primitives,semantic,component}.json
 * Outputs  src/tokens/generated/tokens.css   — custom properties
 *          src/tokens/generated/tokens.ts    — typed constants
 *
 * The generated directory is gitignored: it is derived, and a derived file in
 * version control is a second source of truth waiting to drift.
 *
 * ## Reference validation
 *
 * Every `{a.b.c}` reference is resolved against the set of emitted variables,
 * and an unresolvable reference **fails the build**. A dangling token would
 * otherwise emit `var(--typo)` and render as an invisible or default-coloured
 * element — a bug that looks like a design choice and can survive to
 * production. Failing loudly at build time costs seconds; failing quietly
 * costs an afternoon.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'generated');

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** One emitted CSS custom property. */
type Variable = { readonly name: string; readonly value: string };

/** Grouped by the selector the variables are emitted under. */
type Block = { readonly selector: string; readonly comment: string; readonly variables: Variable[] };

const REFERENCE = /^\{([a-zA-Z0-9_.-]+)\}$/;

/* ------------------------------------------------------------------ *
 * Helpers                                                             *
 * ------------------------------------------------------------------ */

/** `fontSize` → `font-size`; `card-padding` stays as-is. */
function kebab(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** `['color','neutral','950']` → `--color-neutral-950` */
function varName(path: readonly string[]): string {
  return `--${path.map(kebab).join('-')}`;
}

/** Keys beginning with `$` are documentation, not tokens. */
function isCommentKey(key: string): boolean {
  return key.startsWith('$');
}

function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(fileName: string): JsonObject {
  const raw = readFileSync(join(HERE, fileName), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isObject(parsed as Json)) {
    throw new Error(`${fileName} must contain a JSON object at its root.`);
  }
  return parsed as JsonObject;
}

/**
 * Walk a nested object, emitting one variable per leaf.
 *
 * @param prefix - path segments prepended to every emitted name.
 */
function flatten(node: JsonObject, prefix: readonly string[], into: Variable[]): void {
  for (const [key, value] of Object.entries(node)) {
    if (isCommentKey(key)) continue;
    const path = [...prefix, key];

    if (isObject(value)) {
      flatten(value, path, into);
    } else if (typeof value === 'string' || typeof value === 'number') {
      into.push({ name: varName(path), value: String(value) });
    } else {
      throw new Error(`Token "${path.join('.')}" must be a string or number.`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Build                                                               *
 * ------------------------------------------------------------------ */

const primitives = readJson('primitives.json');
const semantic = readJson('semantic.json');
const component = readJson('component.json');

const blocks: Block[] = [];

/* --- Tier 1 ------------------------------------------------------- */
const primitiveVars: Variable[] = [];
flatten(primitives, [], primitiveVars);

/* --- Tier 2: theme-dependent colour ------------------------------- */
function themeColorVars(themeKey: 'dark' | 'light'): Variable[] {
  const theme = semantic[themeKey];
  if (!isObject(theme)) throw new Error(`semantic.json is missing the "${themeKey}" theme.`);
  const out: Variable[] = [];
  flatten(theme, [], out);
  return out;
}

const darkVars = themeColorVars('dark');
const lightVars = themeColorVars('light');

/* --- Tier 2: shared typography ------------------------------------ */
const shared = semantic['shared'];
if (!isObject(shared)) throw new Error('semantic.json is missing the "shared" block.');

const typographyVars: Variable[] = [];
const typography = shared['typography'];
if (isObject(typography)) flatten(typography, ['typography'], typographyVars);

/* --- Tier 2: density ---------------------------------------------- *
 * `layout.comfortable.gutter` collapses to `--layout-gutter`, emitted
 * once per density selector. Density is a runtime attribute (§8.4), so
 * the variable name must be stable across both. */
function densityVars(density: 'comfortable' | 'compact'): Variable[] {
  const layout = shared['layout'];
  if (!isObject(layout)) throw new Error('semantic.json is missing "shared.layout".');
  const scale = layout[density];
  if (!isObject(scale)) throw new Error(`semantic.json is missing "shared.layout.${density}".`);

  const out: Variable[] = [];
  for (const [key, value] of Object.entries(scale)) {
    if (isCommentKey(key)) continue;
    out.push({ name: varName(['layout', key]), value: String(value) });
  }
  return out;
}

const comfortableVars = densityVars('comfortable');
const compactVars = densityVars('compact');

/* --- Tier 3 ------------------------------------------------------- */
const componentVars: Variable[] = [];
const componentRoot = component['component'];
if (!isObject(componentRoot)) throw new Error('component.json is missing the "component" block.');
flatten(componentRoot, [], componentVars);

/* ------------------------------------------------------------------ *
 * Reference resolution + validation                                   *
 * ------------------------------------------------------------------ */

/** Every variable name that will exist at runtime. */
const declared = new Set<string>([
  ...primitiveVars.map((v) => v.name),
  ...darkVars.map((v) => v.name),
  ...lightVars.map((v) => v.name),
  ...typographyVars.map((v) => v.name),
  ...comfortableVars.map((v) => v.name),
  ...componentVars.map((v) => v.name),
]);

const danglingReferences: string[] = [];

function resolve(variable: Variable): Variable {
  const match = REFERENCE.exec(variable.value);
  if (!match) return variable;

  const target = varName((match[1] ?? '').split('.'));
  if (!declared.has(target)) {
    danglingReferences.push(`${variable.name}: ${variable.value} → ${target} (not declared)`);
  }
  return { name: variable.name, value: `var(${target})` };
}

const resolved = {
  primitives: primitiveVars, // tier 1 holds raw values only
  dark: darkVars.map(resolve),
  light: lightVars.map(resolve),
  typography: typographyVars.map(resolve),
  comfortable: comfortableVars.map(resolve),
  compact: compactVars.map(resolve),
  component: componentVars.map(resolve),
};

if (danglingReferences.length > 0) {
  const detail = danglingReferences.map((line) => `  • ${line}`).join('\n');
  throw new Error(
    `Design tokens reference ${String(danglingReferences.length)} variable(s) that do not exist:\n${detail}\n\n` +
      'A dangling reference emits var(--typo) and renders as an invisible or default-coloured\n' +
      'element — a bug that looks like a design choice. Fix the reference or add the token.',
  );
}

/* ------------------------------------------------------------------ *
 * Emit CSS                                                            *
 * ------------------------------------------------------------------ */

blocks.push(
  {
    selector: ':root',
    comment: 'TIER 1 — primitives, plus TIER 2 dark semantics (dark is the default theme, §8.7)',
    variables: [...resolved.primitives, ...resolved.dark, ...resolved.typography],
  },
  {
    selector: "[data-theme='light']",
    comment: 'TIER 2 — light semantic overrides',
    variables: resolved.light,
  },
  {
    selector: ':root',
    comment: 'TIER 2 — density: comfortable (default, §8.4)',
    variables: resolved.comfortable,
  },
  {
    selector: "[data-density='compact']",
    comment: 'TIER 2 — density: compact',
    variables: resolved.compact,
  },
  {
    selector: ':root',
    comment: 'TIER 3 — component contracts. The only tier a component may reference.',
    variables: resolved.component,
  },
);

function renderCss(): string {
  const header = [
    '/*',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * Source: src/tokens/{primitives,semantic,component}.json',
    ' * Regenerate: pnpm tokens:build',
    ' *',
    ' * Blueprint §8.1 — three-tier token architecture.',
    ' * A component may only reference TIER 3.',
    ' */',
    '',
  ].join('\n');

  const body = blocks
    .map((block) => {
      const lines = block.variables.map((v) => `  ${v.name}: ${v.value};`).join('\n');
      return `/* ${block.comment} */\n${block.selector} {\n${lines}\n}`;
    })
    .join('\n\n');

  return `${header}\n${body}\n`;
}

/* ------------------------------------------------------------------ *
 * Emit TypeScript                                                     *
 * ------------------------------------------------------------------ */

function renderTs(): string {
  const names = [...declared].sort();
  const union = names.map((name) => `  | '${name}'`).join('\n');

  const cssVarEntries = names.map((name) => `  '${name}': 'var(${name})',`).join('\n');

  return [
    '/**',
    ' * GENERATED FILE — DO NOT EDIT.',
    ' *',
    ' * Source: src/tokens/{primitives,semantic,component}.json',
    ' * Regenerate: pnpm tokens:build',
    ' */',
    '',
    '/** Every design token that exists at runtime. */',
    'export type TokenName =',
    union,
    '  ;',
    '',
    '/** Token name → `var(--token)`, for inline styles and chart configuration. */',
    'export const cssVar = {',
    cssVarEntries,
    '} as const satisfies Record<TokenName, string>;',
    '',
    '/** Theme identifiers. Dark is the default (§8.7). */',
    "export const THEMES = ['dark', 'light'] as const;",
    'export type Theme = (typeof THEMES)[number];',
    '',
    '/** Density identifiers. Comfortable is the default (§8.4). */',
    "export const DENSITIES = ['comfortable', 'compact'] as const;",
    'export type Density = (typeof DENSITIES)[number];',
    '',
    '/** Chart series tokens, in the order a categorical scale should consume them. */',
    'export const DATA_SERIES_TOKENS = [',
    "  '--color-data-1',",
    "  '--color-data-2',",
    "  '--color-data-3',",
    "  '--color-data-4',",
    "  '--color-data-5',",
    "  '--color-data-6',",
    '] as const satisfies readonly TokenName[];',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Write                                                               *
 * ------------------------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'tokens.css'), renderCss(), 'utf8');
writeFileSync(join(OUT_DIR, 'tokens.ts'), renderTs(), 'utf8');

const total = declared.size;
process.stdout.write(
  `✓ design tokens — ${String(total)} variables across 3 tiers → src/tokens/generated/\n`,
);
