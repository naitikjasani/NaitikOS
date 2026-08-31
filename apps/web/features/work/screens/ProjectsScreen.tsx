'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, systemClock } from '@naitikos/core';
import type { ProjectStatus } from '@naitikos/core';
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

import type { ProjectBoard } from '@/lib/platform/work';
import { createProject, setProjectStatus } from '../services/workClient';

/**
 * `/work/projects` — §4.8's "container above tasks, linked to career artifacts".
 *
 * ## Two numbers, never one
 *
 * Each project shows open tasks and logged career entries side by side and
 * never combines them. A project with eleven open tasks and nothing logged is a
 * different situation from one with two open tasks and six entries, and a
 * single "health" score would render them identical while looking
 * authoritative. §10.0's prohibition on the system asserting things it cannot
 * support applies to a composite number as much as to a sentence.
 *
 * ## Pausing is not ending
 *
 * A paused project keeps its `endedAt` empty, so it does not read as finished
 * on any list sorted by completion. §4.10's goal archaeology has the same
 * shape: the reason something stopped is information, and flattening pause into
 * abandonment destroys it.
 */
export function ProjectsScreen({ board }: { readonly board: ProjectBoard }): ReactNode {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const move = useMutation({
    mutationFn: async (input: { id: string; status: ProjectStatus }) => {
      await setProjectStatus(input.id, input.status);
    },
    onSuccess: refresh,
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not change that project.');
    },
  });

  return (
    <Stack gap="6">
      <AddProject onSaved={refresh} />

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {board.projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="A project is what tasks and career entries hang off. It does not need a plan to exist."
        />
      ) : (
        board.projects.map((project) => (
          <Card key={project.id} variant="outlined">
            <CardBody>
              <Stack gap="3">
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="title-3" as="h2">
                      {project.name}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {project.context ?? 'No context recorded'}
                      {project.startedAt === null ? '' : ` · since ${project.startedAt.slice(0, 10)}`}
                    </Text>
                  </Stack>
                  <Badge tone={project.status === 'active' ? 'accent' : 'neutral'}>
                    {PROJECT_STATUS_LABELS[project.status]}
                  </Badge>
                </Inline>

                {project.description !== null && (
                  <Text role="body-sm" tone="secondary">
                    {project.description}
                  </Text>
                )}

                <Inline gap="4" wrap>
                  <Stack gap="1">
                    <Text role="caption" tone="tertiary">
                      Open tasks
                    </Text>
                    <Text role="metric-m" as="span">
                      {String(project.standing.openTasks)}
                    </Text>
                  </Stack>
                  <Stack gap="1">
                    <Text role="caption" tone="tertiary">
                      Done
                    </Text>
                    <Text role="metric-m" as="span">
                      {String(project.standing.doneTasks)}
                    </Text>
                  </Stack>
                  <Stack gap="1">
                    <Text role="caption" tone="tertiary">
                      Logged
                    </Text>
                    <Text role="metric-m" as="span">
                      {String(project.standing.careerEntries)}
                    </Text>
                  </Stack>
                </Inline>

                {project.openTaskTitles.length > 0 && (
                  <Stack gap="1">
                    {project.openTaskTitles.map((title) => (
                      <Text key={title} role="body-sm" tone="secondary">
                        · {title}
                      </Text>
                    ))}
                  </Stack>
                )}

                <Text role="caption" tone="tertiary">
                  {project.standing.lastActivityAt === null
                    ? 'Nothing recorded against this yet.'
                    : `Last activity ${project.standing.lastActivityAt.slice(0, 10)}.`}
                </Text>

                <Inline gap="2" wrap>
                  {PROJECT_STATUSES.filter((status) => status !== project.status).map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant="secondary"
                      disabled={move.isPending}
                      onClick={() => {
                        move.mutate({ id: project.id, status });
                      }}
                    >
                      {PROJECT_STATUS_LABELS[status]}
                    </Button>
                  ))}
                </Inline>
              </Stack>
            </CardBody>
          </Card>
        ))
      )}
    </Stack>
  );
}

function AddProject({ onSaved }: { readonly onSaved: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [context, setContext] = useState('');
  const [description, setDescription] = useState('');
  const [startedDay, setStartedDay] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await createProject({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        description: description.trim() === '' ? null : description.trim(),
        /* Noon, like every other day-anchored instant here: midnight sits on a
         * boundary a DST rule can push into the previous day. */
        startedAt: startedDay === '' ? null : `${startedDay}T12:00:00.000Z`,
        context: context.trim() === '' ? null : context.trim(),
      });
    },
    onSuccess: () => {
      setOpen(false);
      setName('');
      setContext('');
      setDescription('');
      setStartedDay('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that project.');
    },
  });

  if (!open) {
    return (
      <Inline gap="2">
        <Button
          variant="secondary"
          onClick={() => {
            setOpen(true);
          }}
        >
          New project
        </Button>
      </Inline>
    );
  }

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label="Context"
            hint="Employer, client, or yourself. Free text — this is not a CRM."
            value={context}
            onChange={(event) => {
              setContext(event.target.value);
            }}
          />
          <TextField
            label="Description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <DateField label="Started" value={startedDay} onValueChange={setStartedDay} />
          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}
          <Inline gap="2">
            <Button
              variant="primary"
              disabled={name.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
