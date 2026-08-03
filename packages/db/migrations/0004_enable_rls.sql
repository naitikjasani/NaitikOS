-- Row Level Security on every table — blueprint §5.4, defence in depth.
--
--   "Row Level Security is enabled on every table as defence in depth — but it
--    is explicitly *not* the primary authorization mechanism. Authorization
--    lives in the API layer where it is testable, readable, and
--    version-controlled. Encoding domain rules in RLS policies is a maintenance
--    trap at C2 horizons: policies are hard to test, hard to diff meaningfully,
--    and hard to reason about two years later."
--
-- ## What this migration does, and why it looks so blunt
--
-- It enables RLS everywhere and creates **no permissive policies at all**.
--
-- That is not an omission. RLS with no policy denies everything, which is
-- exactly the intended posture, because §5.4 also says:
--
--   "No client-direct-to-database access. This forgoes Supabase's headline
--    feature deliberately."
--
-- Supabase exposes every table over PostgREST to the `anon` and `authenticated`
-- roles. This system never uses that path — the application connects as its own
-- role and goes through the API layer. So the correct configuration is to make
-- the PostgREST path inert: if the anon key leaks (it is a public key; it will
-- appear in a browser bundle), an attacker reaches a database that returns
-- nothing.
--
-- Writing per-table policies instead would mean maintaining ~71 policy sets
-- that grant access to a path the architecture forbids, and each one would be a
-- place to make a mistake. Zero policies is both stricter and less code, and it
-- is the rare case where those coincide.
--
-- ## Why FORCE
--
-- `FORCE ROW LEVEL SECURITY` applies the policies to the table owner too.
-- Without it, the owning role bypasses RLS silently, and a migration run or an
-- accidental `psql` session as the owner would behave differently from the
-- application — which is how a policy gets believed to work when it does not.
-- The application role is not the owner, so this costs nothing operationally
-- and removes a class of false confidence.
--
-- ## The one thing to know before adding a table
--
-- A new table is NOT covered automatically. `0004_rls_coverage.test.ts` asserts
-- that every table in `public` has `relrowsecurity`, so forgetting fails CI
-- rather than shipping an exposed table. That test is the actual guarantee;
-- this migration is just today's application of it.

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'                       -- ordinary tables only
       AND c.relname <> '__drizzle_migrations'   -- tool bookkeeping, not our data
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Remove the PostgREST grants outright, as well as denying via RLS.
--
-- Belt and braces, and they fail differently: RLS returns an empty result,
-- a missing GRANT returns a permission error. The second is louder, and
-- something loud is what you want if a client-direct call is ever introduced by
-- mistake — a silent empty array looks like "no data yet".
--
-- Guarded because these roles exist on Supabase and not in the local container.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
  END IF;
END;
$$;
--> statement-breakpoint

COMMENT ON SCHEMA public IS
  'NaitikOS application schema. RLS is enabled and unpolicied on every table by design '
  '(blueprint 5.4): all access goes through the API layer, never client-direct. '
  'Adding a permissive policy here is an architectural change requiring an ADR.';
