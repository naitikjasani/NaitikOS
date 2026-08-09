# core/domain/gym

The training domain — §4.1, and §12's first full domain.

**Owns:** what a set means. The exercise taxonomy, the session and set model,
volume arithmetic, personal-record detection, the prefill that makes the logger
usable, and program adherence.

**Does not own:** persistence (`packages/db`), transport, or presentation.
Nothing here knows a database exists, and every file in it is tested from a
literal.

## The three decisions worth knowing before changing anything

1. **Sets are entities, set values are observations.** `planSetLog` is the only
   place a set becomes both, which is what stops the two representations
   disagreeing. The duplication buys P3: Skin can query training volume without
   knowing Gym exists.

2. **An unresolvable bodyweight excludes the set and says so.** `volume.ts`
   refuses to guess. Zero understates a pull-up day by an order of magnitude and
   the latest weigh-in attributes today's weight to a session six weeks ago;
   `SessionVolume.excluded` carries the count instead.

3. **`SECONDARY_MUSCLE_SHARE` is a convention, not a measurement.** It is the
   least defensible number in the package and deliberately the most visible. It
   exists so the comparison is consistent over twenty years, and the chart that
   renders it says so on its face.

## Files

| File | Owns |
|---|---|
| `exercise.ts` | Muscle/equipment taxonomy, deterministic slugs, local fuzzy ranking |
| `session.ts` | Session and set model, `planSetLog`, `planSessionClose`, bounds |
| `volume.ts` | Effective load, set/session volume, muscle attribution |
| `records.ts` | Epley estimate, the three PR kinds, relative strength |
| `progression.ts` | Prefill by set position, per-session progression points |
| `program.ts` | Programs, prescription parsing, adherence as a ratio |

Full reasoning: [`docs/gym.md`](../../../../../docs/gym.md).

Blueprint §4.1, §9.2, §9.3, §12.
