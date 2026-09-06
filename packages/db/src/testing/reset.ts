/**
 * The integration-test reset, in one place.
 *
 * ## Why this is a module and not four copies of a `beforeEach`
 *
 * Every integration suite shares one local database, so each has to clear the
 * tables it touches. That was fine with one suite. With two it stopped being
 * fine in a specific and annoying way: the Health suite left `condition` rows
 * behind, and the Mind/Skin suite's `delete from medical_event` — written
 * before Health existed — started failing on a foreign key, sixteen tests at a
 * time, in a file nobody had edited.
 *
 * The information that keeps being rediscovered is the **order**, and it is a
 * property of the schema rather than of any one test. So it lives here, once,
 * and a new domain adds a line rather than breaking an unrelated suite.
 *
 * ## The observation trigger
 *
 * §9.1 enforces append-only with a `BEFORE UPDATE OR DELETE` trigger, so the
 * log cannot be cleared without disabling it. That is exactly as intended: this
 * is the only code in the repository that does it, and it is test-only.
 */

import type { Sql } from 'postgres';

/**
 * Every domain table, in an order that satisfies the foreign keys.
 *
 * Children before parents; `medical_event` last of the clinical block because
 * §9.3 makes it the supertype every clinical subtype points at.
 */
export const RESET_ORDER: readonly string[] = Object.freeze([
  /* Skin */
  'skin_region_state',
  'skin_state',
  'product_event',
  'skincare_product',
  /* The routine engine */
  'routine_log',
  'routine_step',
  'routine',
  /* Mind */
  'anxiety_episode',
  'journal_entry',
  'practice_session',
  /* Gym — sets before sessions, sessions before the program they cite */
  'workout_set',
  'workout_session',
  'program_block',
  'program',
  /* Health core — subtypes first */
  'lab_result',
  'lab_panel',
  'appointment',
  'side_effect',
  'symptom',
  'condition',
  'medication_event',
  'medication_schedule',
  'medication',
  'treatment_course',
  'procedure',
  'medical_event',
  /* The document vault */
  'document_extraction',
  'document',
  /* Nutrition — items before meals, versions before foods */
  'meal_item',
  'meal',
  'meal_template',
  'nutrition_target',
  'food_nutrient',
  'food_version',
  'food',
  /* Goals — snapshots reference both, so they go first */
  'goal_progress_snapshot',
  'goal_target',
  'goal',
  /* Predictions and the Life Timeline — events reference spans */
  'life_event',
  'life_span',
  'prediction',
  /* Money — shopping references transactions, which reference accounts */
  'shopping_item',
  'money_transaction',
  'account_balance',
  'budget',
  'subscription',
  'financial_account',
  /* Sleep */
  'sleep_night',
  /* Work — focus sessions reference both tasks and projects, so they lead */
  'focus_session',
  'career_entry',
  'task',
  'project',
  'learning_item',
  'calendar_event',
  /* Insights — evidence references the insight */
  'insight_evidence',
  'insight',
  /* Saved lines of enquiry — turns before threads */
  'ask_turn',
  'ask_thread',
  /* People and places — interactions before people, visits before places and trips */
  'interaction',
  'person',
  'visit',
  'trip',
  'place',
  /*
   * Device samples. Nothing references them, so position is free — but they
   * are cleared, unlike `observation_source`, because a re-import test that
   * inherited last suite's rows would see duplicates it did not create.
   */
  'sample',
  /* The knowledge graph — edges reference nodes on both ends */
  'graph_edge',
  'graph_node',
  /*
   * Media. Four tables carry a foreign key to `media_object`, so all four go
   * first. `media_access_log` is included despite reading like operational
   * logging: §9.10 makes it a record of who looked at a photograph, which is
   * domain data with a foreign key, and a stale row here fails an insert
   * exactly as a stale `condition` row once did.
   */
  'media_access_log',
  'media_attachment',
  'media_thumbnail',
  'upload_outbox',
  'media_object',
  /* Tags — the join before the vocabulary it cites */
  'entity_tag',
  'tag',
  /* Domain tables with no dependants, added when the gap below was found */
  'body_measurement',
  'therapy_session',
  'note',
  'crisis_plan',
  'review',
  /* Embeddings and remembered facts (§10.2, §10.4) */
  'embedding',
  'memory_fact',
]);

/**
 * What is deliberately *not* here, so the question is not re-asked.
 *
 * The fourteen entries above were missing until 7 September 2026 — found while
 * writing `docs/runbooks/migration.md`, by listing every table in the database
 * and subtracting this array. None of them leaks today, because no suite writes
 * to them yet. Each was one test away from the failure this file's header
 * describes, which is the same reason `program` and `program_block` were added
 * after a count returned 9 instead of 1.
 *
 * Everything still absent falls into one of four groups, and none of them is an
 * oversight:
 *
 * - **Seeded reference data** the suites read rather than write: `metric`,
 *   `exercise`, `food`-adjacent rows, `journal_prompt`, `feature_flag`. The
 *   seed script populates these once; clearing them would break every suite
 *   that assumes a registered metric key exists.
 * - **`observation` and `observation_source`**, handled above and below for the
 *   reasons given there.
 * - **Derived projections** rebuilt from their inputs — `timeline_entry`,
 *   `metric_rollup`. A stale row is overwritten rather than accumulated, and a
 *   projector test that needs a clean slate should say so itself.
 * - **Operational tables** that are not domain data: `job_run`, `app_event`,
 *   `app_metric`, `domain_event`, `event_handled`, `event_dead_letter`,
 *   `deferred_task`, `idempotency_record`, `sync_state`, `setting`,
 *   `auth_identity`, `ai_interaction`, `schema_migration`, and the `sample_*`
 *   partitions, which are cleared through their parent.
 *
 * `audit_log` is the one judgement call. §9.4 calls it domain data rather than
 * operational logging — "application logs expire, this does not" — and it is
 * retained forever. It stays out because a suite asserting on the audit trail
 * of its *own* writes wants the rows it just made, and clearing the table
 * between tests within a file would defeat that. A suite that needs it empty
 * should clear it explicitly, and thereby say why.
 *
 * `profile` is a singleton with a database constraint enforcing it, so
 * deleting it would break every suite that resolves the profile.
 */

/**
 * Clear the observation log and every domain table.
 *
 * `observation_source` is deliberately **not** cleared. The rows are resolved
 * on demand and cached per process (`manualSourceId`), so deleting them between
 * tests would leave a repository holding an id that no longer exists — a
 * failure that appears in whichever test happens to run second.
 */
export async function resetDomainTables(sql: Sql): Promise<void> {
  await sql`alter table observation disable trigger observation_append_only`;
  await sql`delete from observation`;
  await sql`alter table observation enable trigger observation_append_only`;

  for (const table of RESET_ORDER) {
    await sql.unsafe(`delete from ${table}`);
  }
}
