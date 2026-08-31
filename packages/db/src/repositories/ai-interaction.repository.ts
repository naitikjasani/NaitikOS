/**
 * The AI ledger — §9.2's "complete auditability of everything the AI layer has
 * ever done is a requirement, not a nicety".
 *
 * ## Every attempt, not every success
 *
 * A refused call, a blocked output and a call the budget stopped are all rows.
 * They are also the rows anyone investigating would actually want: a run of
 * refusals is a prompt problem, a run of blocks is a defect driving an eval
 * case (§10.10), and a month of budget rejections is the reason a feature went
 * quiet. Recording only successes would leave the ledger describing a system
 * that never had a bad day.
 *
 * ## The spend read is what makes the cap real
 *
 * §10.11 requires the monthly cap "enforced before the call", and
 * {@link AiInteractionRepository.spentThisMonth} is the number that enforcement
 * reads. It sums `cost_minor` over the calendar month — minor units, because
 * §5.3 keeps floats off the path money travels.
 */

import { and, desc, gte, isNotNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';

import type { Database } from '../client';
import { aiInteraction } from '../schema/ai';
import type { AiPurpose, ConsentScope } from '../schema/enums';

export type RecordInteractionInput = {
  readonly id: string;
  readonly purpose: AiPurpose;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costMinor: number;
  readonly latencyMs: number;
  /** What was granted *at the moment of the call*, never re-derived later. */
  readonly consentScope: ConsentScope;
  readonly succeeded: boolean;
  readonly blockedReason: string | null;
  readonly errorCode: string | null;
  /** SHA-256 of the returned content, so stored prose can be checked against it. */
  readonly outputHash: string | null;
};

export type SpendByPurpose = { readonly purpose: string; readonly costMinor: number; readonly calls: number };

export type InteractionSummary = {
  readonly totalMinor: number;
  readonly calls: number;
  readonly byPurpose: readonly SpendByPurpose[];
  /** Blocked or refused. §10.10 makes these defect signals rather than noise. */
  readonly blocked: number;
};

export type AiInteractionRepository = {
  record(input: RecordInteractionInput): Promise<Result<void, DomainError>>;
  /** Cents spent since `sinceIso`. The number the cap is checked against. */
  spentThisMonth(sinceIso: string): Promise<Result<number, DomainError>>;
  /** The settings-page breakdown. §10.11: "spend by task type is visible in settings." */
  summarySince(sinceIso: string): Promise<Result<InteractionSummary, DomainError>>;
};

export function createAiInteractionRepository(db: Database): AiInteractionRepository {
  return {
    async record(input) {
      await db.insert(aiInteraction).values({
        id: input.id,
        purpose: input.purpose,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cacheReadTokens: input.cacheReadTokens,
        cacheWriteTokens: input.cacheWriteTokens,
        costMinor: input.costMinor,
        currency: 'USD',
        latencyMs: input.latencyMs,
        consentScope: input.consentScope,
        outputHash: input.outputHash,
        blockedReason: input.blockedReason,
        succeeded: input.succeeded,
        errorCode: input.errorCode,
      });

      return ok(undefined);
    },

    async spentThisMonth(sinceIso) {
      const rows = await db
        .select({ total: sql<string>`coalesce(sum(${aiInteraction.costMinor}), 0)` })
        .from(aiInteraction)
        .where(and(gte(aiInteraction.createdAt, sinceIso), isNotNull(aiInteraction.costMinor)));

      return ok(Number(rows[0]?.total ?? 0));
    },

    async summarySince(sinceIso) {
      const rows = await db
        .select({
          purpose: aiInteraction.purpose,
          costMinor: sql<string>`coalesce(sum(${aiInteraction.costMinor}), 0)`,
          calls: sql<string>`count(*)`,
          blocked: sql<string>`count(*) filter (where ${aiInteraction.blockedReason} is not null)`,
        })
        .from(aiInteraction)
        .where(gte(aiInteraction.createdAt, sinceIso))
        .groupBy(aiInteraction.purpose)
        .orderBy(desc(sql`sum(${aiInteraction.costMinor})`));

      const byPurpose = rows.map((row) => ({
        purpose: row.purpose,
        costMinor: Number(row.costMinor),
        calls: Number(row.calls),
      }));

      return ok({
        totalMinor: byPurpose.reduce((sum, entry) => sum + entry.costMinor, 0),
        calls: byPurpose.reduce((sum, entry) => sum + entry.calls, 0),
        byPurpose,
        blocked: rows.reduce((sum, row) => sum + Number(row.blocked), 0),
      });
    },
  };
}
