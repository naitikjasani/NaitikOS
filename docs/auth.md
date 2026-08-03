# Authentication and Identity

**Status:** implemented, Week 1 · **Blueprint sections:** §5.4, §5.14, §9.4, §10.10
**Related:** [ADR 0004 — auth domain errors](adr/0004-auth-domain-errors.md)

---

## 1. Architecture

### 1.1 The layering

Authentication is spread across four layers on purpose. §5.4 places the
authorization decision "in the API layer where it is testable, readable, and
version-controlled", and §5.0 requires the durable layer to survive a framework
rewrite. Both are satisfied by keeping the *decision* framework-free and the
*mechanism* replaceable.

```
┌──────────────────────────────────────────────────────────────────┐
│ apps/web                                                          │
│   proxy.ts ............. session refresh · coarse route guard     │  replaceable
│   lib/auth/session.ts .. THE server-side entry point              │
│   lib/auth/*provider ... ★ the only Supabase import in the repo   │
│   features/auth ........ form, session context, typed client      │
├──────────────────────────────────────────────────────────────────┤
│ packages/api                                                      │
│   contracts ............ Zod, imported by client AND server       │  replaceable
│   errors/http.ts ....... DomainError → HTTP, in exactly one place │
│   middleware ........... CSRF · rate limit · security headers     │
│   guards ............... the single call site of `authorize`      │
├──────────────────────────────────────────────────────────────────┤
│ packages/db                                                       │
│   auth_identity ........ subject → profile → role                 │  semi-durable
│   repositories ......... implementations of core's ports          │
│   migration 0004 ....... RLS on every table                       │
├──────────────────────────────────────────────────────────────────┤
│ packages/core/auth                    ★ DURABLE — zero frameworks │
│   roles.ts ............. the permission matrix                    │
│   actor.ts ............. `authorize()` — the ONLY decision        │
│   allowlist.ts ......... §5.4's "actual authorization model"      │
│   resolve.ts ........... the only path that produces an Actor     │
│   ports.ts ............. AuthProvider, IdentityRepository, Audit  │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 The two type transitions that carry the security

```
ProviderIdentity ──resolveActor()──▶ AuthState ──authorize()──▶ Actor
   "a credential          allowlist,      "who this is"   permission,  "and they
    was valid"            role, audit                     step-up       may do X"
```

`ProviderIdentity` and `Actor` are deliberately different types. A
`ProviderIdentity` has merely presented a valid credential; an `Actor` has
passed the allowlist and carries a role from *this application's* data.
`resolveActor()` is the only function that produces an `Actor`, which is how
§5.4's "checked server-side on every request" is made structural rather than
remembered.

### 1.3 Where each rule lives — one place each

| Concern | The single location |
|---|---|
| Who may sign in | `core/auth/allowlist.ts` |
| What a role may do | `core/auth/roles.ts` → `ROLE_PERMISSIONS` |
| The authorization decision | `core/auth/actor.ts` → `authorize()` |
| Allowlist + role + audit | `core/auth/resolve.ts` → `resolveActor()` |
| Server-side "who is this?" | `apps/web/lib/auth/session.ts` → `getAuthState()` |
| Which routes are public | `apps/web/lib/auth/routes.ts` |
| Error → HTTP status | `packages/api/src/errors/http.ts` |
| Supabase SDK usage | `apps/web/lib/auth/supabase-auth-provider.ts` + `lib/supabase/clients.ts` |

Nothing else compares a role, checks an email against a list, or maps a domain
error to a status code.

---

## 2. Sign-in flow

```
 Browser                    proxy.ts            /api/auth/sign-in         Supabase        Postgres
    │                          │                       │                     │               │
    │─ GET /body/skin ────────▶│                       │                     │               │
    │                          │─ getUser() ──────────────────────────────▶  │               │
    │                          │◀ no session ──────────────────────────────  │               │
    │◀ 307 /auth/sign-in?next=%2Fbody%2Fskin                                 │               │
    │   + CSRF cookie seeded   │                       │                     │               │
    │                          │                       │                     │               │
    │─ POST /api/auth/sign-in ────────────────────────▶│                     │               │
    │   {email, password, redirectTo}                  │                     │               │
    │   X-Naitikos-Csrf: <token from cookie>           │                     │               │
    │                          │                  1. CSRF (origin + token)   │               │
    │                          │                  2. rate limit (5 / 15 min) │               │
    │                          │                  3. Zod parse               │               │
    │                          │                       │─ signInWithPassword▶│               │
    │                          │                       │◀ user ──────────────│               │
    │                          │                  4. resolveActor:           │               │
    │                          │                       │  · emailVerified?   │               │
    │                          │                       │  · allowlist?       │               │
    │                          │                       │─ findRoleBySubject ────────────────▶│
    │                          │                       │─ linkSubject (first sign-in only) ─▶│
    │                          │                       │─ audit: sign_in_succeeded ─────────▶│
    │◀ 200 {session, redirectTo} + httpOnly session cookies                  │               │
    │                          │                       │                     │               │
    │─ router.refresh() then replace('/body/skin')     │                     │               │
