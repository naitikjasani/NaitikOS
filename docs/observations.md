# Observations — the substrate

> Blueprint §9.1, §9.2, §9.3, §5.3, §6.2. Code: `packages/core/src/observations/`,
> `packages/core/src/units/`, `packages/db/src/repositories/observation.repository.ts`.

Everything the system knows is an observation or an entity. This document is
about the first: what one is, what has to be true of it before it is written,
and why several of those rules are stricter than they look.

## The shape of a fact

An observation is a value, a metric, a time, a zone, and a provenance. Four of
those five are mandatory and the fifth (`subject`) is optional but paired.

```
observation
  metric_key      → metric        the vocabulary. no free-floating numbers
  value           numeric(20,6)   always numeric, even for booleans and text
  value_text      text            content, for metrics with no numeric form
  unit            text            denormalised from the metric, on purpose
  observed_at     timestamptz     when the fact was true
  observed_zone   text            the IANA zone it was captured in
  recorded_at     timestamptz     when the system was told
  source_id       → observation_source   how it came to be known
  subject_type/id                 polymorphic, both or neither
  hlc             text            causal order, for offline writes
  superseded_by_id                the correction pointer
```

Two of those columns are the ones people try to remove.

**`unit` is deliberately redundant** with `metric.canonical_unit`. If the
registry's canonical unit is ever changed, every historical row must still say
what it meant when it was recorded. Without this column, changing a unit
silently reinterprets twenty years of data.

**`observed_zone` is not derivable** from `observed_at`. An offset is not a
zone: `+05:30` does not tell you the rule that produced it, and rules change.
§5.3's example is the one that matters — a workout at "7am" during travel is a
materially different fact from one at 7am at home.

## The seven checks on the write path

`prepareObservations` in `core/observations/write.ts` runs these in order. Each
maps to a promise the blueprint makes.

| # | Check | Why |
|---|---|---|
| 1 | The metric is registered | §9.2 — "unregistered metric keys are rejected on write" |
| 2 | The value matches its declared type | The registry validates on write, or it validates nothing |
| 3 | The value fits the column *as submitted* | Postgres rounds an over-scaled numeric **silently** |
| 4 | Units convert to canonical | §6.2 — "no path by which milligrams become micrograms" |
| 5 | The value is within registered bounds | A phone keyboard produces a 900 kg bodyweight regularly |
| 6 | The converted value fits the column's magnitude | Postgres *errors* on over-precision rather than rounding |
| 7 | Zone, subject pairing, confidence | §5.3, §9.3(3), §9.2 |

Check 3 and check 6 look like the same check and are not. The distinction was a
bug before it was a design:

- A **submitted** value with seven decimal places claims a precision the record
  cannot hold. It is rejected, because storing it would round it silently and
  the stored number would differ from the submitted one with no error anywhere.
- A **converted** value with more places is an artifact of the ratio. `165 lb`
  is exactly `74.84274105 kg`; rounding that at storage is honest. An earlier
  version checked only after conversion and therefore refused every
  pound-to-kilogram bodyweight.

### Two failure modes, deliberately different

An **unregistered metric key** fails fast with `precondition_failed`. It is not
a form error — no amount of retyping fixes it.

Everything else **accumulates**, and the whole batch is rejected with every
issue at once. A Daily Close submits six fields; returning them one per round
trip would turn a sixty-second ritual into a conversation.

## Value encoding

`observation.value` is `numeric` for every metric, including the ones that are
not numbers. The single-column design is what lets a cross-domain query run
without a `COALESCE` per value type, and cross-domain correlation is the entire
point of P3.

| Metric type | `value` | `value_text` |
|---|---|---|
| `numeric`, `integer`, `duration` | the number, at scale 6 | null |
| `boolean` | `0.000000` or `1.000000` | null |
| `categorical` | the **index** into `allowed_values` | the label, for convenience |
| `text` | `0` — a legible placeholder | the content |

Two notes on that table.

Booleans and categoricals go through the same `toQuantityString` as a measured
number. That is not tidiness: `numeric(20,6)` reads a stored `1` back as
`1.000000`, so an encoding that emitted a bare `'1'` would make "is the
submitted value the same as the recorded one?" false for every boolean — and
that comparison is what stops a re-submitted Daily Close writing a pointless
correction over an identical answer.

