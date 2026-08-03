/**
 * UUIDv7 generation (RFC 9562).
 *
 * Blueprint §5.3 selects UUIDv7 for every identifier, and §5.7 explains why it
 * is load-bearing rather than cosmetic:
 *
 *   "Client-generated UUIDv7 IDs. A record created offline has its permanent
 *    identity from the moment it exists. No temporary IDs, no re-keying, no
 *    reconciliation of references."
 *
 * A v4 UUID would satisfy that too, but v7's leading 48-bit timestamp keeps
 * index locality — rows written in time order land near each other in the
 * B-tree — without exposing a guessable sequence. Over twenty years of
 * append-only observations (§9.1) that locality is the difference between an
 * index that stays healthy and one that fragments.
 *
 * ## Why the timestamp is a parameter
 *
 * `now` is injected rather than read from the ambient clock. Three reasons,
 * all from the blueprint:
 *
 *   - §11.3 bans raw `Date` access outside `core/temporal`, because a wall
 *     clock silently discards the IANA zone that every observation must carry.
 *   - §5.7 requires hybrid logical clocks for offline ordering; an HLC supplies
 *     its own timestamp, and this function must accept it.
 *   - §5.8 notes device clocks drift and get manually adjusted. A function that
 *     reads the clock itself cannot be tested against that.
 *
 * `@naitikos/shared` sits at the bottom of the layering (§5.0) and cannot
 * import `core/temporal`, so the dependency is inverted: the caller supplies
 * the time.
 */

import type { Brand } from './brand';

/** A UUID in canonical 8-4-4-4-12 lowercase hexadecimal form. */
export type Uuid = Brand<string, 'Uuid'>;

/** Milliseconds since the Unix epoch. */
export type EpochMillis = Brand<number, 'EpochMillis'>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 2^48 − 1: the largest timestamp the 48-bit field can hold (year 10889). */
const MAX_TIMESTAMP = 0xffff_ffff_ffff;

/** 12-bit `rand_a` field, used as the intra-millisecond counter. */
const MAX_COUNTER = 0x0fff;

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/**
 * A stateful UUIDv7 generator.
 *
 * State exists solely to guarantee monotonicity within a single millisecond
 * (RFC 9562 §6.2, "Replace Leftmost Random Bits with Increased Clock
 * Precision"). Without it, two observations logged in the same millisecond —
 * entirely possible when the outbox drains a batch — could sort in the wrong
 * order, and §9.1's append-only timeline would be subtly wrong.
 */
export type UuidV7Generator = {
  /**
   * @param now - milliseconds since the Unix epoch, supplied by the caller's clock.
   * @throws {RangeError} if `now` is not a non-negative integer within the 48-bit field.
   */
  next(now: number): Uuid;
};

/**
 * Create an independent generator with its own monotonic counter.
 *
 * Prefer this over the module-level {@link uuidV7} where determinism matters —
 * a test can hold its own generator and drive it with a fixed clock.
 */
export function createUuidV7Generator(): UuidV7Generator {
  let lastTimestamp = -1;
  let counter = 0;

  return {
    next(now: number): Uuid {
      if (!Number.isInteger(now) || now < 0 || now > MAX_TIMESTAMP) {
        throw new RangeError(
          `UUIDv7 timestamp must be a non-negative integer ≤ ${MAX_TIMESTAMP}; received ${String(now)}.`,
        );
      }

      // Monotonicity. A clock that jumps backwards (NTP correction, manual
      // adjustment — both called out in §5.8) must not produce a UUID that
      // sorts before one already issued, so we hold the previous timestamp and
      // advance the counter instead.
      let timestamp = now;
      if (timestamp > lastTimestamp) {
        lastTimestamp = timestamp;
        counter = randomCounter();
      } else {
        timestamp = lastTimestamp;
        counter += 1;
        if (counter > MAX_COUNTER) {
          // Counter exhausted within one millisecond (4096 IDs). Borrow from
          // the next millisecond rather than wrapping and breaking ordering.
          lastTimestamp += 1;
          timestamp = lastTimestamp;
          counter = randomCounter();
        }
      }

      return format(timestamp, counter);
    },
  };
}

/** Cryptographically random 12-bit seed for the counter. */
function randomCounter(): number {
  const seed = new Uint8Array(2);
  crypto.getRandomValues(seed);
  return (((seed[0] ?? 0) << 8) | (seed[1] ?? 0)) & MAX_COUNTER;
}

/** Assemble the 128-bit value into canonical form. */
function format(timestampMs: number, counter: number): Uuid {
  const bytes = new Uint8Array(16);

  // Bytes 0–5: 48-bit big-endian timestamp.
  // `Number` is exact to 2^53, so the 48-bit split below is lossless.
  const high = Math.floor(timestampMs / 0x1_0000_0000);
  const low = timestampMs >>> 0;
  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;

  // Bytes 6–7: version (0b0111) in the high nibble, then the 12-bit counter.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // Bytes 8–15: variant (0b10) in the top two bits, then 62 random bits.
  const random = new Uint8Array(8);
  crypto.getRandomValues(random);
  bytes[8] = 0x80 | ((random[0] ?? 0) & 0x3f);
  for (let i = 1; i < 8; i += 1) {
    bytes[8 + i] = random[i] ?? 0;
  }

  const hex = (index: number): string => HEX[bytes[index] ?? 0] ?? '00';
  const group = (from: number, to: number): string => {
    let out = '';
    for (let i = from; i < to; i += 1) out += hex(i);
    return out;
  };

  return `${group(0, 4)}-${group(4, 6)}-${group(6, 8)}-${group(8, 10)}-${group(10, 16)}` as Uuid;
}

/** The process-wide default generator. */
const defaultGenerator = createUuidV7Generator();

/**
 * Generate a UUIDv7 using the shared monotonic counter.
 *
 * @param now - milliseconds since the Unix epoch, from the caller's clock.
 */
export function uuidV7(now: number): Uuid {
  return defaultGenerator.next(now);
}

/** Structural check for canonical UUID form. Does not verify the version. */
export function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Check that a value is a well-formed UUID *and* declares version 7. */
export function isUuidV7(value: unknown): value is Uuid {
  return isUuid(value) && value[14] === '7';
}

/**
 * Recover the embedded creation timestamp from a UUIDv7.
 *
 * Useful in diagnostics and in the audit trail (§9.4), where knowing when an ID
 * was minted — independently of any timestamp column — helps reconstruct what
 * happened.
 *
 * @returns milliseconds since the Unix epoch, or `null` if not a valid v7.
 */
export function timestampFromUuidV7(value: string): EpochMillis | null {
  if (!isUuidV7(value)) return null;
  const hex = value.slice(0, 8) + value.slice(9, 13);
  const parsed = Number.parseInt(hex, 16);
  return Number.isNaN(parsed) ? null : (parsed as EpochMillis);
}
