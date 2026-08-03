# Design System

**Status:** implemented, Week 1 · **Blueprint:** §8 · **Package:** `@naitikos/design-system`

---

## 1. Token architecture

Three tiers, strictly ordered (§8.1). **A component may only reference tier 3.**

```
TIER 1 · PRIMITIVES          primitives.json      raw values, no meaning
  --color-neutral-950: oklch(14.8% 0.009 250)
  --space-4: 1rem

TIER 2 · SEMANTIC            semantic.json        meaning, theme-dependent
  --color-surface: var(--color-neutral-950)
  --color-text-primary: var(--color-neutral-50)

TIER 3 · COMPONENT           component.json       per-component contracts
  --card-bg: var(--color-surface-raised)
  --button-primary-bg: var(--color-accent)
```

Authored as JSON, generated into CSS custom properties and typed TS constants:

```bash
pnpm tokens:build      # → src/tokens/generated/{tokens.css,tokens.ts}
```

**251 variables.** The generated directory is gitignored — a derived file in
version control is a second source of truth waiting to drift.

### The generator validates references

Every `{a.b.c}` is resolved against the emitted variable set, and a dangling
reference **fails the build**. Without that, a typo emits `var(--typo)` and
renders as an invisible or default-coloured element — a bug that looks like a
design choice and survives to production.

### Why three tiers

| Tier alone | Failure |
|---|---|
| Tier 1 only | A redesign edits every component |
| Tier 2 only | A component cannot be adjusted without affecting everything sharing its semantic token |
| Tier 3 added | Per-component escape hatches, no raw values leaking upward |

---

## 2. Colour

**OKLCH throughout the interface palette.** Perceptually uniform lightness means
a programmatically generated dark theme is actually legible, and contrast ratios
behave predictably rather than needing per-colour hand-tuning.

### The product constraint

§8.2's rule is the most important one in the system and it is easy to violate by
reflex:

> **Health data is never coloured by valence.** A mood of 2 is not red. A missed
> medication dose is not red. Health data is rendered in neutral or sequential
> palettes; deviation is communicated through *position relative to a baseline*,
> not through alarm colour. Colour-as-judgement turns a tool into a critic, and a
> critic is not something you open every day.

| Token | For | Explicitly not for |
|---|---|---|
| `--color-accent` | Interactive elements, current selection | Emphasis on data |
| `--color-positive` | Confirmed completion, target met | "Good" readings |
| `--color-caution` | Requires attention, unsynced | "Concerning" readings |
| `--color-critical` | Destructive actions, genuine errors | **Never a health metric. Ever.** |
| `--color-data-{1..8}` | Chart series | — |

Enforced in the components: `ScaleField` renders 1 and 5 identically (only the
selection position differs), `Badge` has no `danger` tone a feature could reach
for, and `Text` exposes `critical` only for destructive labels.

The one exception §8.2 allows: sync failure uses `caution`, because it is a
*system* state requiring action, not a statement about the user.

### The chart palette is adopted, not authored

§8.9 designates the `dataviz` methodology as binding: *"its palette must be
adopted rather than reinvented."*

**This was learned the hard way.** An earlier revision authored a six-hue ramp at
near-constant lightness. It looked principled and failed the validator in both
modes — worst adjacent pair **ΔE 3.4 under deuteranopia** against a target of 8 —
because constant lightness is exactly what collapses under colour-vision
deficiency: a CVD reader has lost the hue axis, and lightness is all that remains.

The adopted palette is 8 slots, both modes independently stepped:

```bash
node <dataviz>/scripts/validate_palette.js \
  "#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767" \
  --mode dark --surface '#080b0e'
```

Both modes pass every hard gate. Three light-mode slots sit below 3:1 with the
**relief rule** attached — they require visible direct labels or the data table.
§8.9(6) already mandates a table on every chart, so relief is satisfied by
construction.

**Rules that follow the palette:** slots are assigned by *entity*, never by rank,
so a filter that removes a series does not repaint the survivors. Never cycle to
a 9th hue — fold to "Other" or facet. Scatter and small-multiples cap at **3
series**, because there every pair can be adjacent.

---

## 3. Typography

Two families (§8.3). Interface is Inter; long-form is a serif, because *"a visual
mode-switch between recording data and writing reflectively is a genuine
cognitive cue"* — journaling is a core Mind interaction.

