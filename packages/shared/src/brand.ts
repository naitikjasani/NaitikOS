/**
 * Nominal typing for TypeScript's structural type system.
 *
 * A `MedicationId` and an `ObservationId` are both strings, and the compiler
 * will happily let you pass one where the other is expected. In a system whose
 * entire premise is an accurate twenty-year record (§C2), that silent
 * substitution is a data-integrity bug with no runtime symptom.
 *
 * Branding costs one type declaration and removes the whole class.
 *
 * @example
 * ```ts
 * export type ObservationId = Brand<string, 'ObservationId'>;
 * export type MedicationId  = Brand<string, 'MedicationId'>;
 *
 * declare const obsId: ObservationId;
 * takesMedicationId(obsId); // ✗ compile error, as it should be
 * ```
 */

declare const BRAND: unique symbol;

/** Attach a compile-time-only tag to an underlying primitive. */
export type Brand<T, TBrand extends string> = T & { readonly [BRAND]: TBrand };

/**
 * Assert that a raw value carries a brand.
 *
 * This performs no validation — it is a type-level cast and nothing more. Call
 * it only where the value has already been validated (a Zod parse, a database
 * read of a column with a check constraint). Where validation is needed, write
 * a parser that returns `Result<Branded, DomainError>` instead.
 */
export function brand<TBranded extends Brand<unknown, string>>(
  value: TBranded extends Brand<infer TUnderlying, string> ? TUnderlying : never,
): TBranded {
  return value as TBranded;
}

/** Strip a brand back to its underlying primitive. */
export function unbrand<T, TBrand extends string>(value: Brand<T, TBrand>): T {
  return value as T;
}
