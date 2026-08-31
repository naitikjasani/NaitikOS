'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { MIN_FOCUS_MINUTES, isoFromMillis, minutesBetween, systemClock } from '@naitikos/core';
import type { FocusSession } from '@naitikos/core';
import {
  AdherenceGrid,
  BarChart,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextField,
  type BarDatum,
} from '@naitikos/design-system';

import type { FocusBoard } from '@/lib/platform/learning';
import { endFocus, startFocus } from '../services/learningClient';

/** The Daily Close scale, reused so a 4 means the same thing in both places. */
const QUALITY_SCALE = [1, 2, 3, 4, 5] as const;

/**
 * `/work/focus` — §4.8's "deep-work sessions and energy mapping across the
 * day".
 *
 * ## Interruptions are typed in, never detected
 *
 * A system that counted interruptions would have to watch what the operator was
 * doing — window focus, keystroke gaps, notification delivery. That is a
 * surveillance apparatus, and building one inside a system whose first
 * principle is that the record belongs to its subject would be a category
 * error. The number is entered afterwards, by the person who was there, and
 * left blank when they would rather not say.
 *
 * ## Fifteen minutes, enforced in `core`
 *
 * A session shorter than `MIN_FOCUS_MINUTES` is refused by `validateFocusSession`
 * rather than by this screen. Below that the setup cost dominates and a list
 * littered with four-minute "sessions" makes the total meaningless — which
 * matters because the total is the figure laid next to sleep and mood. The
 * screen warns before the button is pressed; the refusal itself is not its job.
 *
 * ## A session belongs to the hour it started in
 *
 * `focusByHour` attributes the whole session to its starting hour rather than
 * smearing it across the hours it spans. The question the chart answers is
 * "when do I start doing real work", and a three-hour block spread over three
 * bars would make one good morning look like a flat day.
 *
 * ## Recorded, not peak
 *
 * Every heading here says "recorded". These are the hours the operator logged
 * the most deep work in, which is a much weaker statement than "your peak
 * hours" — a morning that was not logged is not a morning nothing happened, and
 * the difference matters to anyone tempted to rearrange their life around this
 * chart.
 */
export function FocusScreen({ board, zone }: { readonly board: FocusBoard; readonly zone: string }): ReactNode {
  const router = useRouter();

  const refresh = (): void => {
    router.refresh();
  };

  const open = board.sessions.find((session) => session.endedAt === null) ?? null;

  const bars: readonly BarDatum[] = board.byHour
    .filter((band) => band.minutes > 0)
    .map((band) => ({
      id: `hour-${String(band.hour)}`,
      label: formatHour(band.hour),
      value: band.minutes,
      slot: 1,
      detail: `${String(band.sessions)} ${band.sessions === 1 ? 'session' : 'sessions'}`,
    }));

  return (
    <Stack gap="6">
      {open === null ? (
        <StartSession board={board} zone={zone} onStarted={refresh} />
      ) : (
        <OpenSession session={open} onEnded={refresh} />
      )}

      <Inline gap="6" wrap>
        <Figure label="Recorded deep work" value={formatMinutes(board.totalMinutes)} />
        <Figure label="Sessions" value={String(board.sessions.length)} />
      </Inline>

      {bars.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          description="Start a session above. The chart is built from what was logged, so it stays empty rather than guessing."
        />
      ) : (
        <BarChart
          title="Recorded deep work by hour of day"
          description="A session counts wholly against the hour it started in, not spread across the hours it ran."
          data={bars}
          unit="minutes"
        />
      )}

      {board.busiest.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            The hours with the most recorded deep work
          </Text>
          <Inline gap="4" wrap>
            {board.busiest.map((band) => (
              <Figure
                key={band.hour}
                label={formatHour(band.hour)}
                value={formatMinutes(band.minutes)}
              />
            ))}
          </Inline>
          {/* The distinction the whole page turns on. */}
          <Text role="caption" tone="tertiary">
            Recorded, not peak. These are the hours you logged the most deep work in — a morning that
            was not logged is not a morning nothing happened.
          </Text>
        </Stack>
      )}

      <AdherenceGrid
        title={`Recorded deep work — last ${String(board.days.length)} days`}
        description="The same window and the same day convention as the meeting-load strip, so the two can be read against each other."
        fromDayKey={board.days[0]?.dayKey ?? board.todayDayKey}
        toDayKey={board.todayDayKey}
        data={{
          series: [
            {
              id: 'focus-minutes',
              label: 'Focus minutes',
              slot: 1,
              unit: 'minutes',
              points: board.days.map((day) => ({
                at: day.dayKey,
                /* A day with no session logged is missing, not zero. These are
                 * hand-entered, and a confident row of zeroes would state that
                 * no deep work happened — §8.9(3). */
                value: day.focusSessions === 0 ? null : day.focusMinutes,
              })),
            },
          ],
          yAxis: { zeroBaseline: true, unit: 'minutes' },
        }}
      />
    </Stack>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
    </Stack>
  );
}

/* ======================================================================
 * Running
 * ====================================================================== */