Roles, not sizes:

| Role | Size/LH | For |
|---|---|---|
| `display` | 36/40 | Hero metric on a pillar overview |
| `title-1` | 24/32 | Screen title |
| `title-2` | 20/28 | Section |
| `title-3` | 16/24 | Card |
| `body` | 15/24 | Default |
| `body-sm` | 13/20 | Secondary |
| `caption` | 12/16 | Labels, units, timestamps |
| `metric-l` | 32/36 | Primary metric value — **tabular** |
| `metric-m` | 20/24 | Secondary metric — **tabular** |
| `mono` | 13/20 | IDs, codes — **tabular** |

`<Text role="…">` is the only way to set type. A caller asks for `title-2`, never
for 20px, so retuning the scale in year four updates every screen.

**Tabular figures are automatic** on the `metric-*` and `mono` roles. Non-tabular
numerals make columns jitter, which reads as instability in a data-dense product.

### Heading level is separate from heading size

`as` overrides the element. Conflating document structure with visual scale
produces either a broken outline or the wrong type — a `title-1` inside a card is
usually an `h2`.

---

## 4. Spacing, density, layout

4px base grid, `--space-0` through `--space-24`. Layout primitives take
**token-typed** gaps, so `gap="3.5"` is a compile error.

```tsx
<Stack gap="4">      // vertical, gap not margins
<Inline gap="2">     // horizontal, wraps by default
<Grid minColumnWidth="16rem">   // intrinsically responsive, no breakpoints
<Container width="reading">     // reading | content | wide | full
```

`Grid` takes a **minimum column width** rather than a column count, so it behaves
correctly inside a sidebar as well as at full width, with no media queries.

### Density is a first-class setting

`comfortable` (default) and `compact` swap the spacing scale via
`[data-density]` on the root. *"A person reviewing five years of lab results
wants compact; the same person logging a set mid-workout wants comfortable."*

At comfortable, `--layout-control-height` is 44px (the §8.13 touch minimum). At
compact it drops to 40px — only where the user explicitly asked for tighter.

**Breakpoints:** sm 640 · md 768 · lg 1024 · xl 1280. Mobile-first without
qualification: there is no `max-width` query anywhere in the shell.

---

## 5. Motion

Functional only. It communicates causality, continuity, and state change.

```
--duration-instant  100ms   state feedback
--duration-fast     150ms   micro-interactions
--duration-normal   250ms   sheets, dialogs
--duration-slow     400ms   page-level
```

`prefers-reduced-motion` is honoured **once**, at the provider level (§8.6), not
per component. The mechanism:

```css
[data-motion='reduced'] {
  --motion-duration-normal: 1ms;
  --motion-travel: 0;        /* slides become fades, with no per-component work */
}
```

Components multiply their translate distance by `--motion-travel`. A dialog
written once slides under full motion and fades under reduced, because the
variable is 0 — no branching, no second code path.

**Two rules that are easy to break:**

- **Nothing animates on data load.** Charts do not draw themselves in. *"A number
  that animates while you are trying to read it is a number you cannot read."*
- **Skeletons do not shimmer; they hold layout.** A shimmering gradient is motion
  carrying no information, drawing the eye to the one thing not yet readable.

A `prefers-reduced-motion` media block also applies before hydration, guarded by
`:root:not([data-motion='full'])` — so a reduced-motion user never sees one
un-suppressed animation on first paint.

---

## 6. Dark mode

**Dark is the default** (§8.7), and this is a decision rather than a preference:
*"the application is opened last thing at night for the Daily Close and in a
dimly lit gym. Defaulting to light and requiring a setting change is optimising
for the wrong context."*

> An earlier revision of `core/auth/preferences.ts` defaulted to `system` on P6
> reasoning. That was wrong and has been corrected — §8.7 is naming the two
> contexts the application is actually opened in, and a phone set to light mode
> in a dark gym is the case it guards against.

Implemented as a **semantic-token remap**, not a class override. Every tier-2
token has a dark value; tier 3 and the components are unchanged.

Three dark-mode specifics that are easy to get wrong and are therefore explicit:

