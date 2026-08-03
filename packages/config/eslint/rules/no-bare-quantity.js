/**
 * @fileoverview Enforce blueprint §6.2 / §11.3 — measured values are `Quantity`,
 * never a bare number.
 *
 * The blueprint's justification is blunt and worth restating: "Unit confusion in
 * a medical record is a real, documented category of harm." A `20` that is
 * milligrams in one function and micrograms in another is exactly the bug that
 * does not surface in tests and does surface in a dosage.
 *
 * The rule flags a bare numeric literal bound to an identifier whose name
 * denotes a measured physical concept — `const doseMg = 20`, `{ weight: 74.2 }`.
 * The fix is `Quantity` from @naitikos/core/units, which carries its unit and
 * whose conversions are total and tested.
 *
 * Scope discipline: this is a *name heuristic* and is therefore applied only in
 * the packages where measured values actually live (core, db, api). A rule that
 * fires on `const timeout = 5000` in UI code would be noise, and a noisy rule
 * gets disabled — taking the useful signal with it. Narrow and trusted beats
 * broad and ignored.
 *
 * Escape hatch: `// eslint-disable-next-line @naitikos/no-bare-quantity -- reason`.
 * The eslint-comments convention requires the trailing reason, so every
 * exemption is self-documenting.
 */

const DEFAULT_MEASURED_CONCEPTS = [
  'weight',
  'mass',
  'dose',
  'dosage',
  'load',
  'height',
  'length',
  'width',
  'circumference',
  'volume',
  'concentration',
  'temperature',
  'duration',
  'distance',
  'calories',
  'kcal',
  'protein',
  'carbs',
  'fat',
  'bodyweight',
];

/**
 * Names that look measured but are structural counts, not physical quantities.
 * Counts are dimensionless and legitimately bare numbers.
 */
const DEFAULT_ALLOWED_SUFFIXES = ['Count', 'Index', 'Total', 'Ratio', 'Percent', 'Ms', 'Version'];

/** Zero and one are near-always initialisers or identity values, not measurements. */
const TRIVIAL_VALUES = new Set([0, 1, -1]);

function buildMatcher(concepts) {
  // Matches `dose`, `doseMg`, `targetDose`, `dose_mg` — but not `doseCount`.
  const alternation = concepts.join('|');
  return new RegExp(`(^|_|[a-z])(${alternation})([A-Z_]|$)`, 'i');
}

/** Unwrap `-5` / `+5` so negative literals are still detected. */
function numericLiteralValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (
    node.type === 'UnaryExpression' &&
    (node.operator === '-' || node.operator === '+') &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number'
  ) {
    return node.operator === '-' ? -node.argument.value : node.argument.value;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noBareQuantity = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require Quantity for measured physical values rather than bare numbers (blueprint §6.2).',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          concepts: { type: 'array', items: { type: 'string' } },
          allowedSuffixes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      bareQuantity:
        '"{{name}}" is a measured value assigned the bare number {{value}}. Blueprint §6.2 requires Quantity from @naitikos/core/units — a bare number carries no unit, and unit confusion in a medical record is a documented category of harm. If this is genuinely dimensionless, rename it (e.g. "{{name}}Count") or disable this rule with a reason.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const matcher = buildMatcher(options.concepts ?? DEFAULT_MEASURED_CONCEPTS);
    const allowedSuffixes = options.allowedSuffixes ?? DEFAULT_ALLOWED_SUFFIXES;

    function isExempt(name) {
      return allowedSuffixes.some((suffix) => name.endsWith(suffix));
    }

    function check(nameNode, valueNode) {
      if (!nameNode || nameNode.type !== 'Identifier') return;
      const name = nameNode.name;
      if (isExempt(name) || !matcher.test(name)) return;

      const value = numericLiteralValue(valueNode);
      if (value === null || TRIVIAL_VALUES.has(value)) return;

      context.report({
        node: valueNode,
        messageId: 'bareQuantity',
        data: { name, value: String(value) },
      });
    }

    return {
      // const doseMg = 20
      VariableDeclarator(node) {
        check(node.id, node.init);
      },
      // { weight: 74.2 }
      Property(node) {
        if (node.computed || node.shorthand) return;
        check(node.key, node.value);
      },
      // class Foo { weight = 74.2 }
      PropertyDefinition(node) {
        if (node.computed) return;
        check(node.key, node.value);
      },
      // function f(weightKg = 74.2)
      AssignmentPattern(node) {
        check(node.left, node.right);
      },
    };
  },
};
