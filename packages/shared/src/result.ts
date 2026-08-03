/**
 * `Result<T, E>` — expected failure as a value, not an exception.
 *
 * Blueprint §5.12:
 *
 *   "Functions that can fail return an explicit `Result<T, DomainError>`.
 *    Domain errors are a closed, enumerated union. Exceptions are reserved for
 *    genuine bugs, not for expected outcomes."
 *
 * The reason this matters for NaitikOS specifically is §5.12's closing rule:
 * a failed *logging* action must never surface as a lost workout. Making
 * failure part of the return type means every call site is forced by the
 * compiler to decide what happens — which is exactly the discipline that keeps
 * a write in the outbox instead of on the floor.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

/** A computation that either succeeded with `T` or failed with `E`. */
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a success. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failure. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transform the success value, leaving a failure untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the error, leaving a success untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chain another fallible computation onto a success. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Extract the value, substituting a fallback on failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Collapse both branches into a single value. */
export function match<T, E, U>(
  result: Result<T, E>,
  handlers: { readonly onOk: (value: T) => U; readonly onErr: (error: E) => U },
): U {
  return result.ok ? handlers.onOk(result.value) : handlers.onErr(result.error);
}

/**
 * Collect an array of results into a result of an array, failing on the first
 * error. Useful for validating a batch of outbox entries where one bad record
 * should not silently drop the rest.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

/**
 * Bridge a throwing function into the Result world.
 *
 * Use this only at the edge — wrapping a third-party library that throws.
 * Domain code should return `Result` directly rather than throwing and
 * immediately catching.
 */
export function fromThrowable<T, E>(fn: () => T, onThrow: (caught: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (caught: unknown) {
    return err(onThrow(caught));
  }
}

/** Async form of {@link fromThrowable}. */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  onReject: (caught: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return ok(await promise);
  } catch (caught: unknown) {
    return err(onReject(caught));
  }
}
