/**
 * Runtime type guards for `unknown` values arriving from outside the
 * type system — network responses, IndexedDB reads, JSON parsing.
 *
 * These are deliberately primitive. Structured validation is Zod's job at every
 * boundary (§5.14); these cover the narrow cases where pulling in a schema
 * would be heavier than the check itself.
 */

export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Excludes `NaN` and infinities — both of which are numbers to `typeof`. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** True for plain objects only — arrays and `null` are excluded. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Narrow an array by checking every element against a guard. */
export function isArrayOf<T>(
  value: unknown,
  guard: (item: unknown) => item is T,
): value is readonly T[] {
  return Array.isArray(value) && value.every(guard);
}

/** Confirm an object has a property, narrowing the key for safe access. */
export function hasProperty<K extends PropertyKey>(
  value: unknown,
  key: K,
): value is Record<K, unknown> {
  return isRecord(value) && key in value;
}

/** Build a guard for a fixed set of literal values. */
export function isOneOf<const T extends readonly (string | number)[]>(
  allowed: T,
): (value: unknown) => value is T[number] {
  const set = new Set<unknown>(allowed);
  return (value: unknown): value is T[number] => set.has(value);
}
