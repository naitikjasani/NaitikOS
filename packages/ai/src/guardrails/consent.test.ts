/**
 * §10.10's consent scopes.
 *
 * The tests that matter are the ones asserting a *default* and a *projection*,
 * because both are places where a wrong answer is silent: nothing errors when
 * data the operator never consented to reaches a prompt.
 */

import { describe, expect, it } from 'vitest';

import { NO_CONSENT, canRetrieve, fromStoredScope, permittedClasses } from './consent';

describe('consent', () => {
  it('defaults every scope to off', () => {
    /* §10.10's table says "Off" in all four rows. A default of on for anything
     * would mean the first call after a fresh install leaked. */
    expect(NO_CONSENT).toEqual({ metrics: false, clinical: false, journal: false, media: false });
  });

  it('never grants media from a stored scope, at any rung', () => {
    /*
     * §10.10 marks media "Off, and per-invocation confirmed". A standing grant
     * cannot satisfy a per-invocation requirement, so no column value may turn
     * it on — including the most permissive one.
     */
    for (const stored of ['none', 'aggregates_only', 'non_clinical', 'clinical', 'journal'] as const) {
      expect(fromStoredScope(stored).media).toBe(false);
    }
  });

  it('projects the stored ladder conservatively', () => {
    expect(fromStoredScope('none')).toEqual(NO_CONSENT);
    expect(fromStoredScope('aggregates_only').metrics).toBe(true);
    expect(fromStoredScope('aggregates_only').clinical).toBe(false);
    expect(fromStoredScope('clinical').journal).toBe(false);
    expect(fromStoredScope('journal').journal).toBe(true);
  });

  it('gates journal content behind the journal scope and nothing weaker', () => {
    expect(canRetrieve(fromStoredScope('clinical'), 'journal')).toBe(false);
    expect(canRetrieve(fromStoredScope('journal'), 'journal')).toBe(true);
  });

  it('returns permitted classes sorted, so the stable prefix stays byte-identical', () => {
    /* §10.4: the prefix caches only if it does not move. A set iterated in
     * insertion order would reorder the moment the map is edited. */
    const permitted = permittedClasses(fromStoredScope('clinical'));
    expect([...permitted]).toEqual([...permitted].sort((a, b) => a.localeCompare(b)));
    expect(permitted).not.toContain('journal');
    expect(permitted).toContain('lab');
  });
});
