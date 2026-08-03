# Application Shell

**Blueprint:** §3 (information architecture), §5.1 (state), §6.2, §7 · **Location:** `apps/web`

---

## 1. Structure

```
apps/web/
├── app/                                  routing ONLY (§6.2)
│   ├── layout.tsx ...................... document · ThemeScript · providers
│   ├── error.tsx · loading.tsx · not-found.tsx
│   ├── (public)/  ...................... no shell — signed-out surfaces
│   │   └── auth/{sign-in,error,callback}
│   ├── (protected)/  ................... auth guard + shell
│   │   ├── layout.tsx .................. getAuthState → SessionProvider → AppShell
│   │   └── today/page.tsx
│   └── api/auth/*  ..................... route handlers
│
├── components/
│   ├── shell/  ......................... AppShell · Sidebar · MobileNav · TopBar
│   │                                     NavLink · CommandPalette · SettingsDrawer
│   │                                     PageContainer
│   └── PlatformStatus.tsx .............. the shell demonstrating itself
│
├── lib/
│   ├── navigation/config.ts ............ the §3.2 structure, as data
│   ├── stores/ ......................... appearance · navigation (Zustand)
│   └── providers/AppearanceProvider.tsx  theme · density · motion
│
└── styles/{globals,shell}.css
```

`app/` contains routing and nothing else. A page imports a screen and renders it
— *"when the router changes, `app/` is rewritten and `features/` is untouched."*

---

## 2. Route groups

| Group | Shell? | Auth |
|---|---|---|
| `(public)` | **No** | None. Proxy redirects an authenticated user away. |
| `(protected)` | Yes | `getAuthState()` in the layout — allowlist + role + audit |

**The shell mounts in `(protected)`, not the root layout.** A signed-out visitor
must not see navigation: a sidebar listing Body and Mind on a sign-in page tells
an attacker what the account contains.

Two guard layers, failing differently (unchanged from the identity milestone): the
proxy is a coarse "is there a session?" because the edge has no database; the
protected layout is the real gate.

### Error, loading, not-found

| File | Renders |
|---|---|
| `app/error.tsx` | `ErrorState` with the Next digest as the trace id |
| `app/loading.tsx` | `LoadingState` skeletons — never a spinner, which guarantees a layout shift |
| `app/not-found.tsx` | `EmptyState` — "may be a module not built yet", which is usually true |

The error boundary is **inside** the shell, so navigation survives a content
failure. §5.12 wants per-pillar boundaries; those arrive with the pillars.

### Suspense and code splitting

`/today` wraps its interactive region in `<Suspense>`, so the page shell streams
and paints before the client bundle lands. Route-level splitting is the App
Router's default — every `page.tsx` is its own chunk, and the overlays are client
components loaded with the shell rather than per route.

---

## 3. Navigation

Declared as **data** in `lib/navigation/config.ts`, consumed by the sidebar, the
tab bar, and the command palette. One structure, three renderings.

§3.1's warning shapes it: *"Sixteen top-level modules in a sidebar is how personal
systems die. The user opens the app, sees fourteen mostly-empty sections, feels
the weight of everything unmaintained, and closes it."*

Five primary entries (§3.2): Today · Body · Mind · Timeline · Library.

### `available` implements §3.3 R6

> `[V2]` and `[V3]` routes do not exist in the shipped MVP. Not hidden, not
> disabled, not greyed out — **absent**. A visible-but-empty module teaches the
> user that the system is a graveyard.

`visibleNavItems()` filters on `available`, and **that filter is the enforcement.**
In production only Today renders. In development the rest render disabled, so the
shell can be tested at its real shape — a developer affordance gated on
`NODE_ENV`, not a product decision.

An unavailable entry renders as `<button disabled>`, not a `<span>`: a span is
invisible to keyboard users, while a disabled button is announced as unavailable,
which is the truth.

### Breadcrumbs

`breadcrumbsFor(pathname)` resolves the first segment through the nav config and
title-cases the rest. §3.3 caps depth at three, so the trail is short by
construction — *a breadcrumb trail long enough to wrap is a navigation structure
that has already failed.*

The final crumb carries `aria-current="page"` and is **not** a link. Linking the
page you are on is a small lie screen-reader users notice.

Hidden below `md`: on a phone the page `h1` carries the context and a truncated
trail is noise.

---

## 4. Responsive strategy

**Mobile-first without qualification** (§8.4). There is no `max-width` query in
the shell — every query widens.

| Viewport | Navigation | Breadcrumbs | Search |
|---|---|---|---|
| < 640 | Bottom tab bar | Hidden | Icon only |
| 640–1023 | Bottom tab bar | ≥ 768 | Icon + label + ⌘K |
| ≥ 1024 | Sidebar (collapsible) | Yes | Full |

**Both navigations are always rendered**; CSS decides which is visible. Two
consequences: no layout shift when the viewport crosses a breakpoint, and no
JavaScript-measured width — which would be wrong on first paint and would break
if the window were resized before hydration.

### Mobile specifics

- **Bottom placement.** The same reach argument §8.12 makes for sheets: a top tab
  bar on a 6-inch phone requires a grip change.
- **Four tabs maximum.** A fifth makes each target narrower than the 44px §8.13
  requires on a 360px screen.
- **Safe areas.** `env(safe-area-inset-bottom)` on the tab bar, the sheet, and the
  toast viewport. Without it the last control in a sheet sits under the iOS home
  indicator and cannot be pressed.
- **`--app-bottom-nav-height`** is published on `:root` and read by both the
  content padding and the toast viewport, so a toast never covers the navigation.
  Zeroed at `lg`.
