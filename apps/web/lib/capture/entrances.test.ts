import { describe, expect, it } from 'vitest';

import { CAPTURE_ENTRANCES, CAPTURE_PARAM, entranceFor } from './entrances';
import { QUICK_CAPTURE_CHORDS } from './rail';

/**
 * The entrance table and the rail are two lists that must agree.
 *
 * They cannot be one list: the rail is a `'use client'` module holding control
 * configuration — steppers, ranges, presets — and the entrance table is read on
 * the server to build a redirect. So the agreement is checked here instead,
 * because the failure otherwise is silent and lands on the operator's home
 * screen: a shortcut that opens `/today` with nothing on it, which reads as the
 * application being broken rather than as a table that went stale.
 */
describe('capture entrances', () => {
  it('resolves every sheet entrance to a metric the rail actually offers', () => {
    const rail = new Set(QUICK_CAPTURE_CHORDS.map((chord) => chord.metricKey));

    for (const entrance of CAPTURE_ENTRANCES) {
      if (entrance.target.kind !== 'sheet') continue;
      expect(rail, `${entrance.slug} has no sheet`).toContain(entrance.target.metricKey);
    }
  });

  it('gives every metric on the rail a URL', () => {
    const reachable = new Set(
      CAPTURE_ENTRANCES.flatMap((entrance) =>
        entrance.target.kind === 'sheet' ? [entrance.target.metricKey] : [],
      ),
    );

    for (const chord of QUICK_CAPTURE_CHORDS) {
      expect(reachable, `${chord.metricKey} has a chord but no URL`).toContain(chord.metricKey);
    }
  });

  /**
   * §3.2 names the six the route was specified with. Four of them resolve to a
   * route rather than a sheet, which is a decision rather than a gap — but all
   * six must resolve to *something*, or the specified URL 404s.
   */
  it('resolves all six kinds §3.2 names', () => {
    for (const slug of ['mood', 'weight', 'meal', 'set', 'photo', 'note']) {
      expect(entranceFor(slug), slug).not.toBeNull();
    }
  });

  it('has no duplicate slugs', () => {
    const slugs = CAPTURE_ENTRANCES.map((entrance) => entrance.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('states a reason for every kind that is a route rather than a sheet', () => {
    for (const entrance of CAPTURE_ENTRANCES) {
      if (entrance.target.kind !== 'route') continue;
      expect(entrance.target.href.startsWith('/'), entrance.slug).toBe(true);
      /* Not a formality. The reason is the thing that has to be *deleted* to
       * add a sheet later, which is how a decision stays a decision instead of
       * decaying into an omission nobody remembers making. */
      expect(entrance.target.why.length, entrance.slug).toBeGreaterThan(40);
    }
  });

  it('does not resolve an unknown kind', () => {
    expect(entranceFor('mood ')).toBeNull();
    expect(entranceFor('Mood')).toBeNull();
    expect(entranceFor('')).toBeNull();
  });

  it('keeps the query parameter stable', () => {
    /* A home-screen shortcut is a URL the operating system stores for as long
     * as the icon exists. Renaming this breaks every one already installed. */
    expect(CAPTURE_PARAM).toBe('capture');
  });
});
