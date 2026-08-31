'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { TASK_BUCKET_LABELS, TASK_STATUS_LABELS, systemClock } from '@naitikos/core';
import type { Task, TaskBucketKey } from '@naitikos/core';
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

import type { TaskBoard } from '@/lib/platform/work';
import { closeTask, createTask, reopenTask } from '../services/workClient';

/**
 * `/work/tasks` — §4.8.
 *
 * ## The add form is one field
 *
 * §4.8: "deliberately minimal. Not a competitor to a dedicated task manager."
 * A title, and optionally a date and a project. There is no priority selector
 * and no estimate, because a field that exists gets filled in and every second
 * spent filling one in is a second §1.4's capture-friction metric counts
 * against this whole system.
 *
 * ## Dropping asks why; finishing does not
 *
 * A completed task explains itself. A dropped one does not, and in year three
 * a dropped task with no reason is indistinguishable from one that was
 * forgotten. The reason field appears only on the drop path, which is the one
 * place it earns its keystrokes.
 *
 * ## Nothing here is optimistic
 *
 * Closing a task is a state transition, not an append, and the offline outbox
 * replays in queue order rather than causal order — a close replayed after a
 * reopen would leave the row in the wrong state with nothing to detect it. So
 * these writes are online-only and the button waits for the server.
 */
export function TaskBoardScreen({ board, zone }: { readonly board: TaskBoard; readonly zone: string }): ReactNode {
  const router = useRouter();
  const [dropping, setDropping] = useState<string | null>(null);
  const [dropReason, setDropReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const close = useMutation({
    mutationFn: async (input: { id: string; status: 'done' | 'dropped'; reason: string | null }) => {
      await closeTask({ id: input.id, status: input.status, zone, droppedReason: input.reason });
    },
    onSuccess: () => {
      setDropping(null);
      setDropReason('');
      setProblem(null);
      refresh();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not close that task.');
    },
  });

  const reopen = useMutation({
    mutationFn: async (id: string) => {
      await reopenTask(id);
    },
    onSuccess: refresh,
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not reopen that task.');
    },
  });

  const bucketKeys: readonly TaskBucketKey[] = ['overdue', 'today', 'soon', 'undated'];
  const empty = bucketKeys.every((key) => board.buckets[key].length === 0);

  return (
    <Stack gap="6">
      <AddTask board={board} onSaved={refresh} />

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {empty ? (
        <EmptyState
          title="Nothing open"
          description="This list exists for linkage — a task attached to a goal, a project, or a health action."
        />
      ) : (
        bucketKeys.map((key) =>
          board.buckets[key].length === 0 ? null : (
            <Stack key={key} gap="2">
              <Text role="title-3" as="h2">
                {TASK_BUCKET_LABELS[key]}
              </Text>
              {board.buckets[key].map((task) => (
                <Card key={task.id} variant="outlined">
                  <CardBody>
                    <Stack gap="2">
                      <Inline gap="3" align="center" justify="between">
                        <Stack gap="1">
                          <Text role="body" as="span">
                            {task.title}
                          </Text>
                          <Text role="caption" tone="tertiary">
                            {describeContext(task, board)}
                          </Text>
                        </Stack>
                        <Inline gap="2">
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={close.isPending}
                            onClick={() => {
                              close.mutate({ id: task.id, status: 'done', reason: null });
                            }}
                          >
                            Done
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              setDropping(dropping === task.id ? null : task.id);
                              setDropReason('');
                            }}
                          >
                            Drop
                          </Button>
                        </Inline>
                      </Inline>

                      {dropping === task.id && (
                        <Stack gap="2">
                          <TextField
                            label="Why?"
                            /* Asked, never required. An honest blank beats an
                             * invented reason, and a required field would
                             * produce the second. */
                            hint="Optional. In year three, a dropped task with no reason is indistinguishable from a forgotten one."
                            value={dropReason}
                            onChange={(event) => {
                              setDropReason(event.target.value);
                            }}
                          />
                          <Inline gap="2">
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={close.isPending}
                              onClick={() => {
                                close.mutate({
                                  id: task.id,
                                  status: 'dropped',
                                  reason: dropReason.trim() === '' ? null : dropReason.trim(),
                                });
                              }}
                            >
                              Drop it
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setDropping(null);
                              }}
                            >
                              Cancel
                            </Button>
                          </Inline>
                        </Stack>
                      )}
                    </Stack>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          ),
        )
      )}

      {board.recentlyClosed.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Closed
          </Text>
          {board.recentlyClosed.map((task) => (
            <Card key={task.id} variant="flat">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body-sm" tone="secondary" as="span">
                      {task.title}
                    </Text>
                    {task.droppedReason !== null && (
                      <Text role="caption" tone="tertiary">
                        {task.droppedReason}
                      </Text>
                    )}
                  </Stack>
                  <Inline gap="2" align="center">
                    <Badge tone={task.status === 'done' ? 'positive' : 'neutral'}>
                      {TASK_STATUS_LABELS[task.status]}
                      {task.completedDayKey === null ? '' : ` · ${task.completedDayKey}`}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={reopen.isPending}
                      onClick={() => {
                        reopen.mutate(task.id);
                      }}
                    >
                      Reopen
                    </Button>
                  </Inline>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function describeContext(task: Task, board: TaskBoard): string {
  const parts: string[] = [];
  if (task.dueDayKey !== null) parts.push(`due ${task.dueDayKey}`);
  const project = board.projects.find((entry) => entry.id === task.projectId);
  if (project !== undefined) parts.push(project.name);
  if (task.linkedEntityType !== null) parts.push(`linked to a ${task.linkedEntityType.replace(/_/gu, ' ')}`);
  return parts.length === 0 ? 'No date, no link' : parts.join(' · ');
}

function AddTask({ board, onSaved }: { readonly board: TaskBoard; readonly onSaved: () => void }): ReactNode {
  const [title, setTitle] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await createTask({
        id: uuidV7(systemClock.nowMillis()),
        title: title.trim(),
        note: null,
        projectId,
        dueDayKey: dueDay === '' ? null : dueDay,
      });
    },
    onSuccess: () => {
      setTitle('');
      setDueDay('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that task.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="Task"
            value={title}
            placeholder="Book the dermatology follow-up"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <Inline gap="3" wrap>
            <DateField label="Due" value={dueDay} onValueChange={setDueDay} />
            {board.projects.length > 0 && (
              <Stack gap="1">
                <Text role="caption" tone="tertiary">
                  Project
                </Text>
                <Inline gap="2" wrap>
                  {board.projects
                    .filter((project) => project.status === 'active')
                    .map((project) => (
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
          </Inline>
          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}
          <Inline gap="2">
            <Button
              variant="primary"
              disabled={title.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Add
            </Button>
            {/* Said plainly rather than discovered when a queued task never
                appears. The observation path queues; this one does not. */}
            <Text role="caption" tone="tertiary">
              Needs a connection — task state is not queued offline.
            </Text>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