function OpenSession({
  session,
  onEnded,
}: {
  readonly session: FocusSession;
  readonly onEnded: () => void;
}): ReactNode {
  /*
   * `null` until mounted. The elapsed figure depends on the wall clock, and
   * rendering one on the server would guarantee a hydration mismatch against
   * the browser's.
   */
  const [nowMillis, setNowMillis] = useState<number | null>(null);
  const [quality, setQuality] = useState<number | null>(null);
  const [interruptions, setInterruptions] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const tick = (): void => {
      setNowMillis(systemClock.nowMillis());
    };
    tick();
    /* Thirty seconds. The figure is read in minutes, and a per-second interval
     * would re-render the page sixty times for each number that changes. */
    const handle = window.setInterval(tick, 30_000);
    return () => {
      window.clearInterval(handle);
    };
  }, []);

  const elapsed = nowMillis === null ? null : minutesBetween(session.startedAt, isoFromMillis(nowMillis));

  const stop = useMutation({
    mutationFn: async () => {
      await endFocus({
        id: session.id,
        quality,
        interruptions: parseCount(interruptions),
      });
    },
    onSuccess: () => {
      setQuality(null);
      setInterruptions('');
      setProblem(null);
      onEnded();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not end that session.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              Running{session.label === null ? '' : ` · ${session.label}`}
            </Text>
            <Text role="metric-l" as="span">
              {elapsed === null ? '—' : formatMinutes(elapsed)}
            </Text>
          </Stack>

          {elapsed !== null && elapsed < MIN_FOCUS_MINUTES && (
            /* Warned here, refused in `core`. The rule is a domain rule and
               this screen only repeats it early enough to be useful. */
            <Text role="caption" tone="tertiary">
              Under {String(MIN_FOCUS_MINUTES)} minutes. A session shorter than that is not recorded as
              deep work — below it the setup cost is most of the session.
            </Text>
          )}

          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              How did it go?
            </Text>
            <Inline gap="2" wrap>
              {QUALITY_SCALE.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === quality ? 'primary' : 'secondary'}
                  aria-pressed={value === quality}
                  onClick={() => {
                    /* Clicking the selected value clears it. Blank is a real
                     * answer and there has to be a way back to it. */
                    setQuality(value === quality ? null : value);
                  }}
                >
                  {String(value)}
                </Button>
              ))}
            </Inline>
            <Text role="caption" tone="tertiary">
              1–5, the same scale as the Daily Close. Optional.
            </Text>
          </Stack>

          <TextField
            label="Interruptions"
            hint="Typed in, never detected. Counting them would mean watching what you are doing."
            inputMode="numeric"
            value={interruptions}
            onChange={(event) => {
              setInterruptions(event.target.value);
            }}
          />

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={stop.isPending}
              onClick={() => {
                stop.mutate();
              }}
            >
              Stop
            </Button>
            <Text role="caption" tone="tertiary">
              Needs a connection — a stop is a state change, not a queued observation.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ======================================================================
 * Starting
 * ====================================================================== */

function StartSession({
  board,
  zone,
  onStarted,
}: {
  readonly board: FocusBoard;
  readonly zone: string;
  readonly onStarted: () => void;
}): ReactNode {
  const [label, setLabel] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: async () => {
      await startFocus({
        id: uuidV7(systemClock.nowMillis()),
        /*
         * The instant, and the zone it was recorded in. The day key is derived
         * server-side from the pair — a client that sent both separately could
         * send them disagreeing, and a session pointing at two different days
         * is invisible to the per-day joins this pillar exists for.
         */
        startedAt: isoFromMillis(systemClock.nowMillis()),
        zone,
        projectId,
        taskId: null,
        label: label.trim() === '' ? null : label.trim(),
      });
    },
    onSuccess: () => {
      setLabel('');
      setProblem(null);
      onStarted();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not start a session.');
    },
  });

  const active = board.projects.filter((project) => project.status === 'active');

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="What are you working on?"
            /* Optional, and the button does not wait for it. A field that has
             * to be filled in before a timer starts is a field that stops the
             * timer being started. */
            hint="Optional."
            value={label}
            placeholder="The outbox replay path"
            onChange={(event) => {
              setLabel(event.target.value);
            }}
          />

          {active.length > 0 && (
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Project
              </Text>
              <Inline gap="2" wrap>
                {active.map((project) => (
                  <Button
                    key={project.id}
                    size="sm"
                    variant={project.id === projectId ? 'primary' : 'secondary'}
                    aria-pressed={project.id === projectId}
                    onClick={() => {
                      setProjectId(project.id === projectId ? null : project.id);
                    }}
                  >
                    {project.name}
                  </Button>
                ))}
              </Inline>
            </Stack>
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={start.isPending}
              onClick={() => {
                start.mutate();
              }}
            >
              Start
            </Button>
            <Text role="caption" tone="tertiary">
              Needs a connection — a session is a row that gets closed later, not an append.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${String(minutes)}m`;
  if (minutes === 0) return `${String(hours)}h`;
  return `${String(hours)}h ${String(minutes)}m`;
}

/** A whole number, or `null` — never `NaN` and never a guessed zero. */
function parseCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
