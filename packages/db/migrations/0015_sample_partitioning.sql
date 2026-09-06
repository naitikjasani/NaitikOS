-- Convert `sample` to a range-partitioned table, before it holds anything.
--
-- §9.7 does the arithmetic: human observations run to "under 400,000 rows" over
-- twenty years, while device streams reach "tens of millions". `sample` is the
-- device-scale table, and §9.7 requires it be "monthly-partitioned, and subject
-- to a retention policy: full resolution for 90 days, then downsampled to
-- hourly aggregates and the raw rows dropped".
--
-- The schema comment on `sample` deferred this deliberately: "converting an
-- empty table is free — whereas partitioning a populated one is not." Wearable
-- ingestion is the moment that stops being true, so it happens now, immediately
-- before the first importer exists.
--
-- **This migration refuses to run against a populated table.** Recreating the
-- table is the only way to partition it, and a migration that silently dropped
-- a year of heart-rate data because it was re-run in the wrong order would be
-- the worst possible failure in a system whose first principle is that the
-- record is permanent. The assertion below raises instead.

DO $$
DECLARE
  existing bigint;
  partitioned boolean;
BEGIN
  SELECT c.relkind = 'p' INTO partitioned
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'sample';

  -- Already done. A re-run is a no-op rather than an error, because a migration
  -- that cannot be applied twice is a migration that blocks a restore drill.
  IF partitioned THEN RETURN; END IF;

  EXECUTE 'SELECT count(*) FROM sample' INTO existing;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'sample holds % rows; partitioning requires recreating the table and this migration will not drop device data. Migrate the rows out, or partition by hand.',
      existing;
  END IF;

  DROP TABLE sample;

  -- The primary key is composite because Postgres requires the partition key to
  -- participate in every unique constraint on a partitioned table. `id` is a
  -- UUIDv7 and is unique in practice; the database can only enforce that within
  -- a partition, which is why the importer deduplicates on the natural key
  -- below rather than trusting this one.
  CREATE TABLE sample (
    id uuid NOT NULL,
    metric_key text NOT NULL REFERENCES metric(key) ON UPDATE CASCADE,
    value numeric(20, 6) NOT NULL,
    unit text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    observed_zone text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    source_id uuid NOT NULL REFERENCES observation_source(id),
    is_downsampled boolean DEFAULT false NOT NULL,
    CONSTRAINT sample_id_observed_at_pk PRIMARY KEY (id, observed_at)
  ) PARTITION BY RANGE (observed_at);

  CREATE INDEX sample_metric_observed_idx ON sample (metric_key, observed_at DESC);

  -- The real deduplication key. A wearable export overlaps the previous one by
  -- design, and one device cannot have produced two readings of the same metric
  -- at the same instant — so this is what makes a re-import a no-op instead of a
  -- doubling. Declared on the parent, so every partition inherits it.
  CREATE UNIQUE INDEX sample_source_metric_observed_unique
    ON sample (source_id, metric_key, observed_at);
END;
$$;
--> statement-breakpoint

-- Create a month's partition, idempotently.
--
-- A function rather than a fixed list of `CREATE TABLE` statements, because the
-- list would run out. The nightly job calls this for the month ahead; a
-- partition that already exists is left alone, so calling it every night costs
-- one catalogue lookup.
CREATE OR REPLACE FUNCTION ensure_sample_partition(month_start date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  starts date := date_trunc('month', month_start)::date;
  ends date := (date_trunc('month', month_start) + interval '1 month')::date;
  name text := format('sample_%s', to_char(starts, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', name)) IS NOT NULL THEN
    RETURN name;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF sample FOR VALUES FROM (%L) TO (%L)',
    name, starts, ends
  );

  -- Partitions are created after 0004's blanket grant ran, so each one needs the
  -- same §5.4 posture applied as it appears. `rls.test.ts` checks every table in
  -- `public`, partitions included, so a missed one fails the suite rather than
  -- quietly exposing a month of device data.
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);

  RETURN name;
END;
$$;
--> statement-breakpoint

-- A DEFAULT partition, so a reading outside every declared range is stored
-- rather than rejected.
--
-- Without it an import carrying one row with a bad timestamp fails the whole
-- batch, and a wearable export with a single 1970 epoch artefact is a real
-- thing. The row lands here instead and is visible; §8.9's "missing data is
-- shown as missing" has a counterpart, which is that malformed data should be
-- findable rather than refused at the door.
--
-- The cost is that attaching a new partition must scan this table. That is
-- acceptable while it holds the handful of rows it is meant to hold, and if it
-- ever holds more than that, the scan getting slow is the signal.
CREATE TABLE IF NOT EXISTS sample_default PARTITION OF sample DEFAULT;
--> statement-breakpoint

-- The current month and the next, so the first import has somewhere to land
-- before the nightly job has ever run.
SELECT ensure_sample_partition(current_date);
--> statement-breakpoint
SELECT ensure_sample_partition((current_date + interval '1 month')::date);
--> statement-breakpoint

-- §5.4's RLS posture, applied to the new parent and to every partition made
-- above. Same block as every migration that has added a table.
DO $$
DECLARE
  target regclass;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity
       AND c.relname <> '__drizzle_migrations'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END;
$$;
--> statement-breakpoint

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
