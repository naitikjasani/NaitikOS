/**
 * @naitikos/shared — universal utilities.
 *
 * Blueprint §6.2 guards this package aggressively:
 *
 *   "`shared` is where dumping grounds are born. The admission test: *would
 *    this be equally at home in a completely different product?* If not, it
 *    belongs in a feature or in `core`."
 *
 * Everything exported here passes that test. Nothing here knows what an
 * observation, a medication, or a workout is.
 */

export { Sensitive, sensitive, isSensitive, REDACTED } from './sensitive';

export type { Result, Ok, Err } from './result';
export {
  ok,
  err,
  isOk,
  isErr,
  map,
  mapErr,
  andThen,
  unwrapOr,
  match,
  all,
  fromThrowable,
  fromPromise,
} from './result';

export type { Brand } from './brand';
export { brand, unbrand } from './brand';

export type { Uuid, EpochMillis, UuidV7Generator } from './id';
export {
  uuidV7,
  createUuidV7Generator,
  isUuid,
  isUuidV7,
  timestampFromUuidV7,
} from './id';

export { InvariantViolation, invariant, assertPresent, assertNever } from './assert';

export {
  isDefined,
  isString,
  isNonEmptyString,
  isFiniteNumber,
  isBoolean,
  isRecord,
  isArray,
  isArrayOf,
  hasProperty,
  isOneOf,
} from './guards';
