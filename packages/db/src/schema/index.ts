/**
 * The complete §9 schema.
 *
 * §2.1 puts all of this in the MVP deliberately, including the domains that
 * will not have a UI for a year:
 *
 *   "The complete §9 data model — *all* of it, even for domains not yet
 *    surfaced. The schema is the expensive thing to change later; the UI is
 *    not."
 *
 * This barrel is also drizzle-kit's entry point (`drizzle.config.ts`). A table
 * that is not reachable from here does not exist as far as migration generation
 * is concerned — so a new schema file must be re-exported below, or it will be
 * silently absent from the generated SQL.
 */

/** Column primitives and the physical conventions of §5.3. */
export * from './columns';

/** Enumerated vocabularies. */
export * from './enums';

/** Identity and configuration: profile, setting, feature_flag, crisis_plan. */
export * from './identity';

/** The substrate: metric, observation, source, sample, tags, rollups. */
export * from './substrate';

/** Medical — the bitemporal region (§9.5). */
export * from './medical';

/** Body: gym, composition, skin, and the shared routine engine. */
export * from './body';

/** Mind — the highest duty of care in the system (§4.7). */
export * from './mind';

/** Nutrition (V2 surface, MVP schema). */
export * from './nutrition';

/** Sleep — a full module from V3, an observation pair since week one (§4.6). */
export * from './sleep';

/** Work: projects, tasks, career log, learning, calendar, focus (§4.8). */
export * from './work';

/** Goals, insights, reviews, documents, media. */
export * from './crosscutting';

/** Embeddings, knowledge graph, model-call audit (§10). */
export * from './ai';

/** Audit, telemetry, sync, idempotency, jobs. */
export * from './operations';

/**
 * The event log, its timeline projection, deferred tasks, and the upload outbox.
 * See docs/adr/0005-domain-events-as-integration-log.md.
 */
export * from './events';
