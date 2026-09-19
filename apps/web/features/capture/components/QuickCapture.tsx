'use client';

/**
 * Quick capture — §3.3(4).
 *
 *   "Quick capture is global. A floating action available on every route,
 *    keyboard-shortcut driven on desktop (`c` then a domain key), reachable
 *    from the PWA shortcut menu on mobile. **Capture must never require
 *    navigation.**"
 *
 * That last sentence is the specification. This component is a sheet, not a
 * route: it opens over whatever the operator was looking at, records, and
 * closes. P1's "capture in under five seconds from a cold start" cannot survive
 * a page transition, and P8 forbids answering "where do I go?" with navigation.
 *
 * ## The chord, and why it is a chord
 *
 * `c` then a domain key — `c w` for weight, `c m` for mood. A single key per
 * metric would exhaust the alphabet by the third domain and collide with the
 * browser's own bindings; a modifier chord (`⌘⇧W`) collides with the OS. A
 * leader key is what every long-lived keyboard interface converges on, and it
 * scales to sixteen domains without a conflict.
 *
 * The chord times out after {@link CHORD_TIMEOUT_MS}, so a stray `c` while
 * reading does not leave the app waiting for a second key that never comes.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  IconButton,
  Inline,
  NumberField,
  ScaleField,
  Sheet,
  Stack,
  Text,
} from '@naitikos/design-system';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { CAPTURE_PARAM, entranceFor } from '@/lib/capture/entrances';
import { readPrior, writePrior } from '@/lib/capture/priors';
import { RAIL, type CaptureKind } from '@/lib/capture/rail';
import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';
import { useNavigationStore } from '@/lib/stores/navigation.store';

/** How long the leader key stays armed. */
const CHORD_TIMEOUT_MS = 2000;

export type QuickCaptureProps = {
  readonly zone: string;
};

