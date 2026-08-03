/**
 * Assertions for genuine invariant violations.
 *
 * Blueprint §5.12 draws the line clearly: `Result` is for *expected* failure —
 * a validation error, a missing record, a conflict. Assertions are for
 * conditions that indicate a **bug**, where continuing would corrupt data.
 *
 * The distinction matters in this system because §9.1 makes observations
 * append-only and permanent. A wrong value written today is a wrong value
 * forever. Where an invariant genuinely cannot hold, failing loudly is
 * correct; returning a `Result` and letting a caller shrug it off is not.
 *
 * Rule of thumb: if a user action could cause it, use `Result`. If only a
 * programming error could cause it, assert.
 */

/** Thrown when an invariant that should be impossible to violate is violated. */
export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation';

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(`Invariant violated: ${message}`, options);
  }
}

/**
 * Assert a condition holds, narrowing the type when it does.
 *
 * @throws {InvariantViolation} when `condition` is falsy.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new InvariantViolation(message);
  }
}

/**
 * Assert a value is neither `null` nor `undefined`, and return it.
 *
 * Preferred over the non-null assertion operator (`!`), which is banned by
 * lint (§11.3) because it fails silently at runtime while claiming safety at
 * compile time. This fails loudly with a message that names what was missing.
 */
export function assertPresent<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new InvariantViolation(message);
  }
  return value;
}

/**
 * Mark a branch as unreachable, with a compile-time exhaustiveness check.
 *
 * Blueprint §5.12 requires `DomainError` to be a *closed* union. This is what
 * enforces closure: add a variant without handling it and the compiler rejects
 * the call, because `value` will no longer be `never`.
 *
 * @example
 * ```ts
 * switch (error.kind) {
 *   case 'validation': return 400;
 *   case 'not_found':  return 404;
 *   default: return assertNever(error, 'DomainError');
 * }
 * ```
 */
export function assertNever(value: never, context = 'value'): never {
  throw new InvariantViolation(
    `Unhandled ${context}: ${JSON.stringify(value)}. A union member was added without updating every exhaustive switch over it.`,
  );
}
