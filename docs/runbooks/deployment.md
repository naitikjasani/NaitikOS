# Runbook — First Deployment

**Status:** written 8 September 2026 · **never executed** · nothing in this
repository has ever been deployed
**Blueprint sections:** §5.2, §5.4, §5.14, §5.15, §5.16, §9.4, §11.5, §11.8, §12, §13.2
**Related:** [migration.md](migration.md) · [restore-drill.md](restore-drill.md) ·
[key-rotation.md](key-rotation.md) · [incident.md](incident.md) ·
[../background-jobs.md](../background-jobs.md) · [../storage.md](../storage.md) ·
[../auth.md](../auth.md)

---

## 0. Read this first: what is verified and what is derived

**No step in this document has been executed.** There is no Vercel project, no
hosted Supabase project, and no cron. The application has never run outside a
developer machine. This page is a plan derived from the code, not a report of a
thing that was done — and it is written that way deliberately, because
[migration.md](migration.md) §0 and [restore-drill.md](restore-drill.md) §2
establish the convention and the alternative is an artefact that reads as
experience and is not.

| Tag             | Means                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **[verified]**  | Executed on this machine on 8 September 2026, or read directly out of the named file. The stated output is what actually came back.                                                 |
| **[derived]**   | Read out of the code and believed correct, but never executed against a hosted provider. Treat expected output as a prediction.                                                     |
| **[uncertain]** | Depends on current Vercel or Supabase behaviour that was not checked against their documentation while writing this. Verify before relying on it. Each instance says what to check. |

The distribution is stark and should stay visible. **Only §2 (the build), §4
(the environment set), and the four findings in §12 are [verified].** Everything
that touches a provider account is [derived] or [uncertain].

**The first person to execute this runbook should edit the tags as they go.**
That edit is the most valuable output of the first deployment — more valuable
than the deployment.

---

## 1. Why this is the critical path

§12's Week 1 exit criterion is one word longer than it looks:

> "Sign in, write an observation through the API, read it back. **Deployed.**"

§12 expected daily use from 16 August 2026. Nothing can be recorded until there
is somewhere to record it, and a longitudinal record's value is a function of
how early it starts. Every day without a deployment is a day permanently absent
from the twenty-year series P2 is built to hold.

**What exists today [verified]** — the same finding [migration.md](migration.md)
§9.1 recorded on 7 September, unchanged:

- no `vercel.json` and no Vercel configuration of any kind;
- no `.github/workflows/*` deploy job, so §11.5's pipeline — including the
  migration dry-run it calls "the most important gate" — does not exist;
- an empty `scripts/` directory, despite §6.2 naming eight scripts including
  `health-check`;
- a `supabase/` directory containing `config.toml` and `.branches` from a local
  `supabase start` on 7 September. It is **untracked**, describes the local CLI
  stack only, and holds no project reference. It is not a hosted-project
  configuration and must not be mistaken for one.

So the deployment is a manual operation end to end, and the ordering discipline
in §3 is carried by whoever is typing rather than by a pipeline.

---

## 2. The build, settled before anything else [verified]

Two things about this build are non-obvious and both were confirmed by running
it. Getting either wrong costs a build failure on a provider where the feedback
loop is minutes rather than seconds.

### 2.1 What the build command must be

```bash
pnpm turbo run build --filter=@naitikos/web
```

**[verified]** — run from the repository root on 8 September 2026:

```
 Tasks:    2 successful, 2 total
Cached:    1 cached, 2 total
  Time:    20.56s
```

**Two** tasks, not one. `turbo.json` declares `build` as
`dependsOn: ["^build", "tokens:build"]`, and the second dependency is the one
that matters: `@naitikos/design-system` generates `src/tokens/generated/` from
`src/tokens/*.json`, and that directory is **gitignored** — `.gitignore` line 12,
"Generated design tokens — derived from `tokens/*.json`, never hand-edited".

A clean checkout therefore does not contain it, and `next build` alone fails.
**[verified]** by moving the directory aside and running the bare build:

```
> Build error occurred
Error: Turbopack build failed with 1 errors:
./apps/web/styles/globals.css:16:1
Module not found: Can't resolve '@naitikos/design-system/tokens.css'
```

`apps/web/styles/globals.css:16` imports `@naitikos/design-system/tokens.css`,
which the package's `exports` map resolves to
`./src/tokens/generated/tokens.css`. Nothing else generates it. **If Vercel's
build command is `next build`, or `pnpm build` scoped to `apps/web`, the first
deploy fails on a missing CSS file and the cause reads as a broken import rather
than a missing build step.**

### 2.2 What the build produces, and where

**[verified]** from the build output: Next.js 16.2.12, Turbopack, output at
`apps/web/.next`. `turbo.json` declares the same:
`outputs: [".next/**", "!.next/cache/**", "dist/**"]`.

Every route is dynamic. The build summary marks exactly two things static —
`/offline` and `/manifest.webmanifest` — and everything else `ƒ`
(server-rendered on demand), which is §5.6 working as specified: "every data
route is dynamic". There is no static export and no `outputDirectory` surprise;
a Next-framework Vercel project reading `apps/web/.next` is correct.

### 2.3 The client environment is a **build-time** requirement

**[verified].** Next inlines `NEXT_PUBLIC_*` at build time, and
`apps/web/lib/env.ts` parses its client schema at module load — which during
`next build` is page-data collection. Building with `NEXT_PUBLIC_SITE_URL` empty
fails:

```
  Collecting page data using 9 workers ...
Error: Invalid public environment configuration:
  - NEXT_PUBLIC_SITE_URL: Must be the full origin, e.g. https://naitikos.app

> Build error occurred
Error: Failed to collect page data for /auth/callback
```

So the three `NEXT_PUBLIC_*` variables must exist in the Vercel environment
**before the first build**, not merely at runtime. This is by design and is
argued at length in `lib/env.ts`: "A missing `AUTH_ALLOWLIST` therefore crashes
the deployment instead of producing an application that runs, accepts a sign-in,
and authorizes the wrong person."

