'use client';

import { useState, type ReactNode } from 'react';
import { isIanaZone, parseInstant } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
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
 * From the top: **where I am** (a fixed-height status strip), then **what
 * happens next** (the set editor, prefilled), then **what has happened** (the
 * set list, collapsed), then Finish. The rest timer is pinned to the bottom
 * edge of the viewport and is outside that flow entirely.
 *
 * The order used to be history-then-editor, on the reasoning that a session
 * reads chronologically. It does — but the history *grows* and the editor does
 * not, so by the eighth set the primary control of the application was two
 * scrolls below the fold, and it got further away with every set logged. That
 * is the opposite of what §8.13 asks for. Two changes fix it and keep the
 * chronology: the editor is first, and the list shows the last few sets with the
 * rest behind a disclosure. Progress is carried by the status strip and by the
 * per-movement line on the editor itself, both of which are fixed-height.
 *
 * ## Why the rest timer is sticky
 *
 * It is needed at exactly the moment it would otherwise be off screen. The
 * operator finishes a set, the timer starts, and they then scroll — to check
 * what they lifted last week, to change movement, to read the list — and the
 * clock they are scrolling *because of* leaves the viewport. Pinning it costs
 * one row and means the answer to "how long have I got" never requires a
 * scroll, one-handed or otherwise (§8.12: "bottom sheets are reachable
 * one-handed, which matters when logging a set with a phone in one hand" — the
 * same geometry applies to a bar).
 *
 * It sits above the shell's bottom navigation rather than under it, using the
 * `--app-bottom-nav-height` variable the shell publishes, and clears the home
 * indicator with `safe-area-inset-bottom`.
 *
 * ## Density is pinned to comfortable here
 *
 * §8.4 lets the operator choose a compact density, which drops
 * `--layout-control-height` from 2.75rem to 2.5rem — 40px. That is under
 * §8.13's "≥ 44×44px … Non-negotiable for gym use", and the whole point of the
 * preference is that it applies to dense reading surfaces like labs and
 * transactions. This is not one. The setting is honoured everywhere except the
 * one screen where it would shrink a target below the floor.
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

/**
 * How many recent sets the history card shows before the disclosure.
 *
 * Four: enough to see the movement just finished and the one before it, few
 * enough that the card's height is a constant the editor's position can be
 * reasoned about from.
 */
const VISIBLE_SETS = 4;

/**
 * The session's start time, in the operator's own clock.
 *
 * `startedAt` is a UTC instant, and it used to be rendered by slicing characters
 * 11 to 16 out of the ISO string. That reads the *UTC* wall clock: a session
 * begun at 06:14 in Asia/Kolkata displayed as `00:44`, which is not a rounding
 * error but a different number entirely, on the one line of the screen whose
 * whole job is to tell the operator when they started.
 *
 * The zone is the profile's rather than the browser's, matching how every day
 * key in the system is computed (§6.3); an unrecognised one falls back to the
 * device, which is wrong by at most the same amount and never throws.
 */
function startedAtLabel(iso: string | null, zone: string): string {
  if (iso === null) return '—';
  const instant = parseInstant(iso);
  if (instant === null) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(isIanaZone(zone) ? { timeZone: zone } : {}),
  }).format(instant);
}

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
  const [showAllSets, setShowAllSets] = useState(false);

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

  const movementCount = new Set(session.sets.map((set) => set.exerciseId)).size;
  const shownSets = showAllSets ? session.sets : session.sets.slice(-VISIBLE_SETS);
  const hiddenCount = session.sets.length - shownSets.length;

  return (
    <div data-density="comfortable">
      <Stack gap="4">
        {/* --- Where I am. Fixed height, whatever the session does. -------- */}
        <Card variant="flat">
          <CardBody>
            <Inline justify="between" align="center" gap="3">
              <Stack gap="1">
                <Text role="caption" tone="tertiary">
                  Sets
                </Text>
                <Text role="title-3" as="p">
                  {session.sets.length}
                </Text>
              </Stack>
              <Stack gap="1">
                <Text role="caption" tone="tertiary">
                  Movements
                </Text>
                <Text role="title-3" as="p">
                  {movementCount}
                </Text>
              </Stack>
              <Stack gap="1">
                <Text role="caption" tone="tertiary">
                  Started
                </Text>
                <Text role="title-3" as="p">
                  {startedAtLabel(session.startedAt, zone)}
                </Text>
              </Stack>
              {session.bodyweightKg === null ? (
                <Badge tone="caution" icon="status.warning">
                  No bodyweight
                </Badge>
              ) : (
                <Badge tone="neutral">{session.bodyweightKg} kg</Badge>
              )}
            </Inline>
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
              loggedSets={session.currentExerciseSets}
              onLog={(draft) => {
                void session.logSet(draft).then(() => {
                  // Rest starts when the set ends, not when the operator
                  // remembers to press something.
                  timer.start();
                });
              }}
            />

            <Button
              variant="secondary"
              size="lg"
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

        {/* --- What has happened ------------------------------------------ */}
        <Card variant="flat">
          <CardHeader
            title="This session"
            description={`${String(session.sets.length)} ${session.sets.length === 1 ? 'set' : 'sets'} logged`}
          />
          <CardBody>
            {session.sets.length === 0 ? (
              <Text role="body-sm" tone="tertiary">
                Nothing yet. Pick a movement above.
              </Text>
            ) : (
              <Stack gap="2">
                {shownSets.map((set) => (
                  <Inline key={set.id} justify="between" align="center" gap="3">
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

                {(hiddenCount > 0 || showAllSets) && (
                  <Button
                    variant="ghost"
                    size="lg"
                    fullWidth
                    aria-expanded={showAllSets}
                    onClick={() => {
                      setShowAllSets((current) => !current);
                    }}
                  >
                    {showAllSets ? 'Show recent only' : `Show ${String(hiddenCount)} earlier`}
                  </Button>
                )}
              </Stack>
            )}
          </CardBody>
        </Card>

        {/*
          Finish is last and deliberately not in the pinned bar. It happens once
          per session and it ends the session; a control that ends the thing you
          are doing does not belong under the thumb that is tapping "log set"
          forty times. §8.12's soft-delete-and-undo reasoning does not rescue
          this one — closing a session is not a deletion, so there is nothing to
          undo — which makes distance the only protection available.
        */}
        <Button
          variant="secondary"
          size="lg"
          fullWidth
          iconStart="action.confirm"
          isLoading={session.isQueueing}
          onClick={() => {
            timer.stop();
            void session.finish();
          }}
        >
          Finish session
        </Button>

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

        {/*
          The clock, pinned. See the header.

          It must be the **last** child of the scrolling column. `position:
          sticky` with a `bottom` offset pulls an element up into the viewport
          while its flow position is still below the fold, and releases it into
          place at the end of the document — which is the behaviour wanted here
          and is why the picker's portal is mounted above it rather than after
          it. Anything rendered below would put the bar back under the fold for
          as long as that thing was on screen.
        */}
        <div
          style={{
            position: 'sticky',
            bottom: 'calc(var(--app-bottom-nav-height, 0px) + env(safe-area-inset-bottom))',
            zIndex: 'var(--z-index-sticky)',
          }}
        >
          <Card variant="raised">
            <CardBody>
              <RestTimer timer={timer} />
            </CardBody>
          </Card>
        </div>
      </Stack>
    </div>
  );
}
