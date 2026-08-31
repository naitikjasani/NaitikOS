/**
 * Work, persisted — projects, tasks, and the career log (§4.8).
 *
 * ## Every read here is shaped by the join it exists for
 *
 * §4.8's justification for the pillar is that "work load is a major input to
 * Mind, Sleep, and Gym adherence... the missing variable that explains a great
 * many patterns in the others." So `tasksClosedBetween` takes day keys rather
 * than instants, and `completed_day_key` is a stored column rather than a
 * `date_trunc` in the predicate — a zoned truncation in a WHERE clause is not
 * sargable and the index would be decoration.
 *
 * ## Completion is written as a pair, and the database checks that
 *
 * `task_completed_together` is a CHECK constraint, so a completion instant
 * without its day key is rejected by Postgres rather than producing a task
 * that is done but invisible to every per-day query. The repository writes both
 * or neither; the constraint is what makes that a guarantee rather than a
 * habit.
 *
 * ## Career entries are updated in place, and that is correct
 *
 * Unlike `medical_event` (§9.5), a career entry is not bitemporal. Correcting
 * the date something shipped is a correction, not a change of belief about a
 * clinical fact, and §9.5 stops bitemporality at `medical_event` and its
 * subtypes deliberately. `audit_log` already holds the prior state.
 */

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  CareerEntry,
  CareerEntryInput,
  CareerEntryKind,
  DomainError,
  ProjectStatus,
  Task,
  TaskInput,
  TaskStatus,
  WorkProject,
  WorkProjectInput,
} from '@naitikos/core';
import { notFoundError } from '@naitikos/core';

import type { Database } from '../client';
import { careerEntry, project, task } from '../schema/work';

function toProject(row: typeof project.$inferSelect): WorkProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as ProjectStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    context: row.context,
    goalId: row.goalId,
  };
}

function toTask(row: typeof task.$inferSelect): Task {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status as TaskStatus,
    projectId: row.projectId,
    goalId: row.goalId,
    linkedEntityType: row.linkedEntityType,
    linkedEntityId: row.linkedEntityId,
    dueDayKey: row.dueDayKey,
    completedAt: row.completedAt,
    completedDayKey: row.completedDayKey,
    droppedReason: row.droppedReason,
    createdAt: row.createdAt,
  };
}

function toCareerEntry(row: typeof careerEntry.$inferSelect): CareerEntry {
  return {
    id: row.id,
    kind: row.kind as CareerEntryKind,
    title: row.title,
    detail: row.detail,
    occurredAt: row.occurredAt,
    projectId: row.projectId,
    attributedTo: row.attributedTo,
    artifactUrl: row.artifactUrl,
    isVisibleToLeadership: row.isVisibleToLeadership,
    /* `text[]` reads back as `null` when never written. An absent skill list is
     * an empty list to every caller; leaving the null to travel would make each
     * one of them handle it. */
    skills: row.skills ?? [],
  };
}

/** Closing a task. The day key travels with the instant, always. */
export type CloseTaskInput = {
  readonly id: string;
  readonly status: Exclude<TaskStatus, 'open'>;
  readonly at: string;
  readonly dayKey: string;
  readonly zone: string;
  readonly droppedReason?: string | null;
};

export type WorkRepository = {
  projects(): Promise<Result<readonly WorkProject[], DomainError>>;
  projectById(id: string): Promise<Result<WorkProject | null, DomainError>>;
  createProject(input: WorkProjectInput): Promise<Result<WorkProject, DomainError>>;
  setProjectStatus(id: string, status: ProjectStatus, at: string): Promise<Result<WorkProject, DomainError>>;

  /** Open tasks, plus anything closed within `sinceDayKey` if given. */
  tasks(sinceDayKey?: string): Promise<Result<readonly Task[], DomainError>>;
  createTask(input: TaskInput): Promise<Result<Task, DomainError>>;
  closeTask(input: CloseTaskInput): Promise<Result<Task, DomainError>>;
  /** Undo. An open task loses its completion pair together (§9.4: nothing is lost). */
  reopenTask(id: string, at: string): Promise<Result<Task, DomainError>>;
  /** Tasks closed in a day-key window. The Mind/Sleep join §4.8 exists for. */
  tasksClosedBetween(fromDayKey: string, toDayKey: string): Promise<Result<readonly Task[], DomainError>>;

  careerEntries(limit?: number): Promise<Result<readonly CareerEntry[], DomainError>>;
  careerEntriesBetween(fromIso: string, toIso: string): Promise<Result<readonly CareerEntry[], DomainError>>;
  recordCareerEntry(input: CareerEntryInput, zone: string): Promise<Result<CareerEntry, DomainError>>;
  searchCareer(query: string, limit?: number): Promise<Result<readonly CareerEntry[], DomainError>>;
};