`DATABASE_URL` and `AUTH_ALLOWLIST` are read through `serverEnv()`, a function
rather than a constant, so they are **not** required to complete a build — only
to serve a request. Setting them anyway is correct; relying on a green build as
evidence that they are set is not.

### 2.4 Whether `vercel.json` is needed — no, and this is a decision, not an omission

**No `vercel.json` was added.** The reasoning, so nobody re-litigates it from
scratch:

1. **The only setting it uniquely provides is `crons`,** and §9 establishes that
   a cron entry cannot authenticate to the nightly route as the route is written
   today. A `crons` block committed now would produce a nightly 401 and no
   `job_run` row — which is not merely useless, it is a _green-looking_
   configuration hiding a broken control. That is the artefact this codebase
   refuses.
2. **The settings that actually matter cannot live there.** Root Directory and
   Node.js version are Vercel _project_ settings; `vercel.json` has no key for
   either. A file that configured the build command but not the root directory
   would split the configuration across two places and make the dashboard half
   invisible to code review, which is worse than one clearly-documented place.
3. **[uncertain] Its required location depends on the Root Directory setting.**
   Vercel reads `vercel.json` from the configured Root Directory, so with Root
   Directory `apps/web` a file at the repository root is silently ignored. This
   was not confirmed against Vercel's current documentation. A config file that
   might do nothing is precisely the wrong thing to commit into a deployment
   runbook — so it is not committed, and §5.4 below states the exact content and
   placement to add once the cron is authenticable and the placement is
   confirmed.

Everything the deployment needs is therefore in §5's project settings and §4's
environment table. When the cron becomes possible, adding `vercel.json` becomes
justified and §9.4 gives the block verbatim.

---

## 3. The one ordering rule

§5.15:

> "**Migrations** run as a discrete, gated step before deployment — never
> automatically on boot. An application that migrates its own database on
> startup will eventually migrate it during a rollback."

and:

> "**Rollback:** application rollback is instant via the platform. **Database
> rollback is not assumed to exist** — every migration must be
> forward-compatible with the previous application version, so a rollback never
> strands the schema. This is the single most important operational discipline in
> the document."

**Migrate, verify, then deploy.** In that order, every time, for the first
deployment and for every one after it.

The window this creates is deliberate and safe in one direction only. Migrating
first leaves the new schema live while the old application still serves — safe,
because §9.4 requires every migration to be additive. Deploying first leaves the
new application running against a schema that lacks what it reads, and every
request touching the new column fails. There is no version of the second window
that is not an outage.

For the **first** deployment this rule has a concrete consequence: the Supabase
project must exist, have its extensions enabled, and hold all nineteen
migrations _before_ the Vercel project builds for the first time. A first deploy
against an empty database produces an application that boots, signs in, and
fails on the first query — which is a confusing failure to debug from a browser.

`packages/db/src/migrate.ts` is already the "discrete, gated step" §5.15 asks
for: standalone script, its own `max: 1` connection, non-zero exit on failure.
Nothing in the application calls it. Keep it that way.

---

## 4. The complete environment set [verified]

Authoritative sources: `apps/web/lib/env.ts` (the schema that throws),
`packages/db/src/env.ts` (`DATABASE_URL`, again), and every `process.env` read in
`apps/web` and `packages/` — enumerated rather than sampled.

`.env.example` documents six of these. Two are real and were undocumented until
today; `ANTHROPIC_API_KEY` has been added to `.env.example` by this change.

| Variable                        | Required                                         | When                | Read by                                                        | Notes                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------ | ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes                                              | **build** + runtime | `lib/env.ts` client schema; `proxy.ts`; `buildSecurityHeaders` | Public by design. Also becomes the CSP `connect-src` allowlist — the _only_ cross-origin destination the browser may reach (§5.14). A wrong value here breaks auth **and** every fetch, silently, as a CSP violation.                                                                                                                     |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes                                              | **build** + runtime | same                                                           | Public, and safe **only because of migration `0004`**. See §7.                                                                                                                                                                                                                                                                            |
| `NEXT_PUBLIC_SITE_URL`          | yes                                              | **build** + runtime | `lib/env.ts`; `csrfGuard`; `csrfCookieAttributes`              | The most load-bearing single value in the deployment. See §8.                                                                                                                                                                                                                                                                             |
| `AUTH_ALLOWLIST`                | yes                                              | runtime             | `serverEnv()` → `createAllowlist`                              | §5.4's "actual authorization model". Comma-separated; normally one address. Must match the Supabase user's email **exactly** — comparison is lower-cased and trimmed by the schema's transform, nothing more.                                                                                                                             |
| `DATABASE_URL`                  | yes                                              | runtime             | `serverEnv()`; `packages/db/src/env.ts`                        | No default, deliberately. See §5.3 on pooled versus direct.                                                                                                                                                                                                                                                                               |
| `SUPABASE_SERVICE_ROLE_KEY`     | **optional in the schema, required in practice** | runtime             | `serverEnv()`; `lib/storage/supabase-storage-provider.ts:160`  | The trap. `lib/env.ts` marks it `.optional()` and `.env.example` calls it "deliberately unused today" — but `createSupabaseStorageProvider` **throws at construction** without it, and `POST /api/media/uploads` constructs it on the live path (`route.ts:93`). See §12 finding 2. Set it, or every photograph and document upload 500s. |
| `ANTHROPIC_API_KEY`             | no                                               | runtime             | `lib/platform/ask.ts:145`; `lib/platform/settings.ts:63`       | Absent is a _configuration_, not a fault: `transportFromEnv` returns `null` and `/ask` degrades to `UNCONFIGURED_TRANSPORT` with the message "The AI layer is off. Every figure in the app is computed without it". `/settings/ai` reports `transportConfigured: false`. Leave unset for the first deployment.                            |
| `NODE_ENV`                      | —                                                | build + runtime     | `lib/env.ts`; `isDevelopment()`                                | Vercel sets it. `isDevelopment()` gates the CSP relaxations in `buildSecurityHeaders`, so it must be `production` on production. Do not set it by hand.                                                                                                                                                                                   |

