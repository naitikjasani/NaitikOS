# core/domain/routine

§9.2's "one implementation, three consumers" — skincare, dental hygiene,
supplements.

Only skincare has a surface in the MVP. The engine is generic anyway, because the
cost of writing it generic now is a `kind` field and the cost of not doing so is
discovering in V2 that dental hygiene needs the same fifteen functions with
different names.

**Three decisions**, all argued in [`docs/skin.md`](../../../../../docs/skin.md) §6:
optional steps are excluded from both sides of the ratio; a `partial` step counts
as completed; a day with no log is not a miss but *does* end a streak.

Blueprint §9.2, §4.2.
