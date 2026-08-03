/**
 * The allowlist — §5.4's actual authorization model.
 *
 *   "A hardcoded allowlist of exactly one email address, checked server-side on
 *    every request. Sign-up is disabled at the provider. This is the actual
 *    authorization model, and its simplicity is a feature."
 *
 * Two properties are worth being explicit about, because both are easy to
 * erode later without noticing.
 *
 * **It is checked on every request, not only at sign-in.** A session issued
 * before an address was removed from the list must stop working immediately.
 * Checking only at the door means revocation waits up to thirty days (§5.4's
 * sliding session), which is not revocation.
 *
 * **It is independent of the auth provider.** Supabase can be misconfigured;
 * sign-up can be re-enabled by a dashboard click nobody remembers making. This
 * check is in version control, is covered by tests, and fails closed. It is the
 * belt to the provider's braces, and at n=1 the belt is the part that matters.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../errors/domain-error';
import { forbiddenError } from '../errors/domain-error';

/**
 * Normalise an address for comparison.
 *
 * Lowercase and trim, and nothing else. Notably **no** dot-stripping or
 * plus-tag removal: those are Gmail delivery conventions, not identity rules,
 * and treating `a.b@gmail.com` as `ab@gmail.com` would mean the allowlist
 * accepts an address it was never given. For a one-entry list, exactness is
 * free and guessing is not.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Compare two addresses in constant time.
 *
 * The timing channel here is genuinely negligible — the list has one entry and
 * the attacker would be distinguishing string lengths over a network. It is
 * written this way regardless, because the cost is a few lines and the habit of
 * comparing security-relevant strings with `===` is the thing that eventually
 * shows up somewhere it does matter.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);

  // Length is not secret; comparing unequal lengths bit-by-bit adds nothing.
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let i = 0; i < left.length; i += 1) {
    difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return difference === 0;
}

/** An immutable, normalised allowlist. */
export type Allowlist = {
  readonly entries: readonly string[];
  readonly permits: (email: string) => boolean;
};

/**
 * Build an allowlist from configured addresses.
 *
 * @throws {Error} when the list is empty. This is deliberate and it is the most
 *   important line in the file: an empty allowlist that silently permits nobody
 *   looks identical to a broken sign-in, and an empty allowlist that silently
 *   permits *everybody* is a catastrophe. Failing at construction — which
 *   happens at process start, via environment validation — makes a
 *   misconfiguration impossible to deploy rather than merely unlikely.
 */
export function createAllowlist(emails: readonly string[]): Allowlist {
  const entries = Object.freeze(
    emails.map(normaliseEmail).filter((entry) => entry.length > 0),
  );

  if (entries.length === 0) {
    throw new Error(
      'The auth allowlist is empty. Blueprint §5.4 requires a hardcoded allowlist of ' +
        'at least one email address, checked server-side on every request. Set AUTH_ALLOWLIST.',
    );
  }

  return Object.freeze({
    entries,
    permits: (email: string): boolean => {
      const candidate = normaliseEmail(email);
      // `some` short-circuits, which technically leaks position in a
      // multi-entry list. Irrelevant at one entry, and noted rather than
      // optimised away, because the fix would obscure the code.
      return entries.some((entry) => constantTimeEquals(entry, candidate));
    },
  });
}

/**
 * Gate an authenticated identity through the allowlist.
 *
 * Returns `forbidden`, never `unauthenticated`: the caller has proved who they
 * are, and the answer is still no. Sending them back to sign in would loop them
 * forever against a credential that works.
 */
export function checkAllowlist(allowlist: Allowlist, email: string): Result<string, DomainError> {
  const normalised = normaliseEmail(email);

  if (!allowlist.permits(normalised)) {
    // The message does not name the address or the list. §5.13, and there is
    // nothing useful to tell someone who should not be here.
    return err(forbiddenError('not_allowlisted', 'This account is not permitted.'));
  }

  return ok(normalised);
}
