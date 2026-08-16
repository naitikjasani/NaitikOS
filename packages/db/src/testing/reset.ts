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
  /* Gym */
  'workout_set',
  'workout_session',
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
  /* Goals — snapshots reference both, so they go first */
  'goal_progress_snapshot',
  'goal_target',
  'goal',
]);

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
