# core/domain/mind

§4.7 — the module that "carries the highest duty of care in the system".

**Owns:** the 1–5 scales and how they are spoken about, anxiety episodes, the
journal, practices, and the crisis plan's surfacing rule.

**Does not own:** medication. §4.7: "Medication data lives in Health; Mind reads
it." See `core/domain/medication/`.

## Four rules, all structural

1. **No negative framing, ever.** `toneFor` cannot return an alarm tone, and a
   test asserts the whole output set. The scale labels are descriptive
   ("Depleted"), never verdicts ("Bad").
2. **No causal claims about mental state.** `trigger` is nullable free text with
   no vocabulary and no picker. `summariseEpisodes` returns `namedTriggers`.
3. **One thing only, in a crisis.** `CrisisSurface` has exactly one field. There
   is no `message`, no `severity`, nothing a component could render advice from.
4. **A journal list never renders prose.** `JournalListItem` has no `excerpt`,
   and the fallback heading is a word count rather than a derived summary.

## Files

| File | Owns |
|---|---|
| `scales.ts` | Scales, labels, tone, `describeMovement` |
| `episode.ts` | Episodes, severity bands, the trigger tally |
| `journal.ts` | Entry validation, consent, list items, prompt rotation |
| `practice.ts` | Practices and the before/after delta |
| `crisis.ts` | The stored plan and when it surfaces |

Full reasoning: [`docs/mind.md`](../../../../../docs/mind.md).

Blueprint §4.7, §9.2, §10.10.
