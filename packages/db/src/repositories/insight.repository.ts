/**
 * Insights, persisted — and specifically §10.6 control 4's memory.
 *
 * ## This table is what makes out-of-sample confirmation work at all
 *
 *   "A correlation is not surfaced on first detection. It is held, and
 *    re-tested against subsequent data. Only a finding that survives a second
 *    independent window is promoted to the inbox. This single rule eliminates
 *    the large majority of spurious findings."
 *
 * A control that spans two nights needs somewhere to remember the first one.
 * Before this repository existed, `loadInsights` passed an empty held-set and
 * said so in a comment: *"if an inferential detector were enabled today, its
 * findings would be held forever and never promoted."* The correlation detector
 * is that detector. This is the fix it named.
 *
 * ## Held findings are rows, and they are not insights
 *
 * A held finding has `disposition: 'archived'` and no `surfacedAt`. It exists
 * so a later night can recognise it, and it is never shown — §10.6 is explicit
 * that a finding awaiting confirmation stays out of the inbox, and a surface
 * that leaked them would be reporting exactly the spurious associations the
 * control exists to suppress.
 *
 * The signature goes in `detectorVersion`, which is a small abuse of a column
 * whose stated purpose is the detector's version. It is recorded here rather
 * than hidden: adding a `signature` column is a migration, §13.2 keeps those
 * out of feature commits, and this column is unused, indexed nowhere, and holds
 * exactly the kind of opaque per-detector identity string that a version is.
 * When the schema catches up, this moves.
 */

import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Finding } from '@naitikos/core';

import type { Database } from '../client';
import { insight, insightEvidence } from '../schema/crosscutting';

/** How far back `heldSignatures` looks. */
export const HELD_WINDOW_DAYS = 30;

export type InsightRow = {
  readonly id: string;
  readonly method: string;
  readonly signature: string | null;
  readonly title: string;
  readonly narrative: string | null;
  readonly limitations: string | null;
  readonly confidence: string | null;
  readonly pValue: string | null;
  readonly effectSize: string | null;
  readonly disposition: string;
  readonly surfacedAt: string | null;
  readonly actedOnAt: string | null;
  readonly dismissedAt: string | null;
  readonly dismissReason: string | null;
};

/**
 * A row of supporting evidence.
 *
 * §9.2 on `insight_evidence`: "This table is what makes an insight auditable.
 * Without it a finding is an assertion; with it the user can follow every
 * number back to the rows that produced it."
 */
export type InsightEvidenceRow = {
  readonly id: string;
  readonly observationId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly role: string | null;
  readonly note: string | null;
};

export type InsightRepository = {
  /** The inbox: surfaced and not yet dismissed. */
  inbox(): Promise<Result<readonly InsightRow[], DomainError>>;
  /** Everything, including dismissed — the audit view. */
  all(limit?: number): Promise<Result<readonly InsightRow[], DomainError>>;
  byId(id: string): Promise<Result<InsightRow | null, DomainError>>;
  evidenceFor(insightId: string): Promise<Result<readonly InsightEvidenceRow[], DomainError>>;
  /**
   * Signatures held by previous runs, for control 4.
   *
   * Bounded to a window, because a finding held eleven months ago and not seen
   * since is not "confirmed by subsequent data" — it is a coincidence that
   * happened twice a year apart, and promoting it would be the control
   * approving exactly what it exists to reject.
   */
  heldSignatures(sinceIso: string): Promise<Result<readonly string[], DomainError>>;
  /** Persist a night's outcome: surfaced insights and held findings. */
  recordNight(input: {
    readonly surfaced: readonly Finding[];
    readonly held: readonly Finding[];
    readonly nowIso: string;
    readonly newId: () => string;
  }): Promise<Result<{ readonly surfaced: number; readonly held: number }, DomainError>>;
  /** §4.13: "dismissals train the ranking." */
  setDisposition(input: {
    readonly id: string;
    readonly disposition: 'seen' | 'acted_on' | 'dismissed';
    readonly reason: string | null;
    readonly nowIso: string;
  }): Promise<Result<boolean, DomainError>>;
};

