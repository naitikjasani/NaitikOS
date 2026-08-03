/**
 * The @naitikos ESLint plugin.
 *
 * Blueprint §11.3 specifies a small set of project-specific rules that "encode
 * the two invariants most likely to be violated by a tired future maintainer,
 * and they are the kind of thing that a code review would catch if a code
 * review existed" (§11.7 — there is one engineer, so automation is the
 * reviewer).
 */

import { noBareQuantity } from './no-bare-quantity.js';
import { noSensitiveLog } from './no-sensitive-log.js';

/** @type {import('eslint').ESLint.Plugin} */
export const naitikosPlugin = {
  meta: {
    name: '@naitikos/eslint-plugin',
    version: '0.0.0',
  },
  rules: {
    'no-bare-quantity': noBareQuantity,
    'no-sensitive-log': noSensitiveLog,
  },
};

export default naitikosPlugin;