```

**Step 4 is the one that matters.** Supabase saying "this password is correct"
is necessary and not sufficient. The allowlist runs afterwards, against
application configuration Supabase cannot influence, and a rejection there tears
the just-created Supabase session down — otherwise the rejected account would
hold a cookie the proxy waves through.

### Failure responses

| Situation | Status | Why |
|---|---|---|
| Wrong password | 401 | Signing in again may work |
| Unknown account | 401 | **Identical** to wrong password — no enumeration |
| Valid credential, not allowlisted | 403 | Signing in again will never work |
| Unverified email | 403 | Identical response to not-allowlisted |
| 6th attempt in 15 min | 429 + `Retry-After` | |
| Missing/mismatched CSRF | 403 | Message does not say which check failed |

---

## 3. Session lifecycle

```
sign in ──▶ ACTIVE ──(every request, proxy)──▶ refreshed ──▶ ACTIVE
              │                                                │
              │ 30 days idle                                   │ sign out (global)
              ▼                                                ▼
          EXPIRED ──▶ /auth/sign-in                         REVOKED
```

- **Length:** 30 days, sliding. §5.4: "Re-authenticating a personal daily-use
  tool constantly is a P1 violation."
- **Refresh:** in `proxy.ts` only. A Server Component *cannot* set a cookie, so
  a refresh attempted during render is silently discarded. This is the single
  most confusing failure mode in the App Router and the reason the proxy runs
  first and unconditionally.
- **Verification:** `getUser()`, never `getSession()`. `getSession` decodes the
  cookie and trusts it; `getUser` verifies the JWT with the auth server. On a
  trust boundary that is the difference between checking a credential and
  believing one. It costs a round trip, which is why `getAuthState()` is wrapped
  in React's `cache` — one request, one verification.
- **Sign-out:** `scope: 'global'`. A local-only sign-out on a phone that was
  just handed to someone is not a sign-out. The client then calls
  `router.refresh()` before navigating, or the Router Cache would still hold
  server-rendered output produced while signed in.

### Step-up (§5.4)

Export, encryption-key access, and deletion require re-authentication
**regardless of session age**. The window is **15 minutes**, measured from
`last_sign_in_at` — not from token issuance, because a session refreshed
silently for thirty days has a recent token and a stale authentication.

Clock skew fails closed: an `authenticatedAt` in the future is treated as stale.

---

## 4. Authorization

Four roles exist; one is in use. Adding a role is one row in `ROLE_PERMISSIONS`
and one value in the `app_role` enum — **no call site changes**, because no call
site asks "is this the owner?" They ask "may this actor do X?"

| Permission | owner | clinician | delegate | service |
|---|:--:|:--:|:--:|:--:|
| `observation:read` / `:write` | ✅ | read | — | ✅ |
| `medical:read` / `:write` | ✅ | read | — | read |
| `journal:*` | ✅ | — | read | — |
| `media:*` | ✅ | — | — | — |
| `settings:*` | ✅ | — | — | read |
| `export:execute` ⚠️ step-up | ✅ | — | — | — |
| `security:manage` ⚠️ step-up | ✅ | — | — | — |
| `ai:invoke` | ✅ | — | — | ✅ |
| `audit:read` | ✅ | ✅ | — | — |

Two entries are deliberate and worth not "fixing":

- **`clinician` has no journal access.** §4.7 classifies journal content as the
  most sensitive data in the system. A shared clinical export carries a
  medication history, not a diary.
- **`service` — the nightly job — has neither journal nor export.** A process
  that runs unattended at 03:00 and can both read the diary and produce an
  archive is an exfiltration path with nobody watching (C3).

**The rule that keeps this maintainable:** never branch on a role, always on a
permission. `if (actor.role === 'owner')` breaks when a second role appears;
`if (can(actor, 'observation:write'))` does not.

---

## 5. RLS strategy

**RLS is enabled and `FORCE`d on all 72 tables, with zero policies.**

That is not an unfinished migration. §5.4 states the position:

> Row Level Security is enabled on every table as defence in depth — but it is
> explicitly *not* the primary authorization mechanism… Encoding domain rules in
> RLS policies is a maintenance trap at C2 horizons.

Combined with:

> No client-direct-to-database access. This forgoes Supabase's headline feature
> deliberately.

RLS with no policy denies everything. Since the architecture forbids the
PostgREST path entirely, making that path return *nothing* is both stricter and
less code than maintaining 72 policy sets for access that should never happen.

**Why this matters concretely:** `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships in the
browser bundle. It is public. It is harmless *only* because of migration 0004.
Remove that migration and the anon key becomes a full data breach.