**Provided by Vercel, consumed by this application, and worth knowing about**
[verified in the named files]:

| Variable / header        | Read by                               | Effect if absent                                                                                                                   |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `VERCEL_ENV`             | `lib/platform/diagnostics.ts:245`     | Falls back to `NODE_ENV`, then `'unknown'`. `/settings/developer` shows the wrong environment name.                                |
| `VERCEL_GIT_COMMIT_SHA`  | `lib/platform/diagnostics.ts:246`     | Reports `null`. You cannot tell which commit is live from inside the app.                                                          |
| `x-vercel-id` (header)   | `traceIdFor`, `handler-context.ts:66` | Falls back to a fresh `crypto.randomUUID()`, so trace ids stop correlating with the platform log. Present automatically on Vercel. |
| `x-vercel-cron` (header) | `api/jobs/nightly/route.ts`           | Only sets the `isManual` flag. **Not a credential.** See §9.                                                                       |

### 4.1 Which environments get which values

§5.15's table, and its enforcement clause:

> "**Preview deployments must not be able to reach production data.** Separate
> Supabase project, separate credentials, enforced by the **absence** of the
> production connection string in the preview environment rather than by
> convention. A PR preview that touches a real medical record is an incident."

In Vercel's environment-variable UI, that means: **every variable above is
scoped to Production only, and Preview gets its own separate set pointing at a
second Supabase project.** The failure to avoid is the default behaviour of
pasting a variable into "All Environments", which is one click and hands every
pull-request preview a production connection string.

`packages/db/src/env.ts` provides the structural half of this enforcement —
`isLocalDatabase()` gates the destructive helpers so `seed` and `reset` cannot be
pointed at a remote database by accident — but nothing in the code can stop a
preview being _given_ the production URL. That is a settings discipline, and
§10 covers what to do about it.

---

## 5. The procedure

### 5.1 Create the Supabase project [derived]

- **Postgres major version 17.** Not a preference. `docker-compose.yml` pins
  `pgvector/pgvector:pg17` and says why: "Supabase's current major is 17.
  Running 18 locally would reintroduce exactly the dialect drift §5.3 refuses."
  Local and hosted must agree, or a migration verified locally is not verified.
  **[uncertain]** — Supabase's default major may have moved; if it offers 18,
  that is a decision (§13, item 4), not a default to accept.
- **Region:** nearest to `Asia/Kolkata`. Every request is server-rendered and
  dynamic (§5.6), so page latency is round-trips to Postgres, and the Vercel
  function region should match.
- **Two projects, not one.** Production and preview (§4.1). Creating only the
  first is the path of least resistance and is how the preview environment ends
  up holding the production string.
- Record the database password at creation. It appears once.

### 5.2 Enable the extensions, before any migration [derived]

`packages/db/docker/init/001-extensions.sql` explains why this cannot be a
migration, and the explanation is the reason the step exists:

> "It is deliberately NOT a Drizzle migration: `CREATE EXTENSION` requires
> privileges the application role does not have in production, where Supabase
> provisions extensions through its own dashboard. Keeping them out of the
> migration directory means the committed migrations (§9.4: forward-only, never
> edited once applied) stay runnable by an unprivileged role."

and the sentence that makes this a deployment step rather than a footnote:

> "Anything added here must also be enabled in the Supabase project, or a
> migration that depends on it will pass locally and fail in production."

Four, each with a reason it is not optional [verified from that file]:

