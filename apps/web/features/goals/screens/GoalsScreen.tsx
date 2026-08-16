'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import {
  GOAL_COMPARATORS,
  GOAL_STATUS_LABELS,
  MIN_RATE_WINDOW_DAYS,
  PROGRESS_STATUS_LABELS,
  describeTarget,
  explainProgress,
  systemClock,
} from '@naitikos/core';
import type { GoalComparator, GoalProgress } from '@naitikos/core';
import {
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

import type { GoalsOverview } from '@/lib/platform/goals';
import { createGoal, type GoalTargetDraft } from '../services/goalClient';

/**
 * `/life/goals` — §4.10.
 *
 * ## Every number on this page was computed a second ago
 *
 * Nothing here reads a stored progress value, because there is none. §4.10:
 * "Recording progress separately from the underlying observations would create
 * two sources of truth and guarantee drift." The pipeline runs on each request.
 *
 * ## "Not enough data yet" is shown as an answer, not as an error
 *
 * §10.9 requires a projection to "degrade to *'insufficient data'* rather than
 * guessing", and a goal in its first week is exactly that case. It gets the
 * same visual weight as any other status — a greyed-out card with a spinner
 * would imply something is loading, when in fact the honest answer has arrived.
 *
 * ## Tensions are stated at the top, and never resolved
 *
 * §4.10 wants the system to say that a bulk and a visible-abs goal are in
 * tension "rather than let both quietly fail". It says it once, as a fact about
 * two declarations, and does not suggest dropping either. Which of your goals
 * matters more is not something a computer knows (P5).
 */
export function GoalsScreen({ overview }: { readonly overview: GoalsOverview }): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const active = overview.goals.filter((entry) => entry.goal.status === 'active');
  const closed = overview.goals.filter((entry) => entry.goal.status !== 'active');

  return (
    <Stack gap="6">
      {overview.tensions.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Two of these pull against each other
          </Text>
          {overview.tensions.map((tension) => (
            <Card key={tension.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Text role="body" as="span">
                    {tension.claim}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {tension.reason}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
          {/* P5. The system names the tension; it does not arbitrate it. */}
          <Text role="caption" tone="tertiary">
            Stated, not judged. Which of these matters more is yours to decide.
          </Text>
        </Stack>
      )}

      {adding ? (
        <GoalForm
          todayDayKey={overview.todayDayKey}
          onCancel={() => {
            setAdding(false);
          }}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            Set a goal
          </Button>
        </Inline>
      )}

      {overview.goals.length === 0 ? (
        <EmptyState
          icon="domain.streak"
          title="No goals set"
          description="A goal here is a target over numbers you already record — a rate of weight gain, a volume trend. Nothing new gets logged; the progress is derived from what is already there."
        />
      ) : (
        <>
          <Stack gap="2">
            {active.map((entry) => (
              <Card key={entry.goal.id} variant="outlined">
                <CardBody>
                  <Stack gap="3">
                    <Inline justify="between" align="center" wrap>
                      <Link className="nos-inline-link" href={`/life/goals/${entry.goal.id}`}>
                        {entry.goal.title}
                      </Link>
                      {entry.goal.horizonAt !== null && (
                        <Text role="caption" tone="tertiary">
                          by {entry.goal.horizonAt.slice(0, 10)}
                        </Text>
                      )}
                    </Inline>

                    {entry.targets.map((target, index) => {
                      const progress = entry.progress[index];
                      if (progress === undefined) return null;
                      return (
                        <Stack gap="1" key={target.id}>
                          <Inline justify="between" align="center" wrap>
                            <Text role="body-sm" as="span">
                              {target.metricKey} — {describeTarget(target)}
                            </Text>
                            <Badge tone={toneFor(progress)}>{PROGRESS_STATUS_LABELS[progress.status]}</Badge>
                          </Inline>
                          {/* §4.13's standard applied to a status badge: a
                              coloured word with no sentence under it is an
                              unauditable claim. */}
                          <Text role="caption" tone="tertiary">
                            {explainProgress(progress, target)}
                          </Text>
                        </Stack>
                      );
                    })}
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Stack>

          {closed.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                No longer pursued
              </Text>
              {/* §4.10's goal archaeology. Kept visible, because why something
                  stopped mattering is the part worth reading in year three. */}
              {closed.map((entry) => (
                <Card key={entry.goal.id} variant="flat">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Stack gap="1">
                        <Link className="nos-inline-link" href={`/life/goals/${entry.goal.id}`}>
                          {entry.goal.title}
                        </Link>
                        {entry.goal.closingNote !== null && (
                          <Text role="caption" tone="tertiary">
                            {entry.goal.closingNote}
                          </Text>
                        )}
                      </Stack>
                      <Badge tone="neutral">{GOAL_STATUS_LABELS[entry.goal.status]}</Badge>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/life/goals/review">
          Review
        </Link>
      </Text>
    </Stack>
  );
}

/**
 * `insufficient` is `neutral`, not `caution`.
 *
 * "We do not know yet" is not a warning. Colouring it as one would make the
 * first week of every goal look like a problem, which §14.1's no-guilt rule and
 * §13.3's anxiety constraint both rule out.
 */
function toneFor(progress: GoalProgress): 'accent' | 'caution' | 'neutral' {
  switch (progress.status) {
    case 'met':
    case 'on_track':
      return 'accent';
    case 'away':
      return 'caution';
    default:
      return 'neutral';
  }
}

function GoalForm({
  todayDayKey,
  onCancel,
  onSaved,
}: {
  /* Resolved on the server. §11.3 confines wall-clock reads to `core/temporal`,
     and a client reading its own clock would disagree with the server about
     which day a goal started on for anyone whose device clock drifts. */
  readonly todayDayKey: string;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [metricKey, setMetricKey] = useState('body.weight');
  const [comparator, setComparator] = useState<GoalComparator>('rate_of_change');
  const [targetValue, setTargetValue] = useState('');
  const [unit, setUnit] = useState('kg');
  const [windowDays, setWindowDays] = useState(String(28));
  const [horizonDay, setHorizonDay] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const target: GoalTargetDraft = {
        id: uuidV7(systemClock.nowMillis()),
        metricKey: metricKey.trim(),
        comparator,
        targetValue: targetValue.trim(),
        unit: unit.trim(),
        windowDays: comparator === 'rate_of_change' ? Number(windowDays) : null,
      };
      await createGoal({
        id: uuidV7(systemClock.nowMillis()),
        title: title.trim(),
        description: null,
        /* Noon, like every other day-anchored instant here: midnight sits on a
         * boundary a DST rule can push into the previous day. */
        startedAt: `${todayDayKey}T12:00:00.000Z`,
        horizonAt: horizonDay === '' ? null : `${horizonDay}T12:00:00.000Z`,
        targets: [target],
      });
    },
    onSuccess: onSaved,
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that goal.');
    },
  });

  const usable = title.trim() !== '' && /^-?\d+(\.\d+)?$/u.test(targetValue.trim()) && metricKey.trim() !== '';

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="4">
          <Text role="title-3" as="h2">
            Set a goal
          </Text>

          <TextField
            label="What you are aiming at"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            placeholder="Build muscle"
          />

          <TextField
            label="Metric"
            value={metricKey}
            onChange={(event) => {
              setMetricKey(event.target.value);
            }}
            hint="A registered metric key — body.weight, gym.session.volume. Progress is derived from what you already record."
          />

          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              The target
            </Text>
            <Inline gap="2" wrap>
              {GOAL_COMPARATORS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === comparator ? 'primary' : 'secondary'}
                  aria-pressed={option === comparator}
                  onClick={() => {
                    setComparator(option);
                  }}
                >
                  {option === 'at_least' ? 'At least' : option === 'at_most' ? 'At most' : 'Rate per week'}
                </Button>
              ))}
            </Inline>
            <Inline gap="2">
              <TextField
                label="Value"
                value={targetValue}
                inputMode="decimal"
                onChange={(event) => {
                  setTargetValue(event.target.value);
                }}
                placeholder={comparator === 'rate_of_change' ? '0.25' : '80'}
              />
              <TextField
                label="Unit"
                value={unit}
                onChange={(event) => {
                  setUnit(event.target.value);
                }}
              />
            </Inline>
            {comparator === 'rate_of_change' && (
              <TextField
                label="Measured over"
                value={windowDays}
                inputMode="numeric"
                onChange={(event) => {
                  setWindowDays(event.target.value);
                }}
                hint={`Days. At least ${String(MIN_RATE_WINDOW_DAYS)} — a rate fitted over a week of bodyweight is mostly water.`}
              />
            )}
          </Stack>

          <DateField
            label="By when (optional)"
            value={horizonDay}
            onValueChange={setHorizonDay}
            hint="Used only to decide whether the fitted line arrives in time."
          />

          <Inline gap="2" justify="between" align="center">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!usable || save.isPending}
              onClick={() => {
                setProblem(null);
                save.mutate();
              }}
            >
              Set it
            </Button>
          </Inline>

          {problem !== null && (
            <Text role="body-sm" tone="secondary">
              {problem}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