| Role | Reaches the data? | How |
|---|---|---|
| Application (`postgres`, BYPASSRLS) | ✅ | Direct connection, through the API layer |
| `anon` / `authenticated` (PostgREST) | ❌ | RLS denies **and** grants revoked |
| Any role granted `SELECT` later | ❌ | RLS still denies — verified by test |

That last row is tested behaviourally, not just by configuration:
`rls.test.ts` creates a role, grants it `SELECT ON metric`, and asserts it reads
**zero** rows while the app role reads 18.

`FORCE` means even the table owner is subject to RLS. The operational
consequence is real and accepted: **if the application ever connects as a role
without `BYPASSRLS`, everything fails immediately.** That is the correct
direction — a loud outage rather than a silent bypass.

Adding a policy is an architectural change requiring an ADR. `rls.test.ts`
fails if one appears, and fails if a new table is added without RLS.

---

## 6. Security decisions

### Implemented

| Control | Where | Note |
|---|---|---|
| Single-email allowlist | `core/auth/allowlist.ts` | Checked every request; throws at boot if empty |
| Constant-time comparison | allowlist, CSRF | Negligible threat, cheap habit |
| No account enumeration | provider adapter | All credential failures identical |
| CSRF: origin + double-submit | `api/middleware/csrf.ts` | Origin is primary, token is backup |
| Rate limiting | `api/middleware/rate-limit.ts` | 5/15min sign-in, 3/15min step-up |
| CSP, nonce-based, `strict-dynamic` | `api/middleware/security-headers.ts` | Per-request nonce from the proxy |
| HSTS, 2 years, preload | same | Production only — localhost would be poisoned |
| `Referrer-Policy: same-origin` | same | Paths here are sensitive: `/body/skin/treatments` |
| `Permissions-Policy` | same | Microphone denied; camera allowed for §4.2 |
| Environment validation | `apps/web/lib/env.ts` | Fails at process start, not at first use |
| Audit hooks | `db/repositories/audit.repository.ts` | Every sign-in, refusal, and denial |
| No tokens in JS | session contract | httpOnly cookies only; response bodies carry none |
| `robots: noindex` | root layout | A crawler confirming the account exists is step one |

### Deliberate trade-offs

**`style-src 'unsafe-inline'`.** Tailwind v4 and Next both emit inline
`<style>` during hydration, and nonce-ing them is not currently possible without
patching the framework. Residual risk is CSS injection — defacement, and
selector-based inference with effort. It is *not* exfiltration, because
`connect-src` still holds. **Revisit when** Next supports style nonces, or when
the design system lands and the inline surface is known.

**In-process rate limiting.** Correct for a single deployment; on two serverless
instances the effective limit doubles. The store is a port
(`RateLimitStore`) so swapping to Postgres or Upstash is one adapter. **Revisit
when** the deployment stops being single-instance.

**CSRF cookie is not httpOnly.** Required — double-submit works by having client
JS read it. Safe because the token is not a credential; the security property is
that a cross-origin attacker cannot *read* it, which same-origin policy provides
regardless.

**Step-up reuses `signInWithPassword`.** Supabase's own `reauthenticate()` sends
an emailed code, which is a different flow. Re-signing in as the same user
refreshes `last_sign_in_at` and preserves the session, which is what the port
requires — but it is a workaround, not the intended API.

---

## 7. Future strategies

