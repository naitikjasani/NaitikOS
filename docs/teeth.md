# Teeth

**Status:** shipped, 10 August 2026 (§12's November block, built early — see
[validation.md](validation.md)). · **Blueprint sections:** §4.5, §9.2, §9.3,
§8.13
**Related:** [health.md](health.md) · [skin.md](skin.md)

---

## 1. Why a small module earns its place

§4.5, and it is the whole argument:

> A person with multiple root canals has a dental history that will matter for
> decades and that no dental practice will reliably retain across relocations,
> insurers, or practitioner changes.

So this is a **record**, not a dashboard. Everything on it is a fact that was
entered; nothing on it is a judgement that was computed.

## 2. It is almost entirely reuse

Five features in §4.5. Four were already built:

| §4.5 asks for | Served by | New code |
|---|---|---|
| Per-tooth procedure history | `procedure` + `toothNotation`, shipped with Health core | A repository method and a screen |
| Hygiene routine and adherence | The generic routine engine, `kind: 'dental'` | **None** |
| Appointment cadence | `appointment`, filtered by specialty | A filter |
| Sensitivity and pain log | `symptom`, filtered by body site | A filter |
| Cost tracking | `procedure.costMinor` / `currency` | A per-currency total |
| Imaging | The document vault, `kind: 'imaging'` | **None** — `documentTier` already routes it to the sensitive tier |

§9.2 predicted the routine part exactly:

> `routine` / `routine_step` / `routine_log` — a generic routine engine reused by
> skincare, **dental hygiene**, and supplements. One implementation, three
> consumers — the alternative is three near-identical adherence systems.

`HygieneScreen.tsx` is that prediction being right. There is no dental adherence
code in `core`, in `db`, or in the API — the engine needed no changes to accept
a third consumer, and defining a dental routine uses the same authoring surface
skincare does.

**One new domain file exists:** `domain/teeth/tooth.ts`, for notation.

## 3. FDI notation, and how that was decided

The blueprint says "standard notation" and does not name one. Three are in use —
FDI two-digit, Universal (1–32), Palmer — and they disagree about the same
tooth, so picking wrongly means a decade of records a dentist reads as a
different tooth.

§9.2 settles it by example: *"`procedure` — what was done. **Root canal on tooth
36**, 2024-03."* Tooth 36 is FDI. It is also what every practice outside North
America uses, which is where this record will be read.

```
       UPPER
  18…11 | 21…28      quadrant 1 = upper right, 2 = upper left
  ------+------      (the patient's right and left, not the viewer's)
  48…41 | 31…38      quadrant 4 = lower right, 3 = lower left
       LOWER
```

Three details worth knowing:

- **Primary teeth are parsed** (quadrants 5–8), because a childhood record can
  legitimately arrive in a scanned document and refusing to read one would
  silently drop it. Positions 6–8 in a primary quadrant are **rejected** — a
  child has five teeth per quadrant, and labelling `56` would name a tooth
  nobody has.
- **An unreadable notation is stored and displayed verbatim**, and gets no place
  on the chart. That is visibly different from being placed on the wrong one.
- **The form says which reading it made as you type.** A mistyped `63`
  announcing itself as *"upper-left canine (primary)"* is caught before it is
  saved rather than in year six.

The arch layout runs the patient's right quadrant reversed then their left
forward, which is how a dentist reads a chart. Getting it backwards puts every
marked tooth on the wrong side of the mouth, so there is a test.

## 4. The chart marks, and says nothing more

No colour scale by procedure count. No per-tooth condition score. No "areas of
concern".

A per-tooth health score computed from procedure counts would tell a person with
four root canals that their mouth is failing — a clinical judgement made by
arithmetic, which is precisely what P5 forbids. A tooth either has recorded
history or it does not, and that history is one tap away.

**Marked teeth are labelled, not only coloured.** §8.13 forbids colour-alone
status, so each carries a dot *and* an accessible name with its procedure count:
*"lower-left first molar, 2 procedures recorded"*. The dot is decoration on top
of the name, never instead of it, and forced-colours mode thickens the border
because a background dot may not survive there.

## 5. Grouped by tooth, not by date

The question §4.5 exists to answer is per tooth, and a flat chronology does not
answer it. `byTooth` groups and orders newest-first within each.

Procedures with no tooth — a scale and polish, a graft — are kept under a
separate heading rather than dropped. They are still part of the history; they
just did not happen to one tooth.

## 6. Cost is totalled per currency and never across them

There is no exchange rate in this system, and inventing one produces a number
that is wrong by a different amount every year. That is §6.2's unit argument
applied to money: refusing to answer is correct when the question is
underspecified.

A cost with no currency is ignored rather than assumed. Money is V3; this is
display only.

## 7. Two limitations, stated rather than hidden

**The dental filters are string matches.** An appointment is dental if its
specialty, provider or title contains one of a dozen words. Neither
`appointment.specialty` nor `symptom.bodySite` is an enum, and neither should
become one — §9.2 leaves them free text because a specialty vocabulary is
exactly the kind of list that is wrong in year three.

The cost is real: an appointment filed with no specialty and a neutral title
does not appear on this page. So **the count of unclassifiable appointments is
shown**, with a link to the full register. A list that silently omits things is
worse than one that says how much it is omitting.

**Dental routine steps carry no product.** `routineStep.productId` is a foreign
key to `skincareProduct`, so dental steps ship label-only with a null product. A
`skincare_product` row named "toothpaste" would be a lie in the table name, and
generalising the table is a migration on shipped data for one nullable column.

## 8. What is not built

| Not built | Why |
|---|---|
| **Recall reminders** | §4.5 asks for "appointment cadence with recall reminders". The cadence is computed and shown — *"last visit was 7 months ago"*. The reminder is not, because §5.9 makes notifications opt-in and the notification surface does not exist. A reminder wired to nothing is the declared-but-never-executed pattern this codebase keeps finding. |
| Dental imaging comparison | §4.5 future expansion. Needs the encrypted media path, which is still deferred — see [documents.md](documents.md). |
| A treatment-plan tracker | §4.5 future expansion. `treatment_course` exists and is populated by nothing; isotretinoin has the same gap and both belong to one later piece of work. |
| The Consultation Pack for dentistry | §4.5 names it; §12 puts the Pack itself in December. The question-derivation machinery already exists in `domain/health/appointment.ts` and is not dental-specific — pointing it at a dental appointment is a filter, not a build. |
| The nutrition ↔ teeth link | §4.5 has Teeth reading "nutrition (sugar)". `nutrition.sugar` is registered by the Nutrition module; correlating it with anything is a **December detector** under §10.6's controls, not a Teeth feature. |
| The SSRI dry-mouth link | §4.5 names it as "a real and directly relevant cross-domain link for this user". The data is there — `medication` and `side_effect` both shipped in October — and asserting the connection is exactly what §9.2 means by "Linked but never asserted as causal by the system". It is a question for the Consultation Pack, not a claim for this page. |
