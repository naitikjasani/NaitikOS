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
import { Button, Inline, NumberField, ScaleField, Sheet, Stack, Text } from '@naitikos/design-system';
import { isoFromMillis, systemClock } from '@naitikos/core';

import { CAPTURE_PARAM, entranceFor } from '@/lib/capture/entrances';
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
  /** True between `c` and the domain key. A ref, so arming does not re-render. */
  const armed = useRef(false);
  const armedTimer = useRef<number | undefined>(undefined);

  const open = useCallback(
    (kind: CaptureKind) => {
      openCapture(kind.metricKey);
      setValue(null);
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

      // The Close reads the same metrics, so a quick capture that lands must not
      // leave a stale form behind it.
      void queryClient.invalidateQueries({ queryKey: ['close'] });
      void queryClient.invalidateQueries({ queryKey: ['observations'] });
      closeCapture();
    } finally {
      setSaving(false);
    }
  }, [active, value, zone, queryClient, closeCapture]);

  return (
    <>
      <Sheet
        open={active !== null}
        onOpenChange={(next) => {
          if (!next) closeCapture();
        }}
        title={active?.label ?? 'Quick capture'}
      >
        {active !== null && (
          <Stack gap="5">
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

            <Text role="caption" tone="tertiary" as="p">
              Stored on this device immediately. It syncs on its own.
            </Text>
          </Stack>
        )}
      </Sheet>
    </>
  );
}