Strategies are entries in `STRATEGY_REGISTRY` (`core/auth/strategies.ts`), not
branches in a flow. Nothing in the guards, session model, allowlist, or audit
trail asks *how* a user signed in.

| Strategy | Status | To enable |
|---|---|---|
| `password` | ✅ enabled | — |
| `magic_link` | wired, disabled | Configure SMTP on the Supabase project; flip `enabled`. The adapter method exists and already sets `shouldCreateUser: false` |
| `passkey` | not implemented | Needs a WebAuthn ceremony the adapter does not have. §5.4's **preferred** factor |
| `oauth_google` | wired, disabled | Configure the provider; flip `enabled`. Callback route, code exchange, and allowlist check all handle it already |

### The divergence from §5.4, stated plainly

The blueprint specifies **"email magic link plus passkey (WebAuthn) as the
preferred factor"**. This milestone shipped email/password instead, by product
decision.

What was preserved regardless of mechanism: the single-email allowlist, sign-up
disabled at the provider, server-side checking on every request, and step-up for
sensitive operations. Those are strategy-independent by construction.

What was lost: phishing resistance. A password is the one credential its owner
can be socially engineered into disclosing, and this database contains
psychiatric medication history and body photographs. The `preferred: true` flags
on `passkey` and `magic_link` exist so this remains visible rather than becoming
permanent by default — and the sign-in form says so in the UI.

### A note on enabling Google

The plumbing is complete and it stays off deliberately. An OAuth provider never
receives health data, but it does learn every sign-in time — which for a
daily-use health tool is a behavioural record of when its user was awake,
anxious, or in a clinic, accruing to a third party the user cannot audit.
Smaller than an analytics SDK; not zero. Enabling it is legitimate; enabling it
*silently* is not, which is why the flag is in version control next to this
paragraph rather than in a provider dashboard.

---

## 8. Operations

### Local setup

```bash
cp .env.example .env.local          # then fill in the Supabase values
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm --filter @naitikos/web dev
```

`AUTH_ALLOWLIST` must contain at least one address or the process refuses to
start. That is intentional: §5.4 calls the allowlist "the actual authorization
model", and a typo in its variable name must not be survivable.

### Supabase project checklist

1. **Disable sign-ups** (Authentication → Providers → Email). §5.4 requires it.
   The allowlist is the backstop, not the gate.
2. **Require email confirmation.** `resolveActor` refuses unverified addresses.
3. **Enable the four extensions** from `packages/db/docker/init/001-extensions.sql`.
4. **Set the site URL and redirect allowlist** to match `NEXT_PUBLIC_SITE_URL`.
5. **Verify the app role has `BYPASSRLS`** — see §5 above. Without it, `FORCE`
   RLS means total lockout.

### Revoking access

```sql
UPDATE auth_identity SET disabled_at = now(), disabled_reason = 'lost device'
 WHERE subject_id = '<subject>';
```

Takes effect on the next request — `findRoleBySubject` filters `disabled_at IS
NULL`. Not at session expiry, which would mean up to thirty days. A subsequent
sign-in cannot resurrect it; `linkSubject` returns `identity_disabled`.

### Reading the audit trail

```sql
SELECT occurred_at, after_state->>'kind' AS event, after_state->>'email', trace_id
  FROM audit_log
 WHERE entity_type = 'auth_session'
 ORDER BY occurred_at DESC LIMIT 50;
```

---

## 9. Test coverage

| Suite | Tests | Covers |
|---|---:|---|
| `core/auth/authorization.test.ts` | 24 | Matrix, `authorize`, step-up, allowlist, registry |
| `core/auth/resolve.test.ts` | 12 | The allowlist seam, first sign-in, races, audit |
| `db/repositories/identity.repository.test.ts` | 18 | Idempotency, revocation, no role escalation, C1 |
| `db/schema/rls.test.ts` | 5 | RLS on every table; behavioural denial proof |
| `api/api.test.ts` | 55 | Contracts, error mapping, CSRF, rate limit, headers |
| `web/lib/auth/routes.test.ts` | 24 | Default deny, open redirect |
| `web/lib/auth/flow.test.ts` | 21 | End-to-end: credentials → HTTP status |

Attack cases are written as tests rather than described in comments: open
redirect (6 vectors), account enumeration, cross-origin CSRF, token mismatch,
role escalation on re-sign-in, revoked-identity resurrection, and permission
leakage in error bodies.
