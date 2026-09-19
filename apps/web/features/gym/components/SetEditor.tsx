'use client';

import { useState, type ReactNode } from 'react';
import { MAX_RPE, MIN_RPE, RPE_STEP, type Exercise, type SetPrefill } from '@naitikos/core';
import { Badge, Button, Card, CardBody, Inline, NumberField, Stack, Text } from '@naitikos/design-system';

import type { LoggedSet } from '../services/liveSessionStore';

/**
 * The one control the whole module is arranged around.
 *
 * §4.1: "the logger must default to *last session's numbers* for the same
 * exercise, so the primary interaction is confirming or nudging rather than
 * typing. Typing a weight from scratch every set is a P1 violation."
 *
 * So the fields arrive **filled**, the prefill's provenance is stated on the
 * card ("last time: 60 kg × 8, 10 Aug"), and the primary action is a single
 * full-width button.
 *
 * ## The tap budget, which is the specification
 *
 * A set that repeats last week costs **one tap**, and that is true of a
 * unilateral set too. It used not to be: a unilateral movement required
 * choosing a side and *then* pressing Log, two taps for a decision the operator
 * had already made. The side chooser is therefore not a chooser any more — it
 * *is* the log button, twice: "Log left" and "Log right". Nothing is guessed
 * (see below), and nothing is asked twice.
 *
 * ## The button says what it is about to record
 *
 * `Log 60 kg × 8`, not `Log set`. The whole design of this screen is that the
 * operator confirms rather than types, and a confirm button whose label does not
 * name what is being confirmed asks for a blind tap — which is exactly how
 * last week's numbers get recorded as this week's on the set where the operator
 * meant to add a plate and the stepper did not register. The label is the
 * read-back, and it costs nothing.
 *
 * ## What has already been done, at the point of doing the next one
 *
 * The sets already logged *for this movement* are listed on the card. §12's
 * criterion is a session logged "under fatigue"; the question asked most often
 * under fatigue is "was that my third or my fourth?", and answering it used to
 * mean scrolling up to a flat chronological list and counting. `Set 4` plus
 * `60×8 · 60×8 · 60×7` answers it without moving the thumb.
 *
 * ## Two things that are deliberately not prefilled
 *
 * **RPE.** It is a judgement about *this* set, and copying last week's would
 * turn the only subjective field in the logger into a number nobody assessed.
 *
 * **Side.** A unilateral movement alternates, and guessing wrong is worse than
 * asking — the two sides are two sets, and mislabelling them corrupts the
 * per-side breakdown permanently (observations are append-only, §9.1). Which is
 * why the two log buttons are *equal*: neither is primary-and-the-other-not, so
 * nothing about the layout suggests an answer the operator has not given.
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
  /** This movement's sets so far in this session, in the order they were logged. */
  readonly loggedSets: readonly LoggedSet[];
};

export function SetEditor({
  exercise,
  prefill,
  setNumber,
  onLog,
  isQueueing = false,
  bodyweightKnown,
  loggedSets,
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
  const canLog = draft.reps !== null && draft.reps > 0;

  const log = (side: 'left' | 'right' | null): void => {
    onLog({ ...draft, side });
  };

  /** `60 kg × 8`, or `× 8` for a movement carrying no external load. */
  const readback =
    draft.load === null || draft.load === 0
      ? `× ${String(draft.reps ?? 0)}`
      : `${String(draft.load)} ${draft.loadUnit} × ${String(draft.reps ?? 0)}`;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Stack gap="1">
            <Inline justify="between" align="center" gap="2">
              <Text role="title-3" as="h3">
                {exercise.name}
              </Text>
              <Badge tone="neutral">Set {setNumber}</Badge>
            </Inline>

            {loggedSets.length > 0 && (
              <Text role="mono" as="p" tone="secondary">
                {loggedSets.map(describeLoggedSet).join(' · ')}
              </Text>
            )}

            {/*
              The provenance of the numbers already in the fields. Without it a
              prefilled value is indistinguishable from a recorded one, which is
              a data-integrity problem wearing a convenience hat.

              On its own line rather than opposite the exercise name: at 360px
              "Romanian Deadlift" and "Last time: 100 kg × 8" do not share a row,
              and the one that wraps to three words is the one that matters.
            */}
            {prefill.source !== 'none' && prefill.fromDayKey !== null && (
              <Text role="caption" as="p" tone="tertiary">
                Last time: {prefill.load ?? '—'} {prefill.loadUnit} × {prefill.reps ?? '—'}
              </Text>
            )}
          </Stack>

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

          {/*
            The primary action, at the bottom edge of the card and full width.
            §8.13's one-handed case: "a thumb reaches the bottom edge of a phone
            and the middle of it, not the top-right corner."
          */}
          {needsSide ? (
            <Inline gap="2" align="center" wrap={false}>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isQueueing}
                disabled={!canLog}
                onClick={() => {
                  log('left');
                }}
              >
                Log left
              </Button>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isQueueing}
                disabled={!canLog}
                onClick={() => {
                  log('right');
                }}
              >
                Log right
              </Button>
            </Inline>
          ) : (
            <Button
              variant="primary"
              size="lg"
              fullWidth
              isLoading={isQueueing}
              disabled={!canLog}
              iconStart="action.confirm"
              onClick={() => {
                log(null);
              }}
            >
              Log {readback}
            </Button>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/** `60×8`, `60×8 L`, `×12`. Compact enough that six of them fit one line at 360px. */
function describeLoggedSet(set: LoggedSet): string {
  const core = set.load === null || set.load === 0 ? `×${String(set.reps ?? 0)}` : `${String(set.load)}×${String(set.reps ?? 0)}`;
  if (set.side === null) return core;
  return `${core} ${set.side === 'left' ? 'L' : 'R'}`;
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