export function QuickCapture({ zone }: QuickCaptureProps): ReactNode {
  const queryClient = useQueryClient();
  /*
   * Which sheet is open lives in the shell store, not here.
   *
   * Two surfaces open it — the `c` chord below and the command palette — and a
   * sheet whose state lives inside one of its triggers cannot be opened by the
   * other without an imperative handle threaded through the shell.
   */
  const captureKind = useNavigationStore((state) => state.captureKind);
  const openCapture = useNavigationStore((state) => state.openCapture);
  const closeCapture = useNavigationStore((state) => state.closeCapture);

  const active = RAIL.find((kind) => kind.metricKey === captureKind) ?? null;
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** Set when the durable write itself failed. See {@link record}. */
  const [problem, setProblem] = useState(false);
  /** True between `c` and the domain key. A ref, so arming does not re-render. */
  const armed = useRef(false);
  const armedTimer = useRef<number | undefined>(undefined);

  const open = useCallback(
    (kind: CaptureKind) => {
      openCapture(kind.metricKey);
      setProblem(false);
      /*
       * §8.10: "Last value pre-filled wherever a sensible prior exists.
       * Confirming beats typing." §4.1 puts it in the imperative: "typing a
       * weight from scratch every set is a P1 violation."
       *
       * Only the `number` controls. Bodyweight steps by 0.1 kg from a floor of
       * 20, which is five hundred and forty presses of `+` to reach 74.2 — the
       * sheet is currently unusable for the one metric it exists to make fast.
       * A tap scale is deliberately excluded: a mood is a fresh judgement every
       * time, and pre-filling last night's would be the system proposing an
       * answer. Presets are excluded because they are already one tap.
       *
       * Pre-filled here and merely *offered* in the Daily Close, which looks
       * inconsistent and is not. Opening this sheet is already the decision to
       * record a weight; a Close field is optional (§4.0), so a default there
       * could be submitted untouched and become a measurement nobody took.
       */
      setValue(kind.control === 'number' ? readPrior(kind.metricKey) : null);
    },
    [openCapture],
  );

  /**
   * The deep-link entrance — `/today?capture=mood`.
   *
   * §3.3(4) forbids capture requiring navigation, so `/today/capture/:kind`
   * redirects here rather than rendering anything; this is the other half of
   * that adaptor. See `lib/capture/entrances.ts` for why the route exists at
   * all.
   *
   * Read from `window.location` rather than `useSearchParams`, for two reasons.
   * The parameter is an *entrance* — it is consumed once on arrival and then
   * removed, so there is nothing reactive about it. And `useSearchParams` opts
   * every route rendering this shell into client-side rendering unless each one
   * wraps it in Suspense, which is a build-wide cost for a value read once.
   *
   * The parameter is stripped with `history.replaceState`, not `router.replace`.
   * The path does not change, so nothing needs to re-render — and a real
   * navigation would fire the shell's route-change handler, which closes every
   * overlay, including the sheet this just opened.
   *
   * ## Why the sheet opens in an effect rather than during render
   *
   * Deriving it during render is the pattern the lint rule below asks for, and
   * here it would be wrong: the server has no URL search parameters to read, so
   * a sheet open on the first client render and closed in the server's HTML is
   * a hydration mismatch. Opening after mount is what makes the two agree.
   *
   * The rule's own exception covers this — *"subscribe for updates from some
   * external system"* — with the launch URL as the external system. It happens
   * once, on arrival, and never again.
   */
  useEffect(() => {
    const slug = new URLSearchParams(window.location.search).get(CAPTURE_PARAM);
    if (slug === null) return;

    const url = new URL(window.location.href);
    url.searchParams.delete(CAPTURE_PARAM);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

    const target = entranceFor(slug)?.target;
    if (target === undefined || target.kind !== 'sheet') return;

    const kind = RAIL.find((candidate) => candidate.metricKey === target.metricKey);
    if (kind === undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- See above: the launch URL is the external system, and deriving this during render would be a hydration mismatch rather than an optimisation.
    open(kind);
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      /*
       * Never steal a key from a text field.
       *
       * Without this, typing "capture" into the journal opens the mood sheet on
       * the `c`. The check covers `contentEditable` too, because the journal
       * editor is one.
       */
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }

      // A modifier means the browser or the OS owns this chord, not us.
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (armed.current) {
        const kind = RAIL.find((candidate) => candidate.key === event.key.toLowerCase());
        armed.current = false;
        window.clearTimeout(armedTimer.current);
        if (kind !== undefined) {
          event.preventDefault();
          open(kind);
        }
        return;
      }

      if (event.key.toLowerCase() === 'c') {
        armed.current = true;
        // Disarmed on a timer, so a stray `c` does not leave the app waiting
        // for a second key and then swallowing an unrelated one.
        armedTimer.current = window.setTimeout(() => {
          armed.current = false;
        }, CHORD_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(armedTimer.current);
    };
  }, [open]);

  const record = useCallback(async () => {
    if (active === null || value === null) return;
    setSaving(true);
    setProblem(false);

    try {
      await queueAndDrain({
        id: newIdempotencyKey(),
        endpoint: '/api/observations',
        method: 'POST',
        body: {
          observations: [
            {
              metricKey: active.metricKey,
              // A string for a measured number (§5.3), an integer for a tap
              // scale. The distinction is the metric's, and the rail carries it
              // rather than guessing at the API boundary.
              value:
                active.control === 'scale'
                  ? { kind: 'integer', value }
                  : { kind: 'number', value: String(value) },
              observedAt: isoFromMillis(systemClock.nowMillis()),
              observedZone: zone,
            },
          ],
          ...offlineEnvelope(),
        },
        label: `${active.label} · quick capture`,
      });

      // Tomorrow's starting point, written only once the entry is durable in
      // the outbox. An abandoned or failed capture must not move the default.
      if (active.control === 'number') writePrior(active.metricKey, value);

      // The Close reads the same metrics, so a quick capture that lands must not
      // leave a stale form behind it.
      void queryClient.invalidateQueries({ queryKey: ['close'] });
      void queryClient.invalidateQueries({ queryKey: ['observations'] });
      closeCapture();
    } catch {
      /*
       * The one failure this flow has, said out loud.
       *
       * §5.7 makes the *network* a non-event — the entry is queued and drained
       * later — but `queueAndDrain` still has to reach IndexedDB, and in a
       * private window or with storage blocked it cannot. Before this, that
       * threw, the sheet stayed open, and the operator had no way to tell a
       * recorded capture from a lost one. §8.9's instinct generalises: the one
       * outcome a health record may never produce is silence.
       *
       * The sheet stays open with the value still in it, so retrying is one tap
       * rather than a re-entry.
       */
      setProblem(true);
    } finally {
      setSaving(false);
    }
  }, [active, value, zone, queryClient, closeCapture]);

  const first = RAIL[0];

  return (
    <>
      {/*
        §3.3(4)'s floating action, which until now did not exist.

        "Quick capture is global. **A floating action available on every
        route**, keyboard-shortcut driven on desktop (`c` then a domain key),
        reachable from the PWA shortcut menu on mobile. Capture must never
        require navigation."

        Two of those three shipped. The chord needs a keyboard and the shortcut
        menu needs the operator to leave the app and come back in through the
        home screen, so on a phone — the device §8.4 calls "where capture
        happens, and capture is the product" — there was no way to reach this
        sheet at all. A rail nobody can open is a rail that does not exist.

        Fixed, bottom-inline-end, clear of the tab bar and the home indicator by
        composition rather than by a measured number: `--app-bottom-nav-height`
        is declared on `:root` by the shell and collapses to zero at `lg`, so
        this sits above the bar on a phone and in the corner on a desktop with
        no media query of its own. §8.4 forbids `max-width` queries and this
        needs none.

        Thumb-reachable by construction: bottom-right is the one region of a
        phone screen a right hand reaches without regripping, which is the same
        argument §8.12 makes for bottom sheets.
      */}
      {first !== undefined && (
        <IconButton
          icon="action.add"
          label="Quick capture"
          variant="primary"
          size="lg"
          onClick={() => {
            open(first);
          }}
          style={{
            position: 'fixed',
            insetInlineEnd: 'var(--space-4)',
            insetBlockEnd:
              'calc(var(--app-bottom-nav-height) + var(--space-4) + env(safe-area-inset-bottom))',
            zIndex: 'var(--z-index-sticky)',
            /* Round, and raised by lightness rather than by a shadow — §8.7:
               "elevation is conveyed by lightness, not shadow, since shadows
               are near-invisible on dark surfaces", and dark is the default. */
            borderRadius: 'var(--radius-full)',
          }}
        />
      )}

      <Sheet
        open={active !== null}
        onOpenChange={(next) => {
          if (!next) closeCapture();
        }}
        title="Quick capture"
      >
        {active !== null && (
          <Stack gap="5">
            {/*
              The rail itself, as one row of targets.

              This is what makes §3.2's "≤3-tap logging" true from a cold tap
              rather than only from a keyboard chord: the action button opens on
              the first rail entry, so a mood is *open, tap the number, record* —
              three. Switching domain costs a fourth, and that is the right
              trade, because the alternative is a menu screen that every capture
              pays for and §3.3(4) calls navigation.

              Selection is carried by the button variant *and* by
              `aria-current`, because §8.13 forbids colour as the sole carrier of
              a state.
            */}
            <Inline gap="2" wrap as="nav" aria-label="What to capture">
              {RAIL.map((kind) => (
                <Button
                  key={kind.metricKey}
                  variant={kind.metricKey === active.metricKey ? 'primary' : 'secondary'}
                  aria-current={kind.metricKey === active.metricKey ? 'true' : undefined}
                  onClick={() => {
                    open(kind);
                  }}
                >
                  {kind.label}
                </Button>
              ))}
            </Inline>

            {active.control === 'preset' ? (
              <Stack gap="2">
                <Text role="caption" tone="tertiary" as="p">
                  {active.label}
                </Text>
                <Inline gap="2" wrap>
                  {(active.presets ?? []).map((preset) => (
                    <Button
                      key={preset}
                      variant={value === preset ? 'primary' : 'secondary'}
                      size="lg"
                      onClick={() => {
                        setValue(preset);
                      }}
                    >
                      {String(preset)} {active.unit}
                    </Button>
                  ))}
                </Inline>
              </Stack>
            ) : active.control === 'scale' ? (
              <ScaleField
                label={active.label}
                value={value}
                onValueChange={setValue}
                min={active.min}
                max={active.max}
              />
            ) : (
              <NumberField
                label={active.label}
                value={value}
                onValueChange={setValue}
                min={active.min}
                max={active.max}
                step={active.step}
                unit={active.unit}
              />
            )}

            <Button
              variant="primary"
              fullWidth
              isLoading={saving}
              disabled={value === null}
              onClick={() => {
                void record();
              }}
            >
              Record
            </Button>

            {problem ? (
              <div role="status">
                <Text role="body-sm" tone="secondary">
                  This could not be stored on the device, so nothing was recorded. Your value is
                  still here — try again, or record it in the Daily Close.
                </Text>
              </div>
            ) : (
              <Text role="caption" tone="tertiary" as="p">
                Stored on this device immediately. It syncs on its own.
              </Text>
            )}
          </Stack>
        )}
      </Sheet>
    </>
  );
}
