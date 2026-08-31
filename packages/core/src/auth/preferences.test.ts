/**
 * AI preferences — §10.10's consent, and §7's kill switch.
 *
 * Every test here is about a default or a fallback, because both are places
 * where being wrong is silent: nothing errors when data the operator never
 * agreed to send reaches a prompt. P7's egress is not reversible, which is why
 * this parser leans the opposite way to every other parser in the file.
 */

import { describe, expect, it } from 'vitest';
import { isOk } from '@naitikos/shared';

import {
  DEFAULT_AI_CONSENT,
  DEFAULT_AI_PREFERENCES,
  DEFAULT_MONTHLY_CAP_MINOR,
  MAX_MONTHLY_CAP_MINOR,
  aiIsUsable,
  parseAiPreferences,
  parsePreferences,
  toStoredScope,
  validatePreferences,
} from './preferences';

describe('AI defaults', () => {
  it('grants nothing and runs nothing on a fresh install', () => {
    /* §10.10's table says "Off" in every row, and §7 makes the layer a sidecar
     * the whole product works without. */
    expect(DEFAULT_AI_PREFERENCES.enabled).toBe(false);
    expect(DEFAULT_AI_CONSENT).toEqual({ metrics: false, clinical: false, journal: false, media: false });
  });

  it('appears on the default preferences, so a profile that never set it is closed', () => {
    expect(parsePreferences({}).ai).toEqual(DEFAULT_AI_PREFERENCES);
  });
});

describe('parseAiPreferences', () => {
  it('falls back closed on a malformed block, not to a convention', () => {
    /*
     * Every other parser in this file falls back to something merely
     * conventional — a bad theme becomes dark and nothing is harmed. This one
     * guards against a malformed row causing data to be sent that the operator
     * never agreed to send, so the tolerant read has to lean the other way.
     */
    for (const raw of [null, 'yes', 42, [], undefined]) {
      expect(parseAiPreferences(raw)).toEqual(DEFAULT_AI_PREFERENCES);
    }
  });

  it('treats any non-true value as no consent', () => {
    /* `=== true`, not truthiness. A stored `"true"` string, a `1`, or a
     * half-written migration must not read as a grant. */
    const parsed = parseAiPreferences({
      enabled: 'yes',
      consent: { metrics: 'true', clinical: 1, journal: {}, media: [] },
    });

    expect(parsed.enabled).toBe(false);
    expect(parsed.consent).toEqual(DEFAULT_AI_CONSENT);
  });

  it('keeps a genuine grant', () => {
    const parsed = parseAiPreferences({ enabled: true, consent: { metrics: true, clinical: true } });
    expect(parsed.consent.metrics).toBe(true);
    expect(parsed.consent.clinical).toBe(true);
    /* Absent keys are off, not inherited from anywhere. */
    expect(parsed.consent.journal).toBe(false);
  });

  it('rejects an out-of-range cap rather than clamping it', () => {
    /* Clamping would silently give the operator a different cap than the one
     * they set, and the cap is the thing standing between a loop and a bill. */
    expect(parseAiPreferences({ monthlyCapMinor: -5 }).monthlyCapMinor).toBe(DEFAULT_MONTHLY_CAP_MINOR);
    expect(parseAiPreferences({ monthlyCapMinor: 10 ** 9 }).monthlyCapMinor).toBe(DEFAULT_MONTHLY_CAP_MINOR);
    expect(parseAiPreferences({ monthlyCapMinor: 500 }).monthlyCapMinor).toBe(500);
  });

  it('permits a cap of zero, which is the kill switch by another route', () => {
    expect(parseAiPreferences({ monthlyCapMinor: 0 }).monthlyCapMinor).toBe(0);
  });
});

describe('validatePreferences', () => {
  it('rejects an unknown consent scope rather than dropping it', () => {
    /*
     * Elsewhere in this validator an unknown key is a typo. Here it is a client
     * that believes it is granting something, and silently dropping the grant
     * would leave the operator thinking they had consented to a class that was
     * never enabled.
     */
    const result = validatePreferences({ ai: { consent: { biometrics: true } } });
    expect(isOk(result)).toBe(false);
  });

  it('rejects a cap outside its bounds', () => {
    expect(isOk(validatePreferences({ ai: { monthlyCapMinor: MAX_MONTHLY_CAP_MINOR + 1 } }))).toBe(false);
    expect(isOk(validatePreferences({ ai: { monthlyCapMinor: 1.5 } }))).toBe(false);
  });

  it('accepts a well-formed grant', () => {
    const result = validatePreferences({ ai: { enabled: true, consent: { metrics: true }, monthlyCapMinor: 1000 } });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.ai.consent.metrics).toBe(true);
  });
});

describe('toStoredScope', () => {
  it('projects the four scopes onto the ladder monotonically', () => {
    /* Lossy in one direction, but a narrower grant never projects to a wider
     * rung — which is the property `ai_interaction` actually needs. */
    expect(toStoredScope(DEFAULT_AI_CONSENT)).toBe('none');
    expect(toStoredScope({ ...DEFAULT_AI_CONSENT, metrics: true })).toBe('aggregates_only');
    expect(toStoredScope({ ...DEFAULT_AI_CONSENT, clinical: true })).toBe('clinical');
    expect(toStoredScope({ ...DEFAULT_AI_CONSENT, journal: true })).toBe('journal');
  });

  it('reports the widest granted rung when several are on', () => {
    expect(toStoredScope({ metrics: true, clinical: true, journal: true, media: false })).toBe('journal');
  });
});

describe('aiIsUsable', () => {
  it('needs both the switch and a grant, because they mean different things', () => {
    /*
     * `enabled` is §7's kill switch — a deliberate "not now" that leaves the
     * grants intact. An empty grant is "there is nothing I am willing to send".
     * Flipping one switch back on should not silently satisfy the other.
     */
    expect(aiIsUsable({ ...DEFAULT_AI_PREFERENCES, enabled: true })).toBe(false);
    expect(
      aiIsUsable({ ...DEFAULT_AI_PREFERENCES, consent: { ...DEFAULT_AI_CONSENT, metrics: true } }),
    ).toBe(false);
    expect(
      aiIsUsable({
        ...DEFAULT_AI_PREFERENCES,
        enabled: true,
        consent: { ...DEFAULT_AI_CONSENT, metrics: true },
      }),
    ).toBe(true);
  });
});