| Rule | Implementation |
|---|---|
| Never pure black | Base is `neutral.950`, `oklch(14.8%)` — asserted by test |
| Elevation by **lightness**, not shadow | `.nos-card--raised` lightens in dark, casts a shadow only under `[data-theme='light']` |
| Charts get a **distinct** palette, not an inversion | Separate `dataLight` ramp, independently validated |

### No flash of the wrong theme

Theme lives in `localStorage`, which a server render cannot read. `ThemeScript`
is a small blocking script in `<head>` that stamps `[data-theme]` before first
paint. It carries the CSP nonce — an unnonced inline script is silently blocked
by §5.14's policy, and the symptom is exactly the flash it exists to prevent.

---

## 7. Iconography

A single curated set (Lucide) behind a **semantic named map** (§8.5). Features
never import Lucide.

```tsx
<Icon name="domain.medication" label="Medication" />
<Icon name="action.edit" label={null} />   // decorative; adjacent text carries it
```

`icon.medication`, not `Pill` — *"so meaning survives a set change"*. `Pill` is a
picture; `medication` is a meaning.

**`label` is required, with no default.** §8.5: icons *"never [appear] as the sole
carrier of meaning"*. Passing `null` is the explicit way to say decorative; there
is no way to render an unlabelled icon by forgetting something.

Sizes tokenised at 16/20/24/32, aligned to the type scale. Stroke width scales
with size, because a 2px stroke on a 16px glyph reads noticeably heavier.

---

## 8. Accessibility

§8.13 treats this as ordinary usability under realistic conditions: *"The
operator will use this at 6am half-awake, in a gym with sweaty hands, and in bed
at night with a dimmed screen."*

### Contrast is a test, not a review comment

**59 assertions over the full token matrix, in both themes.** `contrast.ts`
implements OKLCH → sRGB → WCAG relative luminance from scratch — about sixty
lines of specified arithmetic, kept in-repo because a dependency that computes
the contrast of the tokens is a dependency that can silently change what "AA"
means in a health application.

| Bar | Applies to |
|---|---|
| **7:1 (AAA)** | `text-primary` — body copy |
| 4.5:1 (AA) | `text-secondary`, `text-tertiary`, text on accent |
| 3:1 (AA) | Borders, focus ring, status colours, chart series |

**This suite caught 11 real defects** in the authored tokens, including four chart
series unreadable on light backgrounds because §8.7's separate light ramp had
never been built. When one fails, the fix is the **token**, not the threshold.

Also asserted: every semantic token is a reference (never a literal), both themes
define the same token set, every OKLCH primitive is inside the sRGB gamut, and
the dark surface is not pure black.

### The rest

| Requirement | How |
|---|---|
| Touch targets ≥ 44×44 | `--layout-control-height`; `ScaleField` and tab bar sized from it |
| Keyboard operability | Radix for every overlay; skip link is the first tab stop |
| Focus visible | `:focus-visible` with `--color-focus-ring`, never suppressed |
| No colour-only meaning | Active nav carries an inset bar; badges carry text; charts carry a legend and table |
| Text scaling to 200% | No `html { font-size }` override, no fixed heights on text |
| Reduced motion | Provider-level, plus a pre-hydration media block |
| iOS zoom-on-focus | Inputs are `max(16px, …)` — below 16px Safari zooms and does not return |

### Not yet automated

`axe-core` on every route and the keyboard E2E path through the Daily Close
(§8.13) are **not implemented** — Playwright is not installed and the Daily Close
does not exist. Recorded as debt in the self-review.

---

## 9. What is deliberately absent

| Absent | Why |
|---|---|
| A charting library | Charts are V2 (§2.1). The frame, legend, table, and invariant checks exist; the plot layer does not. Adding Recharts now would cost bundle for a feature that cannot ship (§11.5). |
| Tailwind utilities in components | §8.1 permits only tier-3 references; a utility class references tier 1 directly. Components use namespaced CSS over tokens. |
| CSS Modules | Under P2 the durable artifact is the token JSON; a stylesheet readable without a bundler is one fewer thing that must work in 2038. |
| A fifth `Card` variant | §8.8: four, *"because container proliferation is how visual systems lose coherence."* |
| `pie` in `ChartForm` | §8.9: composition is a stacked bar, *"never a pie."* The union has no such member. |
