/**
 * The correlation detector, tested mostly on what it refuses to do.
 *
 * §10.6's argument is that a naive implementation "would produce a confident,
 * plausible, wrong insight most days". Every refusal below is one of the
 * controls that stops that, and each is easier to remove than to notice missing.
 */

import { describe, expect, it } from 'vitest';

import { shiftDayKey } from '../temporal/instant';
import type { CorrelationPair, MetricSeries } from './correlation';
import { MIN_PAIRED_OBSERVATIONS, MIN_REPORTABLE_RHO, detectCorrelation } from './correlation';

const PAIR: CorrelationPair = {
  id: 'sleep_duration.mood',
  x: 'body.sleep.duration',
  y: 'mind.mood',
  mechanism: 'Sleep restriction has a well-established effect on next-day affect.',
  provenance: 'pre_registered',
};

function series(metricKey: string, label: string, values: readonly number[], from = '2026-01-01'): MetricSeries {
  return {
    metricKey,
    label,
    points: values.map((value, index) => ({ dayKey: shiftDayKey(from, index) ?? from, value })),
  };
}

/** A strong, non-trivial monotone relationship over `n` days. */
function related(n: number): { x: MetricSeries; y: MetricSeries } {
  const xs = Array.from({ length: n }, (_, index) => 5 + ((index * 3) % 5));
  const ys = xs.map((value, index) => value * 2 + (index % 2));
  return { x: series('body.sleep.duration', 'Sleep', xs), y: series('mind.mood', 'Mood', ys) };
}

describe('correlation detector', () => {
  it('produces nothing before day 60, and says why', () => {
    /* §10.6 control 5. Unlike adherence there is no descriptive fallback — a
     * correlation is an inference by construction. */
    const { x, y } = related(120);
    const outcome = detectCorrelation({ pair: PAIR, x, y, dayKey: '2026-06-01', inferentialAllowed: false });

    expect(outcome.findings).toHaveLength(0);
    expect(outcome.insufficient).toHaveLength(1);
    expect(outcome.insufficient[0]?.message).toContain('sixty days');
  });

  it('refuses below thirty paired days and reports the shortfall', () => {
    /* §10.6 control 1, and the message tells the operator what would fix it —
     * "not enough data yet" is honest and builds trust. */
    const { x, y } = related(20);
    const outcome = detectCorrelation({ pair: PAIR, x, y, dayKey: '2026-06-01', inferentialAllowed: true });

    expect(outcome.findings).toHaveLength(0);
    expect(outcome.insufficient[0]?.required).toBe(MIN_PAIRED_OBSERVATIONS);
    expect(outcome.insufficient[0]?.available).toBeLessThan(MIN_PAIRED_OBSERVATIONS);
  });

  it('counts only days where both metrics were recorded', () => {
    /* Ninety days of sleep against thirty of mood is thirty pairs, not ninety.
     * Counting the longer series would clear the gate on data that is not
     * there. */
    const xs = Array.from({ length: 90 }, (_, index) => index % 7);
    const outcome = detectCorrelation({
      pair: PAIR,
      x: series('body.sleep.duration', 'Sleep', xs),
      y: series('mind.mood', 'Mood', xs.slice(0, 10)),
      dayKey: '2026-06-01',
      inferentialAllowed: true,
    });

    expect(outcome.findings).toHaveLength(0);
    expect(outcome.insufficient[0]?.available).toBeLessThan(MIN_PAIRED_OBSERVATIONS);
  });

  it('surfaces a strong association as exploratory, never as confirmed', () => {
    /*
     * §10.6 control 4 belongs to the battery, which recognises the same finding
     * across two independent windows. A detector able to promote its own
     * finding would defeat it entirely.
     */
    const { x, y } = related(120);
    const outcome = detectCorrelation({ pair: PAIR, x, y, dayKey: '2026-06-01', inferentialAllowed: true });

    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.confidence).toBe('exploratory');
  });

  it('declines a true but trivial association', () => {
    /*
     * The problem no amount of FDR control addresses. At large n a rho of 0.15
     * clears any significance threshold and describes about two percent of the
     * variation — true, uninteresting, and indistinguishable to a reader from
     * something that matters.
     */
    const n = 400;
    const xs = Array.from({ length: n }, (_, index) => (index * 17) % 23);
    const ys = xs.map((value, index) => ((index * 29) % 31) + (index % 200 === 0 ? value : 0));

    const outcome = detectCorrelation({
      pair: PAIR,
      x: series('body.sleep.duration', 'Sleep', xs),
      y: series('mind.mood', 'Mood', ys),
      dayKey: '2026-06-01',
      inferentialAllowed: true,
    });

    for (const finding of outcome.findings) {
      expect(Math.abs(Number(finding.effect.replace('rho ', '')))).toBeGreaterThanOrEqual(MIN_REPORTABLE_RHO);
    }
  });

  it('carries the three-part caveat on every finding', () => {
    const { x, y } = related(120);
    const finding = detectCorrelation({
      pair: PAIR,
      x,
      y,
      dayKey: '2026-06-01',
      inferentialAllowed: true,
    }).findings[0];

    expect(finding?.doesNotProve).toContain('not a cause');
    /* The one a reader is least likely to think of and most likely to be the
     * actual explanation: both taps come from the same person on the same day. */
    expect(finding?.doesNotProve).toContain('same day');
  });

  it('never says the word "causes"', () => {
    /* §10.2: no edge is ever labelled causal, and prose is an edge the reader
     * traverses. */
    const { x, y } = related(120);
    const finding = detectCorrelation({
      pair: PAIR,
      x,
      y,
      dayKey: '2026-06-01',
      inferentialAllowed: true,
    }).findings[0];

    const prose = `${finding?.headline ?? ''} ${finding?.detail ?? ''}`;
    expect(prose.toLowerCase()).not.toMatch(/\bcaus(?:e|es|ed|ing)\b/u);
    expect(prose.toLowerCase()).not.toMatch(/\bbecause\b/u);
  });

  it('cites the registered mechanism as evidence', () => {
    /* §10.6 control 3. A finding whose hypothesis is not on the record is one
     * nobody declared in advance. */
    const { x, y } = related(120);
    const finding = detectCorrelation({
      pair: PAIR,
      x,
      y,
      dayKey: '2026-06-01',
      inferentialAllowed: true,
    }).findings[0];

    expect(finding?.evidence.some((entry) => entry.kind === 'hypothesis')).toBe(true);
  });

  it('gives the same finding the same id across runs, so confirmation can work', () => {
    /* Control 4 recognises a repeat by id. A per-run id would mean nothing was
     * ever confirmed and every correlation stayed held forever. */
    const { x, y } = related(120);
    const first = detectCorrelation({ pair: PAIR, x, y, dayKey: '2026-06-01', inferentialAllowed: true });
    const second = detectCorrelation({ pair: PAIR, x, y, dayKey: '2026-06-01', inferentialAllowed: true });

    expect(first.findings[0]?.id).toBe(second.findings[0]?.id);
  });
});
