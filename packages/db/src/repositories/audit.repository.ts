/**
 * The `AuthAuditRecorder` port, writing to §9.4's permanent audit log.
 *
 * §9.4: the log is "append-only and permanent... Never pruned. It is the answer
 * to 'when did this change, and to what?' at any point in the next twenty
 * years, and it is the recovery mechanism of last resort."
 *
 * ## Two decisions worth stating
 *
 * **Auth events are audit rows, not application logs.** §9.4 draws the line
 * explicitly: "The audit log is not the application log. Audit is domain data,
 * lives in Postgres, and is retained forever. Application logs are operational
 * exhaust and expire." A failed sign-in against a single-user system is domain
 * data — it is the record of someone trying to get in.
 *
 * **Recording never throws.** An audit write failing must not turn a successful
 * sign-in into a 500, nor a refusal into a different refusal. The event is
 * written on a best-effort basis and a failure is surfaced through the
 * application log instead. That is a deliberate trade and it points the right
 * way: losing one audit row is bad, and locking the operator out of their own
 * medical record because the audit table is full is worse.
 */

import type { AuthAuditEvent, AuthAuditRecorder } from '@naitikos/core';

import type { Database } from '../client';
import { auditLog } from '../schema/operations';

/**
 * The synthetic entity type auth events are filed under.
 *
 * `audit_log` is keyed by (entityType, entityId) because it normally records a
 * mutation to a row. An auth event has no row — a failed sign-in changed
 * nothing. Filing them under a stable pseudo-entity keeps them queryable
 * through the same composite index (§9.6) instead of needing their own table.
 */
const AUTH_ENTITY_TYPE = 'auth_session';

/** Actor string for events with no established identity yet. */
const ANONYMOUS_ACTOR = 'anonymous';

export type AuditRecorderOptions = {
  /**
   * Called when the audit write itself fails.
   *
   * Injected rather than logged directly: `packages/db` has no logger, and
   * §5.13 wants structured output with a traceId that only the caller has.
   */
  readonly onFailure?: (error: unknown, event: AuthAuditEvent) => void;
};

export function createAuthAuditRecorder(
  db: Database,
  options: AuditRecorderOptions = {},
): AuthAuditRecorder {
  return {
    async record(event: AuthAuditEvent): Promise<void> {
      try {
        await db.insert(auditLog).values({
          id: crypto.randomUUID(),
          entityType: AUTH_ENTITY_TYPE,

          /**
           * The subject when known, otherwise a nil UUID.
           *
           * `entityId` is NOT NULL because every other audit row genuinely has
           * one. A failed sign-in with a wrong address has no subject at all,
           * and the nil UUID says "no entity" unambiguously — better than
           * inventing an id that looks real in a query result.
           */
          entityId: event.subjectId ?? '00000000-0000-0000-0000-000000000000',

          /**
           * Auth events are not mutations, so `operation` is always `insert`.
           * The meaning lives in `changeReason`, which carries the event kind.
           */
          operation: 'insert',

          /**
           * §5.11's rule applied to audit: names and identifiers, never
           * content. `beforeState` is null because nothing existed;
           * `afterState` holds only the declared fields of AuthAuditEvent.
           */
          afterState: {
            kind: event.kind,
            ...(event.email === undefined ? {} : { email: event.email }),
            ...(event.strategy === undefined ? {} : { strategy: event.strategy }),
            // The permission that was refused is logged here and deliberately
            // never returned to the caller (ADR 0004).
            ...(event.permission === undefined ? {} : { permission: event.permission }),
            ...(event.clientHint === undefined ? {} : { clientHint: event.clientHint }),
          },

          actor: event.subjectId ?? ANONYMOUS_ACTOR,
          changeReason: event.kind,
          occurredAt: event.occurredAt.toISOString(),
          ...(event.traceId === undefined ? {} : { traceId: event.traceId }),
        });
      } catch (error: unknown) {
        // Never propagate. See the header: a full audit table must not lock the
        // operator out of their own record.
        options.onFailure?.(error, event);
      }
    },
  };
}

export { AUTH_ENTITY_TYPE };
