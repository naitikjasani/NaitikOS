'use client';

import { useState, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  EmptyState,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query/QueryProvider';
import { fetchSessions } from '../services/gymClient';
import { ExercisePicker } from '../components/ExercisePicker';
import { RestTimer } from '../components/RestTimer';
import { SetEditor } from '../components/SetEditor';
import { useLiveSession } from '../hooks/useLiveSession';
import { useRestTimer } from '../hooks/useRestTimer';

/**
 * `/body/gym/log` — the live session logger.
 *
 * §12's exit criterion for this week is the only test that matters here: "a real
 * training session logged in the gym, on a phone, without friction. If the
 * logger is annoying to use under fatigue, week 4 is spent fixing it rather than
 * moving on."
 *
 * Everything below is arranged around that sentence.
 *
 * ## The layout, and why it is in this order
 *
 * From the top: **what has happened** (the set list, scrollable and ignorable),
 * then **what happens next** (the set editor, prefilled), then **the timer**
 * pinned at the bottom. Reversed — timer first, editor last — the primary
 * action ends up above the fold on a phone only until the fourth set, and then
 * it is behind a scroll for the rest of the session.
 *
 * The one-handed constraint from §4.1 is why the log button is full-width at the
 * bottom of the editor rather than a neat right-aligned control: a thumb reaches
 * the bottom edge of a phone and the middle of it, not the top-right corner.
 *
 * ## Nothing here awaits the network
 *
 * Starting a session, logging a set and finishing all resolve as soon as the
 * write is durable in IndexedDB (§5.7). The sync banner in the app shell is the
 * only place that reports on the server, and it is deliberately not on this
 * screen — a status indicator between sets is a distraction from the thing the
 * operator is actually doing.
 */

export type SessionLoggerScreenProps = {
  readonly zone: string;
};

export function SessionLoggerScreen({ zone }: SessionLoggerScreenProps): ReactNode {
  /*
   * The bodyweight comes from the sessions query rather than a server prop.
   *
   * §6.2 keeps `app/` to routing only, and a page that reached into a
   * repository to fetch one number would be the first exception. The logger
   * already makes this request; carrying one more field on it costs nothing.
   */
  const sessions = useQuery({ queryKey: queryKeys.gymSessions(), queryFn: fetchSessions });
  const session = useLiveSession(zone, sessions.data?.bodyweightKg ?? null);
  const timer = useRestTimer();
  const [pickerOpen, setPickerOpen] = useState(false);

  const bodyweightKg = sessions.data?.bodyweightKg ?? null;

  if (session.sessionId === null) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="nav.body"
          title="No session in progress"
          description={
            bodyweightKg === null
              ? 'Start when you are at the gym. No bodyweight is recorded, so bodyweight movements will not count towards volume until one is.'
              : `Start when you are at the gym. Bodyweight ${bodyweightKg} kg will be recorded against this session.`
          }
        />
        <Button
          variant="primary"
          size="lg"
          fullWidth
          iconStart="action.add"
          isLoading={session.isQueueing}
          onClick={() => {
            void session.start();
          }}
        >
          Start a session
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap="4">
      {/* --- What has happened ------------------------------------------ */}
      <Card variant="flat">
        <CardHeader
          title="This session"
          description={`${String(session.sets.length)} ${session.sets.length === 1 ? 'set' : 'sets'} logged`}
        />
        <CardBody>
          {session.sets.length === 0 ? (
            <Text role="body-sm" tone="tertiary">
              Nothing yet. Pick a movement below.
            </Text>
          ) : (
            <Stack gap="1">
              {session.sets.map((set) => (
                <Inline key={set.id} justify="between" align="center">
                  <Text role="body-sm" as="span">
                    {set.exerciseName}
                    {set.side === null ? '' : ` (${set.side})`}
                  </Text>
                  <Text role="mono" as="span">
                    {set.load ?? '—'} {set.loadUnit} × {set.reps ?? '—'}
                    {set.rpe === null ? '' : ` @ ${String(set.rpe)}`}
                  </Text>
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      {/* --- What happens next ------------------------------------------ */}
      {session.currentExercise === null ? (
        <Button
          variant="primary"
          size="lg"
          fullWidth
          iconStart="action.search"
          onClick={() => {
            setPickerOpen(true);
          }}
        >
          Add an exercise
        </Button>
      ) : (
        <Stack gap="3">
          <SetEditor
            exercise={session.currentExercise}
            prefill={session.prefill}
            setNumber={session.nextSetNumber}
            isQueueing={session.isQueueing}
            bodyweightKnown={session.bodyweightKg !== null}
            onLog={(draft) => {
              void session.logSet(draft).then(() => {
                // Rest starts when the set ends, not when the operator
                // remembers to press something.
                timer.start();
              });
            }}
          />

          <Button
            variant="ghost"
            fullWidth
            iconStart="action.search"
            onClick={() => {
              setPickerOpen(true);
            }}
          >
            Change exercise
          </Button>
        </Stack>
      )}

      <Divider />

      {/* --- The timer, last, because it is read at arm's length -------- */}
      <RestTimer timer={timer} />

      <Divider />

      <Inline justify="between" align="center">
        <Stack gap="1">
          <Text role="caption" tone="tertiary">
            Started
          </Text>
          <Text role="body-sm" as="span">
            {session.startedAt?.slice(11, 16) ?? '—'}
          </Text>
        </Stack>

        {session.bodyweightKg === null ? (
          <Badge tone="caution" icon="status.warning">
            No bodyweight
          </Badge>
        ) : (
          <Badge tone="neutral">{session.bodyweightKg} kg</Badge>
        )}

        <Button
          variant="secondary"
          isLoading={session.isQueueing}
          onClick={() => {
            timer.stop();
            void session.finish();
          }}
        >
          Finish
        </Button>
      </Inline>

      <ExercisePicker
        open={pickerOpen}
        exercises={session.exercises}
        recent={session.recentExercises}
        onSelect={(exercise) => {
          session.selectExercise(exercise);
          setPickerOpen(false);
        }}
        onClose={() => {
          setPickerOpen(false);
        }}
      />
    </Stack>
  );
}
