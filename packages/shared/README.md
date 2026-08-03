# @naitikos/shared

Universal utilities. The floor of the dependency graph.

## What this package owns

Primitives that would be equally at home in a completely different product. That sentence is the admission test from blueprint §6.2, and it is applied strictly — `shared` is where dumping grounds are born.

| Module | Purpose | Blueprint |
| --- | --- | --- |
| `sensitive` | `Sensitive<T>` — redaction by construction | §5.13 |
| `result` | `Result<T, E>` — expected failure as a value | §5.12 |
| `brand` | Nominal typing over structural types | §5.1 |
| `id` | UUIDv7 with monotonic ordering | §5.3, §5.7 |
| `assert` | Invariant violations (bugs, not expected failures) | §5.12 |
| `guards` | Runtime narrowing for `unknown` | §5.14 |

## What it does not own

- **Anything domain-specific.** Nothing here knows what an observation, a medication, or a workout is. That is `@naitikos/core`.
- **Anything framework-bound.** Enforced by `boundaries/external` — React, Next, Drizzle, and Supabase imports fail the build here.
- **Anything that reads a clock.** `uuidV7(now)` takes its timestamp as a parameter. See below.

## Two decisions worth knowing

**`Sensitive<T>` closes every stringification route, not just `JSON.stringify`.** Template interpolation, `String()`, `Symbol.toPrimitive`, and Node's `util.inspect` are all covered, because a redaction that only holds for one of them is not a redaction. Reading the value requires `.expose()`, which is deliberately greppable — `grep -rn '.expose()'` should return a list short enough to audit by eye.

**`uuidV7` takes the timestamp as a parameter.** It does not read the clock. Three reasons, all from the blueprint: §11.3 bans ambient `Date` access because a wall clock discards the IANA zone every observation must carry; §5.7 requires hybrid logical clocks for offline ordering, which supply their own timestamp; and §5.8 notes device clocks drift and get manually adjusted, which is untestable if the function reads the clock itself. `shared` sits below `core/temporal` in the layering (§5.0) and cannot import it, so the dependency is inverted — the caller supplies the time.

## Testing

`vitest run`. Coverage floor is 70% (§11.4), but the modules here are pure and small, so they should sit far above it. The monotonicity tests in `id.test.ts` are the ones that matter most: a backwards clock silently reordering the append-only timeline (§9.1) is the failure mode least likely to be noticed.
