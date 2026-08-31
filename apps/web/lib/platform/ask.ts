/**
 * Ask — §10.4's Context Engine, wired to real data, and the first caller of
 * §10.10's boundary.
 *
 * ## Consent is enforced here, at the query
 *
 * §10.10: "A scope that is off means the Context Engine **cannot retrieve that
 * class at all** — enforced at retrieval, not at prompt assembly, so there is
 * no path by which a prompt-construction bug leaks it."
 *
 * So the guard is a `return` before a repository is called, not a filter on the
 * result. `assemble` filters again afterwards, and that redundancy is
 * deliberate — a defence that lives only upstream is one refactor from being
 * gone — but this is the one that matters, because unconsented data is never
 * fetched, never held in memory, and never available to leak.
 *
 * ## The model gets summaries, never rows
 *
 * §10.4: "Ninety days of mood observations should reach the model as *'mean
 * 3.4, sd 0.8, trend −0.02/day, 6 days missing'* — not as ninety rows... it
 * prevents the model from doing arithmetic, which is exactly what §10.0
 * forbids." Every number in a context pack is computed by `summariseSeries`, in
 * TypeScript, over rows the database returned.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { AiPreferences, DomainError, Observation } from '@naitikos/core';
import {
  aiIsUsable,
  dailyRollup,
  dayKeyInZone,
  isoFromMillis,
  medicationLabel,
  shiftDayKey,
  systemClock,
  toStoredScope,
  zonedDayBounds,
} from '@naitikos/core';
import type { Answer, ContextItem, ContextPack, QuestionKind } from '@naitikos/ai';
import {
  RETRIEVAL_PLAN,
  answerSchema,
  assemble,
  canRetrieve,
  classifyQuestion,
  invoke,
  resolveWindowDays,
  routeForReadings,
  summariseSeries,
  transportFromEnv,
  UNCONFIGURED_TRANSPORT,
} from '@naitikos/ai';
import type { Database } from '@naitikos/db';
import {
  createAiInteractionRepository,
  createHealthRepository,
  createMedicationRepository,
  createMetricRepository,
  createObservationRepository,
  createProfileRepository,
} from '@naitikos/db';

/** How many metric series a pack will summarise. Ranked, then cut. */
export const MAX_SERIES = 12;

/** §10.4's budget. Generous, because the pack is summaries rather than rows. */
export const CONTEXT_TOKEN_BUDGET = 12_000;

export type AskResult = {
  readonly question: string;
  readonly kind: QuestionKind;
  readonly windowDays: number;
  readonly answer: Answer | null;
  /** Set when no answer was produced. Always says what still works. */
  readonly problem: string | null;
  /** What the pack did not contain, surfaced whether or not there is an answer. */
  readonly omitted: string;
};

