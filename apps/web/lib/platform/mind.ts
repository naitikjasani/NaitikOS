/**
 * The Mind service — §4.7's orchestration.
 *
 * §5.2 keeps handlers to transport, so this is where the registry, the
 * repositories and the clock are held together long enough to write an episode
 * or read a trend. Like `gym.ts`, it decides almost nothing.
 *
 * ## The two things it does decide
 *
 * **Every read carries the medication annotations.** §4.7: "Medication changes
 * are annotated on every chart in the system. A mood trend without a 'started
 * Escitalopram' marker is a misleading chart." That is enforced here rather than
 * left to each screen — {@link loadMindOverview} returns them whether or not the
 * caller asked, so a new chart cannot ship without them by omission.
 *
 * **The crisis evaluation runs on the read path, not on a schedule.** A nightly
 * job that decided whether to surface a crisis plan would be up to a day stale
 * on the day it matters most. It is cheap — two series already in hand — so it
 * runs every time the surface is opened.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { err, ok } from '@naitikos/shared';
import type {
  AnxietyEpisode,
  CrisisPlan,
  DailyValue,
  DomainError,
  EpisodeInput,
  Hlc,
  JournalEntryInput,
  JournalListItem,
  JournalPrompt,
  Medication,
  MedicationAnnotation,
  MetricRegistry,
  MindScaleId,
  Movement,
  PracticeInput,
  PracticeSession,
  WindowAdherence,
} from '@naitikos/core';
import {
  MIND_SCALES,
  crisisSurface,
  dailyRollup,
  describeMovement,
  evaluateCrisisState,
  hlcReceive,
  initialHlcState,
  isoFromMillis,
  medicationAnnotations,
  notFoundError,
  planEpisode,
  planJournalEntry,
  planPractice,
  promptForDay,
  shouldInvitePlanning,
  windowAdherence,
  windowDayKeys,
  systemClock,
  zonedDayBounds,
} from '@naitikos/core';
import type { Database } from '@naitikos/db';
import {
  createMedicationRepository,
  createMetricRepository,
  createMindRepository,
  createObservationRepository,
} from '@naitikos/db';

import type { OfflineEnvelope } from './capture';

function clockFor(envelope: OfflineEnvelope, physicalMillis: number) {
  const seed = initialHlcState(envelope.deviceId, physicalMillis);
  return envelope.clientHlc === undefined
    ? { state: seed }
    : hlcReceive(seed, envelope.clientHlc as Hlc, physicalMillis);
}

async function registryFor(db: Database): Promise<Result<MetricRegistry, DomainError>> {
  return createMetricRepository(db).registry();
}

function writeContext(registry: MetricRegistry, envelope: OfflineEnvelope, newId: () => string) {
  const physicalMillis = systemClock.nowMillis();
  return {
    registry,
    hlcState: clockFor(envelope, physicalMillis).state,
    recordedAt: isoFromMillis(physicalMillis),
    physicalMillis,
    newId,
  };
}

/* -------------------------------------------------------------------------
 * Writes
 * ---------------------------------------------------------------------- */

export async function logAnxietyEpisode(
  db: Database,
  envelope: OfflineEnvelope,
  input: EpisodeInput,
  newId: () => string,
): Promise<Result<AnxietyEpisode, DomainError>> {
  const planned = planEpisode(input);
  if (!planned.ok) return planned;

  const registry = await registryFor(db);
  if (!registry.ok) return registry;

  const written = await createMindRepository(db).logEpisode(
    planned.value,
    writeContext(registry.value, envelope, newId),
  );
  return written.ok ? ok(written.value.episode) : err(written.error);
}

export async function closeAnxietyEpisode(
  db: Database,
  id: string,
  endedAt: string,
): Promise<Result<AnxietyEpisode, DomainError>> {
  const closed = await createMindRepository(db).closeEpisode(id, endedAt);
  if (!closed.ok) return closed;
  return closed.value === null ? err(notFoundError('anxiety_episode', id)) : ok(closed.value);
}

