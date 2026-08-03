-- Enforce the append-only rule on `observation` (blueprint §9.1).
--
--   "Observations are append-only. This is not a stylistic preference; it is
--    what makes a twenty-year record trustworthy. If a weight from 2027 can be
--    silently edited in 2031, then no number in the system can be relied upon
--    and the entire premise fails."
--
-- The Drizzle schema can declare the columns but not the prohibition, so it
-- lives here. A rule this central cannot be a code-review convention in a
-- one-engineer project (§11.7) — it has to fail at the database.
--
-- Exactly one thing may be mutated after insert: the supersession pointer.
-- §9.1 requires corrections to be additive — "a new observation marks the old
-- one superseded, both persist" — which means writing `superseded_by_id`,
-- `superseded_at` and `supersede_reason` onto the row being replaced. Nothing
-- else may change, and nothing may be deleted.

CREATE OR REPLACE FUNCTION observation_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'observation is append-only (blueprint 9.1): rows may never be deleted. '
      'To correct a value, insert a new observation and set superseded_by_id on this row. '
      'Attempted to delete id=%', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Permit only the supersession columns to change.
  IF ( NEW.id,  NEW.metric_key,  NEW.value,  NEW.value_text,  NEW.unit,
       NEW.observed_at, NEW.observed_zone, NEW.recorded_at, NEW.source_id,
       NEW.confidence, NEW.subject_type, NEW.subject_id, NEW.context, NEW.hlc )
     IS DISTINCT FROM
     ( OLD.id,  OLD.metric_key,  OLD.value,  OLD.value_text,  OLD.unit,
       OLD.observed_at, OLD.observed_zone, OLD.recorded_at, OLD.source_id,
       OLD.confidence, OLD.subject_type, OLD.subject_id, OLD.context, OLD.hlc )
  THEN
    RAISE EXCEPTION
      'observation is append-only (blueprint 9.1): only superseded_by_id, superseded_at '
      'and supersede_reason may be updated. Attempted to modify id=%', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Supersession is itself write-once. Re-pointing an existing correction would
  -- rewrite the correction chain, which is the history §9.1 exists to protect.
  IF OLD.superseded_by_id IS NOT NULL
     AND NEW.superseded_by_id IS DISTINCT FROM OLD.superseded_by_id
  THEN
    RAISE EXCEPTION
      'observation %: supersession is write-once. It is already superseded by %.',
      OLD.id, OLD.superseded_by_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER observation_append_only
BEFORE UPDATE OR DELETE ON observation
FOR EACH ROW
EXECUTE FUNCTION observation_reject_mutation();
--> statement-breakpoint

-- `sample` is device data under a 90-day retention policy (§9.7), so it is
-- deliberately NOT covered by the rule above — the downsample job has to delete
-- raw rows. That difference is the whole reason the two tables are separate.

COMMENT ON TRIGGER observation_append_only ON observation IS
  'Blueprint 9.1: observations are immutable. Corrections are additive via superseded_by_id.';