export async function ask(
  db: Database,
  input: { readonly question: string; readonly zone: string },
): Promise<Result<AskResult, DomainError>> {
  const preferences = await createProfileRepository(db).getPreferences();
  if (!preferences.ok) return preferences;

  const ai = preferences.value.ai;
  const kind = classifyQuestion(input.question);
  const windowDays = resolveWindowDays(input.question, kind);

  /*
   * The switch is checked before anything is read. §7 makes the layer a
   * sidecar, and a disabled sidecar should not cause the database to be
   * queried on its behalf.
   */
  if (!aiIsUsable(ai)) {
    return ok({
      question: input.question,
      kind,
      windowDays,
      answer: null,
      problem: ai.enabled
        ? 'Nothing is granted for the model to read. Open AI settings to choose what it may see — every figure in the app is computed without it either way.'
        : 'The AI layer is off. Every figure in the app is computed without it; turning it on adds prose and nothing else.',
      omitted: 'Everything. Nothing was read.',
    });
  }

  const built = await buildPack(db, { ...input, kind, windowDays, ai });
  if (!built.ok) return built;

  const { pack, crisis } = built.value;

  const spentSince = monthStartIso(input.zone);
  const spent = await createAiInteractionRepository(db).spentThisMonth(spentSince);
  if (!spent.ok) return spent;

  const transport = transportFromEnv(process.env['ANTHROPIC_API_KEY']) ?? UNCONFIGURED_TRANSPORT;

  const outcome = await invoke({
    task: 'ask',
    pack,
    schema: answerSchema,
    jsonSchema: ANSWER_JSON_SCHEMA,
    transport,
    grant: ai.consent,
    crisis,
    spentMinor: spent.value,
    /* Every free-text field the model produced, for §10.10's scan. Listed
     * explicitly rather than walked, so a field added later is a compile
     * change rather than a silent gap. */
    proseOf: (value) => [...value.paragraphs.map((entry) => entry.template), value.omitted],
    nowMillis: () => systemClock.nowMillis(),
  });

  /*
   * The ledger is written for every outcome, including the failures. §9.2 makes
   * auditability a requirement, and the refused and blocked rows are the ones
   * an investigation actually wants.
   */
  if (outcome.record !== null) {
    await createAiInteractionRepository(db).record({
      id: crypto.randomUUID(),
      purpose: 'ask',
      model: outcome.record.model,
      inputTokens: outcome.record.usage.inputTokens,
      outputTokens: outcome.record.usage.outputTokens,
      cacheReadTokens: outcome.record.usage.cacheReadTokens,
      cacheWriteTokens: outcome.record.usage.cacheWriteTokens,
      costMinor: outcome.record.costMinor,
      latencyMs: outcome.record.latencyMs,
      /* What was granted *at the moment of the call*. §9.2's whole point: a
       * later consent change cannot retroactively justify an earlier one. */
      consentScope: toStoredScope(ai.consent),
      succeeded: outcome.record.succeeded,
      blockedReason: outcome.record.blockedReason,
      errorCode: outcome.record.errorCode,
      outputHash: null,
    });
  }

  return ok({
    question: input.question,
    kind,
    windowDays,
    answer: outcome.ok ? outcome.value : null,
    problem: outcome.ok ? null : outcome.sentence,
    omitted: pack.omitted,
  });
}

/* -------------------------------------------------------------------------
 * RETRIEVE, RANK, BUDGET, ASSEMBLE
 * ---------------------------------------------------------------------- */