| Extension    | Why                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vector`     | Semantic search over journal entries and documents (§10, §9.6's HNSW index).                                                                                                            |
| `pg_trgm`    | Typo-tolerant exercise and food lookup (§9.6). "Without this the food library fails P1's ten-second rule the first time a name is misspelt."                                            |
| `pgcrypto`   | `gen_random_bytes` and `digest`, for content hashing in the audit trail.                                                                                                                |
| `btree_gist` | The exclusion constraints in §9.6 — "prevents two active schedules for the same medication". A btree index cannot express that. `0002_medication_schedule_exclusion.sql` depends on it. |

Enable all four in the Supabase dashboard's Database → Extensions before §5.3.
A migration that hits a missing extension fails partway through, and the schema
is then neither the old shape nor the new one.

### 5.3 Apply the migrations [derived]

Nineteen files, `0000_init.sql` through `0018_app_event_dimensions.sql`.
[migration.md](migration.md) §9.2 already tabulates how a hosted run differs
from a local one; it is not repeated here. Two points from it are load-bearing
enough to restate:

- **Use the direct connection string, not the pooler.** `src/migrate.ts` opens
  its own connection and migrations take session-level locks; a transaction-mode
  pooler does not support session state. [migration.md](migration.md) marks this
  **derived** and says to verify it against Supabase's current guidance — that
  caveat carries over unchanged.
- **The application's `DATABASE_URL` is a different string.** Serverless wants
  the pooled endpoint; `packages/db/src/client.ts` explains the constraint
  ("§5.15 hosts on Vercel, where each serverless invocation can open its own
  pool. `max: 1` plus a module-scoped cache is what keeps that from exhausting
  Postgres' connection limit"). So: **direct for `pnpm db:migrate`, pooled for
  `DATABASE_URL` in Vercel.** These being two different values is easy to
  collapse into one by accident and the symptom — intermittent connection
  exhaustion under no load — reads as a provider fault.

```bash
# From the repository root. DATABASE_URL is the DIRECT connection string.
DATABASE_URL='postgresql://…' pnpm db:migrate
```

**[derived]** expected output, from `src/migrate.ts`:

```
Migrating postgres at db.<ref>.supabase.co:5432
Migrations applied.
```

Then the reference data — the metric registry in particular, without which
`refresh-rollups` has nothing to roll up:

```bash
DATABASE_URL='postgresql://…' pnpm --filter @naitikos/db run seed
```

Note the command shape. `pnpm db:seed` **does not exist** — that is
[migration.md](migration.md) §10 finding 2, still true. And note that `seed` is
gated by `isLocalDatabase()` in `packages/db/src/env.ts` for exactly the reason
§4.1 gives, so **[uncertain]** whether it will run against a hosted URL at all;
read `src/seed/index.ts` before assuming it will, and if it refuses, that
refusal is the gate working and the reference data has to be loaded another way.

### 5.4 Create the storage buckets [derived]

`packages/core/src/media/storage.ts:135` — "Bucket per tier. Separate buckets so
a policy mistake cannot span tiers" [verified]:

| Tier        | Bucket              | Public?                                                                                                         |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `public`    | `public-assets`     | served from a CDN, never signed                                                                                 |
| `private`   | `private-documents` | private; 60-second signed URLs (`PRIVATE_URL_TTL_SECONDS`)                                                      |
| `sensitive` | `sensitive-media`   | private; 300-second signed URLs — longer because the object is ciphertext and a 12 MB photo needs time to fetch |

All three must be **private buckets with no public read policy** except
`public-assets`. `docs/storage.md` states the posture: "every read and write here
is server-mediated, so the browser never holds a storage credential and never
talks to the bucket except through a signed URL". Bucket names are read from
`BUCKET_FOR_TIER` and a mismatch produces a storage 404 that
`locate()` will not catch, because both buckets would be ours.

### 5.5 The Vercel project [derived, with the build settings verified in §2]

| Setting                  | Value                                                     | Why                                                                                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework Preset         | Next.js                                                   |                                                                                                                                                                                                                                                                                |
| Root Directory           | `apps/web`                                                | The Next application. `next.config.ts` lives there.                                                                                                                                                                                                                            |
| Build Command (override) | `cd ../.. && pnpm turbo run build --filter=@naitikos/web` | §2.1. The default `next build` fails on the generated tokens. **[uncertain]** — Vercel's Turborepo detection may generate an equivalent command automatically; set it explicitly regardless, because a detection that changes is a build that breaks with no diff to point at. |
| Output Directory         | default (`.next` under the root directory)                | §2.2.                                                                                                                                                                                                                                                                          |
| Install Command          | default                                                   | pnpm 11.16.0 is declared in `packageManager` and `pnpm-lock.yaml` is committed; overriding this risks getting frozen-lockfile flags wrong for no gain.                                                                                                                         |
| Node.js Version          | 24.x                                                      | See below.                                                                                                                                                                                                                                                                     |

**Node version is a real trap [verified in the files, [uncertain] on Vercel's
side].** `engines.node` is `>=24.0.0` — in the **root** `package.json`.
`apps/web/package.json` declares no `engines` at all. Vercel reads `engines` from
the Root Directory's `package.json`, which here is `apps/web`, so the constraint
is invisible to it and the project falls back to whatever the dashboard's
Node.js Version is set to. Two consequences:

1. Set the Node.js Version explicitly in project settings. Do not assume
   `engines` carries.
2. **[uncertain]** whether Vercel currently offers Node 24. If it does not, the
   build either fails on `engines` or — worse — succeeds on an older runtime and
   the difference surfaces as a runtime error in something the repo assumes is
   available. This is a blocker; §13 item 1.

Adding `engines` to `apps/web/package.json` would fix the invisibility, and it
is outside this change's file scope. §13 item 1.

### 5.6 Create the allowlisted user [derived]

Auth is **email and password** through Supabase — `signInWithPassword` in
`lib/auth/supabase-auth-provider.ts`, reached by `POST /api/auth/sign-in`. There
is no magic-link path in shipped code.

`resolveActor` refuses an identity whose email is unverified: `emailVerified`
comes from `user.email_confirmed_at != null`, and a refusal renders as anonymous
(`getAuthState` returns `ANONYMOUS`). So a user created without confirming the
address produces the single most confusing symptom available — **correct
password, successful Supabase authentication, and a sign-in page that keeps
sending you back to itself, with no error on screen.** The refusal _is_ audited
by `resolveActor`, so the evidence exists in `auth_audit`; it is just not
visible in the browser.

Therefore, in order:

1. Create the user in Supabase Auth with the operator's email.
2. **Confirm the address** — either by using the invitation flow, or by setting
   the user as confirmed in the dashboard. **[uncertain]** which control
   Supabase's current dashboard exposes for this; the requirement in code is
   simply that `email_confirmed_at` is non-null.
3. Set `AUTH_ALLOWLIST` to exactly that address. §5.4: an address absent from
   the list is refused even with valid credentials.
4. `createAllowlist` throws on an empty list, so a typo in the _variable name_
   crashes the deployment rather than authorizing the wrong person — which is
   `lib/env.ts`'s stated intent and is the one failure mode here that is loud.

### 5.7 Deploy, and the `NEXT_PUBLIC_SITE_URL` chicken-and-egg [derived]

The first build needs `NEXT_PUBLIC_SITE_URL`, and the production URL is only
knowable once a project exists. Create the project and assign the production
domain **before** the first build, then set the variable to that origin — with
scheme, no trailing path. `csrfGuard` compares it to the browser's `Origin`
header, which is scheme + host + port together, so `https://naitikos.app` and
`https://www.naitikos.app` are different values and only one of them works.

---

## 6. Verifying that it _works_, not that it _built_

A green build proves the tokens were generated and the client env parsed. It
proves nothing about the database, auth, RLS, or the record. Run all of these,
in order, and stop at the first failure.

### 6.1 Sign in [derived]

Load the production origin. `proxy.ts` redirects `/` to `/auth/sign-in` with no
session. Sign in with the allowlisted address and land on `/today` (§3.2's
default route).

- Sent back to sign-in with no error → the email is unconfirmed, or the address
  is not in `AUTH_ALLOWLIST`, or the two differ by case or whitespace. §5.6.
- A 401 JSON body from an API route instead of a redirect → that is `proxy.ts`
  working as designed for `/api/*`; it means no session, not a broken route.

### 6.2 Write an observation and read it back — §12's actual exit criterion [derived]

> "Sign in, write an observation through the API, read it back. Deployed."

Do it through a surface rather than curl: capture something on `/today` and see
it on `/timeline`. This exercises the full path — proxy session refresh, CSRF
double-submit, guard chain, permission check, event bus, timeline projection —
and a `curl` with a hand-made token exercises none of the browser half.

