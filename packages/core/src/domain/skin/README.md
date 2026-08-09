# core/domain/skin

§4.2 — "the photography protocol is the module".

**Owns:** the daily state model, the product register replayed from its events,
and the capture protocol's scoring.

**Does not own:** the routine engine, which is generic (`core/domain/routine/`),
or the media pipeline (`core/media/`).

## Three rules

1. **The protocol is advisory, never blocking.** `evaluateProtocol` has no error
   path. §14.2 Finding 9: "a warning that is wrong even twenty percent of the
   time is a warning that gets ignored within a fortnight."
2. **A re-logged day supersedes, never accumulates.** `planSkinState` takes the
   day's current observations and emits `supersedes`. Without it, correcting a 2
   to a 4 leaves `mean` reporting 3.
3. **`changesBefore` lists, it does not rank.** No score, no suspicion, no word
   resembling "cause".

## Files

| File | Owns |
|---|---|
| `state.ts` | Regions, the daily log, observation planning, region trends |
| `product.ts` | The register, use periods replayed from events, reactions |
| `protocol.ts` | Series, the checks, the compliance score, comparison filtering |

Full reasoning: [`docs/skin.md`](../../../../../docs/skin.md).

Blueprint §4.2, §9.8, §14.2.
