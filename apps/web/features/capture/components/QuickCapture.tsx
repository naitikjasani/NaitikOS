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

import { newIdempotencyKey, offlineEnvelope } from '@/lib/offline/device';
import { queueAndDrain } from '@/lib/offline/drain';
import { useNavigationStore } from '@/lib/stores/navigation.store';

/** How long the leader key stays armed. */
const CHORD_TIMEOUT_MS = 2000;

type CaptureKind = {
  readonly key: string;
  readonly metricKey: string;
  readonly label: string;
  readonly control: 'scale' | 'number' | 'preset';
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /**
   * For `preset`: the values offered as one-tap buttons.
   *
   * Hydration is the one metric on this rail where the *value* is almost always
   * one of three numbers — a glass, a bottle, a litre. A stepper from 0 to 3000
   * in steps of 50 is sixty taps for a number the operator already knows, so the
   * control is three buttons and the stepper is not offered at all.
   */
  readonly presets?: readonly number[];
};

/**
 * The rail's contents.
 *
 * A short, hard-coded list rather than everything in the registry, and that is
 * the design. §3.2 caps quick capture at "≤3-tap logging" — a rail of eighteen
 * metrics is a menu, and a menu is navigation, which §3.3(4) forbids here. What
 * belongs is the handful of things captured *between* Daily Closes.
 *
 * §3.2 puts the configuration at `/settings/capture`; until that exists, this
 * list is the default it will edit.
 */
const KINDS: readonly CaptureKind[] = [
  { key: 'm', metricKey: 'mind.mood', label: 'Mood', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'e', metricKey: 'mind.energy', label: 'Energy', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'a', metricKey: 'mind.anxiety', label: 'Anxiety', control: 'scale', unit: '', min: 1, max: 5, step: 1 },
  { key: 'w', metricKey: 'body.weight', label: 'Weight', control: 'number', unit: 'kg', min: 20, max: 400, step: 0.1 },
  /*
   * Hydration, and the only Nutrition thing on this rail.
   *
   * §4.3's other captures are *meals*, and a meal needs the suggestion ranking
   * — which is server data this shell does not have. Fetching it when the sheet
   * opens would put a round trip in the middle of §2.2's ten-second budget,
   * making the sheet slower than `/body/nutrition/log`, which is server-rendered
   * with that data already in the response. So there is no `c f`: the fastest
   * path to a logged meal is the route, and a second slower path that looks
   * faster would be a trap.
   *
   * Water is different. It is one number, it has no library behind it, and the
   * three presets cover almost every case. It belongs on the rail for the same
   * reason weight does.
   */
  {
    key: 'h',
    metricKey: 'nutrition.water',
    label: 'Water',
    control: 'preset',
    unit: 'ml',
    min: 0,
    max: 3000,
    step: 50,
    presets: [250, 500, 1000],
  },
];

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

  const active = KINDS.find((kind) => kind.metricKey === captureKind) ?? null;
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
        const kind = KINDS.find((candidate) => candidate.key === event.key.toLowerCase());
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

/**
 * The rail, for the command palette.
 *
 * A chord nobody can discover is a chord nobody uses, and the palette is the
 * only surface a person opens *looking* for what is possible. Exported as data
 * rather than rendered here so the palette owns its own layout.
 */
export const QUICK_CAPTURE_CHORDS: readonly {
  readonly chord: string;
  readonly label: string;
  readonly metricKey: string;
}[] = KINDS.map((kind) => ({ chord: `c ${kind.key}`, label: kind.label, metricKey: kind.metricKey }));
