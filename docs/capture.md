# Quick capture

**Status:** complete against §3.3(4), including the URL entrances added
6 September 2026. ·
**Blueprint sections:** §2.2, §3.2, §3.3(4), §5.7, §8.4
**Related:** [daily-close.md](daily-close.md) · [offline.md](offline.md) ·
[app-shell.md](app-shell.md)

---

## 1. The rule the whole module is built around

> **Quick capture is global.** A floating action available on every route,
> keyboard-shortcut driven on desktop (`c` then a domain key), reachable from
> the PWA shortcut menu on mobile. **Capture must never require navigation.**
> — §3.3(4)

The last sentence is the specification. Capture is a sheet over whatever the
operator was looking at — it opens, records, and closes. P1's "capture in under
five seconds from a cold start" does not survive a page transition, and P8
forbids answering *where do I go?* with navigation.

## 2. Three ways in, and they all reach the same sheet

| Surface | How | Where the state lives |
|---|---|---|
| `c` then a domain key | `QuickCapture`'s own key listener | `navigation.store` |
| Command palette (⌘K) | An entry per rail item | `navigation.store` |
| A URL — `/today/capture/:kind` | Redirect to `/today?capture=<slug>` | `navigation.store` |

The open sheet lives in the shell store rather than inside the component,
because three triggers cannot share a state that lives inside one of them.

### The chord is a chord for a reason

`c` then a domain key. One key per metric exhausts the alphabet by the third
domain and collides with the browser's bindings; a modifier chord collides with
the OS. A leader key is what every long-lived keyboard interface converges on,
and it scales to sixteen domains without a conflict. It disarms after two
seconds so a stray `c` while reading does not swallow the next keystroke, and it
never fires inside an input, a textarea, or a `contentEditable` — without that
check, typing "capture" into the journal opens the mood sheet on the `c`.

## 3. The rail is five entries, and it is hard-coded

`lib/capture/rail.ts`. §3.2 caps quick capture at "≤3-tap logging" — a rail of
eighteen metrics is a menu, and a menu is navigation.

| Chord | Metric | Control |
|---|---|---|
| `c m` | `mind.mood` | 1–5 scale |
| `c e` | `mind.energy` | 1–5 scale |
| `c a` | `mind.anxiety` | 1–5 scale |
| `c w` | `body.weight` | stepper, kg |
| `c h` | `nutrition.water` | three presets |

Water is presets rather than a stepper because the *value* is almost always one
of three numbers — a glass, a bottle, a litre — and a stepper from 0 to 3000 in
steps of 50 is sixty taps for a number the operator already knows.

`/settings/capture` is a reference for this list rather than an editor. The list
being extensible is the thing §3.3(4) is protecting against, so the page says
that in as many words instead of rendering toggles that write a preference
nothing reads.

## 4. `/today/capture/:kind` — a route for a thing that must not be a route

§3.2 names this route; §3.3(4) forbids capture requiring navigation. Both are
satisfied because **every path through the route is a redirect**. It renders
nothing and the operator never sees it. Nothing inside the application links
there.

It exists for the contexts §3.3(4) names, which can hand the application a URL
and nothing else: the PWA shortcut menu, a notification action, a share target.
The manifest already asserted this was how capture worked on a phone —

> "Long-pressing the home-screen icon is the mobile equivalent of the `c` chord,
> and it is the only way to reach capture without opening the app first."

— while carrying exactly one shortcut, the Daily Close, because there was no URL
for anything else. The claim was true about the design and false about the
build.

### Half the kinds resolve to a page, on purpose

§3.2 names six: `mood|weight|meal|set|photo|note`. Two have sheets. The other
four are not missing sheets — they are captures whose fastest path is a route,
and this is the one place where all six resolve.

| Kind | Resolves to | Why |
|---|---|---|
| `mood`, `energy`, `anxiety`, `weight`, `water` | the sheet | One number, no server data needed |
| `meal` | `/body/nutrition/log` | The suggestion ranking is server data the sheet does not have; fetching it on open puts a round trip inside the capture |
| `set` | `/body/gym/log` | A set belongs to a session, and the logger holds the session, the previous load and the rest timer |
| `photo` | `/body/skin/photos` | §4.2 makes the capture protocol the module. A photo taken outside it is stored and flagged, which is worse than one not taken |
| `note` | `/mind/journal` | A journal entry is prose, and a one-line field teaches the operator to write one line |

A shortcut that opened a sheet which then told the operator to go somewhere else
would cost them the seconds the shortcut existed to save.

An unknown slug is a **404**. A home-screen shortcut outlives the code it points
at, and if a slug is retired the icon keeps working for months — "that is not a
thing" is honest where a silent landing on `/today` reads as the application
being broken.

### Two shortcuts in the manifest, not nine

Android shows at most four on a long-press and iOS a similar handful. Past that
the menu scrolls, and a scrolled menu is the list-reading §3.3(4) exists to
avoid. Mood and weight are the two things captured between Closes often enough
to earn a place on the home screen.

### The two lists are checked against each other

`entrances.test.ts` asserts that every sheet entrance names a metric the rail
actually offers, and that every metric on the rail has a URL. They cannot be one
list — the rail describes controls, the entrance table describes URLs, and four
of those do not point at the rail at all — and the failure mode without the test
is silent and lands on the operator's home screen: a shortcut that opens
`/today` with nothing on it.

## 5. Two things the deep link broke, and how

Worth recording because both were invisible until the route existed.

**The shell closed the sheet before the first paint.** `AppShell` clears every
overlay when the pathname changes, which is right — the alternative is the
command palette staying open over an unrelated page. But the effect also ran on
mount, and child effects run before the parent's, so the sheet a URL had just
opened was closed by the shell in the same commit. The first run is now skipped;
nothing can be open on mount, so the call was always a no-op except in the one
case where it was not.

**The parameter is stripped with `history.replaceState`, not `router.replace`.**
The path does not change, so nothing needs to re-render — and a real navigation
would fire the route-change handler above, closing the sheet again.

The sheet also opens in an effect rather than during render, which is the
opposite of the usual advice. The server has no search parameters to read, so a
sheet open on the first client render and closed in the server's HTML is a
hydration mismatch; opening after mount is what makes the two agree.

## 6. Writes go through the outbox, always

A capture is queued locally and drained, never posted directly — §5.7, and the
reason the sheet can close immediately. See [offline.md](offline.md). The Close
reads the same metrics, so a landed capture invalidates the close query rather
than leaving a stale form behind it.
