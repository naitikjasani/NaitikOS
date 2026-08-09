# Accessibility — the Week 4 audit

**Status:** audited and remediated, Week 4 · **Blueprint sections:** §8.13, §8.6, §8.9
**Related:** [design-system.md](design-system.md) · [charts.md](charts.md)

---

## 1. Why this document exists

§8.13's opening line is the whole argument:

> "Not a checklist item. The operator will use this at 6am half-awake, in a gym
> with sweaty hands, and in bed at night with a dimmed screen. Accessibility here
> is ordinary usability under realistic conditions."

§12 puts an "accessibility audit and remediation across all shipped routes" in
week 4, and this is its record: what was checked, what was found, what was fixed,
and what is knowingly outstanding.

## 2. Scope

Every route shipped as of week 4 — twenty-two of them:

```
/today  /today/close  /timeline
/body  /body/gym{,/log,/history,/exercises,/exercises/:id,/volume}  /body/composition
/body/skin{,/state,/routine,/products,/photos}
/mind{,/anxiety,/journal,/journal/:id,/practices,/meds}
/auth/sign-in  /offline
```

## 3. What was found and fixed

### 3.1 Two `h1` elements on eleven routes — **fixed**

`PageContainer` renders the page `h1`, with a comment saying "exactly one per
page". Ten of the new screens *also* opened with `<Text role="title-2" as="h1">`,
and so did `ExerciseDetailScreen`, shipped in week 3.

The result was two `h1`s and a visibly duplicated title: "Mind" in the container
header and "Mind" again in the screen. Screen-reader users navigate by heading
level, and a page with two `h1`s has no top to its outline.

**Fix.** The screen-level heading is removed where the container already supplies
it. Where the screen's heading carries information the route title cannot — the
journal entry's own title, the skin log's day key, the exercise's name — it is
demoted to `h2`. `ExerciseDetailScreen` is fixed too; it was a pre-existing
defect this audit found rather than a new one.

### 3.2 Selection conveyed by fill colour alone — **fixed**

Region, distance, lighting, practice-kind and chart-measure pickers are rows of
buttons where the selected one is `variant="primary"`. To a screen reader all of
them announce identically: "Face, button".

§8.13: "No information conveyed by colour alone." **Fix:** `aria-pressed` on every
one, so selection is in the accessibility tree rather than in the fill.

### 3.3 Six routine buttons all announced as "Done" — **fixed**

The routine screen renders a step label and, beside it, a button whose visible
text is the step's state. Six rows produce six buttons announced as "Done" with
nothing to distinguish them, because the label is a sibling rather than part of
the accessible name.

**Fix:** `aria-label={`${step.label}: ${status}. Activate to cycle.`}` — the
control is understandable from its own accessible name, and the cycling behaviour
is stated rather than discovered.

### 3.4 An unlabelled file input in the tab order — **fixed**

The photo capture screen keeps a visually-hidden `<input type="file">` that the
visible button clicks. Hidden by CSS is still focusable, so keyboard users hit an
unlabelled "Choose file" stop immediately before a button that does the same
thing.

**Fix:** `tabIndex={-1}` and `aria-hidden="true"`. The button is the control.

### 3.5 Unlabelled chart annotations — **fixed**

Not strictly an accessibility defect, but the same class of problem. `TrendChart`
drew a medication annotation as a dashed vertical rule with no text, which
satisfies §8.9(2) literally and communicates nothing to anyone — §4.7 asks for a
"started Escitalopram" *marker*, and an unlabelled line is not one.

**Fix:** a numbered flag on the plot and an ordered list of labels beneath it.
Labels beneath rather than inline because at 360px (§8.9(7)) two annotations a
fortnight apart overlap into illegibility. The list is an `<ol>`, so the numbers
are semantic rather than painted.

### 3.6 The ghost overlay described the operator's skin — **fixed at design time**

An `alt` on the reference photo would be a description of the operator's own body
read aloud. It is an alignment aid, not content: `alt=""` and `aria-hidden`.

## 4. What was checked and already held

| Requirement | Evidence |
|---|---|
| Focus rings on every interactive element | `--focus-ring-width` / `--color-focus-ring` used by `.nos-card__link`, `.nos-inline-link`, and every control in `components.css`. The new `.nos-inline-link` carries its own. |
| Touch targets ≥ 44px | `Button` sizes and `ScaleField`'s radio group were built to it in week 1. The routine step buttons use `size="sm"`, which is 44px tall by token. |
| Semantic HTML first | The protocol checklist is a `<ul>`, the annotation key is an `<ol>`, the scale field is a radio group rather than five buttons. |
| Charts expose a data table | `ChartFrame`, unchanged — §8.9(6). |
| Colour is never the only signal | The protocol checklist prints "consistent / differs / not assessed" beside the dot. Adherence prints its sentence beside the bar. |
| No alarm colour in Mind | `toneFor` cannot return one; a test asserts the whole output set. |
| `prefers-reduced-motion` | Honoured globally in `base.css` (§8.6), unchanged. |
| Text scaling to 200% | Relative units throughout; the new `.nos-ghost` uses `aspect-ratio` rather than a fixed height. |

## 5. Two decisions worth stating

**The plot is `role="img"` with a short label, not a described image.** The chart
is a picture of the table below it. Reading out a hundred unlabelled numbers in
visual order is worse than pointing at the table, which is what §8.9(6) requires
exist.

**`aria-live` is used sparingly.** The trend chart's scrub readout is
`aria-live="off"` on purpose: it changes on every pointer move, and an assertive
region there would produce a stream of announcements nobody can follow. The
values are in the table.

## 6. Knowingly outstanding

§8.13 also specifies what CI should automate:

> "axe-core on every route, contrast assertions on the full token matrix, and a
> keyboard-navigation E2E path through the Daily Close."

**Contrast assertions exist** (token-matrix tests, week 1). **axe-core on every
route and the keyboard E2E do not.** Both need a browser in CI, which the
pipeline does not have yet, and standing one up was not affordable alongside two
domains and the detector battery.

This audit is therefore a **manual pass**, and it says so rather than implying the
routes are covered by a machine. The gap is real: a manual audit catches what it
looks for, and the two defects in §3.1 and §3.4 are exactly the kind an automated
run would have caught in week 3 rather than week 4.
