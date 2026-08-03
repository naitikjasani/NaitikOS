# ADR 0004 — Extend the closed `DomainError` union with `unauthenticated` and `forbidden`

- **Status:** Accepted
- **Date:** 3 August 2026
- **Supersedes:** nothing
- **Blueprint sections:** §5.12 (error handling), §5.4 (authentication), §11.6 (ADRs)

> ADRs 0001–0003 are referenced from `pnpm-workspace.yaml` and
> `packages/config/tsconfig/base.json` but were never written. Those numbers are
> treated as reserved rather than reused.

## Context

§5.12 defines the domain error union and calls it closed:

> Domain errors are a closed, enumerated union — `ValidationError`, `NotFound`,
> `ConflictError`, `PreconditionFailed` — with structured fields.

`packages/core/src/errors/domain-error.ts` restates the constraint and sets the
process:

> **Closed** is the operative word. These four variants are the complete set.
> Adding a fifth is an architectural decision requiring an ADR (§11.6), not a
> convenience.

The identity and auth milestone needs to express two failures that none of the
four variants covers:

1. **There is no valid session.** The caller has not proved who they are.
2. **There is a valid session, and it does not permit this.** The caller is
   known and refused.

## Decision

Add exactly two variants: `UnauthenticatedError` and `ForbiddenError`.

## Alternatives rejected

**Reuse `PreconditionFailedError`.** Tempting, because "you are not signed in"
reads like an unmet precondition. Rejected on two grounds. §5.12 requires that
"domain errors map to HTTP status codes in exactly one place", and that mapping
sends `precondition_failed` to 412 — auth failures must be 401 and 403, so the
single mapping point would need to inspect a string field to decide the status,
which is a variant wearing a disguise. And the client behaviours are genuinely
different: 401 redirects to sign-in, 403 renders a refusal, 412 asks the user to
change something about their request.

**One `unauthorized` variant carrying a `reason: 'unauthenticated' | 'forbidden'`.**
Rejected for the same disguised-variant reason. Any field that fully determines
the HTTP status and the client's next action is a discriminant, and modelling a
discriminant as a payload field defeats the exhaustive `switch` that makes the
union worth having.

**A separate `AuthError` union outside `DomainError`.** Rejected because it
doubles the error surface every handler must consider. Route handlers would
return `Result<T, DomainError | AuthError>`, every mapping site would need two
switches, and the "exactly one place" guarantee becomes "exactly two places".

## Consequences

**Intended.** Auth failures are ordinary domain errors: they flow through the
same `Result` type, the same HTTP mapping, and the same audit hook as everything
else. Every exhaustive switch over `DomainError` now fails to compile until it
handles both new cases — which is the property §5.12 wanted from closing the
union, working as designed.

**Cost.** The union is 50% larger, and every existing exhaustive switch had to
be updated. That was three sites at the time of writing; it will be more later,
which is exactly the friction that should make a seventh variant hard.

**A deliberate non-consequence.** `ForbiddenError` does not carry the permission
that was missing. Telling an unauthorised caller precisely which permission
would have worked is a small information leak, and at n=1 it buys nothing a
server log cannot provide. The permission is logged, not returned.

## Revisit if

A third auth-shaped failure appears that is neither of these — the likely
candidate being step-up re-authentication (§5.4), where the caller *is*
authenticated and *does* hold the permission but the session is too old. That is
currently modelled as `ForbiddenError` with `stepUpRequired: true`, on the
grounds that the client's action is the same refusal-plus-prompt either way. If
that flag starts being checked in more than two places, it has become a
discriminant and earns its own variant by the same argument used above.
