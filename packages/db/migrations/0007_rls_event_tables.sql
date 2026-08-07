-- Extend §5.4's RLS posture to the tables added by migration 0005.
--
-- Migration 0004 enabled RLS on every table that existed then. It cannot cover
-- tables added later, and Postgres will not complain about one that is missing —
-- which is exactly why `rls.test.ts` asserts coverage rather than trusting the
-- migration. This is that assertion being satisfied for the new tables.
--
-- Same posture, same reasoning: RLS enabled, FORCEd, and **no policies**. §5.4
-- forbids client-direct-to-database access, so the PostgREST path must reach a
-- database that returns nothing even holding the anon key — which ships in the
-- browser bundle.
--
-- The event log makes this sharper than before. `domain_event` is a single table
-- containing an ordered record of every action across every domain: one
-- successful anon read would be a complete behavioural history. It is the highest
-- value target in the schema.

DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT c.relrowsecurity
       AND c.relname <> '__drizzle_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Re-revoke. `ALTER DEFAULT PRIVILEGES` in 0004 covers tables created after it,
-- but only for the role that ran it — so an explicit revoke is the reliable path
-- rather than an assumption about which role owns the migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  END IF;
END;
$$;
