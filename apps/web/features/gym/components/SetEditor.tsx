'use client';

import { useState, type ReactNode } from 'react';
import { MAX_RPE, MIN_RPE, RPE_STEP, type Exercise, type SetPrefill } from '@naitikos/core';
import { Badge, Button, Card, CardBody, Inline, NumberField, Stack, Text } from '@naitikos/design-system';

/**
 * The one control the whole module is arranged around.
 *
 * §4.1: "the logger must default to *last session's numbers* for the same
 * exercise, so the primary interaction is confirming or nudging rather than
 * typing. Typing a weight from scratch every set is a P1 violation."
 *
 * So the fields arrive **filled**, the prefill's provenance is stated on the
 * card ("last time: 60 kg × 8, 10 Aug"), and the primary action is a single
 * full-width button. A set that is a repeat of last week costs one tap.
 *
 * ## Two things that are deliberately not prefilled
 *
 * **RPE.** It is a judgement about *this* set, and copying last week's would
 * turn the only subjective field in the logger into a number nobody assessed.
 *
 * **Side.** A unilateral movement alternates, and guessing wrong is worse than
 * asking — the two sides are two sets, and mislabelling them corrupts the
 * per-side breakdown permanently (observations are append-only, §9.1).
 */

export type SetDraft = {
  readonly load: number | null;
  readonly loadUnit: string;
  readonly reps: number | null;
  readonly rpe: number | null;
  readonly side: 'left' | 'right' | null;
};

export type SetEditorProps = {
  readonly exercise: Exercise;
  readonly prefill: SetPrefill;
  readonly setNumber: number;
  readonly onLog: (draft: SetDraft) => void;
  readonly isQueueing?: boolean;
  /** Shown when the session has no bodyweight and this movement needs one. */
  readonly bodyweightKnown: boolean;
};

export function SetEditor({
  exercise,
  prefill,
  setNumber,
  onLog,
  isQueueing = false,
  bodyweightKnown,
}: SetEditorProps): ReactNode {
  const [draft, setDraft] = useState<SetDraft>(() => fromPrefill(prefill));

  /*
   * Re-seeded when the prefill changes — which happens when the exercise
   * changes, or when the previous set lands and the next position's numbers
   * arrive.
   *
   * **Adjusted during render, not in an effect.** React's own guidance, and it
   * matters here rather than being a style point: an effect runs *after* paint,
   * so the operator would see one frame of last set's numbers before the new
   * prefill replaced them — a flicker on the field they are about to tap.
   * React discards this render and re-runs immediately, so nothing is committed
   * with stale values.
   *
   * The identity comparison is against the prefill *object*, which the query
   * layer replaces only when the data changes, so an unrelated re-render never
   * discards what the operator has typed.
   */
  const [seenPrefill, setSeenPrefill] = useState(prefill);
  if (seenPrefill !== prefill) {
    setSeenPrefill(prefill);
    setDraft(fromPrefill(prefill));
  }

  const needsSide = exercise.isUnilateral;
  const canLog = draft.reps !== null && draft.reps > 0 && (!needsSide || draft.side !== null);

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline justify="between" align="center">
            <Stack gap="1">
              <Text role="title-3" as="h3">
                {exercise.name}
              </Text>
              <Text role="caption" tone="tertiary">
                Set {setNumber}
              </Text>
            </Stack>

            {/*
              The provenance of the numbers already in the fields. Without it a
              prefilled value is indistinguishable from a recorded one, which is
              a data-integrity problem wearing a convenience hat.
            */}
            {prefill.source !== 'none' && prefill.fromDayKey !== null && (
              <Badge tone="neutral" icon="nav.timeline">
                Last time: {prefill.load ?? '—'} {prefill.loadUnit} × {prefill.reps ?? '—'}
              </Badge>
            )}
          </Inline>

          {exercise.isBodyweight && !bodyweightKnown && (
            /*
              Said now, not at the end. `volume.ts` refuses to guess a bodyweight
              and excludes these sets; the operator discovering that when they
              close the session is too late to do anything about it.
            */
            <Badge tone="caution" icon="status.warning">
              No bodyweight recorded — this movement will not count towards volume
            </Badge>
          )}

          <NumberField
            label={exercise.isBodyweight ? 'Added weight' : 'Weight'}
            value={draft.load}
            onValueChange={(load) => {
              setDraft((current) => ({ ...current, load }));
            }}
            // §8.10: "Logging a set is `+2.5 kg`, not typing `62.5`." 2.5 is the
            // smallest plate pair on most bars.
            step={2.5}
            min={0}
            unit={draft.loadUnit}
          />

          <NumberField
            label="Reps"
            value={draft.reps}
            onValueChange={(reps) => {
              setDraft((current) => ({ ...current, reps }));
            }}
            step={1}
            min={0}
          />

          <NumberField
            label="RPE"
            value={draft.rpe}
            onValueChange={(rpe) => {
              setDraft((current) => ({ ...current, rpe }));
            }}
            step={RPE_STEP}
            min={MIN_RPE}
            max={MAX_RPE}
            hint="Optional. 10 means no further reps were possible."
          />

          {needsSide && (
            <Stack gap="1">
              <Text role="caption" tone="secondary">
                Side
              </Text>
              <Inline gap="2">
                {(['left', 'right'] as const).map((side) => (
                  <Button
                    key={side}
                    variant={draft.side === side ? 'primary' : 'secondary'}
                    fullWidth
                    onClick={() => {
                      setDraft((current) => ({ ...current, side }));
                    }}
                  >
                    {side === 'left' ? 'Left' : 'Right'}
                  </Button>
                ))}
              </Inline>
            </Stack>
          )}

          <Button
            variant="primary"
            size="lg"
            fullWidth
            isLoading={isQueueing}
            disabled={!canLog}
            iconStart="action.confirm"
            onClick={() => {
              onLog(draft);
            }}
          >
            Log set
          </Button>
        </Stack>
      </CardBody>
    </Card>
  );
}

function fromPrefill(prefill: SetPrefill): SetDraft {
  return {
    load: prefill.load === null ? null : Number(prefill.load),
    loadUnit: prefill.loadUnit,
    reps: prefill.reps,
    rpe: null,
    side: null,
  };
}
