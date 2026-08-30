/**
 * Consent scopes — §10.10, P7.
 *
 *   "A scope that is off means the Context Engine **cannot retrieve that class
 *    at all** — enforced at retrieval, not at prompt assembly, so there is no
 *    path by which a prompt-construction bug leaks it."
 *
 * That sentence is the design. This file gives the Context Engine a predicate
 * it applies *before* a query runs, so an unconsented class is never in memory
 * to be leaked by a later mistake. Filtering at assembly would mean the data was
 * fetched, held, and then hopefully dropped — and "hopefully" is not a boundary.
 *
 * ## The blueprint and the schema disagree, and the blueprint wins here
 *
 * §10.10 specifies four **independently revocable** scopes: `metrics`,
 * `clinical`, `journal`, `media`. The database's `consent_scope` enum is a
 * *ladder* — `none | aggregates_only | non_clinical | clinical | journal` —
 * where granting journal implies granting everything below it.
 *
 * The ladder is strictly weaker: it cannot express "metrics on, clinical off",
 * which is a reasonable and likely configuration. This file therefore models
 * §10.10's four independent scopes as authoritative and provides
 * {@link fromStoredScope} as a **conservative projection** of the stored ladder
 * onto them — conservative meaning that where the two disagree, the narrower
 * reading wins.
 *
 * Reconciling the column is a migration, and §13.2 says migrations are never
 * bundled with features. Until it ships, this projection is the boundary and
 * the asymmetry is stated rather than hidden.
 */

/** §10.10's four data classes. */
export const CONSENT_SCOPES = Object.freeze(['metrics', 'clinical', 'journal', 'media'] as const);

export type ConsentScopeName = (typeof CONSENT_SCOPES)[number];

/**
 * A grant. **Every scope defaults to off**, per §10.10's table.
 *
 * Not `Partial<...>` — an absent key would default to whatever the reader
 * assumed, and a missing-key-means-allowed bug in a consent check is the exact
 * class of defect this whole file exists to prevent. All four are required and
 * all four default to `false`.
 */
export type ConsentGrant = Readonly<Record<ConsentScopeName, boolean>>;

export const NO_CONSENT: ConsentGrant = Object.freeze({
  metrics: false,
  clinical: false,
  journal: false,
  media: false,
});

/** The stored ladder, as the `consent_scope` column spells it. */
export type StoredConsentScope = 'none' | 'aggregates_only' | 'non_clinical' | 'clinical' | 'journal';

/**
 * Project the stored ladder onto §10.10's four scopes, conservatively.
 *
 * `media` is `false` at every rung, including `journal`. §10.10 marks it "Off,
 * **and per-invocation confirmed**" — a standing grant cannot satisfy a
 * per-invocation requirement, so no value of a stored column may turn it on.
 * The media path takes its grant from the invocation instead.
 */
export function fromStoredScope(stored: StoredConsentScope): ConsentGrant {
  switch (stored) {
    case 'none':
      return NO_CONSENT;
    case 'aggregates_only':
    case 'non_clinical':
      return { ...NO_CONSENT, metrics: true };
    case 'clinical':
      return { ...NO_CONSENT, metrics: true, clinical: true };
    case 'journal':
      return { ...NO_CONSENT, metrics: true, clinical: true, journal: true };
  }
}

/**
 * The classes of thing the Context Engine can retrieve, each mapped to the
 * scope that governs it.
 *
 * Exhaustive on purpose. A retrieval class with no entry here cannot be
 * requested — {@link canRetrieve} takes this type, so adding a new source of
 * data means deciding which consent scope covers it at the moment it is added,
 * rather than discovering later that it was never gated.
 */
export const RETRIEVAL_CLASSES = Object.freeze({
  observation: 'metrics',
  aggregate: 'metrics',
  finding: 'metrics',
  goal: 'metrics',
  workout: 'metrics',
  meal: 'metrics',

  condition: 'clinical',
  medication: 'clinical',
  lab: 'clinical',
  symptom: 'clinical',
  appointment: 'clinical',
  document: 'clinical',

  journal: 'journal',
  therapy_note: 'journal',

  photo: 'media',
} as const satisfies Readonly<Record<string, ConsentScopeName>>);

export type RetrievalClass = keyof typeof RETRIEVAL_CLASSES;

/** Whether this grant permits retrieving this class at all. */
export function canRetrieve(grant: ConsentGrant, retrievalClass: RetrievalClass): boolean {
  return grant[RETRIEVAL_CLASSES[retrievalClass]];
}

/**
 * The classes a grant permits, for a Context Engine that wants to ask once.
 *
 * Returned sorted so a context pack's provenance line is stable across calls —
 * §10.4's stable prefix is byte-identical or it does not cache.
 */
export function permittedClasses(grant: ConsentGrant): readonly RetrievalClass[] {
  return (Object.keys(RETRIEVAL_CLASSES) as RetrievalClass[])
    .filter((entry) => canRetrieve(grant, entry))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The crisis plan is outside every scope, at every rung, forever.
 *
 * §4.7 and the `crisis_plan_never_shared_with_ai` check constraint both say so;
 * this is the third statement of it, in the layer that would otherwise be the
 * one to get it wrong. It is a constant rather than a function because there is
 * no input that could change the answer.
 */
export const CRISIS_PLAN_IS_NEVER_RETRIEVABLE = true;
