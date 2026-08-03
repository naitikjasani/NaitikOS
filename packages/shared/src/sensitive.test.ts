import { describe, expect, it } from 'vitest';

import { REDACTED, Sensitive, isSensitive, sensitive } from './sensitive';

/**
 * These tests exist because blueprint §5.13 makes redaction a *structural*
 * guarantee rather than a policy. Each case below closes one escape route a
 * value could otherwise take to a log line. If any of them regress, the
 * guarantee is gone and §P7 is violated silently.
 */
describe('Sensitive', () => {
  const JOURNAL = 'Felt anxious before the 1:1. Slept badly.';

  it('exposes the original value only via expose()', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    expect(wrapped.expose()).toBe(JOURNAL);
  });

  it('redacts under JSON.stringify — the log-aggregator path', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    expect(JSON.stringify({ entry: wrapped })).toBe(`{"entry":"${REDACTED}"}`);
  });

  it('redacts under template interpolation', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    expect(`${wrapped}`).toBe(REDACTED);
  });

  it('redacts under String() coercion', () => {
    expect(String(sensitive(JOURNAL))).toBe(REDACTED);
  });

  it('redacts when nested inside a larger structure', () => {
    const payload = {
      id: 'obs-1',
      meta: { entry: sensitive(JOURNAL, 'journalEntry'), tags: ['work'] },
    };
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('anxious');
    expect(serialised).toContain(REDACTED);
  });

  it('reports a non-identifying label under Node inspection', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    const inspect = wrapped[Symbol.for('nodejs.util.inspect.custom') as never] as () => string;
    expect(inspect.call(wrapped)).toBe('Sensitive<journalEntry>');
  });

  it('keeps the result protected when mapped', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    const length = wrapped.map((text) => text.length, 'journalEntryLength');

    expect(length).toBeInstanceOf(Sensitive);
    expect(length.expose()).toBe(JOURNAL.length);
    expect(JSON.stringify(length)).toBe(`"${REDACTED}"`);
  });

  it('does not leak the value through Object.keys or spread', () => {
    const wrapped = sensitive(JOURNAL, 'journalEntry');
    expect(Object.values({ ...wrapped })).not.toContain(JOURNAL);
  });

  it('narrows unknown values', () => {
    expect(isSensitive(sensitive('x'))).toBe(true);
    expect(isSensitive('x')).toBe(false);
    expect(isSensitive(null)).toBe(false);
  });
});
