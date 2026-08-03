import { reactConfig } from '@naitikos/config/eslint/react';
import { boundariesConfig } from '@naitikos/config/eslint/boundaries';

/**
 * The design system is React, so it uses the react config rather than the
 * library one — but it is still a package, so the §5.0 boundary rules apply.
 * `boundariesConfig` is what enforces "the design system must stay
 * domain-agnostic" (§6.2): it may import `shared` and nothing else internal,
 * and it may never reach the database.
 */
export default [
  ...reactConfig,
  ...boundariesConfig,
  { ignores: ['src/tokens/generated/**', 'coverage/**'] },
];
