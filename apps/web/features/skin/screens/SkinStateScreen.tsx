'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { REGION_LABELS, shiftDayKey, SKIN_STATE_LABELS, systemClock, TRACKED_REGIONS } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  Inline,
  LoadingState,
  NumberField,
  ScaleField,
  Stack,
  Text,
  TextAreaField,
  TextField,
  ToggleField,
} from '@naitikos/design-system';

import { fetchSkinOverview, logSkinDay } from '../services/skinClient';

/**
 * `/body/skin/state` — the daily log.
 *
 * ## The form loads what is already there
 *
 * A day has one row for its whole life, and the operator revises it — logs in
 * the morning, counts lesions properly that evening. So the form is *seeded
 * from the stored day*, and saving edits it: the row is upserted on the day, and
 * the observations supersede rather than accumulate (§9.1). Without that,
 * correcting a 2 to a 4 would leave `mean` aggregation reporting 3, a number
 * the operator never entered and cannot see the source of.
 *
 * ## Three regions, not one score
 *
 * §4.2 tracks face, chest and back separately because "an aggregate score hides
 * a chest flare during a good face week." The overall field is offered too, and
 * it is genuinely a different judgement rather than an average of the three.
 *
 * ## Lesion count is optional and stays optional
 *
 * Counting spots is a two-minute job in front of a mirror, and the day it
 * becomes mandatory is the day the skin log stops being filled in. The state
 * scale is five seconds; the count is for the days there is patience for it.
 */

export function SkinStateScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const fromDayKey = shiftDayKey(dayKey, -6) ?? dayKey;

  const overview = useQuery({
    queryKey: ['skin', 'overview', fromDayKey, dayKey],
    queryFn: () => fetchSkinOverview(fromDayKey, dayKey),
  });

  const today = overview.data?.states.find((state) => state.observedOn === dayKey) ?? null;

  const [overall, setOverall] = useState<number | null>(null);
  const [regionState, setRegionState] = useState<Record<string, number | null>>({});
  const [lesions, setLesions] = useState<Record<string, number | null>>({});
  const [isFlare, setIsFlare] = useState(false);
  const [trigger, setTrigger] = useState('');
  const [note, setNote] = useState('');
  const [seededDay, setSeededDay] = useState<string | null>(null);

  /*
   * Seed from the stored day, once per day key.
   *
   * A render-phase adjustment rather than an effect. React's own guidance, and
   * the `react-hooks/set-state-in-effect` rule: setting state in an effect
   * renders the empty form first and then replaces it, which on a slow phone is
   * a visible flash of a blank form over a day that is already recorded.
   *
   * The `seededDay` guard is what stops a background refetch overwriting
   * whatever the operator has half-typed — it seeds once per day key, not once
   * per response.
   */
  if (!overview.isLoading && seededDay !== dayKey) {
    setSeededDay(dayKey);
    setOverall(today?.overallState ?? null);
    setIsFlare(today?.isFlare ?? false);
    setTrigger(today?.suspectedTrigger ?? '');
    setNote(today?.note ?? '');

    const states: Record<string, number | null> = {};
    const counts: Record<string, number | null> = {};
    for (const region of today?.regions ?? []) {
      states[region.region] = region.state;
      counts[region.region] = region.activeLesionCount;
    }
    setRegionState(states);
    setLesions(counts);
  }

  const save = useMutation({
    mutationFn: async () => {
      await logSkinDay({
        // Reused when the day already exists; the server prefers the stored id.
        id: today?.id ?? uuidV7(systemClock.nowMillis()),
        observedOn: dayKey,
        observedAt: nowIso,
        zone,
        overallState: overall,
        note: note.trim() === '' ? null : note.trim(),
        isFlare,
        suspectedTrigger: trigger.trim() === '' ? null : trigger.trim(),
        regions: TRACKED_REGIONS.map((region) => ({
          id:
            today?.regions.find((candidate) => candidate.region === region)?.id ??
            uuidV7(systemClock.nowMillis()),
          region,
          state: regionState[region] ?? null,
          activeLesionCount: lesions[region] ?? null,
        })),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['skin'] });
    },
  });

  if (overview.isLoading) return <LoadingState label="Loading" />;

  return (
    <Stack gap="5">
      <Stack gap="1">
        <Text role="title-2" as="h2">
          Skin — {dayKey}
        </Text>
        <Text role="caption" tone="tertiary">
          {today === null ? 'Nothing recorded for today yet.' : 'Editing today’s record.'}
        </Text>
      </Stack>

      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            <ScaleField
              label="Overall"
              value={overall}
              onValueChange={setOverall}
              minLabel={SKIN_STATE_LABELS[0]}
              maxLabel={SKIN_STATE_LABELS[4]}
              hint="A judgement across everything, not an average of the regions below."
            />

            {TRACKED_REGIONS.map((region) => (
              <Stack gap="2" key={region}>
                <ScaleField
                  label={REGION_LABELS[region]}
                  value={regionState[region] ?? null}
                  onValueChange={(value) => {
                    setRegionState((current) => ({ ...current, [region]: value }));
                  }}
                  minLabel={SKIN_STATE_LABELS[0]}
                  maxLabel={SKIN_STATE_LABELS[4]}
                />
                <NumberField
                  label={`${REGION_LABELS[region]} — active lesions (optional)`}
                  value={lesions[region] ?? null}
                  onValueChange={(value) => {
                    setLesions((current) => ({ ...current, [region]: value }));
                  }}
                  min={0}
                  max={500}
                  step={1}
                />
              </Stack>
            ))}

            <ToggleField
              label="Flare today"
              checked={isFlare}
              onCheckedChange={setIsFlare}
              description="Your annotation. Nothing here is inferred."
            />

            {isFlare && (
              <TextField
                label="What you suspect"
                value={trigger}
                onChange={(event) => {
                  setTrigger(event.target.value);
                }}
                hint="Suspected, not asserted. The product register shows what changed recently."
              />
            )}

            <TextAreaField
              label="Notes"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              rows={3}
            />

            <Inline justify="between" align="center">
              <Text role="caption" tone="tertiary">
                Saving again edits today rather than adding a second record.
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  save.mutate();
                }}
                disabled={save.isPending}
              >
                Save
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