export async function writeJournal(
  db: Database,
  input: JournalEntryInput,
): Promise<Result<{ readonly id: string; readonly wordCount: number }, DomainError>> {
  const planned = planJournalEntry(input);
  if (!planned.ok) return planned;

  const written = await createMindRepository(db).writeJournalEntry(planned.value);
  if (!written.ok) return err(written.error);

  /*
   * The response carries the id and a word count, not the entry.
   *
   * §4.7's most-sensitive-data rule applied to the wire: the client already has
   * the text it just sent, so echoing it back only puts it into one more place
   * — a response log, a service-worker cache, an error report.
   */
  return ok({ id: written.value.id, wordCount: planned.value.content.trim().split(/\s+/u).length });
}

export async function logPracticeSession(
  db: Database,
  envelope: OfflineEnvelope,
  input: PracticeInput,
  newId: () => string,
): Promise<Result<PracticeSession, DomainError>> {
  const planned = planPractice(input);
  if (!planned.ok) return planned;

  const registry = await registryFor(db);
  if (!registry.ok) return registry;

  const written = await createMindRepository(db).logPractice(
    planned.value,
    writeContext(registry.value, envelope, newId),
  );
  return written.ok ? ok(written.value.practice) : err(written.error);
}

/* -------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------- */

export type ScaleSeries = {
  readonly id: MindScaleId;
  readonly label: string;
  readonly metricKey: string;
  readonly points: readonly DailyValue[];
  readonly movement: Movement;
};

export type MindOverview = {
  readonly fromDayKey: string;
  readonly toDayKey: string;
  readonly scales: readonly ScaleSeries[];
  /** §4.7: every chart in the system carries these. */
  readonly annotations: readonly MedicationAnnotation[];
  readonly episodes: readonly AnxietyEpisode[];
  readonly practices: readonly PracticeSession[];
  /** The stored plan, or null. Never a generated message. */
  readonly crisis: { readonly plan: CrisisPlan } | null;
  /** True on a settled stretch with no plan on file — never during a bad one. */
  readonly invitePlanning: boolean;
  readonly prompt: JournalPrompt | null;
  /**
   * Every active prompt, for `/mind/journal/prompts`.
   *
   * Carried on the overview rather than given its own endpoint. They are seeded
   * rows that change when the seed does, and a second endpoint returning the
   * same list would be a second thing to keep in step — the payload cost is a
   * dozen short strings.
   *
   * `/mind` renders only {@link MindOverview.prompt}, and deliberately: §4.7's
   * journal is for opening and writing in, and a wall of questions is a
   * decision to make before writing on an evening when making one is hard.
   */
  readonly promptLibrary: readonly JournalPrompt[];
  readonly journal: readonly JournalListItem[];
};

export async function loadMindOverview(
  db: Database,
  options: { readonly fromDayKey: string; readonly toDayKey: string; readonly zone: string },
): Promise<Result<MindOverview, DomainError>> {
  const registry = await registryFor(db);
  if (!registry.ok) return registry;

  const from = zonedDayBounds(options.fromDayKey, options.zone);
  const until = zonedDayBounds(options.toDayKey, options.zone);
  if (from === null || until === null) {
    return err(notFoundError('day', `${options.fromDayKey}..${options.toDayKey}`, 'invalid_day_range'));
  }

  const observations = createObservationRepository(db);
  const mind = createMindRepository(db);
  const medications = createMedicationRepository(db);

  const [rows, episodes, practices, plan, prompts, journal, register] = await Promise.all([
    observations.query({
      metricKeys: Object.values(MIND_SCALES).map((scale) => scale.metricKey),
      from: from.start,
      until: until.end,
    }),
    mind.episodesBetween(from.start, until.end),
    mind.recentPractices(20),
    mind.activeCrisisPlan(),
    mind.prompts(),
    mind.journalList(20),
    medications.all(),
  ]);

  for (const result of [rows, episodes, practices, plan, prompts, journal, register]) {
    if (!result.ok) return err(result.error);
  }
  if (!rows.ok || !episodes.ok || !practices.ok || !plan.ok || !prompts.ok || !journal.ok || !register.ok) {
    return err(notFoundError('mind', 'overview', 'mind_overview_unavailable'));
  }

  const schedules = await medications.schedules();
  if (!schedules.ok) return err(schedules.error);

  const scales: ScaleSeries[] = [];
  for (const scale of Object.values(MIND_SCALES)) {
    const definition = registry.value.get(scale.metricKey);
    /*
     * The aggregation comes from the registry, never from here. §9.2: it is
     * "what stops a chart summing bodyweight" — and it is equally what stops one
     * summing a mood score.
     */
    const points =
      definition === null || definition === undefined
        ? []
        : dailyRollup(rows.value, definition, { zone: options.zone });

    scales.push({
      id: scale.id,
      label: scale.label,
      metricKey: scale.metricKey,
      points,
      movement: describeMovement(scale.id, points),
    });
  }

  const evaluation = evaluateCrisisState(
    {
      mood: scales.find((scale) => scale.id === 'mood')?.points ?? [],
      anxiety: scales.find((scale) => scale.id === 'anxiety')?.points ?? [],
    },
    plan.value,
  );

  return ok({
    fromDayKey: options.fromDayKey,
    toDayKey: options.toDayKey,
    scales,
    annotations: medicationAnnotations(register.value, schedules.value, options.zone),
    episodes: episodes.value,
    practices: practices.value,
    crisis: crisisSurface(evaluation, plan.value),
    invitePlanning: shouldInvitePlanning(evaluation),
    prompt: promptForDay(prompts.value, options.toDayKey),
    promptLibrary: prompts.value,
    journal: journal.value,
  });
}