- **Opaque navigation.** Not translucent: content scrolling behind a blurred bar
  drops label contrast below the §8.13 threshold.

### Landscape and PWA

`100dvh` rather than `100vh`, so a rotated phone with a collapsing URL bar does
not clip. `viewportFit: 'cover'` with explicit safe-area padding. Zoom is **not**
disabled — §8.13 requires layout to survive 200%.

---

## 5. State architecture

§5.1's line: **"Zustand never holds server data."** Two stores, both ephemeral.

### `navigation.store.ts` — unambiguously ephemeral

Sidebar collapsed, mobile nav open, palette open, settings open. §7.3's test:
*"If a store field could be refetched from the server, it is in the wrong
place."* None of these can.

`isSidebarCollapsed` is deliberately **not** persisted: on a tablet it collapses
for width reasons, and persisting that would leave a desktop session
mysteriously narrow after one visit on a smaller screen.

`closeAllOverlays()` runs on every route change. Without it, opening the palette,
navigating, and landing on a new page leaves the palette open over unrelated
content — the most common shell bug, and one that only appears once routing works.

### `appearance.store.ts` — a deliberate, documented exception

Theme, density, motion, persisted to `localStorage`. **This is two copies of data
the server also holds**, which is what §5.1's rule exists to prevent.

The justification is latency, not architecture: theme must apply *before first
paint*, and a server round trip means a flash of the wrong theme on every load —
which on a tool opened in a dark bedroom is not cosmetic.

**The direction of authority is fixed and stated: the server `setting` row is the
truth; this store is a cache of it.** `hydrateFromServer` overwrites local;
nothing writes the other way except an explicit user action, which persists
through the API and then updates here.

Values are sanitised on read, falling back rather than throwing — a preference
written by an older build must not lock the user out of the screen that would fix
it.

### `AppearanceProvider`

Stamps `[data-theme]`, `[data-density]`, `[data-motion]`, and `color-scheme` on
the root. §8.6 requires the motion decision **once**, at provider level; no
component queries the media query.

OS preferences are read with **`useSyncExternalStore`**, not `useState` +
`useEffect`. Reading a media query in an effect and calling `setState` renders
once with the wrong value and once corrected — a cascading render React's own
lint rule flags, and for theme that means a visible flash.

`data-motion="full"` is stamped explicitly rather than omitted, because
`base.css` has a `prefers-reduced-motion` block guarded by
`:root:not([data-motion='full'])` for the pre-hydration case. Defeating that
guard requires the attribute to be *present*.

---

## 6. Search and the command palette

**The palette is the search architecture, singular.** §2.5 forbids *"an in-app
'everything' search that queries live LLM context"*, and Ask is V2. That leaves a
keyboard-driven registry of navigation targets and actions.

⌘K / Ctrl+K is registered in `AppShell`, not the palette — the palette is
unmounted while closed and cannot listen for the key that opens it.

Built on `cmdk`, which supplies the filtering, roving focus, and the
combobox-with-listbox ARIA pattern (one of the harder ones, and one where a
mistake makes it unusable with a screen reader). It renders a Radix Dialog
underneath, so it inherits the same focus semantics as every other overlay.

Current groups: **Go to** (nav targets), **Appearance** (theme), **Settings**.
Actions close the palette *before* acting — acting first can unmount it
mid-handler and leave focus nowhere.

When data search arrives it is Postgres full-text plus trigram (§9.6), surfaced
as an additional group here.

---

## 7. Settings drawer

A **sheet, not a route** — §8.12: a sheet is for *"contextual detail"*, and
appearance settings are changed while looking at what they affect. A
`/settings/appearance` page hides the subject of the change behind the control.

Contains theme, density, and motion. §3.2's full `/settings` tree is where export,
integrations, and consent scopes will live.

Notification categories and AI consent are listed as **explicitly unbuilt** rather
than omitted — an empty screen implies these are the only preferences the system
will ever have, and a toggle that writes nothing is worse than its absence.

---

## 8. Notifications

A **disabled** affordance in the top bar. §5.9: *"Opt-in per category, off by
default, no exceptions."* Everything is off, so there is nothing to show.

**No badge, and no count.** P6 forbids *"badges… red numbers… [or] notification
that exists to drive engagement"*. When notifications land, the affordance opens a
list; it will not grow a number designed to be cleared.

---

## 9. Accepted debt

| Item | Assessment |
|---|---|
| **Theme in `localStorage`, not a cookie** | A cookie would let the server render the correct theme with no inline script and no duplicated logic. Deferred because it requires the theme to be known before `getAuthState`, and that ordering interacts with the proxy in a way worth doing deliberately. The `ThemeScript` duplication is the cost. |
| **`ThemeScript` duplicates provider logic** | Unavoidable while theme lives in storage — it must run before React. Kept to ~12 lines for that reason. |
| **No `axe-core` in CI** | §8.13 requires it on every route. Playwright is not installed; the route set is 9 and mostly auth. Should land with the first feature. |
| **No component tests** | §11.4 puts them at "critical paths"; the critical path is the Daily Close, which does not exist. |
| **`PlatformStatus` is scaffolding** | Exists so the library is observable end to end without a feature. Should be deleted, not extended, when Today becomes real. |
| **Sidebar collapse is not persisted** | Deliberate (see §5), but a desktop-only user may reasonably expect it to stick. Revisit with a viewport-aware persistence rule rather than a plain boolean. |
| **No `manifest.webmanifest`** | §5.9 needs it for installability and iOS web push. `appleWebApp` metadata is set; the manifest and service worker are Week 2's PWA task (§12). |
