-- Prevent overlapping validity intervals for the same medication's schedule.
--
-- Blueprint §9.6 asks for this by name:
--
--   | Overlapping validity intervals | GiST with `btree_gist` — also enforces
--   | exclusion constraints preventing two active schedules for the same
--   | medication |
--
-- Why it matters clinically (§9.2): a dose change must be "a new schedule
-- rather than an edit that erases the old dose", so that "was I on 75mg or
-- 150mg when the side effects started?" stays answerable. That guarantee is
-- only worth anything if the intervals cannot overlap — two simultaneously
-- valid schedules make the question ambiguous again, which is the exact failure
-- the design was meant to prevent.
--
-- A unique index cannot express this. Uniqueness compares values for equality;
-- what is needed here is "no two rows whose time ranges intersect", which
-- requires a range operator and therefore GiST. `btree_gist` supplies GiST
-- support for the scalar `medication_id`, so the two can sit in one constraint.
-- The extension is installed by the container's init script.

ALTER TABLE medication_schedule
  ADD CONSTRAINT medication_schedule_no_overlap
  EXCLUDE USING gist (
    medication_id WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  )
  -- Superseded rows (§9.5 transaction time) and tombstones (§9.4) are excluded.
  -- A corrected schedule and its correction legitimately cover the same valid
  -- time; what must not overlap is what the system currently believes.
  WHERE (recorded_to IS NULL AND deleted_at IS NULL);
--> statement-breakpoint

COMMENT ON CONSTRAINT medication_schedule_no_overlap ON medication_schedule IS
  'Blueprint 9.6: at most one believed schedule per medication at any instant.';
--> statement-breakpoint

-- The same reasoning applies to a medication's own validity, but is left
-- unconstrained on purpose: a genuine clinical history can contain the same
-- substance prescribed twice over overlapping periods by different prescribers,
-- and refusing to record that would make the register lie about what happened.
