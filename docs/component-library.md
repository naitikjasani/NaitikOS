# Component Library

**Package:** `@naitikos/design-system` · **Blueprint:** §8.8, §8.10, §8.11, §8.12

Everything is imported from the package root. The package is domain-agnostic
(§6.2) — it renders values, it does not know what a medication is — and the
boundary lint rule enforces that: it may import `@naitikos/shared` and nothing
else internal.

```tsx
import { Button, Card, Stack, Text, useToast } from '@naitikos/design-system';
```

---

## Primitives

### `Stack` · `Inline` · `Grid` · `Container` · `Spacer` · `Divider`

Token-typed layout (§8.4). `gap` accepts only spacing-scale steps.

```tsx
<Stack gap="4" align="center">…</Stack>
<Inline gap="2" justify="between" wrap={false}>…</Inline>
<Grid minColumnWidth="18rem" gap="4">…</Grid>
<Container width="reading">…</Container>
```

| Prop | Notes |
|---|---|
| `gap` | `'0' \| 'px' \| '1' \| '2' \| '3' \| '4' \| '5' \| '6' \| '8' \| '10' \| '12' \| '16' \| '20' \| '24'` |
| `Grid.minColumnWidth` | A minimum, not a count — intrinsically responsive, no media queries |
| `Container.width` | `reading` (42rem, long-form) · `content` (64rem) · `wide` (90rem, tables/charts) · `full` |

`Divider` renders `role="separator"` with an orientation, so a section break is
announced rather than being an invisible bordered `<div>`.

### `Text` · `VisuallyHidden`

```tsx
<Text role="title-2" as="h3" tone="secondary">Section</Text>
<Text role="metric-l">74.2</Text>          {/* tabular figures, automatic */}
<Text role="body" serif>Journal prose…</Text>
<Text role="body-sm" lines={2}>Clamped…</Text>
```

`role` sets the type scale; `as` sets the element. They are separate because
heading *level* is document structure and heading *size* is visual — see
design-system.md §3.

`tone` is `primary | secondary | tertiary | accent | critical | inherit`.
**`critical` is for destructive labels, never for data** (§8.2).

### `Icon`

```tsx
<Icon name="domain.gym" label="Gym" size="md" />
<Icon name="nav.next" label={null} />       {/* decorative */}
```

`label` is required. `null` means decorative and sets `aria-hidden`. Sizes:
`sm` 16 · `md` 20 · `lg` 24 · `xl` 32.

---

## Controls

### `Button` · `IconButton`

```tsx
<Button variant="primary" iconStart="action.add">Log a set</Button>
<Button variant="destructive" isLoading>Deleting…</Button>
<Button asChild variant="secondary"><Link href="/today">Today</Link></Button>
<IconButton icon="action.edit" label="Edit entry" />
```

| Prop | Values |
|---|---|
| `variant` | `primary` · `secondary` (default) · `ghost` · `destructive` |
| `size` | `sm` · `md` (44px) · `lg` |
| `isLoading` | Disables, sets `aria-busy`, **keeps the label** |
| `asChild` | Renders the child element — for links that look like buttons |

`type="button"` is the default. An un-typed button inside a form submits it,
which is the most common accidental-submit bug in React.

`isLoading` keeps the label in the DOM rather than swapping in a spinner —
swapping changes the button width mid-interaction and leaves a screen reader
announcing nothing.

**`IconButton` is a separate component, not `Button` with no children**, so
`label` can be *required*. An icon-only button without a label is the easiest
accessibility failure to ship.

### Fields — §8.10

All share the same shell: visible label, correct `aria-describedby`, error with
`role="alert"`.

```tsx
<TextField label="Display name" hint="Shown in the top bar" required />
<NumberField label="Load" value={62.5} onValueChange={setLoad} step={2.5} unit="kg" />
<ScaleField label="Mood" value={mood} onValueChange={setMood} min={1} max={5}
            minLabel="Worst" maxLabel="Best" />
<TextAreaField label="Journal" serif rows={8} />
<ToggleField label="Sync failure alerts" checked={on} onCheckedChange={setOn} />
<SearchField value={q} onValueChange={setQ} placeholder="Find an exercise" />
<DateField label="Collected" value={date} onValueChange={setDate} />
<FileField label="Lab report" accept="application/pdf" onFilesSelected={upload} />
```