async function buildPack(
  db: Database,
  input: {
    readonly question: string;
    readonly zone: string;
    readonly kind: QuestionKind;
    readonly windowDays: number;
    readonly ai: AiPreferences;
  },
): Promise<Result<{ readonly pack: ContextPack; readonly crisis: ReturnType<typeof routeForReadings> }, DomainError>> {
  const nowIso = isoFromMillis(systemClock.nowMillis());
  const todayDayKey = dayKeyInZone(nowIso, input.zone);
  const fromDayKey = shiftDayKey(todayDayKey, -input.windowDays) ?? todayDayKey;
  const fromIso = zonedDayBounds(fromDayKey, input.zone)?.start ?? nowIso;

  const registry = await createMetricRepository(db).registry();
  if (!registry.ok) return registry;

  const plan = new Set<string>(RETRIEVAL_PLAN[input.kind]);
  const items: ContextItem[] = [];
  const stableBlocks: string[] = [];

  /* --- metrics ------------------------------------------------------- */
  let crisis = routeForReadings([]);

  if (plan.has('observation') && canRetrieve(input.ai.consent, 'observation')) {
    const rows = await createObservationRepository(db).query({
      from: fromIso,
      until: nowIso,
      currentOnly: true,
    });
    if (!rows.ok) return rows;

    const byMetric = new Map<string, Observation[]>();
    for (const row of rows.value) {
      const bucket = byMetric.get(row.metricKey) ?? [];
      bucket.push(row);
      byMetric.set(row.metricKey, bucket);
    }

    /*
     * The crisis check reads mood and anxiety directly rather than going
     * through a detector. §4.7 permits one behaviour and it must not depend on
     * a battery having run — a person in crisis on a night the nightly job
     * failed is exactly the case that cannot be missed.
     */
    crisis = routeForReadings(crisisReadings(byMetric, input.zone));

    const summaries = [...byMetric.entries()].flatMap(([metricKey, observations]) => {
      const definition = registry.value.get(metricKey);
      if (definition === null) return [];

      const points = dailyRollup(observations, definition, { zone: input.zone });
      const summary = summariseSeries({
        metricKey,
        label: definition.displayName,
        unit: definition.canonicalUnit,
        points: points.map((point) => ({ dayKey: point.dayKey, value: point.value })),
        windowDays: input.windowDays,
      });

      return summary === null ? [] : [summary];
    });

    for (const summary of summaries) {
      items.push({
        id: `metric:${summary.metricKey}`,
        retrievalClass: 'observation',
        text: summary.sentence,
        /* A metric recorded up to yesterday is fresher than one abandoned in
         * March, and `n / windowDays` is the cheapest honest proxy for that. */
        recency: summary.n / Math.max(1, summary.windowDays),
        relevance: mentionScore(input.question, summary.label, summary.metricKey),
        strength: Math.min(1, summary.n / 30),
      });
    }
  }

  /* --- clinical ------------------------------------------------------ */
  if (plan.has('condition') && canRetrieve(input.ai.consent, 'condition')) {
    const conditions = await createHealthRepository(db).conditions();
    if (!conditions.ok) return conditions;

    for (const condition of conditions.value) {
      items.push({
        id: `condition:${condition.id}`,
        retrievalClass: 'condition',
        text: `Condition: ${condition.name}, ${condition.status}, since ${condition.validFrom.slice(0, 10)}.`,
        recency: condition.status === 'active' ? 1 : 0.2,
        relevance: mentionScore(input.question, condition.name),
        strength: condition.status === 'active' ? 0.9 : 0.3,
      });
    }
  }

  if (plan.has('medication') && canRetrieve(input.ai.consent, 'medication')) {
    const medications = await createMedicationRepository(db).active();
    if (!medications.ok) return medications;

    for (const medication of medications.value) {
      items.push({
        id: `medication:${medication.id}`,
        retrievalClass: 'medication',
        text: `Medication: ${medicationLabel(medication)}, started ${medication.startedAt?.slice(0, 10) ?? 'unknown'}.`,
        recency: 1,
        relevance: mentionScore(input.question, medication.substance, medication.brandName ?? ''),
        strength: 0.8,
      });
    }
  }

  if (plan.has('symptom') && canRetrieve(input.ai.consent, 'symptom')) {
    const symptoms = await createHealthRepository(db).symptomsBetween(fromIso, nowIso);
    if (!symptoms.ok) return symptoms;

    for (const symptom of symptoms.value.slice(0, 20)) {
      items.push({
        id: `symptom:${symptom.id}`,
        retrievalClass: 'symptom',
        text: `Symptom: ${symptom.name}${symptom.bodySite === null ? '' : ` (${symptom.bodySite})`}, from ${symptom.startedAt?.slice(0, 10) ?? 'unknown'}.`,
        recency: 0.7,
        relevance: mentionScore(input.question, symptom.name, symptom.bodySite ?? ''),
        strength: 0.5,
      });
    }
  }

  /*
   * The stable prefix. Nothing here may vary between two calls a minute apart,
   * and `assemble` refuses the pack if it does — §10.4 names the interpolated
   * timestamp as the classic way this goes wrong, and it fails silently as a
   * bill rather than as an error.
   */
  stableBlocks.push(
    'You are answering questions about one person’s own recorded data. Every figure you are given was computed from their records; you may not calculate, estimate, or introduce a number of your own. Where you cannot answer from what you were given, say so.',
  );
  stableBlocks.push(
    `Metrics on record: ${registry.value
      .all()
      .map((definition) => `${definition.displayName} (${definition.canonicalUnit})`)
      .sort((a, b) => a.localeCompare(b))
      .join(', ')}.`,
  );

  const assembled = assemble({
    stableBlocks,
    items: items.slice(0, MAX_SERIES * 4),
    question: input.question,
    grant: input.ai.consent,
    tokenBudget: CONTEXT_TOKEN_BUDGET,
  });

  if (!assembled.ok) {
    /*
     * A prefix that would not cache is a defect in this file, not a user error.
     * It is surfaced rather than worked around, because the failure it prevents
     * is invisible.
     */
    return ok({
      pack: {
        stable: '',
        volatile: '',
        included: [],
        droppedIds: [],
        omitted: assembled.problems.join(' '),
        estimatedTokens: 0,
        refusedClasses: [],
      },
      crisis,
    });
  }

  return ok({ pack: assembled.pack, crisis });
}

