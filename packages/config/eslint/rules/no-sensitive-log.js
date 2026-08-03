/**
 * @fileoverview Enforce blueprint §5.13 — "Redaction by construction".
 *
 * The blueprint's position is that relying on a redaction *list* fails the
 * moment someone adds a field and forgets. The primary defence is the
 * `Sensitive<T>` branded type in @naitikos/shared, whose serialiser emits
 * `[redacted]`. This rule is the second line: it catches the cases where a
 * value reaches a log call *before* it has been wrapped.
 *
 * Two enforcements:
 *
 *   1. `console.*` is banned outright in application and package source.
 *      Blueprint §5.13 requires structured JSON logging with traceId; a bare
 *      `console.log` produces none of that and is the most common vector for
 *      accidentally printing a journal entry to a hosting provider's log
 *      aggregator. Scripts and tests are exempt (configurable).
 *
 *   2. Any call to a logger-shaped callee is checked for arguments that
 *      reference the sensitive vocabulary. This is a name heuristic and it is
 *      deliberately narrow: it produces an error only for identifiers and
 *      property accesses whose names are unambiguous.
 *
 * This rule cannot see types, so it does not attempt to detect `Sensitive<T>`
 * directly. That is the type system's job, and it does it properly. This rule
 * exists to catch the raw value on its way to the logger before wrapping.
 */

const DEFAULT_SENSITIVE_NAMES = [
  // Mind — the highest sensitivity classification in the system (§9.2).
  'journal',
  'journalEntry',
  'entryContent',
  'therapyNotes',
  'sessionNotes',
  'crisisPlan',
  // Clinical.
  'diagnosis',
  'medication',
  'dosage',
  'labResult',
  'symptom',
  'condition',
  // Media — body photography (§5.5).
  'photo',
  'photoData',
  'mediaBuffer',
  'imageData',
  // Credentials.
  'passphrase',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'privateKey',
  'dataKey',
  'wrappedKey',
];

const DEFAULT_LOGGER_NAMES = ['logger', 'log'];
const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'fatal']);

/** Resolve the leaf name of an Identifier or MemberExpression. */
function leafName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) return leafName(node.property);
  return null;
}

/** Recursively collect candidate names referenced inside an expression. */
function collectNames(node, out, depth = 0) {
  if (!node || depth > 6) return out;
  switch (node.type) {
    case 'Identifier':
      out.add(node.name);
      break;
    case 'MemberExpression': {
      const leaf = leafName(node);
      if (leaf) out.add(leaf);
      collectNames(node.object, out, depth + 1);
      break;
    }
    case 'ObjectExpression':
      for (const prop of node.properties) {
        if (prop.type === 'Property') {
          const key = leafName(prop.key) ?? (prop.key.type === 'Literal' ? prop.key.value : null);
          if (typeof key === 'string') out.add(key);
          collectNames(prop.value, out, depth + 1);
        } else if (prop.type === 'SpreadElement') {
          collectNames(prop.argument, out, depth + 1);
        }
      }
      break;
    case 'TemplateLiteral':
      for (const expr of node.expressions) collectNames(expr, out, depth + 1);
      break;
    case 'ArrayExpression':
      for (const el of node.elements) collectNames(el, out, depth + 1);
      break;
    case 'CallExpression':
      for (const arg of node.arguments) collectNames(arg, out, depth + 1);
      break;
    default:
      break;
  }
  return out;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noSensitiveLog = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow console usage and prevent sensitive values from reaching a logger (blueprint §5.13).',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowConsole: { type: 'boolean' },
          sensitiveNames: { type: 'array', items: { type: 'string' } },
          loggerNames: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      noConsole:
        'Do not use console.{{method}}. Blueprint §5.13 requires structured logging with a traceId — use the logger from @naitikos/shared. A stray console call is how a journal entry reaches a hosting provider’s log aggregator.',
      sensitiveArgument:
        'Potentially sensitive value "{{name}}" passed to a log call. Blueprint §5.13: wrap it in Sensitive<T> from @naitikos/shared so the serialiser emits [redacted], or log a non-identifying reference such as an ID instead.',
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const allowConsole = options.allowConsole === true;
    const sensitive = new Set(
      (options.sensitiveNames ?? DEFAULT_SENSITIVE_NAMES).map((n) => n.toLowerCase()),
    );
    const loggerNames = new Set(options.loggerNames ?? DEFAULT_LOGGER_NAMES);

    /** Is this callee a log-shaped call we should inspect? */
    function isLoggerCall(callee) {
      if (callee.type !== 'MemberExpression' || callee.computed) return false;
      const method = leafName(callee.property);
      if (!method || !LOG_METHODS.has(method)) return false;
      const base = callee.object.type === 'Identifier' ? callee.object.name : leafName(callee.object);
      return base !== null && loggerNames.has(base);
    }

    return {
      CallExpression(node) {
        const callee = node.callee;

        // (1) console.* — banned outright.
        if (
          !allowConsole &&
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'console'
        ) {
          context.report({
            node,
            messageId: 'noConsole',
            data: { method: leafName(callee.property) ?? 'log' },
          });
          return;
        }

        // (2) logger.* — inspect arguments for the sensitive vocabulary.
        if (!isLoggerCall(callee)) return;

        for (const arg of node.arguments) {
          const names = collectNames(arg, new Set());
          for (const name of names) {
            if (sensitive.has(name.toLowerCase())) {
              context.report({ node: arg, messageId: 'sensitiveArgument', data: { name } });
              break;
            }
          }
        }
      },
    };
  },
};
