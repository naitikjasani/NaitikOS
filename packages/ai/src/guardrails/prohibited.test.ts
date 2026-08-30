/**
 * §10.10's post-generation scan.
 *
 * Each test is a sentence a model could plausibly write. That framing matters:
 * a test suite of contrived strings would pass while the real failure mode —
 * fluent, well-formed, helpful-sounding clinical advice — walked through.
 */

import { describe, expect, it } from 'vitest';

import { scanAll, scanForProhibited } from './prohibited';

describe('prohibited patterns', () => {
  it('blocks discontinuation advice, the most dangerous output in the system', () => {
    const verdict = scanForProhibited(
      'Given the improvement over the last two months, you could stop taking your medication and see how it goes.',
    );

    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.category).toBe('discontinuation');
  });

  it('blocks a diagnosis stated as a fact about the operator', () => {
    const verdict = scanForProhibited('Based on these readings you have a deficiency.');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.category).toBe('diagnostic');
  });

  it('blocks urgency framing', () => {
    const verdict = scanForProhibited('This is worth looking at immediately.');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.category).toBe('urgency');
  });

  it('blocks a dose instruction', () => {
    expect(scanForProhibited('You may want to increase your dose.').blocked).toBe(true);
  });

  it('does not block a clinical noun in an ordinary sentence', () => {
    /*
     * The system names medications, analytes and conditions on every Health
     * screen. A scanner that fired on the vocabulary rather than on the speech
     * act would block its own module.
     */
    expect(scanForProhibited('Vitamin D has been recorded four times since March.').blocked).toBe(false);
    expect(scanForProhibited('Escitalopram appears in the medication register.').blocked).toBe(false);
  });

  it('does not block a question, which is the form §10.7 requires', () => {
    expect(
      scanForProhibited('My Vitamin D was low in March and I have been supplementing since; should we retest?')
        .blocked,
    ).toBe(false);
  });

  it('reports the first match and stops, because the whole output is discarded anyway', () => {
    const verdict = scanForProhibited('You have a condition. Stop taking your medication immediately.');
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.category).toBe('diagnostic');
  });

  it('scans every field it is given', () => {
    expect(scanAll(['fine', 'also fine', 'you should see a doctor']).blocked).toBe(true);
    expect(scanAll(['fine', 'also fine']).blocked).toBe(false);
  });
});
