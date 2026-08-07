/**
 * Event version migration.
 *
 * Events are append-only and never rewritten. An event written in 2027 at
 * version 1 is still a version 1 event in 2039 — so a handler in 2039 must be
 * able to read it, and the only way that stays true is if every version bump
 * ships an upcaster at the same time.
 *
 * ## Upcast on read, never rewrite in place
 *
 * The alternative — a migration that rewrites old rows to the new shape — is
 * rejected for the same reason §9.1 rejects mutable observations: "If a weight
 * from 2027 can be silently edited in 2031, then no number in the system can be
 * relied upon." Rewriting an event destroys the record of what was actually
 * emitted, and with it the ability to reproduce a past replay.
 *
 * So the stored row is immutable and `upcast` runs on the way out. It is a pure
 * function, which means a replay in 2039 produces the same projection as one in
 * 2029 given the same log.
 *
 * ## Adding a version
 *
 * 1. Change the payload type in `registry.ts` and bump its `version`.
 * 2. Add an upcaster below, from the previous version to the new one.
 * 3. Add a case to `migrate.test.ts` with a realistic old payload.
 *
 * Step 3 is not optional. An upcaster with no test is a guess about data that
 * already exists and cannot be re-created.
 */

import type { Result } from '@naitikos/shared';
import { err, isErr, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { preconditionFailedError } from '../errors/domain-error';
import type { DomainEvent } from './envelope';
import { currentVersion, type EventType } from './registry';

/**
 * Transforms a payload from `fromVersion` to `fromVersion + 1`.
 *
 * Takes and returns `unknown`: an upcaster operates on a shape that no longer
 * has a TypeScript type, because that type was deleted when the version was
 * bumped. Pretending otherwise would mean keeping every historical payload type
 * alive forever.
 */
export type Upcaster = {
  readonly eventType: EventType;
  readonly fromVersion: number;
  readonly describe: string;
  upcast(payload: unknown): unknown;
};

/**
 * The upcaster table.
 *
 * **Empty, and that is correct** — every event type is at version 1, so there is
 * nothing to upcast from. The machinery exists now because the first version bump
 * will happen under time pressure, and building the migration path then is how
 * an event log acquires a rewrite script.
 *
 * A worked example of what an entry looks like, for whoever adds the first one:
 *
 * ```ts
 * {
 *   eventType: 'Workout.Completed',
 *   fromVersion: 1,
 *   describe: 'v2 splits setCount into workingSetCount + warmupSetCount.',
 *   upcast: (payload) => {
 *     const old = payload as { setCount: number };
 *     return {
 *       // Historical events cannot distinguish the two. Attributing all of it
 *       // to working sets is a guess; recording that it IS a guess is the part
 *       // that matters, because a detector reading this later must know.
 *       workingSetCount: old.setCount,
 *       warmupSetCount: 0,
 *       isUpcastEstimate: true,
 *     };
 *   },
 * }
 * ```
 */
export const UPCASTERS: readonly Upcaster[] = Object.freeze([]);

/** Upcasters for a type, ordered by version. */
function upcastersFor(type: EventType, upcasters: readonly Upcaster[]): readonly Upcaster[] {
  return upcasters
    .filter((u) => u.eventType === type)
    .sort((a, b) => a.fromVersion - b.fromVersion);
}

/**
 * Bring a stored event up to the current payload version.
 *
 * Applies upcasters in sequence: a v1 event with three bumps behind it passes
 * through three functions. Chaining rather than jumping straight to the current
 * version means each step is small, individually testable, and does not have to
 * know about the steps after it.
 */
export function upcast(event: DomainEvent): Result<DomainEvent, DomainError> {
  return upcastWith(event, UPCASTERS, currentVersion(event.eventType));
}

/**
 * `upcast` with the table and the target version injected.
 *
 * The reason this parameterisation exists is uncomfortable but worth stating:
 * {@link UPCASTERS} is empty and every registered type is at v1, so
 * {@link upcast} can only ever exercise the identity path today. The chain
 * logic below — gap detection, sequencing, the incomplete-chain refusal — would
 * therefore ship entirely untested and first execute during the very version
 * bump it exists to protect.
 *
 * So the tests drive this function with a synthetic table, and `upcast` is a
 * one-line delegation. Production callers should use `upcast`.
 */
export function upcastWith(
  event: DomainEvent,
  upcasters: readonly Upcaster[],
  target: number,
): Result<DomainEvent, DomainError> {
  if (event.version === target) return ok(event);

  if (event.version > target) {
    /**
     * A stored event newer than this build understands.
     *
     * §5.8 anticipates the scenario — "Over twenty years there will be a stale
     * phone in a drawer" — and the same applies to a rolled-back server reading
     * events a newer deploy wrote. Failing closed is the only safe direction:
     * guessing at a future shape would corrupt the projection.
     */
    return err(
      preconditionFailedError(
        'event_version_supported',
        `${event.eventType} event is version ${String(event.version)} but this build understands only ${String(target)}. Deploy the newer build.`,
        'event_from_future',
      ),
    );
  }

  const chain = upcastersFor(event.eventType, upcasters).filter(
    (u) => u.fromVersion >= event.version && u.fromVersion < target,
  );
  let payload: unknown = event.payload;
  let version = event.version;

  for (const upcaster of chain) {
    if (upcaster.fromVersion !== version) {
      // A gap in the chain. Better to refuse than to skip a transformation and
      // hand a handler a shape from two versions ago.
      return err(
        preconditionFailedError(
          'upcaster_chain_complete',
          `No upcaster for ${event.eventType} v${String(version)}. The migration chain has a gap.`,
          'upcaster_missing',
        ),
      );
    }
    payload = upcaster.upcast(payload);
    version += 1;
  }

  if (version !== target) {
    return err(
      preconditionFailedError(
        'upcaster_chain_complete',
        `${event.eventType} reached v${String(version)} after upcasting but the current version is v${String(target)}.`,
        'upcaster_incomplete',
      ),
    );
  }

  return ok({ ...event, version, payload } as DomainEvent);
}

/** Upcast a batch, failing on the first event that cannot be migrated. */
export function upcastAll(
  events: readonly DomainEvent[],
): Result<readonly DomainEvent[], DomainError> {
  const out: DomainEvent[] = [];
  for (const event of events) {
    const result = upcast(event);
    if (isErr(result)) return result;
    out.push(result.value);
  }
  return ok(out);
}
