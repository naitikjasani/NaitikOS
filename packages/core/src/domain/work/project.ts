/**
 * Projects — §4.8's "container above tasks, linked to career artifacts".
 *
 * Small on purpose. A project here is a name, a window, and a place for tasks
 * and career entries to hang off; everything a project-management tool would
 * add — milestones, dependencies, allocation — is absent because §4.8 puts this
 * pillar's value in its joins with Mind, Sleep and Gym, not in its own
 * completeness.
 *
 * The one derived thing is {@link projectStanding}, and it deliberately reports
 * two numbers without combining them. A project with eleven open tasks and no
 * career entry is a different situation from one with two open tasks and six
 * career entries, and a single "health" score would render them identical while
 * looking authoritative.
 */

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';

import type { DomainError } from '../../errors/domain-error';
import { validationError } from '../../errors/domain-error';
import { parseInstant } from '../../temporal/instant';

/** Mirrors the `project_status` pgEnum exactly. */
export const PROJECT_STATUSES = Object.freeze(['active', 'shipped', 'paused', 'abandoned'] as const);

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Readonly<Record<ProjectStatus, string>> = Object.freeze({
  active: 'Active',
  shipped: 'Shipped',
  paused: 'Paused',
  abandoned: 'Abandoned',
});

export function isProjectStatus(value: string): value is ProjectStatus {
  return (PROJECT_STATUSES as readonly string[]).includes(value);
}

export type WorkProject = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: ProjectStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly context: string | null;
  readonly goalId: string | null;
};

export type WorkProjectInput = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly context?: string | null;
  readonly goalId?: string | null;
};

export function validateProject(input: WorkProjectInput): Result<WorkProjectInput, DomainError> {
  if (input.name.trim() === '') {
    return err(validationError('project_name_empty', 'A project needs a name.'));
  }
  for (const [field, value] of [
    ['startedAt', input.startedAt ?? null],
    ['endedAt', input.endedAt ?? null],
  ] as const) {
    if (value !== null && parseInstant(value) === null) {
      return err(validationError('project_instant_invalid', `${field} must be an ISO-8601 instant.`));
    }
  }
  const started = input.startedAt ?? null;
  const ended = input.endedAt ?? null;
  if (started !== null && ended !== null && ended < started) {
    return err(validationError('project_ends_before_start', 'A project cannot end before it started.'));
  }
  return ok(input);
}

export type ProjectStanding = {
  readonly projectId: string;
  readonly openTasks: number;
  readonly doneTasks: number;
  readonly careerEntries: number;
  /**
   * The most recent thing that happened on this project, of any kind, or
   * `null` when nothing has. Used to sort, and to answer "which of these have I
   * not touched since spring" without asserting that not touching one is bad.
   */
  readonly lastActivityAt: string | null;
};

export function projectStanding(input: {
  readonly projectId: string;
  readonly tasks: readonly { readonly projectId: string | null; readonly status: string; readonly completedAt: string | null; readonly createdAt: string }[];
  readonly careerEntries: readonly { readonly projectId: string | null; readonly occurredAt: string }[];
}): ProjectStanding {
  let openTasks = 0;
  let doneTasks = 0;
  let last: string | null = null;

  const touch = (value: string | null): void => {
    if (value !== null && (last === null || value > last)) last = value;
  };

  for (const task of input.tasks) {
    if (task.projectId !== input.projectId) continue;
    if (task.status === 'open') openTasks += 1;
    else if (task.status === 'done') doneTasks += 1;
    touch(task.completedAt ?? task.createdAt);
  }

  let careerEntries = 0;
  for (const entry of input.careerEntries) {
    if (entry.projectId !== input.projectId) continue;
    careerEntries += 1;
    touch(entry.occurredAt);
  }

  return { projectId: input.projectId, openTasks, doneTasks, careerEntries, lastActivityAt: last };
}