/* -------------------------------------------------------------------------
 * The medication lens (§3.3(3): one row, three lenses)
 * ---------------------------------------------------------------------- */

export type MedicationLens = {
  readonly medications: readonly Medication[];
  readonly adherence: readonly WindowAdherence[];
  readonly annotations: readonly MedicationAnnotation[];
  readonly windowDays: number;
};

export async function loadMedicationLens(
  db: Database,
  options: {
    readonly toDayKey: string;
    readonly zone: string;
    readonly windowDays?: number;
    /** §4.7's lens: psychiatric only. Omitted, the whole register. */
    readonly psychiatricOnly?: boolean;
  },
): Promise<Result<MedicationLens, DomainError>> {
  const windowDays = options.windowDays ?? 30;
  const dayKeys = windowDayKeys(options.toDayKey, windowDays);
  const first = dayKeys[0];
  if (first === undefined) return err(notFoundError('day', options.toDayKey, 'invalid_day'));

  const bounds = zonedDayBounds(first, options.zone);
  const until = zonedDayBounds(options.toDayKey, options.zone);
  if (bounds === null || until === null) return err(notFoundError('day', first, 'invalid_day'));

  const medications = createMedicationRepository(db);
  const [register, schedules, events] = await Promise.all([
    medications.all(),
    medications.schedules(),
    medications.eventsBetween(bounds.start, until.end),
  ]);
  if (!register.ok) return err(register.error);
  if (!schedules.ok) return err(schedules.error);
  if (!events.ok) return err(events.error);

  const selected =
    options.psychiatricOnly === true
      ? register.value.filter((item) => item.isPsychiatric)
      : register.value;

  /*
   * Adherence is computed for *active* medications only.
   *
   * A stopped medication has no doses to adhere to, and reporting "0 of 0" for
   * a course finished in March would put a permanent empty row on the screen —
   * which is the graveyard §3.3 R6 warns about, one card at a time. The stopped
   * ones still appear in `medications` and as chart annotations, because a
   * medication that ended is exactly the sort of thing a trend needs marked.
   */
  const adherence = selected
    .filter((item) => item.stoppedAt === null)
    .map((item) => windowAdherence(item, schedules.value, events.value, dayKeys, options.zone));

  return ok({
    medications: selected,
    adherence,
    annotations: medicationAnnotations(selected, schedules.value, options.zone),
    windowDays,
  });
}

export async function logDose(
  db: Database,
  input: Parameters<ReturnType<typeof createMedicationRepository>['logEvent']>[0],
): Promise<Result<{ readonly written: boolean }, DomainError>> {
  const logged = await createMedicationRepository(db).logEvent(input);
  return logged.ok ? ok({ written: logged.value.written }) : err(logged.error);
}