**A mutation succeeding is the CSRF and cookie configuration verified**, and
this is the check worth understanding rather than merely passing. It confirms
three things at once: `NEXT_PUBLIC_SITE_URL` matches the real origin (`Origin`
comparison), the CSRF cookie was stored (so `requiresSecureCookies` decided
`Secure` correctly for the scheme actually served), and the session cookie
survived the proxy. If every POST answers 403 with `csrf_origin_mismatch` or
`csrf_token_missing`, go to §8 — it is one of those three and the error code
says which.

### 6.3 The RLS posture, from outside [derived]

This is the check §7 exists for, and the only one that cannot be inferred from a
working application. From a terminal, with the anon key and no session:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/observation?select=id&limit=1" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

**Expected: a permission error, not `200 []`.** Migration `0004` revokes the
schema and table grants from `anon`, and its comment says why that is preferable
to relying on RLS alone: "RLS returns an empty result, a missing GRANT returns a
permission error. The second is louder, and something loud is what you want if a
client-direct call is ever introduced by mistake — a silent empty array looks
like _no data yet_."

**A `200` with `[]` is not a pass.** It means the grants are present and RLS is
carrying the whole defence — recoverable, but you have lost the louder of the two
locks and you will not notice when the other one slips. A `200` with **rows** is
an incident: §7.

Run the same check against `public.setting` and one event table, because the
`REVOKE` in `0004` targets tables existing when it ran, and `0005`–`0018` added
more. `ALTER DEFAULT PRIVILEGES … REVOKE` in `0004` is what should cover the
later ones — **[derived]; its effect has never been observed**, since `anon` does
not exist in the local container and the whole block is wrapped in
`IF EXISTS (SELECT 1 FROM pg_roles …)`.

### 6.4 The schema, in place [derived]

The queries are already written — [restore-drill.md](restore-drill.md) §7.1
through §7.8 verify the migration ledger, the extensions, RLS coverage, the
invariants, the partitions, the indexes and the sequence, and each is marked
**[verified query]** there. Run them against production once, on the first
deployment. Two notes for the hosted case:

- The ledger is `drizzle.__drizzle_migrations` — schema `drizzle`, not `public`.
  Expect nineteen rows.
- RLS coverage must return **zero** rows missing `relrowsecurity` and **zero**
  policies. A policy appearing here is an architectural change requiring an ADR,
  per the `COMMENT ON SCHEMA public` that `0004` leaves behind.

### 6.5 A media upload [derived]

The check that catches §12 finding 2. Attach a photo through a capture surface.
If `POST /api/media/uploads` 500s, read the server log for
`SUPABASE_SERVICE_ROLE_KEY is required for storage` — the provider throws at
construction, deliberately, "so the plaintext is gone from the capture screen
and the ciphertext went nowhere" never happens.

### 6.6 The nightly job [derived]

Run it by hand from `/settings/developer`, or as
[incident.md](incident.md) §5 describes — DevTools console on an authenticated
tab, where the CSRF cookie is already present.

Expect **200 even if steps failed** (the request succeeded; it ran the job and
produced a report), and a new `job_run` row with `steps` showing each registered
step. Then expect `GET /api/jobs/nightly` to keep reporting
`healthy: false` — `hasCompletedRunSince` requires `is_manual = false`, and
`isManual` is set from the _absence_ of the `x-vercel-cron` header.

**That flag is the honest signal here.** It stays `false` until a real scheduled
invocation lands, which per §9 cannot currently happen. Do not read a successful
manual run as the schedule working.

---

## 7. RLS, PostgREST, and the most important operational consequence in this document

Locally, migration `0004_enable_rls.sql` is half a no-op. The `anon` and
`authenticated` roles do not exist in `pgvector/pgvector:pg17`, so the two
`REVOKE` blocks are wrapped in `IF EXISTS (SELECT 1 FROM pg_roles …)` and skip.
What runs locally is the RLS enable/force loop. **On a hosted Supabase project
both roles exist and PostgREST is a live, internet-facing HTTP service on the
project URL, so the `REVOKE` half executes for the first time and is doing real
work from the moment it runs.**

That single difference carries the deployment's whole security posture, and it
cuts both ways. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is inlined into the browser
bundle by design — `lib/env.ts` says it plainly: "This key reaches every
browser. It is harmless here specifically because RLS is enabled and unpolicied
on every table and the PostgREST grants are revoked — so an attacker holding it
reaches a database that returns nothing. Remove that migration and this becomes
a full data breach." So on production the anon key is a published credential
whose safety rests entirely on `0004` having applied to _every_ table, and
§6.3's check is the only way to know it did. Conversely, the same posture means
**PostgREST is inert and must stay inert**: the Supabase dashboard's table
editor, its auto-generated REST and GraphQL surfaces, and every "select this
table from the browser" convenience will return permission errors rather than
rows, and each one of those is the control working rather than a thing to fix.
The predictable failure is an operator hitting that wall on a slow evening,
adding a permissive policy or re-granting `authenticated` to make the dashboard
useful, and thereby converting the published anon key into read access over a
database of psychiatric medication history and body photographs — which is why
`0004` leaves a `COMMENT ON SCHEMA public` saying "Adding a permissive policy
here is an architectural change requiring an ADR", why `FORCE ROW LEVEL
SECURITY` is set so even the owning role cannot silently bypass it, and why the
right response to a locked dashboard is to reach the database through the direct
connection string as the application role instead.

---

## 8. `NEXT_PUBLIC_SITE_URL`, CSRF, and preview URLs

Three separate mechanisms read this one value, and a preview deployment breaks
all three in the same way.

**It is the CSRF expected origin.** `csrfGuard` (`handler-context.ts`) passes
`new URL(clientEnv.NEXT_PUBLIC_SITE_URL).origin` as `expectedOrigin`, and
`verifyCsrf` refuses on any mismatch — `origin_mismatch`. The comment says why
it is not the `Host` header: "an attacker controls Host, and checking against it
would not be a check."

**It decides cookie transport.** `requiresSecureCookies(siteUrl)` in
`lib/auth/cookies.ts` returns `false` only for an explicitly configured
plaintext **loopback** origin, and `true` for everything else including an
unparseable value. So an `https://` origin gets `Secure` cookies, as it must.

