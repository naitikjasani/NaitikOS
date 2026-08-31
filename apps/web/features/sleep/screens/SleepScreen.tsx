'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  MIN_CONSISTENCY_NIGHTS,
  SLEEP_DISTURBANCES,
  SLEEP_DISTURBANCE_LABELS,
  describeNight,
  shiftDayKey,
  systemClock,
} from '@naitikos/core';
import type { SleepDisturbance } from '@naitikos/core';
import {
  AdherenceGrid,
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextField,
} from '@naitikos/design-system';

import type { SleepBoard } from '@/lib/platform/sleep';
import { recordNight } from '../services/sleepClient';

/**
 * `/body/sleep` — §4.6.
 *
 * ## Why this page exists at all, given two observations already did
 *
 * `body.sleep.duration` and `body.sleep.quality` have been in the Daily Close
 * since week one, and every chart in the system already reads them. What they
 * cannot show is what §4.6 asks for beyond them: **timing and consistency.**
 * Those are properties of the *relationship between nights*, not of any one
 * night, and no per-metric series can express them.
 *
 * ## The consistency figure wraps around midnight, and that is the whole trick
 *
 * A sleep midpoint of 03:00 and one of 23:00 are two hours apart, not twenty.
 * An arithmetic spread over clock minutes does not know that, and it reports a
 * rock-steady sleeper as chaotic the moment their midpoint crosses midnight —
 * which for most people it does most nights. `consistencyOver` computes the
 * circular standard deviation instead. This page is where that would have been
 * visible as nonsense, so it is worth naming here as well as there.
 *
 * ## Three figures, never one
 *
 * Consistency, debt and duration stay separate. Every wearable computes a
 * single sleep score, no two agree, and the weights are a product decision
 * rather than a finding — §10.0 keeps this system out of asserting a number it
 * could not defend.
 *
 * ## The page says nothing about why
 *
 * §4.7 forbids "your mood is low because you skipped the gym", and the
 * prohibition runs in every direction. A short night sits next to a bad day and
 * the system draws no arrow between them. §10.6's five controls govern anything
 * stronger than adjacency, and none of them is satisfied by two rows on a
 * screen.
 */