| Field | The §8.10 rule it implements |
|---|---|
| `TextField` | Every input has a **visible** label — placeholder-as-label is an accessibility failure |
| `NumberField` | **Steppers over typing.** `inputMode="decimal"`, not `numeric` — `numeric` has no decimal separator on iOS, making 62.5 impossible |
| `ScaleField` | The 1–5 tap of the Daily Close. A **radio group**, so the whole scale is one tab stop and arrows move between options |
| `TextAreaField` | `serif` for the long-form mode-switch (§8.3) |
| `SearchField` | `type="search"`, native clear suppressed in favour of a labelled button |
| `DateField` | **The native control, deliberately** — see below |
| `FileField` | Native input kept as the real control, visually hidden inside a label drop zone |

**`DateField` is the native picker on purpose.** It is fully keyboard accessible,
localised for free, works with every screen reader, and on mobile opens the
platform wheel — faster than any custom grid and already familiar. A hand-built
calendar is one of the largest accessibility liabilities a design system can take
on, and §8.10's priority is capture speed. Revisit only for a range picker or an
annotated calendar.

`ScaleField` is **uncoloured**. 1 and 5 render identically; only the selection
position differs (§8.2).

`NumberField` steppers are full touch targets — they are pressed one-handed
mid-workout.

### `SegmentedControl` · `Tabs`

```tsx
<SegmentedControl label="Density" value={d} onValueChange={setD} fullWidth
  options={[{ value: 'comfortable', label: 'Comfortable' }, …]} />

<Tabs label="Views" value={tab} onValueChange={setTab}
  items={[{ id: 'log', label: 'Log', content: <Log /> }]} />
```

They look similar and are **not interchangeable**. Tabs switch panels of content
and wire `role="tabpanel"`; a segmented control picks a value affecting something
elsewhere. Using tabs for a filter announces "tab panel" for content that is not
one.

`SegmentedControl` cannot be emptied — the `''` that Radix emits when the active
item is re-pressed is ignored, because a required single choice with nothing
selected is a state the caller cannot render.

---

## Containers

### `Card` — four variants, no more (§8.8)

```tsx
<Card variant="outlined">
  <CardHeader title="Volume" description="Last 7 sessions" actions={<IconButton …/>} />
  <CardBody>…</CardBody>
  <CardFooter>…</CardFooter>
</Card>

<Card variant="interactive" onActivate={open}>…</Card>
```

| Variant | Use |
|---|---|
| `flat` | Grouping without emphasis. No border, no shadow. The default. |
| `outlined` | Distinct entity. 1px subtle border. |
| `raised` | Elevated. Lightness in dark, shadow in light (§8.7). |
| `interactive` | Whole card is a target. |

**`interactive` renders a real `<button>`**, not a `<div>` with `onClick`. That is
what `onActivate` exists for — bolting `role="button"` and a keydown handler onto
a div is the pattern that reliably breaks keyboard users.

Adding a fifth variant is a design-system decision, not a prop.

### `Badge` · `Avatar` · `Progress`

```tsx
<Badge tone="caution" icon="status.unsynced">Unsynced</Badge>
<Avatar name="Naitik Jasani" size="sm" />
<Progress value={72} label="Adherence" showValue />
<Progress value={null} label="Syncing" />      {/* indeterminate */}
```

`Badge` tones are `neutral | accent | positive | caution | critical`. There is
**no `danger`** a feature could reach for to colour a reading. The text is always
present, so the badge survives greyscale printing and colour blindness.

`Progress` requires a `label` — a bare bar announces nothing.

---

## Overlays — all on Radix (§8.12)

Focus trapping, focus restoration, escape handling, and scroll locking come from
Radix. Each is individually subtle and collectively ~400 lines nobody should
write twice; getting focus restoration wrong dumps a keyboard user at the top of
the document every time they close a dialog.

```tsx
<Dialog open={o} onOpenChange={setO} title="Export" description="…" footer={…}>…</Dialog>
<AlertDialog open={o} onOpenChange={setO} title="Delete?" description="…" onConfirm={del} />
<Sheet open={o} onOpenChange={setO} title="Log a set" side="bottom">…</Sheet>
<Popover trigger={<IconButton …/>}>…</Popover>
<Tooltip content="Search  ⌘K"><button>…</button></Tooltip>
<DropdownMenu label="Account" trigger={…} items={[{ id, label, icon, onSelect }]} />
```

| Component | Use | Placement |
|---|---|---|
| `Dialog` | Focused task needing confirmation | Centred, modal |
| `AlertDialog` | Destructive confirmation | Centred, explicit action |
| `Sheet` | Contextual detail or capture | **Bottom** on mobile, right on desktop |
| `Popover` | Lightweight secondary content | Anchored |
| `Tooltip` | Supplementary label — **never essential** | Anchored |
| `DropdownMenu` | Actions on an entity | Anchored |

**`description` is required on `Dialog`.** Radix warns without one and the warning
is right: a screen-reader user hears the title and then silence while sighted
users read the body.