export function createWorkRepository(db: Database): WorkRepository {
  return {
    async projects() {
      const rows = await db
        .select()
        .from(project)
        .where(isNull(project.deletedAt))
        .orderBy(desc(project.startedAt), asc(project.name));
      return ok(rows.map(toProject));
    },

    async projectById(id) {
      const rows = await db
        .select()
        .from(project)
        .where(and(eq(project.id, id), isNull(project.deletedAt)))
        .limit(1);
      const row = rows[0];
      return ok(row === undefined ? null : toProject(row));
    },

    async createProject(input) {
      const rows = await db
        .insert(project)
        .values({
          id: input.id,
          name: input.name,
          description: input.description ?? null,
          startedAt: input.startedAt ?? null,
          endedAt: input.endedAt ?? null,
          context: input.context ?? null,
          goalId: input.goalId ?? null,
        })
        /* §5.7: a replayed write arrives with the same client-minted UUIDv7. */
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toProject(row));

      const existing = await db.select().from(project).where(eq(project.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('project', input.id) }
        : ok(toProject(replayed));
    },

    async setProjectStatus(id, status, at) {
      const rows = await db
        .update(project)
        .set({
          status,
          /* Only a terminal status dates the project. A pause is not an
           * ending, and writing `endedAt` on one would make the project read as
           * finished on every list that sorts by it. */
          ...(status === 'shipped' || status === 'abandoned' ? { endedAt: at } : {}),
          updatedAt: at,
        })
        .where(and(eq(project.id, id), isNull(project.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('project', id) } : ok(toProject(row));
    },

    async tasks(sinceDayKey) {
      const rows = await db
        .select()
        .from(task)
        .where(
          and(
            isNull(task.deletedAt),
            sinceDayKey === undefined
              ? eq(task.status, 'open')
              : /*
                 * Open tasks are unbounded — an open task from last year is
                 * still open and belongs on the list. Only the closed ones are
                 * windowed, which is why this is an OR rather than a date
                 * filter over everything.
                 */
                sql`(${task.status} = 'open' OR ${task.completedDayKey} >= ${sinceDayKey})`,
          ),
        )
        .orderBy(asc(task.dueDayKey), asc(task.createdAt));
      return ok(rows.map(toTask));
    },

    async createTask(input) {
      const rows = await db
        .insert(task)
        .values({
          id: input.id,
          title: input.title,
          note: input.note ?? null,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          linkedEntityType: input.linkedEntityType ?? null,
          linkedEntityId: input.linkedEntityId ?? null,
          dueDayKey: input.dueDayKey ?? null,
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toTask(row));

      const existing = await db.select().from(task).where(eq(task.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('task', input.id) }
        : ok(toTask(replayed));
    },

    async closeTask(input) {
      const rows = await db
        .update(task)
        .set({
          status: input.status,
          /*
           * Both halves, always. `task_completed_together` rejects one without
           * the other, so a `dropped` task gets a completion pair too — it was
           * closed on a day, and a drop with no date is invisible to every
           * question this table exists to answer.
           */
          completedAt: input.at,
          completedDayKey: input.dayKey,
          zone: input.zone,
          droppedReason: input.status === 'dropped' ? (input.droppedReason ?? null) : null,
          updatedAt: input.at,
        })
        .where(and(eq(task.id, input.id), isNull(task.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('task', input.id) } : ok(toTask(row));
    },

    async reopenTask(id, at) {
      const rows = await db
        .update(task)
        .set({
          status: 'open',
          completedAt: null,
          completedDayKey: null,
          droppedReason: null,
          updatedAt: at,
        })
        .where(and(eq(task.id, id), isNull(task.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined ? { ok: false, error: notFoundError('task', id) } : ok(toTask(row));
    },

    async tasksClosedBetween(fromDayKey, toDayKey) {
      const rows = await db
        .select()
        .from(task)
        .where(
          and(
            isNull(task.deletedAt),
            eq(task.status, 'done'),
            isNotNull(task.completedDayKey),
            gte(task.completedDayKey, fromDayKey),
            lte(task.completedDayKey, toDayKey),
          ),
        )
        .orderBy(asc(task.completedDayKey));
      return ok(rows.map(toTask));
    },

    async careerEntries(limit = 200) {
      const rows = await db
        .select()
        .from(careerEntry)
        .where(isNull(careerEntry.deletedAt))
        .orderBy(desc(careerEntry.occurredAt))
        .limit(limit);
      return ok(rows.map(toCareerEntry));
    },

    async careerEntriesBetween(fromIso, toIso) {
      const rows = await db
        .select()
        .from(careerEntry)
        .where(
          and(
            isNull(careerEntry.deletedAt),
            gte(careerEntry.occurredAt, fromIso),
            lte(careerEntry.occurredAt, toIso),
          ),
        )
        .orderBy(desc(careerEntry.occurredAt));
      return ok(rows.map(toCareerEntry));
    },

    async recordCareerEntry(input, zone) {
      const rows = await db
        .insert(careerEntry)
        .values({
          id: input.id,
          kind: input.kind,
          title: input.title,
          detail: input.detail ?? null,
          occurredAt: input.occurredAt,
          zone,
          projectId: input.projectId ?? null,
          attributedTo: input.attributedTo ?? null,
          artifactUrl: input.artifactUrl ?? null,
          isVisibleToLeadership: input.isVisibleToLeadership ?? null,
          skills: [...(input.skills ?? [])],
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toCareerEntry(row));

      const existing = await db.select().from(careerEntry).where(eq(careerEntry.id, input.id)).limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('career_entry', input.id) }
        : ok(toCareerEntry(replayed));
    },

    async searchCareer(query, limit = 50) {
      const trimmed = query.trim();
      if (trimmed === '') return ok([]);

      /*
       * `websearch_to_tsquery`, not `plainto_tsquery`. It accepts what a person
       * actually types into a search box — quoted phrases, `or`, a leading
       * minus — and it never throws on malformed input, which `to_tsquery`
       * does. A search box that 500s on an apostrophe is a search box nobody
       * uses twice.
       */
      const rows = await db
        .select()
        .from(careerEntry)
        .where(
          and(
            isNull(careerEntry.deletedAt),
            sql`${careerEntry.searchVector} @@ websearch_to_tsquery('english', ${trimmed})`,
          ),
        )
        .orderBy(desc(careerEntry.occurredAt))
        .limit(limit);
      return ok(rows.map(toCareerEntry));
    },
  };
}

/** Kept so the several callers that ask "which projects" spell it one way. */
export function projectsIn(ids: readonly string[]) {
  return ids.length === 0 ? isNull(project.id) : inArray(project.id, [...ids]);
}
