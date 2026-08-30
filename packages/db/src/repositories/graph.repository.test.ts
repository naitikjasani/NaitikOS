/**
 * The knowledge graph — integration, against real Postgres.
 *
 * `core/graph/reconcile.ts` decides and is tested there against a table of
 * cases. What only a database can answer is whether the five outcomes are
 * actually *applied* — and specifically whether removal is, because a caller
 * that applied additions and updates and quietly skipped removals would have
 * §10.2's accumulating graph and nothing would ever error.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { GraphEdge } from '@naitikos/core';
import { UNSUPPORTED_NIGHTS_BEFORE_REMOVAL, reconcileEdges } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createGraphRepository } from './graph.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

async function twoNodes(): Promise<{ readonly a: string; readonly b: string }> {
  if (db === undefined) throw new Error('no database');
  const graph = createGraphRepository(db);

  const a = await graph.upsertNode({ id: newId(), kind: 'metric', label: 'Sleep', entityType: null, entityId: null });
  const b = await graph.upsertNode({ id: newId(), kind: 'metric', label: 'Mood', entityType: null, entityId: null });
  if (!isOk(a) || !isOk(b)) throw new Error('nodes not created');

  return { a: a.value.id, b: b.value.id };
}

function edgeBetween(a: string, b: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    sourceNodeId: a,
    targetNodeId: b,
    type: 'CORRELATES_WITH',
    origin: 'computed',
    /* An edge weight is genuinely dimensionless: it is |rho|, a scalar used to
     * rank traversal, with no unit to confuse. §6.2's rule is about measured
     * quantities, and a rank-order correlation coefficient is not one. */
    // eslint-disable-next-line @naitikos/no-bare-quantity -- |rho| is dimensionless, see above.
    weight: 0.45,
    statistics: { method: 'spearman', n: 90, effect: 0.45, pValue: 0.002, windowDays: 90, lagDays: 0 },
    observationIds: ['obs-1', 'obs-2'],
    ...overrides,
  };
}