The text placeholder is a constant zero rather than, say, the character count.
A reader in 2046 encountering `value = 47` on a journal line would have no way
to know it was a length rather than a measurement. A constant zero is legibly
meaningless, which is the honest option, and `schema.json` says so.

## Corrections

Observations are never updated and never deleted. Migration
`0001_observation_immutable` installs a `BEFORE UPDATE OR DELETE` trigger, and
the integration tests assert it by trying.

A correction is a **new** observation. The old row's `superseded_by_id` points
at it, `superseded_at` records when, and `supersede_reason` records why. Both
rows survive forever, so the timeline can be replayed as it was known at any
past moment.

The reason is required. §9.1 keeps both rows precisely so the record explains
itself; a supersession with no reason is a silent edit wearing a paper trail.

The supersession write is guarded by `superseded_by_id IS NULL`, so a row can be
superseded exactly once. Without the guard, two devices correcting the same
observation while offline would both succeed and the second would overwrite the
first's pointer — losing a link in a chain that is supposed to be complete.

## Hybrid logical clocks

`core/observations/hlc.ts`. §5.7: "Physical time on a phone is untrustworthy —
timezone changes, clock drift, manual adjustment. An HLC gives a total causal
order that survives all three."

The encoding is `<12 hex: millis><4 hex: counter>-<12 hex: device>`, fixed
width, so **lexicographic string order is causal order**. `ORDER BY hlc` in
Postgres, `.sort()` in JavaScript and `compareHlc` all agree without anybody
parsing anything. Keep it that way.

The HLC is *not* a replacement for `observed_at`. `observed_at` is when the fact
was true and it is what the user sees; the HLC is the write order and it is what
the system sorts by when two writes claim the same instant.

### How the server picks one

The server has nowhere to keep clock state — §5.15 is serverless, so there is no
long-lived process. Instead it **uses the writing device as the HLC node** and
rebuilds the state per request from the client's last HLC and the server's
physical clock, merged with `hlcReceive`. Three properties follow:

1. **Monotone per device** — the merged value is greater than `clientHlc`.
2. **Globally distinct** — the node id is the device's, so two devices writing
   in the same millisecond do not collide.
3. **Drift-bounded** — a peer more than five minutes ahead is *clamped*, not
   adopted. Adopting a phone set to 2031 would drag the logical clock forward
   permanently, and it can never go back.

## Units

`core/units/`. §6.2 is blunt about why this exists: "Unit confusion in a medical
record is a real, documented category of harm."

Three properties make "no path by which milligrams become micrograms" true
rather than aspirational:

1. **Every unit carries a dimension.** `convertQuantity` returns `null` across
   dimensions rather than guessing, so `kg → hours` is a handled absence and not
   a plausible-looking number.
2. **Every factor is exact.** Ratios, not decimals — `°F → °C` is `× 5 ÷ 9`, so
   `212 °F` converts to exactly `100 °C` rather than `100.0000000094`.
3. **Conversion never rounds beyond its working scale.** Rounding is a storage
   or display decision, made once.

Molar and mass concentration are **separate dimensions**. mmol/L and mg/dL both
describe "how much of this is in the blood", and the conversion depends on the
analyte's molar mass — so there is no substance-independent factor. Filing them
under one dimension would let the generic converter answer with whatever factor
happened to be in the table. `convertConcentration` takes an analyte and returns
`null` for one whose molar mass is not registered.

`Decimal` is `{ unscaled: bigint, scale: number }`. Scale is significant and
preserved: `1.250` and `1.25` compare equal but are not identical, because the
first records a measurement to three places. A `number` anywhere on this path
reintroduces the floating point §5.3 bans.

## Reading a value back

`decodeValue(metric, observation)` is the inverse of `normaliseValue`, and both
live in the same file on purpose — an encoding whose decoder is elsewhere gets
decoded two different ways within a year.

It returns `null` when the row and its metric disagree: a categorical ordinal
past the end of `allowed_values`, which happens if a value is retired without
migrating the rows that used it. `null` is the honest answer; a guess would put
a wrong label on a real observation.
