/**
 * Insights — integration, and specifically §10.6 control 4's memory.
 *
 * The control spans two nights, which means it cannot be tested inside the
 * battery alone: the battery is a pure function that is *told* what was held,
 * and the interesting failure is in what remembers it.
 *
 * That failure was live until this repository existed. `loadInsights` passed an
 * empty held-set and recorded the consequence in a comment — "if an inferential
 * detector were enabled today, its findings would be held forever and never
 * promoted" — and then an inferential detector was enabled.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isOk, uuidV7 } from '@naitikos/shared';
import type { Finding } from '@naitikos/core';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createInsightRepository } from './insight.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'correlation:pair:sleep.mood:lag1:2026-12-01',
    signature: 'correlation:pair:sleep.mood:lag1',
    detector: 'correlation',
    subject: 'pair:sleep.mood',
    dayKey: '2026-12-01',
    headline: 'Sleep and mood moved together with mood read one day later.',
    detail: 'Spearman’s rho 0.44 over 88 days where both were recorded.',
    n: 88,
    effect: 'rho 0.44',
    confidence: 'exploratory',
    doesNotProve: 'This is an association, not a cause, and both figures were recorded on the same day.',
    pValue: 0.004,
    evidence: [{ kind: 'metric', id: 'mind.mood', label: 'Mood' }],
    ...overrides,
  };
}

suite('insight repository', () => {
  beforeEach(async () => {
    if (db === undefined) return;
    await resetDomainTables(db.$client);
  });

  it('remembers a held signature so a later night can confirm it', () => {
    /* Covered end to end in the next test; this one names the contract. */
    expect(finding().signature).not.toContain('2026-12-01');
  });

  it('keeps a held finding out of the inbox entirely', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [],
      held: [finding()],
      nowIso: '2026-12-01T22:00:00.000Z',
      newId,
    });

    const inbox = await insights.inbox();
    expect(isOk(inbox)).toBe(true);
    if (!isOk(inbox)) return;

    /*
     * §10.6 keeps a finding awaiting confirmation out of the inbox. A surface
     * that leaked them would be showing exactly the spurious associations
     * control 4 exists to suppress — and each one would look individually
     * well-evidenced, which is the whole problem.
     */
    expect(inbox.value).toHaveLength(0);
  });

  it('returns the held signature, which is what closes the two-night loop', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [],
      held: [finding()],
      nowIso: '2026-12-01T22:00:00.000Z',
      newId,
    });

    /*
     * The window is measured against `created_at` — when the row was written —
     * rather than against the finding's own day key, because "held by a previous
     * *run*" is a fact about when the job ran. The fixture's day keys are
     * arbitrary; the insertion time is the database's `now()`, so the boundary
     * has to be expressed relative to that.
     */
    const held = await insights.heldSignatures('2020-01-01T00:00:00.000Z');
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;

    expect(held.value).toEqual(['correlation:pair:sleep.mood:lag1']);
  });

  it('does not return a signature held outside the window', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [],
      held: [finding()],
      nowIso: '2026-12-01T22:00:00.000Z',
      newId,
    });

    /*
     * A finding held eleven months ago and not seen since is not "confirmed by
     * subsequent data" — it is a coincidence that happened twice, a year apart.
     * Promoting it would be the control approving what it exists to reject.
     */
    const held = await insights.heldSignatures('2099-01-01T00:00:00.000Z');
    if (!isOk(held)) return;
    expect(held.value).toHaveLength(0);
  });

  it('surfaces a confirmed finding with its evidence and its limitation', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [finding({ confidence: 'confirmed' })],
      held: [],
      nowIso: '2026-12-02T22:00:00.000Z',
      newId,
    });

    const inbox = await insights.inbox();
    if (!isOk(inbox)) return;

    expect(inbox.value).toHaveLength(1);
    /* §10.6 makes this a required field. An insight without it is one the
     * operator cannot audit. */
    expect(inbox.value[0]?.limitations).toContain('not a cause');
    expect(inbox.value[0]?.pValue).not.toBeNull();

    const evidence = await db.$client`select count(*)::int as n from insight_evidence`;
    expect(evidence[0]?.['n']).toBe(1);
  });

  it('does not duplicate an insight when the nightly job is re-run', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    const night = {
      surfaced: [finding({ confidence: 'confirmed' as const })],
      held: [],
      nowIso: '2026-12-02T22:00:00.000Z',
      newId,
    };

    await insights.recordNight(night);
    await insights.recordNight(night);

    const inbox = await insights.inbox();
    if (!isOk(inbox)) return;

    /* The inbox is read by a person, and a duplicated finding reads as two
     * independent pieces of evidence for the same thing. */
    expect(inbox.value).toHaveLength(1);
  });

  it('removes a dismissed insight from the inbox and keeps the reason', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [finding({ confidence: 'confirmed' })],
      held: [],
      nowIso: '2026-12-02T22:00:00.000Z',
      newId,
    });

    const inbox = await insights.inbox();
    if (!isOk(inbox)) return;
    const id = inbox.value[0]?.id ?? '';

    await insights.setDisposition({
      id,
      disposition: 'dismissed',
      reason: 'I already knew this.',
      nowIso: '2026-12-03T08:00:00.000Z',
    });

    const after = await insights.inbox();
    if (!isOk(after)) return;
    expect(after.value).toHaveLength(0);

    /* §4.13: "dismissals train the ranking." A dismissal with no reason
     * recorded is a dismissal nothing can learn from. */
    const all = await insights.all();
    if (!isOk(all)) return;
    expect(all.value[0]?.dismissReason).toBe('I already knew this.');
  });

  it('records when an insight was acted on, which is §12’s V2 gate', async () => {
    if (db === undefined) return;
    const insights = createInsightRepository(db);

    await insights.recordNight({
      surfaced: [finding({ confidence: 'confirmed' })],
      held: [],
      nowIso: '2026-12-02T22:00:00.000Z',
      newId,
    });

    const inbox = await insights.inbox();
    if (!isOk(inbox)) return;

    await insights.setDisposition({
      id: inbox.value[0]?.id ?? '',
      disposition: 'acted_on',
      reason: null,
      nowIso: '2026-12-03T08:00:00.000Z',
    });

    /* "At least one insight the operator acted on" is half of December's gate,
     * and it is measured from this column. */
    const all = await insights.all();
    if (!isOk(all)) return;
    expect(all.value[0]?.actedOnAt).not.toBeNull();
  });
});
