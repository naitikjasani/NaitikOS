/**
 * `Sensitive<T>` — redaction by construction.
 *
 * Blueprint §5.13:
 *
 *   "Sensitive fields are wrapped in a `Sensitive<T>` branded type whose
 *    serialiser emits `[redacted]`. The logger physically cannot serialise a
 *    journal entry, because the type system will not produce the string.
 *    Relying on a redaction *list* fails the moment someone adds a field and
 *    forgets — relying on a *type* fails loudly at compile time."
 *
 * This matters because the database holds psychiatric medication history,
 * therapy notes, and body photographs (§P7). "The logger promises not to print
 * it" is not a control. A value that cannot be stringified is.
 *
 * Every escape route a value normally has to a log line is closed:
 *
 *   JSON.stringify(s)        → "[redacted]"     (toJSON)
 *   `${s}`                   → "[redacted]"     (toString / Symbol.toPrimitive)
 *   String(s)                → "[redacted]"     (toString)
 *   console.log(s) in Node   → Sensitive<…>     (util.inspect.custom)
 *
 * Reading the real value requires calling `.expose()`, which is greppable,
 * reviewable, and reads as a deliberate act at the call site.
 */

const SENSITIVE_BRAND: unique symbol = Symbol.for('naitikos.sensitive');
const NODE_INSPECT: unique symbol = Symbol.for('nodejs.util.inspect.custom');

/** What a redacted value renders as, everywhere. */
export const REDACTED = '[redacted]' as const;

/**
 * A value that must never reach a log, a telemetry event, or an error message.
 *
 * @typeParam T - the wrapped value's type, preserved for `expose()`.
 */
export class Sensitive<T> {
  readonly [SENSITIVE_BRAND] = true as const;

  /** A short, non-identifying label used in place of the value. */
  readonly label: string;

  readonly #value: T;

  constructor(value: T, label = 'value') {
    this.#value = value;
    this.label = label;
  }

  /**
   * Unwrap the protected value.
   *
   * Deliberately verbose and deliberately greppable. Every call site is a place
   * where sensitive data enters plaintext handling, and `grep -rn '.expose()'`
   * should return a list short enough to audit by eye.
   */
  expose(): T {
    return this.#value;
  }

  /**
   * Apply a function to the value without unwrapping it, keeping the result
   * protected. Use this for transformations that must stay inside the boundary
   * — hashing, length checks, encryption.
   */
  map<U>(fn: (value: T) => U, label = this.label): Sensitive<U> {
    return new Sensitive(fn(this.#value), label);
  }

  /** @returns `"[redacted]"` — never the value. */
  toJSON(): typeof REDACTED {
    return REDACTED;
  }

  /** @returns `"[redacted]"` — never the value. */
  toString(): typeof REDACTED {
    return REDACTED;
  }

  /** Closes template-literal and implicit-coercion escape routes. */
  [Symbol.toPrimitive](): typeof REDACTED {
    return REDACTED;
  }

  /** Closes `console.log` / `util.inspect` in Node. */
  [NODE_INSPECT](): string {
    return `Sensitive<${this.label}>`;
  }
}

/**
 * Wrap a value as sensitive.
 *
 * @param value - the value to protect.
 * @param label - a short non-identifying description, shown in place of the
 *   value during inspection. Must not itself contain sensitive content.
 *
 * @example
 * ```ts
 * const entry = sensitive(body.content, 'journalEntry');
 * logger.info('journal saved', { id, entry }); // logs "[redacted]"
 * await repository.save(id, entry.expose());   // deliberate, greppable
 * ```
 */
export function sensitive<T>(value: T, label?: string): Sensitive<T> {
  return new Sensitive(value, label);
}

/** Narrowing guard for unknown values. */
export function isSensitive(value: unknown): value is Sensitive<unknown> {
  return value instanceof Sensitive;
}
