/**
 * The bridge from "the provider says this credential is valid" to "this actor
 * may act".
 *
 * This is the only function in the system that produces an {@link Actor}. That
 * is the point: §5.4 requires the allowlist to be "checked server-side on every
 * request", and the reliable way to guarantee a check happens everywhere is to
 * make it impossible to obtain the thing guards consume without passing it.
 *
 * The sequence, and why it is this order:
 *
 *   1. **No identity → anonymous.** Not an error. A signed-out visitor loading
 *      a public page is an ordinary state.
 *   2. **Email unverified → refuse.** An unverified address has not been proven
 *      to belong to the person holding the account, so allowlisting it would
 *      allowlist whoever registered it.
 *   3. **Allowlist → refuse if absent.** Before any database work, because a
 *      rejected identity should not cause a profile lookup, let alone create one.
 *   4. **Role lookup, linking on first sign-in.**
 *
 * Every refusal is audited. §9.4's log is "the recovery mechanism of last
 * resort", and a rejected sign-in against a single-user system is exactly the
 * event worth being able to find later.
 */

import type { Result } from '@naitikos/shared';
import { err, isErr, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { forbiddenError } from '../errors/domain-error';
import type { AuthState } from './actor';
import { ANONYMOUS, authenticated } from './actor';
import type { Allowlist } from './allowlist';
import { checkAllowlist } from './allowlist';
import type { AuthAuditRecorder, IdentityRepository, ProviderIdentity } from './ports';

export type ResolveDependencies = {
  readonly allowlist: Allowlist;
  readonly identities: IdentityRepository;
  readonly audit: AuthAuditRecorder;
  readonly now: Date;
  readonly traceId?: string;
};

/**
 * Turn a provider identity into an authorized actor, or refuse.
 *
 * @param identity - `null` when there is no session at all.
 */
export async function resolveActor(
  identity: ProviderIdentity | null,
  deps: ResolveDependencies,
): Promise<Result<AuthState, DomainError>> {
  if (identity === null) {
    return ok(ANONYMOUS);
  }

  /* --- 2. The address must be verified ------------------------------- */
  if (!identity.emailVerified) {
    await deps.audit.record({
      kind: 'allowlist_rejected',
      email: identity.email,
      subjectId: identity.subjectId,
      strategy: identity.strategy,
      occurredAt: deps.now,
      ...(deps.traceId === undefined ? {} : { traceId: deps.traceId }),
    });

    // Reported as not-allowlisted rather than as its own reason. An unverified
    // address is not on the list, and telling the caller which of the two
    // checks it failed distinguishes "wrong address" from "right address,
    // unverified" — which is an account enumeration hint.
    return err(forbiddenError('not_allowlisted', 'This account is not permitted.'));
  }

  /* --- 3. The allowlist ---------------------------------------------- */
  const allowed = checkAllowlist(deps.allowlist, identity.email);
  if (isErr(allowed)) {
    await deps.audit.record({
      kind: 'allowlist_rejected',
      email: identity.email,
      subjectId: identity.subjectId,
      strategy: identity.strategy,
      occurredAt: deps.now,
      ...(deps.traceId === undefined ? {} : { traceId: deps.traceId }),
    });
    return allowed;
  }

  /* --- 4. Role, linking on first sign-in ------------------------------ */
  const existing = await deps.identities.findRoleBySubject(identity.subjectId);
  if (isErr(existing)) return existing;

  let role = existing.value;

  if (role === null) {
    // First sign-in on a fresh installation: the credential is valid and
    // allowlisted, but no profile row exists yet. Linking is idempotent
    // (see IdentityRepository), so two tabs racing here is safe.
    const linked = await deps.identities.linkSubject(identity.subjectId, allowed.value);
    if (isErr(linked)) return linked;
    role = linked.value;
  }

  return ok(
    authenticated({
      subjectId: identity.subjectId,
      email: allowed.value,
      role,
      authenticatedAt: identity.authenticatedAt,
      strategy: identity.strategy,
    }),
  );
}