**`Sheet` defaults to `bottom`** — §8.12: bottom sheets are *"reachable
one-handed, which matters when logging a set with a phone in one hand."*
Implemented with Vaul for drag-to-dismiss with velocity, which cannot be added
afterwards and is how a sheet is actually closed on a phone. Vaul is built on
Radix Dialog, so the focus semantics hold.

**`AlertDialog` is the second line of defence, not the first.** §8.12: *"Deletion
is soft (§9.4) and produces an undo toast. Confirmation dialogs train people to
click through them; undo actually protects data."* Cancel is first in the DOM, so
the destructive action is never one stray Enter away.

**`Tooltip` never carries essential information** — it is invisible on touch and
to most screen readers until focused.

### `Toast` — the undo mechanism

```tsx
const { toast } = useToast();

toast({
  title: 'Session deleted',
  action: { label: 'Undo', onAction: restore },   // ← the data-safety feature
});
```

`action` is not decoration. A toast with an action gets **10 seconds** instead of
5, because 5 is enough to read a confirmation and not enough to notice, decide,
and reach for a button.

The viewport clears the mobile tab bar and the home indicator — a toast covering
the navigation blocks the way out.

Toasts never congratulate, never nudge, and never report a health value (P6).

---

## States

```tsx
<EmptyState icon="domain.gym" title="No sessions yet"
  description="Workouts you log will appear here."
  action={{ label: 'Log a session', onAction: start }} />

<ErrorState traceId={digest} onRetry={reset} />
<LoadingState rows={4} />           {/* skeletons, holds layout */}
<LoadingState variant="spinner" />  {/* only when the shape is unknown */}
<Skeleton height="1rem" width="60%" />
<Spinner label="Saving" />
```

**§8.8 makes empty states a primary design surface**, not an afterthought:
*"Given that this system will legitimately have empty modules for long periods…
each one states what would appear here and offers the single action that would
populate it."*

`description` is **required**, and it is meant to say what *would* be here. "No
data" is a failing description; "Workouts you log will appear here" is a passing
one. `action` is a single action, and the type says so — one, not an array.

**`ErrorState` uses `caution`, not `critical`.** A page that failed to load is
recoverable; colouring it the same as "you are about to delete five years of
records" erodes the stronger signal.

Note §5.12's product-specific rule: **never show a raw error for a logging
action.** A failed write is "saved locally, will sync" — true, because the outbox
has it — not a red toast that makes the user wonder whether their workout is gone.
`ErrorState` is for a page that genuinely could not load.

---

## Charts — architecture only

```tsx
<ChartFrame form="trend" title="Bodyweight" height={240}
  data={{ yAxis: { zeroBaseline: false, min: 74, unit: 'kg' }, series: […], annotations: […] }} />
```

**No charting library is imported.** Charts are V2; the frame is what has to be
right before the first plot.

What the frame guarantees for every chart:

| Guarantee | §8.9 |
|---|---|
| A data table toggle is always present | (6) *"Every chart has a table."* |
| Legend is text, never colour alone | (5), §8.13 |
| A truncated y-axis is **visibly labelled** | (1) *"An unlabelled truncated axis is a lie told in a health application."* |
| Interventions are listed as text as well as drawn | (2) — a screen reader cannot see a vertical line |
| Readable at 360px | (7) |
| `value: null` is a gap, never a zero | (3) *"Interpolation across a week of no data is fabrication."* |

`validateChartData()` returns violations rather than throwing, and the frame
renders them beneath the chart in development. A chart that refuses to render
teaches nothing; a chart with its own complaint underneath teaches the rule.

`ChartForm` has no `pie` member (§8.9). The series shape lives here rather than in
`core` — a recorded deviation, explained in `charts/types.ts`: §8.9 says `core`,
but the boundary rules forbid `design-system → core`, and resolving it the other
way would give the durable layer a presentation type.

---

## Conventions

**`exactOptionalPropertyTypes` is on.** Optional props that get forwarded are
declared `?: T | undefined`; where a third-party component rejects an explicit
`undefined`, props are spread conditionally:

```tsx
{...(item.disabled === undefined ? {} : { disabled: item.disabled })}
```

**Styling** is namespaced plain CSS over tokens (`nos-*`), imported once:

```css
@import '@naitikos/design-system/tokens.css';
@import '@naitikos/design-system/base.css';
@import '@naitikos/design-system/components.css';
```

**No component tests yet.** §11.4 puts component testing at "critical paths", and
the critical path is the Daily Close capture flow, which does not exist. Adding
jsdom now to assert that a form renders would be coverage theatre. The 59 token
tests cover the part that is computable.
