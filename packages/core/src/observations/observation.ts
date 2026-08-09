/**
 * The observation — the spine of the record (§9.1).
 *
 *   "Observations are append-only. This is not a stylistic preference; it is
 *    what makes a twenty-year record trustworthy. If a weight from 2027 can be
 *    silently edited in 2031, then no number in the system can be relied upon
 *    and the entire premise fails."
 *
 * These types are the shape of that row, framework-free. Three things about
 * them are worth stating because they are easy to "clean up" into wrongness.
 *
 * **Values are strings.** `value` is a decimal string, not a `number`, all the
 * way from the request body to Postgres. §5.3 bans floats for weight, dosage
 * and lab values; a `number` anywhere on that path reintroduces one.
 *
 * **There is no `update`.** There is no `deletedAt`, no `version`, and no
 * setter. A correction is {@link Supersession} — a *new* observation, with the
 * old one pointing at it, and both surviving forever. The database enforces
 * this with a `BEFORE UPDATE OR DELETE` trigger; the type system's job is to
 * make sure nobody writes the code that trigger would have to reject.
 *
 * **Provenance is mandatory.** `sourceId` is not optional, because §9.2 is not
 * hedging when it says "a derived value must be distinguishable from a measured
 * one forever, and a model-inferred value must be distinguishable from both".
 */

import type { Brand } from '@naitikos/shared';

import type { Hlc } from './hlc';
import type { MetricKey } from './metric';

export type ObservationId = Brand<string, 'ObservationId'>;
export type ObservationSourceId = Brand<string, 'ObservationSourceId'>;

/** Where a fact came from, in roughly descending trust (§9.2). */
export type SourceKind =
  | 'manual'
  | 'device_import'
  | 'derivation'
  | 'document_extraction'
  | 'model_inference';

export const SOURCE_KINDS: readonly SourceKind[] = [
  'manual',
  'device_import',
  'derivation',
  'document_extraction',
  'model_inference',
];

export type ObservationSource = {
  readonly id: ObservationSourceId;
  readonly kind: SourceKind;
  /** `apple_health`, `derivation:sleep_debt`, `claude-opus-5`, `manual`. */
  readonly identifier: string;
  /** Version of the importer, rule, or model. `null` for `manual`. */
  readonly version: string | null;
  readonly documentId: string | null;
};

/**
 * The polymorphic subject reference (§9.3(3)).
 *
 * Deliberately not a foreign key in the schema, so its consistency is this
 * layer's responsibility: both halves present or both absent, which is also a
 * check constraint (`observation_subject_paired`).
 */
export type ObservationSubject = {
  readonly type: string;
  readonly id: string;
};

/** A persisted observation. Every field is what the row holds. */
export type Observation = {
  readonly id: ObservationId;
  readonly metricKey: MetricKey;

  /** Decimal string. Booleans are `0`/`1`; categoricals are their ordinal. */
  readonly value: string;
  /**
   * Free text, for metrics with no numeric form.
   *
   * When this is set, `value` is `0` and carries no meaning — see
   * {@link TEXT_VALUE_PLACEHOLDER}.
   */
  readonly valueText: string | null;
  /** Denormalised from the metric at write time, on purpose (§9.2). */
  readonly unit: string;

  /** When the fact was true. */
  readonly observedAt: string;
  /** The IANA zone it was captured in (§5.3). */
  readonly observedZone: string;
  /** When the system was told. Diverges from `observedAt` constantly (§9.5). */
  readonly recordedAt: string;

  readonly sourceId: ObservationSourceId;
  /** 0–1. `null` means measured directly, with no uncertainty to record. */
  readonly confidence: string | null;

  readonly subjectType: string | null;
  readonly subjectId: string | null;

  readonly context: Readonly<Record<string, unknown>> | null;

  readonly supersededById: ObservationId | null;
  readonly supersededAt: string | null;
  readonly supersedeReason: string | null;

  readonly hlc: Hlc;
};

/**
 * The numeric stand-in for a text observation.
 *
 * `observation.value` is `NOT NULL` because every other value type needs it,
 * and a nullable column would weaken the invariant for the 95% of rows that do
 * carry a number. So a text observation stores zero here and the meaning lives
 * entirely in `valueText`.
 *
 * The alternative considered and rejected was storing the character count —
 * aggregatable, and superficially more useful. Rejected because a reader in
 * 2046 encountering `value = 47` on a journal line would have no way to know it
 * was a length rather than a measurement, and §9.10's self-describing
 * requirement is exactly about not doing that. A constant zero is legibly
 * meaningless, which is the honest option.
 *
 * The export's `schema.json` states this explicitly.
 */
export const TEXT_VALUE_PLACEHOLDER = '0';

/**
 * A correction, as recorded on the *old* row.
 *
 * §9.1: "write a new observation, point the old one's `supersededById` at it,
 * and both persist. The timeline can then be replayed as it was known at any
 * past moment."
 *
 * Note that this is the one write that touches an existing observation row, and
 * therefore the one exception the immutability trigger has to allow. It is
 * narrow by construction: three columns, set once, never cleared.
 */
export type Supersession = {
  readonly observationId: ObservationId;
  readonly supersededById: ObservationId;
  readonly supersededAt: string;
  readonly supersedeReason: string;
};

/* -------------------------------------------------------------------------
 * Input
 * ---------------------------------------------------------------------- */

/**
 * A value as submitted, before the registry has had a look at it.
 *
 * A discriminated union rather than `unknown`, so that "the client sent a
 * string where a boolean belongs" is a *parse* failure at the API boundary
 * rather than a coercion surprise three layers in. The `unit` on `number` is
 * what makes §9.2's "conversion happens at the edges" real: a scale reporting
 * pounds sends pounds and says so, and this layer converts to the metric's
 * canonical unit exactly once.
 *
 * ## Why the optional fields here say `| undefined` and elsewhere do not
 *
 * The repo runs `exactOptionalPropertyTypes`, under which `{ unit?: string }`
 * and `{ unit?: string | undefined }` are different types — the first forbids
 * the key being *present and undefined*. That distinction is valuable for
 * domain objects, where "absent" and "explicitly nothing" can mean different
 * things.
 *
 * It is meaningless for a type parsed out of JSON. `{"unit": null}` is rejected
 * by the schema and `{}` produces `undefined`; there is no third state to
 * distinguish. Insisting on the strict form here would mean every route handler
 * rebuilding a nested union field by field to launder a `string | undefined`
 * into a `string`, which is ceremony that introduces the typo it is protecting
 * against.
 *
 * So: **wire-facing input types admit `| undefined`; domain types do not.**
 * {@link Observation} above uses `| null` throughout for the same reason in
 * reverse — that is what a database read produces.
 */
export type ObservationValueInput =
  | { readonly kind: 'number'; readonly value: string; readonly unit?: string | undefined }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'text'; readonly value: string };

/**
 * One observation as submitted.
 *
 * `id` is optional but *should* be supplied: §5.7 wants client-generated
 * UUIDv7s so "a record created offline has its permanent identity from the
 * moment it exists". The server generates one only for callers that have no
 * offline story — a derivation job, an import.
 */
export type ObservationInput = {
  readonly id?: string;
  readonly metricKey: string;
  readonly value: ObservationValueInput;
  readonly observedAt: string;
  readonly observedZone: string;
  readonly subject?: ObservationSubject | null;
  readonly context?: Readonly<Record<string, unknown>> | null;
  /** 0–1, as a decimal string. */
  readonly confidence?: string | null;
  /** Set when this input corrects an existing observation (§9.1). */
  readonly supersedes?: { readonly id: string; readonly reason: string } | null;
};
