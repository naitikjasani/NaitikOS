-- Enforce append-only on `domain_event`, and monotonic sequencing.
--
-- ADR 0005 makes this log the record of causality and ordering. §9.1's argument
-- for immutable observations applies verbatim:
--
--   "If a weight from 2027 can be silently edited in 2031, then no number in the
--    system can be relied upon and the entire premise fails."
--
-- An event log that can be edited is worse than none, because a replay over an
-- edited log rebuilds a projection of a history that never happened — and it does
-- so silently, producing a plausible timeline.
--
-- The Drizzle schema declares the columns; only a trigger can declare the
-- prohibition, and §11.7 notes there is no code review to catch the difference.

CREATE OR REPLACE FUNCTION domain_event_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'domain_event is append-only (ADR 0005): events may never be deleted. '
      'A mistaken event is corrected by emitting a compensating event, not by erasing it. '
      'Attempted to delete id=%', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RAISE EXCEPTION
    'domain_event is append-only (ADR 0005): events may never be updated. '
    'Payload shape changes are handled by upcasting on read (events/migrate.ts), '
    'never by rewriting stored rows. Attempted to modify id=%', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

-- Stricter than `observation`, which permits the supersession columns to change.
-- There is no equivalent here: a corrected event is a NEW event carrying the
-- original's id as its `causationId`, which keeps both the mistake and the
-- correction in the record.
CREATE TRIGGER domain_event_append_only
BEFORE UPDATE OR DELETE ON domain_event
FOR EACH ROW
EXECUTE FUNCTION domain_event_reject_mutation();
--> statement-breakpoint

COMMENT ON TRIGGER domain_event_append_only ON domain_event IS
  'ADR 0005: the event log is append-only. Corrections are compensating events.';
--> statement-breakpoint

-- The projection IS rebuildable, deliberately.
--
-- `timeline_entry` carries no trigger: ADR 0005 rule 3 makes rebuilding it a
-- supported operation, and the projector is pure so a rebuild is byte-identical.
-- That asymmetry is the point — the log is permanent, the projection is derived.

COMMENT ON TABLE timeline_entry IS
  'Projection over domain_event. Safe to TRUNCATE and rebuild via replay (ADR 0005 rule 3).';
--> statement-breakpoint

COMMENT ON TABLE event_handled IS
  'Idempotency ledger. Truncating this causes non-idempotent handlers to re-run on the next replay.';
