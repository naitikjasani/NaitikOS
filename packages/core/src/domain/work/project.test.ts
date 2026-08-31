import { describe, expect, it } from 'vitest';

import { projectStanding, validateProject } from './project';

const PROJECT = '01900000-0000-7000-8000-0000000000p1'.replace('p', '0');

describe('validateProject', () => {
  it('refuses an empty name', () => {
    const result = validateProject({ id: PROJECT, name: ' ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project_name_empty');
  });

  it('refuses an end before the start', () => {
    const result = validateProject({
      id: PROJECT,
      name: 'x',
      startedAt: '2026-05-01T00:00:00.000Z',
      endedAt: '2026-04-01T00:00:00.000Z',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project_ends_before_start');
  });

  it('accepts a project with no dates at all', () => {
    expect(validateProject({ id: PROJECT, name: 'Ongoing' }).ok).toBe(true);
  });
});

describe('projectStanding', () => {
  it('counts open and done separately and never combines them into a score', () => {
    const standing = projectStanding({
      projectId: PROJECT,
      tasks: [
        { projectId: PROJECT, status: 'open', completedAt: null, createdAt: '2026-08-01T09:00:00.000Z' },
        { projectId: PROJECT, status: 'done', completedAt: '2026-08-20T09:00:00.000Z', createdAt: '2026-08-02T09:00:00.000Z' },
        { projectId: PROJECT, status: 'dropped', completedAt: null, createdAt: '2026-08-03T09:00:00.000Z' },
      ],
      careerEntries: [{ projectId: PROJECT, occurredAt: '2026-08-25T09:00:00.000Z' }],
    });

    expect(standing.openTasks).toBe(1);
    expect(standing.doneTasks).toBe(1);
    expect(standing.careerEntries).toBe(1);
    expect(standing.lastActivityAt).toBe('2026-08-25T09:00:00.000Z');
  });

  it('ignores rows belonging to another project', () => {
    const standing = projectStanding({
      projectId: PROJECT,
      tasks: [{ projectId: null, status: 'open', completedAt: null, createdAt: '2026-08-01T09:00:00.000Z' }],
      careerEntries: [{ projectId: 'other', occurredAt: '2026-08-25T09:00:00.000Z' }],
    });
    expect(standing).toEqual({
      projectId: PROJECT,
      openTasks: 0,
      doneTasks: 0,
      careerEntries: 0,
      lastActivityAt: null,
    });
  });
});
