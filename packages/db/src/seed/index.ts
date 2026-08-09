/**
 * Seed runner — `pnpm db:seed`.
 *
 * Two categories of data, with very different rules.
 *
 * **Reference data** — the metric registry, feature flags. This is not test
 * fixture material; it is data the application requires in order to function,
 * because §9.2 rejects unregistered metric keys on write. It is seeded in every
 * environment including production, and it is idempotent.
 *
 * **Synthetic data** — §5.15 permits it in `local` and `preview` only, and
 * "never production". Not implemented yet; when it is, it goes behind the
 * {@link isLocalDatabase} guard below rather than behind a NODE_ENV check,
 * because an environment variable is a weaker guarantee than a hostname.
 */

import { sql } from 'drizzle-orm';
/* §4.0's cap. Imported rather than restated: the Close's form generator
 * enforces the same number, and two copies of a budget is one copy too many. */
import { DAILY_CLOSE_ELEMENT_BUDGET } from '@naitikos/core';

import { createDatabase } from '../client';
import { databaseUrl, isLocalDatabase } from '../env';
import { metric } from '../schema/substrate';
import { featureFlag } from '../schema/identity';
import { createExerciseRepository } from '../repositories/exercise.repository';
import { DAILY_CLOSE_METRICS, MVP_METRICS } from './metrics';
import { SEED_EXERCISES } from './exercises';

/**
 * Feature flags the application expects to exist.
 *
 * The AI kill switch is here from day one even though there is no AI in the MVP
 * (§2.1: "No LLM in the MVP path at all"). §5.10 requires the switch to exist
 * and to be provably sufficient — "the acceptance test for the flag is that the
 * whole product still works with it off" — and a flag that is added at the same
 * time as the feature it disables has never been tested in the off position.
 */
const FEATURE_FLAGS = [
  {
    key: 'ai.enabled',
    enabled: false,
    description:
      'Master kill switch for the entire AI layer (§5.10). When false, every AI code path is bypassed and the application must remain fully functional. Off by default; the MVP ships with no LLM in any path.',
  },
  {
    key: 'ai.journal_access',
    enabled: false,
    description:
      'Whether journal content may enter an inference context (§10.10). Journal text is the most sensitive data in the system (§4.7); this stays off unless explicitly granted per action.',
  },
  {
    key: 'insights.enabled',
    enabled: false,
    description:
      'Whether the insight inbox surfaces findings. §10 holds insights until day 60: "An early wrong insight costs more trust than sixty days of silence."',
  },
  {
    key: 'sync.outbox',
    enabled: true,
    description:
      'Offline outbox write path (§5.7). On by default — the PWA must be usable in a gym basement with no signal.',
  },
] as const;

async function main(): Promise<void> {
  const url = databaseUrl();
  const db = createDatabase(url);

  // §4.0's budget, checked here rather than trusted. A registry that quietly
  // grows past the cap is how the sixty-second ritual becomes a two-minute
  // form, which §1.5 names as the way the North Star gets gamed against its
  // own purpose.
  if (DAILY_CLOSE_METRICS.length > DAILY_CLOSE_ELEMENT_BUDGET) {
    throw new Error(
      `Daily Close has ${String(DAILY_CLOSE_METRICS.length)} metrics, over the §4.0 budget of ` +
        `${String(DAILY_CLOSE_ELEMENT_BUDGET)}. Adding a field requires removing a field.`,
    );
  }

  console.log(`Seeding ${url.includes('localhost') ? 'local' : 'remote'} database.`);

  /* --- Metric registry ------------------------------------------------ */
  for (const m of MVP_METRICS) {
    await db
      .insert(metric)
      .values({
        key: m.key,
        domain: m.domain,
        displayName: m.displayName,
        description: m.description,
        valueType: m.valueType,
        canonicalUnit: m.canonicalUnit,
        minValue: m.minValue,
        maxValue: m.maxValue,
        aggregation: m.aggregation,
        // Written even though no MVP metric is categorical yet. A column the
        // seeder never populates is one that is silently wrong the first time
        // it matters, and the export reads it to decode ordinals (§9.10).
        allowedValues: m.allowedValues,
        inDailyClose: m.inDailyClose,
      })
      .onConflictDoUpdate({
        target: metric.key,
        set: {
          displayName: sql`excluded.display_name`,
          description: sql`excluded.description`,
          valueType: sql`excluded.value_type`,
          canonicalUnit: sql`excluded.canonical_unit`,
          minValue: sql`excluded.min_value`,
          maxValue: sql`excluded.max_value`,
          aggregation: sql`excluded.aggregation`,
          allowedValues: sql`excluded.allowed_values`,
          inDailyClose: sql`excluded.in_daily_close`,
          updatedAt: sql`now()`,
        },
      });
  }
  console.log(`  metric              ${String(MVP_METRICS.length)} rows`);
  console.log(`  └─ in Daily Close   ${String(DAILY_CLOSE_METRICS.length)} of ${String(DAILY_CLOSE_ELEMENT_BUDGET)} budget`);

  /* --- Feature flags -------------------------------------------------- */
  for (const f of FEATURE_FLAGS) {
    await db
      .insert(featureFlag)
      .values({ key: f.key, enabled: f.enabled, description: f.description })
      // Description is refreshed; `enabled` is NOT, so a deliberate runtime
      // toggle is never silently reverted by a redeploy.
      .onConflictDoUpdate({
        target: featureFlag.key,
        set: { description: sql`excluded.description`, updatedAt: sql`now()` },
      });
  }
  console.log(`  feature_flag        ${String(FEATURE_FLAGS.length)} rows`);

  /* --- Exercise library (§12 week 3) ---------------------------------- */
  /*
   * Reference data, not fixtures. §4.1's logger is built around confirming
   * numbers rather than typing them, and an empty library makes the first
   * session forty minutes of data entry — the exact friction the module exists
   * to remove. Idempotent on the slug; `form_notes` is never overwritten,
   * because it is the operator's own column.
   */
  const exercises = await createExerciseRepository(db).upsert(SEED_EXERCISES);
  if (!exercises.ok) throw new Error(`Exercise seed failed: ${exercises.error.message}`);
  console.log(`  exercise            ${String(exercises.value)} rows`);

  if (isLocalDatabase(url)) {
    console.log('  synthetic data      not implemented yet (§5.15 local/preview only)');
  }

  console.log('Seed complete.');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exit(1);
  });