suite('graph repository', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await resetDomainTables(db.$client);
  });

  it('round-trips an edge with its statistics, which §10.2 requires it to keep', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    const applied = await graph.applyReconciliation(
      reconcileEdges({ derived: [edgeBetween(a, b)], stored: [] }),
      newId,
    );
    expect(isOk(applied)).toBe(true);

    const edges = await graph.edges();
    if (!isOk(edges)) return;

    expect(edges.value).toHaveLength(1);
    const stored = edges.value[0];

    /* The method specifically. "An edge built by Spearman over ranked taps and
     * one built by a binomial test over doses are different claims." */
    expect(stored?.statistics?.method).toBe('spearman');
    expect(stored?.statistics?.n).toBe(90);
    expect(stored?.type).toBe('CORRELATES_WITH');
    expect(stored?.observationIds).toEqual(['obs-1', 'obs-2']);
  });

  it('does not create a second copy when the same night is replayed', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    const plan = reconcileEdges({ derived: [edgeBetween(a, b)], stored: [] });
    await graph.applyReconciliation(plan, newId);
    /* The same plan again — a retried job, or two nights that overlapped. The
     * unique index is on (source, target, relation) and the insert must not
     * fail the transaction either. */
    await graph.applyReconciliation(plan, newId);

    const edges = await graph.edges();
    if (!isOk(edges)) return;
    expect(edges.value).toHaveLength(1);
  });

  it('washes an unsupported edge out over three nights, and keeps it for two', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    await graph.applyReconciliation(reconcileEdges({ derived: [edgeBetween(a, b)], stored: [] }), newId);

    for (let night = 1; night <= UNSUPPORTED_NIGHTS_BEFORE_REMOVAL; night += 1) {
      const current = await graph.edges();
      if (!isOk(current)) return;

      await graph.applyReconciliation(reconcileEdges({ derived: [], stored: current.value }), newId);

      const after = await graph.edges();
      if (!isOk(after)) return;

      if (night < UNSUPPORTED_NIGHTS_BEFORE_REMOVAL) {
        /* One unlogged Tuesday must not demolish ninety days of evidence. */
        expect(after.value).toHaveLength(1);
        expect(after.value[0]?.unsupportedNights).toBe(night);
      } else {
        /* §10.2: "the graph gets quieter as data accumulates and spurious early
         * associations wash out." */
        expect(after.value).toHaveLength(0);
      }
    }
  });

  it('soft-deletes rather than dropping the row, so the history survives', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    await graph.applyReconciliation(reconcileEdges({ derived: [edgeBetween(a, b)], stored: [] }), newId);
    const stored = await graph.edges();
    if (!isOk(stored)) return;

    await graph.applyReconciliation(
      reconcileEdges({
        derived: [],
        stored: stored.value.map((entry) => ({ ...entry, unsupportedNights: UNSUPPORTED_NIGHTS_BEFORE_REMOVAL })),
      }),
      newId,
    );

    /* §9.4. A graph that hard-deleted its own history could not answer "why did
     * the March review say that?". */
    const rows = await db.$client`select delete_reason from graph_edge where deleted_at is not null`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['delete_reason']).toBe('washed_out');
  });

  it('never washes out an asserted edge, however long the data disagrees', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    const belief = edgeBetween(a, b, { type: 'TRIGGERS', origin: 'asserted', statistics: null, weight: 1 });
    await graph.applyReconciliation(reconcileEdges({ derived: [belief], stored: [] }), newId);

    for (let night = 0; night < UNSUPPORTED_NIGHTS_BEFORE_REMOVAL + 2; night += 1) {
      const current = await graph.edges();
      if (!isOk(current)) return;
      await graph.applyReconciliation(reconcileEdges({ derived: [], stored: current.value }), newId);
    }

    const after = await graph.edges();
    if (!isOk(after)) return;

    /*
     * A belief is not the statistics' to delete. §10.2 records it *as* a
     * belief, which means it does not answer to a p-value — and a job that
     * deleted it would be the system overruling the person about their own
     * body.
     */
    expect(after.value).toHaveLength(1);
    expect(after.value[0]?.origin).toBe('asserted');
  });

  it('resets the decay counter when an edge comes back, without losing its statistics', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    await graph.applyReconciliation(reconcileEdges({ derived: [edgeBetween(a, b)], stored: [] }), newId);

    const first = await graph.edges();
    if (!isOk(first)) return;
    await graph.applyReconciliation(reconcileEdges({ derived: [], stored: first.value }), newId);

    const decayed = await graph.edges();
    if (!isOk(decayed)) return;
    expect(decayed.value[0]?.unsupportedNights).toBe(1);

    await graph.applyReconciliation(
      reconcileEdges({ derived: [edgeBetween(a, b)], stored: decayed.value }),
      newId,
    );

    const revived = await graph.edges();
    if (!isOk(revived)) return;
    expect(revived.value[0]?.unsupportedNights).toBe(0);
    /* The refresh path rewrites only the counter. Rewriting `properties`
     * wholesale would discard the statistics on every unchanged edge, which is
     * every refreshed edge by definition. */
    expect(revived.value[0]?.statistics?.method).toBe('spearman');
  });

  it('returns only outgoing neighbours, because PRECEDES is not symmetric', async () => {
    if (db === undefined) return;
    const graph = createGraphRepository(db);
    const { a, b } = await twoNodes();

    await graph.applyReconciliation(
      reconcileEdges({
        derived: [edgeBetween(a, b, { type: 'PRECEDES', statistics: { method: 'spearman', n: 90, effect: 0.5, pValue: 0.001, windowDays: 90, lagDays: 2 } })],
        stored: [],
      }),
      newId,
    );

    const forward = await graph.neighbours(a);
    const backward = await graph.neighbours(b);
    if (!isOk(forward) || !isOk(backward)) return;

    expect(forward.value).toHaveLength(1);
    expect(backward.value).toHaveLength(0);
  });
});