/**
 * Mood and anxiety for the last few days, for the crisis check.
 *
 * Read from the observations already fetched rather than issued as a second
 * query. §4.7's check must be cheap enough that nothing is ever tempted to skip
 * it on a slow path.
 */
function crisisReadings(
  byMetric: ReadonlyMap<string, readonly { readonly observedAt: string; readonly value: string }[]>,
  zone: string,
): readonly { readonly dayKey: string; readonly mood: number | null; readonly anxiety: number | null }[] {
  const byDay = new Map<string, { mood: number | null; anxiety: number | null }>();

  for (const [metricKey, rows] of byMetric) {
    if (metricKey !== 'mind.mood' && metricKey !== 'mind.anxiety') continue;

    for (const row of rows) {
      const dayKey = dayKeyInZone(row.observedAt, zone);
      const entry = byDay.get(dayKey) ?? { mood: null, anxiety: null };
      const value = Number(row.value);
      if (!Number.isFinite(value)) continue;

      byDay.set(
        dayKey,
        metricKey === 'mind.mood' ? { ...entry, mood: value } : { ...entry, anxiety: value },
      );
    }
  }

  return [...byDay.entries()].map(([dayKey, entry]) => ({ dayKey, ...entry }));
}

/**
 * How strongly a question mentions a thing, 0–1.
 *
 * Word-overlap, deliberately crude. §10.4 puts the sophistication in *ranking*
 * rather than in relevance scoring, and a cleverer matcher here would be
 * guessing at intent — which is the job of the retrieval plan, which already
 * ran. This only has to separate "mentioned" from "not mentioned" well enough
 * for the budget step to cut the right tail.
 */
function mentionScore(question: string, ...labels: readonly string[]): number {
  const asked = new Set(
    question
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 2),
  );
  if (asked.size === 0) return 0.3;

  for (const label of labels) {
    const words = label
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 2);

    if (words.some((word) => asked.has(word))) return 1;
  }

  /* Not mentioned is not irrelevant — a causal question wants context it did
   * not name. It ranks below anything that was named. */
  return 0.25;
}

function monthStartIso(zone: string): string {
  const nowIso = isoFromMillis(systemClock.nowMillis());
  const today = dayKeyInZone(nowIso, zone);
  return zonedDayBounds(`${today.slice(0, 7)}-01`, zone)?.start ?? nowIso;
}

/**
 * The JSON Schema for {@link answerSchema}, hand-written.
 *
 * Structured outputs need the raw form, and generating it from the Zod schema
 * would add a dependency to convert something that changes once a year. The
 * pair is kept in step by `invoke`, which validates the response against the
 * Zod schema regardless of what the API was told — so a drift between the two
 * fails closed rather than silently widening what is accepted.
 */
const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'paragraphs', 'omitted', 'answerable'],
  properties: {
    kind: {
      type: 'string',
      enum: ['temporal', 'causal', 'status', 'comparative', 'clinical', 'reflective'],
    },
    paragraphs: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['template', 'references'],
        properties: {
          template: {
            type: 'string',
            description:
              'Prose with no digits. Use {0}, {1} placeholders for every number and supply a reference for each.',
          },
          references: { type: 'array', maxItems: 12, items: { type: 'object' } },
        },
      },
    },
    omitted: { type: 'string', minLength: 1 },
    answerable: { type: 'boolean' },
  },
};