**It builds the OAuth redirect** (`lib/env.ts`'s own description of the field).

### The preview-URL problem [derived]

Vercel preview deployments get a **different URL per deployment** —
`<project>-<hash>-<scope>.vercel.app`. `NEXT_PUBLIC_SITE_URL` is a single value
baked in at build time (§2.3). It therefore cannot match a per-deployment
preview origin, and the consequence is deterministic:

1. The browser loads the preview at its per-deployment origin and sends
   `Origin: https://<hash>.vercel.app`.
2. `csrfGuard` compares that to the configured `NEXT_PUBLIC_SITE_URL` and they
   differ.
3. **Every state-changing request on every preview deployment answers 403
   `csrf_origin_mismatch`.** Reads work. Nothing on screen says why.

This is not a bug to route around, and the two obvious workarounds are both the
mistake `lib/auth/cookies.ts` already documents at length: deriving the expected
origin from the `Host` header, or from `x-forwarded-proto`, turns the origin
check into a check against an attacker-supplied value. "A control whose
correctness depends on an unwritten deployment assumption is a control that
breaks silently during a migration."

What is workable [derived, and each is a decision for §13 item 3]:

- **Assign a stable preview domain** (a Vercel branch alias, e.g. one fixed
  hostname always pointing at the latest preview) and set `NEXT_PUBLIC_SITE_URL`
  to _that_ for the Preview environment. One value, one origin, checks hold.
  **[uncertain]** on the exact Vercel feature name and whether it covers all
  preview deployments or only branch-tip ones.
- **Accept that previews are read-only** and verify mutations locally. Honest,
  costs nothing, and blocks §11.5's "E2E on preview deploy" — which does not
  exist yet anyway.
- **Do not** add a wildcard origin allowance. A CSRF check that accepts
  `*.vercel.app` accepts every project any Vercel user deploys.

---

## 9. The nightly cron

### 9.1 The arithmetic

§5.2 requires "exactly one scheduled entry point — a nightly job at 03:00 local".
`DEFAULT_PROFILE_ZONE` in `lib/platform/context.ts` is `Asia/Kolkata`
[verified].

Vercel cron schedules are **UTC**. `Asia/Kolkata` is **UTC+05:30**:

```
03:00 IST − 05:30 = 21:30 UTC, on the previous calendar day
```

So the expression is:

```
30 21 * * *
```

Note the half-hour offset — India's is one of the few zones that is not a whole
number of hours from UTC, and `0 21 * * *` (a natural typo) fires at 02:30 IST.

**DST: none, confirmed rather than assumed.** India has not observed daylight
saving since the 1940s — brief wartime exceptions aside — and the tz database
carries `Asia/Kolkata` at a fixed +05:30 with no DST rules. So this offset is
constant year-round and, unlike a Europe- or America-zoned deployment, the cron
does not need re-checking twice a year and does not drift by an hour relative to
03:00 local. This is genuinely simpler; it is also the reason the arithmetic is
easy to do once and never revisit, which is why it is written down here rather
than left in someone's head.

Why 03:00 at all: the job recomputes rollups, resolves and writes predictions,
and runs the §10.6 detector battery over the day that just closed. Running
before local midnight would derive against an incomplete day.

### 9.2 Whether Vercel cron can authenticate to this route — no

This is the finding this section exists for, and it is a hard blocker on §5.2's
schedule. Four independent reasons, each verified in the code, and **any one of
them is sufficient**:

1. **The scheduled entry point is a POST; Vercel cron issues GET.**
   `POST /api/jobs/nightly` runs the job. `GET` returns the last run and the
   `healthy` flag and runs nothing. **[uncertain]** on the precise wording of
   Vercel's current documentation, but cron invoking paths with GET is
   long-standing behaviour and there is no method selector in a `crons` entry.
   A GET-triggered cron would report status nightly and never derive anything —
   the worst available outcome, because `job_run` would stay empty while a cron
   appeared configured.

2. **`proxy.ts` rejects it before the route runs.** `/api/jobs/nightly` is not in
   `UNGUARDED_PREFIXES`, not in `PUBLIC_PREFIXES`, and not in
   `PUBLIC_API_PREFIXES` — and `lib/auth/routes.ts` is default-deny. A cron
   request carries no session cookie, so `supabase.auth.getUser()` returns null,
   `hasSession` is false, and the proxy answers **401** with
   `code: 'unauthenticated_no_session'`. The route handler is never entered.

3. **`csrfGuard` would reject it next.** `guard()` runs CSRF first, deliberately
   ("a cross-origin request should be rejected before it consumes any rate-limit
   budget"). A cron POST sends no `Origin` and no `Referer`, so `verifyCsrf`
   returns `origin_missing` → **403**. It also has no `naitikos-csrf` cookie to
   echo, so it would fail `token_missing` even with an origin.

4. **`requireServerPermission('settings:write')` would reject it last.** No
   session means `getAuthState()` returns `ANONYMOUS`, and the refusal is
   audited.

**And there is no bypass.** `x-vercel-cron` is read in exactly one place —
`isManual: request.headers.get('x-vercel-cron') === null` — and grants nothing.
`docs/background-jobs.md` §9 states the intent: "Cron authenticates through the
same session path as a human. **There is no bypass token** — a second way in is
a second thing to secure (§5.4)." Nothing in the repository reads a
`CRON_SECRET`, and adding one would be the architectural change that sentence
refuses.

**That sentence is also, as written, factually wrong about Vercel cron**, and
§12 finding 1 reports it: a Vercel cron invocation has no cookies, so "the same
session path as a human" is a path it cannot walk. The design is coherent; its
stated deployment mechanism is not.

### 9.3 What the operator must therefore configure

There is no configuration that makes Vercel cron work against this route today.
The choice is between three options, and it is a decision for §13 item 2, not
something this runbook can settle.

| Option                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What it costs                                                                                                                                                                                                                                                                              | What it preserves                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **A — external scheduler that signs in.** A GitHub Actions scheduled workflow, or cron on a machine the operator owns, that POSTs `/api/auth/sign-in` (public per `PUBLIC_API_PREFIXES`) with an `Origin` header equal to `NEXT_PUBLIC_SITE_URL` and a self-consistent CSRF cookie/header pair, then POSTs `/api/jobs/nightly` with the returned session. **[derived]** — the guards permit this: double-submit only compares the two values to each other, and a non-browser client can set `Origin`. | The operator's **password** must live in a scheduler's secret store. That is a second copy of the primary credential, which is a genuine security cost and the reason this is a decision rather than a recommendation. Also: GitHub Actions scheduled workflows are best-effort on timing. | No route change. No bypass token. §5.4's "one way in" holds literally. |
| **B — a cron-authenticable path in the route.** A code change, outside this change's file scope, and directly contrary to `background-jobs.md` §9. If taken, it needs an ADR.                                                                                                                                                                                                                                                                                                                          | A second credential and a second authentication path to secure — exactly what §5.4 refuses.                                                                                                                                                                                                | Vercel cron works with `crons` in `vercel.json` and nothing else.      |
| **C — accept no schedule for now** and run the job manually from `/settings/developer`.                                                                                                                                                                                                                                                                                                                                                                                                                | `healthy` stays `false` for ever (§6.6), so §5.16's absence alert is permanently useless. Nightly derivation happens only when remembered — and §5.2's whole argument is that a control a human can satisfy by hand is not a control.                                                      | Nothing to build. Honest.                                              |

Option A is the only one that both schedules the job and leaves §5.4 intact, and
it is also the one that duplicates a password. That trade is the operator's to
make.

### 9.4 The `vercel.json` to add **if and only if** option B is chosen

Not committed today, for the reasons in §2.4. If the route is changed to accept
a scheduled invocation, this is the block — and note it belongs in the
`vercel.json` at whichever directory is the configured Root Directory
(**[uncertain]**, §2.4 point 3):

```json
{
  "crons": [{ "path": "/api/jobs/nightly", "schedule": "30 21 * * *" }]
}
```

`path` is the route. `schedule` is §9.1's arithmetic: 03:00 `Asia/Kolkata`.
Nothing else. **[uncertain]** whether Vercel's current plan tiers honour
minute-level precision on a daily cron — some tiers have historically
guaranteed only the hour — which for a 21:30 schedule would mean the job runs
somewhere in the 21:00–22:00 UTC window, i.e. between 02:30 and 03:30 IST. That
is acceptable for this job (it is idempotent and derives against a closed day)
but it should be known rather than discovered.

---

## 10. Preview deployments and production data

§5.15's requirement is quoted in §4.1 and enforced by **absence**, not by
convention: the production connection string must not exist in the preview
environment. Practically, three things to get right and one to know:

1. **Scope every variable to Production explicitly.** "All Environments" is the
   default and it is wrong here.
2. **Give Preview a second Supabase project** with its own credentials, migrated
   the same way, seeded with synthetic data only. §5.15's table: preview data is
   "Synthetic seed data — **never production**".
3. **Do not point Preview at production for convenience,** not even once, not
   even for a single debugging session. §5.15: "A PR preview that touches a real
   medical record is an incident."
4. **A preview with no Supabase credentials at all fails at build**, not at
   runtime (§2.3). That is the enforcement being loud, and it is the correct
   behaviour — but it means "preview builds are broken" and "preview is
   correctly denied production access" look identical from the deployments list
   until someone reads the log.

Note the interaction with §8: even a correctly-configured preview cannot perform
a mutation unless it has a stable origin. So a preview environment as things
stand is a read-only smoke test of a synthetic database. That is worth having and
it is not what §11.5's "E2E on preview deploy" assumes.

---

## 11. Failure modes, and what each one actually means

| Symptom                                                                           | Cause                                                                                                                                                                                                | Where to look                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Build fails: `Can't resolve '@naitikos/design-system/tokens.css'`                 | Build command does not run `tokens:build`.                                                                                                                                                           | §2.1.                                                          |
| Build fails at "Collecting page data": `Invalid public environment configuration` | A `NEXT_PUBLIC_*` variable missing or malformed **in the build environment**.                                                                                                                        | §2.3. The message names the field.                             |
| Build fails on `engines`                                                          | Node version.                                                                                                                                                                                        | §5.5.                                                          |
| Every POST answers 403 `csrf_origin_mismatch`                                     | `NEXT_PUBLIC_SITE_URL` ≠ the origin actually browsed. Scheme, host and port all count.                                                                                                               | §8.                                                            |
| Every POST answers 403 `csrf_token_missing`                                       | The CSRF cookie was not stored. On https this should not happen; on a plaintext non-loopback origin it always does, because `requiresSecureCookies` returns `true` and the browser drops the cookie. | `lib/auth/cookies.ts` — and this failing loudly is the design. |
| Sign-in succeeds and returns to the sign-in page                                  | Email unconfirmed, or not in `AUTH_ALLOWLIST`. Look in `auth_audit`, not on screen.                                                                                                                  | §5.6.                                                          |
| Everything 500s with a trace id and nothing else                                  | By design (§5.12, §5.14). The trace id is `x-vercel-id`; join it against the platform log.                                                                                                           | `unhandledErrorResponse`.                                      |
| `POST /api/media/uploads` 500s                                                    | `SUPABASE_SERVICE_ROLE_KEY` unset.                                                                                                                                                                   | §12 finding 2, §6.5.                                           |
| PostgREST returns permission errors; the Supabase table editor shows nothing      | **Correct.** §7. Do not fix it.                                                                                                                                                                      | §7.                                                            |
| `GET /api/jobs/nightly` reports `healthy: false` after a successful manual run    | Correct: `is_manual = false` is required.                                                                                                                                                            | §6.6, §9.2.                                                    |
| Intermittent connection exhaustion under no load                                  | `DATABASE_URL` is the direct string rather than the pooled one.                                                                                                                                      | §5.3.                                                          |
| The nightly job never runs                                                        | §9.2. Not a misconfiguration — it cannot currently work.                                                                                                                                             | §9.3.                                                          |

---

## 12. Problems found while writing this page

Reported, not fixed. Each verified in the named file.

1. **`docs/background-jobs.md` §9 is wrong about how cron authenticates.** It
   says "Cron authenticates through the same session path as a human. There is no
   bypass token." The second sentence is true and correct. The first describes
   something a Vercel cron invocation cannot do — it carries no cookies, and
   `proxy.ts` answers 401 before the route is entered. The same belief is implied
   by `route.ts`'s "Cron fires this at 03:00 local" and by
   `incident.md`'s "until the real cron fires". **No cron has ever fired, and as
   configured none can.** §9.2. The design is sound; the sentence describing its
   deployment is not, and it is the kind of confident line that stops anyone
   checking.

2. **`SUPABASE_SERVICE_ROLE_KEY` is documented as unused and is not.**
   `lib/env.ts` marks it `.optional()` and describes it as "deliberately unused
   today"; `.env.example` leaves it commented out.
   `incident.md` (line ~956) hedges precisely — "Nothing calls that adapter
   today, so the two statements do not yet conflict in practice; the moment media
   upload is wired, the key becomes required." **Media upload is wired.**
   `apps/web/app/api/media/uploads/route.ts:93` calls
   `createSupabaseStorageProvider({ clock: systemClock })` on the live path, and
   the provider throws at construction without the key. The conflict is no longer
   hypothetical, and on a first deployment it presents as an unexplained 500 on
   the first photograph.

3. **`engines.node` does not reach Vercel.** The constraint `>=24.0.0` is in the
   **root** `package.json`; `apps/web/package.json` has no `engines` field, and
   `apps/web` is the Root Directory Vercel will be pointed at. The requirement is
   therefore invisible to the platform. Adding `engines` to
   `apps/web/package.json` would fix it; that file is outside this change's
   scope.

4. **§5.16's uptime check has no endpoint to check.** §5.16 requires "an external
   HTTP check every five minutes against a health endpoint that verifies database
   connectivity", and §6.2 lists `health-check` among the scripts. There is no
   such endpoint. `/api/health` is the **Health pillar** API — vitals, symptoms,
   conditions, medications — and it requires `observation:read`, so an external
   monitor pointed at it would receive a 401 every five minutes and learn
   nothing. `lib/platform/diagnostics.ts` has the connectivity check but is
   reached only through the authenticated `/settings/developer` page. Naming a
   pillar route `/api/health` while §5.16 wants a health check at that shape is
   the sort of collision that gets resolved by accident, in the wrong direction.

---

## 13. Blocking: what the operator must provide or decide

Nothing above can proceed past §5.1 without these. Each says what it unblocks.

1. **A Vercel account, and a confirmed answer on Node 24.** Unblocks the whole of
   §5.5. If Vercel does not currently offer Node 24, this becomes a decision
   about relaxing `engines.node` — and `engines` should be added to
   `apps/web/package.json` regardless (§12 finding 3), because the constraint
   being invisible to the platform is a silent failure either way.

2. **A decision on the cron: option A, B or C in §9.3.** Unblocks §5.2's
   schedule and §5.16's nightly-job alert, which is the only automated signal in
   the system that the derivation pipeline ran at all. **This is the largest
   open question in the deployment** and it is not a configuration choice — B
   requires an ADR, A requires storing the operator's password in a scheduler.
   Until it is settled, `healthy` is permanently `false` and every insight in the
   system silently ages.

3. **A decision on preview deployments: a stable preview origin, or read-only
   previews (§8).** Unblocks preview being useful for anything beyond a build
   check, and unblocks §11.5's "E2E on preview deploy" ever being written.

4. **Two Supabase projects, on Postgres 17, with the four extensions enabled,
   and the database password recorded.** Unblocks §5.2 through §5.4. If Supabase
   now defaults to Postgres 18, that is a decision — `docker-compose.yml` pins 17
   to match it, and the pin moves with the provider, not before.

5. **The allowlisted email address, confirmed in Supabase Auth.** Unblocks §5.6
   and therefore §12's exit criterion. An unconfirmed address produces the
   silent sign-in loop in §5.6, which is the worst-diagnosing failure in this
   document.

6. **A decision on `SUPABASE_SERVICE_ROLE_KEY`.** Unblocks media upload (§6.5).
   It bypasses RLS entirely, so this is a real choice: set it and media works
   while a key that can read everything exists in the runtime environment, or
   leave it unset and every capture involving a photograph fails. Not setting it
   is a defensible first-deployment position **provided it is a decision** — §12
   finding 2 exists because it currently is not one.

7. **Whether §5.16's uptime check is in scope for this deployment.** If yes, it
   needs an endpoint that does not exist (§12 finding 4) — a code change, an ADR
   on the `/api/health` name collision, and an external monitoring service.

---

## 14. What this runbook does not cover

- **CI.** `.github/workflows/` is empty and building §11.5's pipeline —
  particularly the migration dry-run against a production clone — is separate
  work. Nothing here assumes a pipeline exists.
- **Backups.** They are Supabase's and automatic (§5.15), and
  [restore-drill.md](restore-drill.md) is emphatic that a backup nobody has
  restored is "a claim about a dashboard, not a claim about the record". Schedule
  the first drill for shortly after the first deployment, while there is still
  little to lose.
- **Custom domains and DNS.** They change `NEXT_PUBLIC_SITE_URL`, and per §8
  that value is baked in at build time — so a domain change requires a rebuild,
  not just a DNS record.
- **The embeddings runtime.** §5.15's own finding 6: "ONNX runtime with model
  weights does not fit a Vercel serverless function". The nightly job's
  embedding step is unimplemented and will need a persistent runtime when it
  lands. That is a second deployment target, and it is out of scope here.
- **Key rotation.** [key-rotation.md](key-rotation.md).