export function SleepScreen({
  board,
  zone,
}: {
  readonly board: SleepBoard;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();

  return (
    <Stack gap="6">
      <LogNight
        board={board}
        zone={zone}
        onSaved={() => {
          router.refresh();
        }}
      />

      <AdherenceGrid
        title={`Sleep duration — last ${String(board.windowDays)} nights`}
        description="Day-keyed to the morning each night ended, so it lines up with mood, training and skin."
        fromDayKey={board.series[0]?.dayKey ?? board.todayDayKey}
        toDayKey={board.todayDayKey}
        data={{
          series: [
            {
              id: 'duration',
              label: 'Hours slept',
              slot: 1,
              unit: 'h',
              points: board.series.map((day) => ({
                at: day.dayKey,
                /* A morning with no record is absent, not zero. §8.9 — and a
                 * night the operator did not log is not a night they did not
                 * sleep. */
                value: day.durationHours,
              })),
            },
          ],
          yAxis: { zeroBaseline: true, unit: 'h' },
        }}
      />

      <Consistency board={board} />
      <Debt board={board} />

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Recent nights
        </Text>
        {board.nights.length === 0 ? (
          <EmptyState
            title="No nights recorded"
            description="Duration and quality also arrive through the Daily Close. This page is for the timing the ritual does not ask for."
          />
        ) : (
          board.nights.map((night) => (
            <Card key={night.id} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {night.dayKey}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {describeNight(night)}
                    </Text>
                    {night.disturbanceNote !== null && (
                      <Text role="caption" tone="tertiary">
                        {night.disturbanceNote}
                      </Text>
                    )}
                  </Stack>
                  {night.disturbance !== null && (
                    <Badge tone="caution">{SLEEP_DISTURBANCE_LABELS[night.disturbance]}</Badge>
                  )}
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>
    </Stack>
  );
}

function Consistency({ board }: { readonly board: SleepBoard }): ReactNode {
  const report = board.consistency;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Consistency
          </Text>

          {report.insufficient ? (
            /*
             * Shown as an answer, not as an error or a spinner. §10.9 asks a
             * projection to "degrade to insufficient data rather than
             * guessing", and a fortnight of patchy logging is exactly that
             * case — the honest answer has arrived.
             */
            <Text role="body" tone="secondary">
              {String(report.nights)} of {String(MIN_CONSISTENCY_NIGHTS)} nights needed. Not enough to say
              anything about consistency yet.
            </Text>
          ) : (
            <Inline gap="4" wrap>
              <Figure
                label="Midpoint spread"
                value={
                  report.midpointSpreadMinutes === null
                    ? null
                    : `± ${String(Math.round(report.midpointSpreadMinutes))} min`
                }
                hint="How much the middle of the night moves. Measured around the clock, so 03:00 and 23:00 are two hours apart."
              />
              <Figure
                label="Mean duration"
                value={report.meanDurationHours === null ? null : `${report.meanDurationHours.toFixed(1)} h`}
              />
              <Figure
                label="Duration spread"
                value={
                  report.durationSpreadHours === null ? null : `± ${report.durationSpreadHours.toFixed(1)} h`
                }
              />
              <Figure label="Nights recorded" value={String(report.nights)} />
            </Inline>
          )}

          {report.longestGapNights > 0 && (
            <Text role="caption" tone="tertiary">
              Longest run with nothing recorded: {String(report.longestGapNights)}{' '}
              {report.longestGapNights === 1 ? 'night' : 'nights'}. Stated because a gap changes what every
              figure above is an average of.
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function Debt({ board }: { readonly board: SleepBoard }): ReactNode {
  const debt = board.debt;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Against {String(board.targetHours)} hours
          </Text>

          {debt.nightsCounted === 0 ? (
            <Text role="body" tone="secondary">
              No durations recorded in this window.
            </Text>
          ) : (
            <>
              <Inline gap="4" wrap>
                <Figure label="Slept" value={`${debt.actualHours.toFixed(1)} h`} />
                <Figure label="Target for those nights" value={`${debt.expectedHours.toFixed(1)} h`} />
                <Figure
                  label={debt.deficitHours >= 0 ? 'Short by' : 'Over by'}
                  value={`${Math.abs(debt.deficitHours).toFixed(1)} h`}
                />
              </Inline>
              {/*
                The denominator is stated, because it is the part that would
                otherwise mislead. Debt is counted only over nights that were
                recorded — charging the operator for nights they simply did not
                log would turn a gap in the record into a claim about their week.
              */}
              <Text role="caption" tone="tertiary">
                Over {String(debt.nightsCounted)} recorded{' '}
                {debt.nightsCounted === 1 ? 'night' : 'nights'}
                {debt.nightsMissing > 0
                  ? `. ${String(debt.nightsMissing)} ${debt.nightsMissing === 1 ? 'night' : 'nights'} in this window have no duration, and are not counted either way.`
                  : '.'}
              </Text>
              <Text role="caption" tone="tertiary">
                {String(board.targetHours)} hours is a setting, not a finding. This system has no basis for
                asserting how much sleep you personally need.
              </Text>
            </>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly hint?: string;
}): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {/* Never a dash and never a zero. The absence is spelled out. */}
        {value ?? 'not enough yet'}
      </Text>
      {hint !== undefined && (
        <Text role="caption" tone="tertiary">
          {hint}
        </Text>
      )}
    </Stack>
  );
}

const QUALITIES = [1, 2, 3, 4, 5] as const;

function LogNight({
  board,
  zone,
  onSaved,
}: {
  readonly board: SleepBoard;
  readonly zone: string;
  readonly onSaved: () => void;
}): ReactNode {
  const [dayKey, setDayKey] = useState(board.todayDayKey);
  const [duration, setDuration] = useState('');
  const [quality, setQuality] = useState<number | null>(null);
  const [bedTime, setBedTime] = useState('');
  const [wakeTime, setWakeTime] = useState('');
  const [latency, setLatency] = useState('');
  const [wakings, setWakings] = useState('');
  const [disturbance, setDisturbance] = useState<SleepDisturbance | null>(null);
  const [disturbanceNote, setDisturbanceNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await recordNight({
        id: uuidV7(systemClock.nowMillis()),
        dayKey,
        zone,
        /*
         * Bedtime belongs to the *previous* calendar day whenever it is in the
         * evening, because the row is keyed by the morning the night ended.
         * Sending both as though they fell on the same date would place lights-out
         * after waking, which the `sleep_night_ordered` CHECK rejects — correctly,
         * and confusingly if the client had not thought about it first.
         */
        bedAt: bedTime === '' ? null : instantFor(shiftDayKey(dayKey, -1) ?? dayKey, bedTime),
        wokeAt: wakeTime === '' ? null : instantFor(dayKey, wakeTime),
        durationHours: duration.trim() === '' ? null : duration.trim(),
        quality,
        latencyMinutes: latency.trim() === '' ? null : Number(latency.trim()),
        wakings: wakings.trim() === '' ? null : Number(wakings.trim()),
        disturbance,
        disturbanceNote: disturbanceNote.trim() === '' ? null : disturbanceNote.trim(),
        note: null,
      });
    },
    onSuccess: () => {
      setDuration('');
      setQuality(null);
      setBedTime('');
      setWakeTime('');
      setLatency('');
      setWakings('');
      setDisturbance(null);
      setDisturbanceNote('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that night.');
    },
  });

  const usable = duration.trim() !== '' || (bedTime !== '' && wakeTime !== '');

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Log a night
          </Text>

          <DateField
            label="Morning it ended"
            hint="A night is filed under the day it produced, not the evening it began."
            value={dayKey}
            onValueChange={setDayKey}
            max={board.todayDayKey}
          />

          <Inline gap="3" wrap>
            <TextField
              label="Hours slept"
              inputMode="decimal"
              placeholder="7.5"
              value={duration}
              onChange={(event) => {
                setDuration(event.target.value);
              }}
            />
            <TextField
              label="Minutes to fall asleep"
              inputMode="numeric"
              value={latency}
              onChange={(event) => {
                setLatency(event.target.value);
              }}
            />
            <TextField
              label="Times woken"
              inputMode="numeric"
              value={wakings}
              onChange={(event) => {
                setWakings(event.target.value);
              }}
            />
          </Inline>

          {/*
            Native time inputs, for the same reason `DateField` wraps the native
            date control: the platform picker is keyboard accessible, localised
            for free, works with every screen reader, and on a phone opens the
            wheel the operator already knows. A hand-built clock is one of the
            larger accessibility liabilities a design system can take on.
          */}
          <Inline gap="3" wrap>
            <Stack gap="1">
              <Text role="caption" tone="tertiary" as="label" id="sleep-bed-label">
                Lights out
              </Text>
              <input
                type="time"
                className="nos-input"
                aria-labelledby="sleep-bed-label"
                value={bedTime}
                onChange={(event) => {
                  setBedTime(event.target.value);
                }}
              />
            </Stack>
            <Stack gap="1">
              <Text role="caption" tone="tertiary" as="label" id="sleep-wake-label">
                Out of bed
              </Text>
              <input
                type="time"
                className="nos-input"
                aria-labelledby="sleep-wake-label"
                value={wakeTime}
                onChange={(event) => {
                  setWakeTime(event.target.value);
                }}
              />
            </Stack>
          </Inline>
          <Text role="caption" tone="tertiary">
            Timing is optional. Duration and quality already arrive through the Daily Close; these two are
            what make consistency computable.
          </Text>

          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              Quality
            </Text>
            <Inline gap="2" wrap>
              {QUALITIES.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === quality ? 'primary' : 'secondary'}
                  aria-pressed={value === quality}
                  onClick={() => {
                    setQuality(value === quality ? null : value);
                  }}
                >
                  {String(value)}
                </Button>
              ))}
            </Inline>
          </Stack>

          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              Disturbed by
            </Text>
            <Inline gap="2" wrap>
              {SLEEP_DISTURBANCES.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === disturbance ? 'primary' : 'secondary'}
                  aria-pressed={option === disturbance}
                  onClick={() => {
                    setDisturbance(option === disturbance ? null : option);
                  }}
                >
                  {SLEEP_DISTURBANCE_LABELS[option]}
                </Button>
              ))}
            </Inline>
          </Stack>

          {disturbance !== null && (
            <TextField
              label="What happened"
              value={disturbanceNote}
              onChange={(event) => {
                setDisturbanceNote(event.target.value);
              }}
            />
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={!usable || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
            <Text role="caption" tone="tertiary">
              Recording the same morning twice corrects it rather than adding a second night.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * A `YYYY-MM-DD` and an `HH:MM` as an instant.
 *
 * Sent as UTC rather than resolved against the zone here. The browser cannot
 * construct an instant in an arbitrary IANA zone without a library, and §11.3
 * puts zone interpretation in `core/temporal` rather than in a form — so the
 * pair travels as written and the zone travels beside it.
 */
function instantFor(dayKey: string, time: string): string {
  return `${dayKey}T${time.length === 5 ? `${time}:00` : time}.000Z`;
}