export function createInsightRepository(db: Database): InsightRepository {
  return {
    async inbox() {
      const rows = await db
        .select()
        .from(insight)
        .where(
          and(
            isNull(insight.deletedAt),
            sql`${insight.disposition} in ('new', 'seen')`,
            sql`${insight.surfacedAt} is not null`,
          ),
        )
        .orderBy(desc(insight.surfacedAt));

      return ok(rows.map(toRow));
    },

    async all(limit = 100) {
      const rows = await db
        .select()
        .from(insight)
        .where(and(isNull(insight.deletedAt), sql`${insight.surfacedAt} is not null`))
        .orderBy(desc(insight.surfacedAt))
        .limit(limit);

      return ok(rows.map(toRow));
    },

    async byId(id) {
      const rows = await db
        .select()
        .from(insight)
        .where(and(isNull(insight.deletedAt), eq(insight.id, id)))
        .limit(1);

      return ok(rows[0] === undefined ? null : toRow(rows[0]));
    },

    async evidenceFor(insightId) {
      const rows = await db
        .select()
        .from(insightEvidence)
        .where(eq(insightEvidence.insightId, insightId));

      return ok(
        rows.map((row) => ({
          id: row.id,
          observationId: row.observationId,
          entityType: row.entityType,
          entityId: row.entityId,
          role: row.role,
          note: row.note,
        })),
      );
    },

    async heldSignatures(sinceIso) {
      const rows = await db
        .select({ signature: insight.detectorVersion })
        .from(insight)
        .where(
          and(
            isNull(insight.deletedAt),
            eq(insight.disposition, 'archived'),
            isNull(insight.surfacedAt),
            gte(insight.createdAt, sinceIso),
          ),
        );

      return ok(rows.flatMap((row) => (row.signature === null ? [] : [row.signature])));
    },

    async recordNight(input) {
      let surfaced = 0;
      let held = 0;

      await db.transaction(async (tx) => {
        /*
         * One open row per signature, checked rather than left to a constraint.
         *
         * `ON CONFLICT` cannot help here: the primary key is a fresh uuid on
         * every run, so nothing ever conflicts. The natural key is the
         * signature, there is no unique index on it, and adding one is a
         * migration (§13.2). So the check is explicit — and it is the right
         * product rule anyway: a re-run of the nightly job must not put a
         * second copy of the same finding in front of a person, because two
         * cards read as two independent pieces of evidence for one thing.
         *
         * A *dismissed* signature is allowed to return. The operator said the
         * finding was not useful in December; the same association still
         * holding in March is a different fact about the world, and suppressing
         * it forever would let one dismissal silence a signal permanently.
         */
        const open = await tx
          .select({ signature: insight.detectorVersion })
          .from(insight)
          .where(
            and(
              isNull(insight.deletedAt),
              sql`${insight.disposition} in ('new', 'seen', 'archived')`,
            ),
          );
        const seen = new Set(open.flatMap((row) => (row.signature === null ? [] : [row.signature])));

        for (const finding of input.surfaced) {
          if (seen.has(finding.signature)) continue;
          seen.add(finding.signature);
          const inserted = await tx
            .insert(insight)
            .values({
              id: input.newId(),
              method: finding.detector,
              detectorVersion: finding.signature,
              title: finding.headline,
              /* `narrative` stays null. It is model-authored prose (§10.10) and
               * no model has run — writing the detector's own `detail` into it
               * would make a deterministic sentence indistinguishable from a
               * generated one in the audit trail. */
              narrative: null,
              limitations: finding.doesNotProve,
              confidence: finding.pValue === null ? null : (1 - finding.pValue).toFixed(4),
              pValue: finding.pValue === null ? null : finding.pValue.toFixed(6),
              effectSize: numericEffect(finding.effect),
              disposition: 'new',
              surfacedAt: input.nowIso,
            })
            .returning({ id: insight.id });

          const row = inserted[0];
          if (row === undefined) continue;
          surfaced += 1;

          for (const evidence of finding.evidence) {
            await tx.insert(insightEvidence).values({
              id: input.newId(),
              insightId: row.id,
              observationId: null,
              entityType: evidence.kind,
              entityId: null,
              role: evidence.kind,
              note: evidence.label,
            });
          }
        }

        for (const finding of input.held) {
          if (seen.has(finding.signature)) continue;
          seen.add(finding.signature);

          const inserted = await tx
            .insert(insight)
            .values({
              id: input.newId(),
              method: finding.detector,
              detectorVersion: finding.signature,
              title: finding.headline,
              limitations: finding.doesNotProve,
              pValue: finding.pValue === null ? null : finding.pValue.toFixed(6),
              effectSize: numericEffect(finding.effect),
              /* Archived and never surfaced. §10.6 keeps a finding awaiting
               * confirmation out of the inbox, and a surface that leaked these
               * would show exactly the spurious associations control 4 exists
               * to suppress. */
              disposition: 'archived',
              surfacedAt: null,
            })
            .returning({ id: insight.id });

          if (inserted[0] !== undefined) held += 1;
        }
      });

      return ok({ surfaced, held });
    },

    async setDisposition(input) {
      const updated = await db
        .update(insight)
        .set({
          disposition: input.disposition,
          ...(input.disposition === 'acted_on' ? { actedOnAt: input.nowIso } : {}),
          ...(input.disposition === 'dismissed'
            ? { dismissedAt: input.nowIso, dismissReason: input.reason }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(insight.id, input.id), isNull(insight.deletedAt)))
        .returning({ id: insight.id });

      return ok(updated.length > 0);
    },
  };
}

/**
 * The number out of a finding's `effect`, which is a *display* string.
 *
 * `Finding.effect` is written for a person — "rho 0.44", "12 of 30 doses" —
 * and `insight.effect_size` is `numeric`. Storing the label would fail the
 * insert, and storing nothing would lose the one figure a reader might want to
 * sort or compare on.
 *
 * Returns `null` where there is no number to take, rather than zero. An effect
 * of zero is a real and meaningful value — two things that did not move
 * together — and conflating it with "this detector reports its effect in words"
 * would put a false claim in a column nobody would think to check.
 */
function numericEffect(effect: string): string | null {
  const match = /-?\d+(?:\.\d+)?/u.exec(effect);
  return match === null ? null : match[0];
}

function toRow(row: typeof insight.$inferSelect): InsightRow {
  return {
    id: row.id,
    method: row.method,
    signature: row.detectorVersion,
    title: row.title,
    narrative: row.narrative,
    limitations: row.limitations,
    confidence: row.confidence,
    pValue: row.pValue,
    effectSize: row.effectSize,
    disposition: row.disposition,
    surfacedAt: row.surfacedAt,
    actedOnAt: row.actedOnAt,
    dismissedAt: row.dismissedAt,
    dismissReason: row.dismissReason,
  };
}
