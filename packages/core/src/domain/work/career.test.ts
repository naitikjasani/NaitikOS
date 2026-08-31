import { describe, expect, it } from 'vitest';

import {
  CAREER_GAP_DAYS,
  loggingGap,
  summarisePeriod,
  validateCareerEntry,
  type CareerEntry,
} from './career';

const dayKeyOf = (instant: string): string => instant.slice(0, 10);

const base: CareerEntry = {
  id: '01900000-0000-7000-8000-000000000001',
  kind: 'shipped',
  title: 'Shipped the outbox',
  detail: null,
  occurredAt: '2026-08-20T12:00:00.000Z',
  projectId: null,
  attributedTo: null,
  artifactUrl: null,
  isVisibleToLeadership: null,
  skills: [],
};

const entry = (overrides: Partial<CareerEntry>): CareerEntry => ({ ...base, ...overrides });

describe('validateCareerEntry', () => {
  it('requires a source for feedback', () => {
    const result = validateCareerEntry({
      id: base.id,
      kind: 'feedback',
      title: 'Good work on the migration',
      occurredAt: base.occurredAt,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('career_entry_attribution_missing');
  });

  it('requires a source for recognition too', () => {
    const result = validateCareerEntry({
      id: base.id,
      kind: 'recognition',
      title: 'Spot award',
      occurredAt: base.occurredAt,
      attributedTo: '  ',
    });
    expect(result.ok).toBe(false);
  });

  it('does not require a source for a shipped thing', () => {
    expect(
      validateCareerEntry({ id: base.id, kind: 'shipped', title: 'x', occurredAt: base.occurredAt }).ok,
    ).toBe(true);
  });

  it('refuses an occurredAt that is not an instant', () => {
    const result = validateCareerEntry({
      id: base.id,
      kind: 'shipped',
      title: 'x',
      occurredAt: 'last Tuesday',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('career_entry_occurred_invalid');
  });

  /*
   * `parseInstant` is `new Date(iso)`, which accepts a bare day key and reads
   * it as midnight UTC. That is the whole system's convention (§11.3 makes
   * `parseInstant` the one sanctioned entry point) and this asserts it rather
   * than tightening it here, because a validator stricter than every other
   * validator in the codebase is a trap for the next caller. In the operator's
   * zone the reading is 05:30 the same morning, so no day boundary moves.
   */
  it('accepts a bare day key, as midnight UTC', () => {
    expect(
      validateCareerEntry({ id: base.id, kind: 'shipped', title: 'x', occurredAt: '2026-08-20' }).ok,
    ).toBe(true);
  });
});

describe('loggingGap', () => {
  it('measures against occurredAt, so a backdated entry closes the gap it was written to close', () => {
    const backdated = entry({ occurredAt: '2026-08-29T12:00:00.000Z' });
    expect(loggingGap([backdated], '2026-08-30', dayKeyOf)).toBe(1);
  });

  it('returns null for an empty log rather than an alarming number', () => {
    expect(loggingGap([], '2026-08-30', dayKeyOf)).toBeNull();
  });

  it('takes the newest entry, not the last one in the array', () => {
    const gap = loggingGap(
      [entry({ occurredAt: '2026-08-28T12:00:00.000Z' }), entry({ occurredAt: '2026-01-02T12:00:00.000Z' })],
      '2026-08-30',
      dayKeyOf,
    );
    expect(gap).toBe(2);
  });

  it('crosses the nudge threshold at CAREER_GAP_DAYS', () => {
    const gap = loggingGap([entry({ occurredAt: '2026-08-16T12:00:00.000Z' })], '2026-08-30', dayKeyOf);
    expect(gap).toBe(CAREER_GAP_DAYS);
  });
});

describe('summarisePeriod', () => {
  const entries = [
    entry({ id: 'a', kind: 'shipped', occurredAt: '2026-03-02T12:00:00.000Z', isVisibleToLeadership: true, skills: ['Postgres', 'sql'] }),
    entry({ id: 'b', kind: 'feedback', occurredAt: '2026-05-10T12:00:00.000Z', attributedTo: 'Priya', isVisibleToLeadership: false, skills: ['postgres'] }),
    entry({ id: 'c', kind: 'incident', occurredAt: '2026-07-01T12:00:00.000Z', skills: [] }),
    entry({ id: 'outside', kind: 'shipped', occurredAt: '2025-12-31T12:00:00.000Z' }),
  ];

  const period = summarisePeriod(entries, '2026-01-01', '2026-12-31', dayKeyOf);

  it('excludes entries outside the window', () => {
    expect(period.total).toBe(3);
    expect(period.entries.map((e) => e.id)).not.toContain('outside');
  });

  it('counts every kind, including the ones with no entries', () => {
    expect(period.byKind.shipped).toBe(1);
    expect(period.byKind.incident).toBe(1);
    expect(period.byKind.role_change).toBe(0);
  });

  it('keeps unknown visibility separate from known-not-visible', () => {
    expect(period.visible).toBe(1);
    expect(period.notVisible).toBe(1);
    expect(period.visibilityUnknown).toBe(1);
  });

  it('folds skills case-insensitively and ranks by count', () => {
    expect(period.skills).toEqual([
      { skill: 'postgres', entries: 2 },
      { skill: 'sql', entries: 1 },
    ]);
  });

  it('orders entries newest first', () => {
    expect(period.entries.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });
});
