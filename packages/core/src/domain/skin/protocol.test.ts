import { describe, expect, it } from 'vitest';

import type { CaptureCandidate, SeriesPhoto } from './protocol';
import {
  COMPLIANCE_THRESHOLD,
  alignmentReferenceFor,
  comparablePhotos,
  evaluateProtocol,
  seriesKey,
  timeBucketFor,
  toProtocolBlock,
} from './protocol';

function photo(overrides: Partial<SeriesPhoto> = {}): SeriesPhoto {
  return {
    mediaObjectId: 'm1',
    capturedAt: '2026-08-17T02:30:00.000Z',
    region: 'face',
    poseId: 'front',
    distance: 'close',
    lighting: 'daylight_indirect',
    timeBucket: 'morning',
    flash: 'off',
    medianLuminance: 120,
    complianceScore: 1,
    ...overrides,
  };
}

function candidate(overrides: Partial<CaptureCandidate> = {}): CaptureCandidate {
  return {
    region: 'face',
    poseId: 'front',
    distance: 'close',
    lighting: 'daylight_indirect',
    timeBucket: 'morning',
    flash: 'off',
    medianLuminance: 120,
    alignmentReferenceId: 'm1',
    ...overrides,
  };
}

describe('timeBucketFor', () => {
  it.each([
    ['05:30', 'early_morning'],
    ['08:00', 'morning'],
    ['12:15', 'midday'],
    ['15:00', 'afternoon'],
    ['19:45', 'evening'],
    ['23:00', 'night'],
  ])('%s falls in %s', (time, bucket) => {
    expect(timeBucketFor(time)).toBe(bucket);
  });

  it('is null for anything that is not HH:MM', () => {
    expect(timeBucketFor('8am')).toBeNull();
    expect(timeBucketFor('25:00')).toBeNull();
  });
});

describe('seriesKey and alignmentReferenceFor', () => {
  it('separates poses within a region', () => {
    expect(seriesKey('face', 'front')).not.toBe(seriesKey('face', 'left'));
    expect(seriesKey('face', null)).toBe('face::default');
  });

  it('picks the most recent photo in the same series, not the most compliant', () => {
    const reference = alignmentReferenceFor(
      [
        photo({ mediaObjectId: 'old', capturedAt: '2026-06-01T02:30:00.000Z', complianceScore: 1 }),
        photo({ mediaObjectId: 'recent', capturedAt: '2026-08-20T02:30:00.000Z', complianceScore: 0.4 }),
        photo({ mediaObjectId: 'other-pose', poseId: 'left', capturedAt: '2026-08-23T02:30:00.000Z' }),
      ],
      'face',
      'front',
    );
    expect(reference?.mediaObjectId).toBe('recent');
  });

  it('is null for a series with nothing in it', () => {
    expect(alignmentReferenceFor([], 'chest', null)).toBeNull();
  });
});

describe('evaluateProtocol', () => {
  it('never fails — the worst it produces is advisories', () => {
    const verdict = evaluateProtocol(
      candidate({ distance: 'full', lighting: 'artificial_cool', flash: 'on', timeBucket: 'night' }),
      photo(),
      [120, 118, 122],
    );
    expect(verdict.advisories.length).toBeGreaterThan(0);
    expect(verdict.isCompliant).toBe(false);
    // No throw, no Result, no refusal. §14.2 Finding 9.
    expect(verdict.complianceScore).toBeGreaterThanOrEqual(0);
  });

  it('scores a matching capture at 1', () => {
    const verdict = evaluateProtocol(candidate(), photo(), [120, 119, 121]);
    expect(verdict.complianceScore).toBe(1);
    expect(verdict.isCompliant).toBe(true);
    expect(verdict.advisories).toEqual([]);
  });

  it('gives the first photo in a series no score rather than a zero', () => {
    const verdict = evaluateProtocol(candidate({ alignmentReferenceId: null }), null, []);
    expect(verdict.complianceScore).toBeNull();
    // It is the reference for its own series; excluding it would leave nothing
    // to compare against.
    expect(verdict.isCompliant).toBe(true);
  });

  it('excludes unassessable checks from both sides of the score', () => {
    const verdict = evaluateProtocol(
      candidate({ distance: null, medianLuminance: null }),
      photo({ distance: null }),
      [],
    );
    const unknowns = verdict.checks.filter((check) => check.status === 'unknown').map((check) => check.id);
    expect(unknowns).toEqual(expect.arrayContaining(['distance', 'luminance']));
    expect(verdict.complianceScore).toBe(1);
  });

  it('flags a lighting drift as advisory, with the direction named', () => {
    const verdict = evaluateProtocol(candidate({ medianLuminance: 180 }), photo(), [120, 120, 122]);
    const luminance = verdict.checks.find((check) => check.id === 'luminance');
    expect(luminance?.status).toBe('advisory');
    expect(luminance?.detail).toContain('brighter');
    expect(luminance?.detail).toContain('not a reason to retake');
  });

  it('uses a median so one lamp-lit photo does not poison the baseline', () => {
    const verdict = evaluateProtocol(candidate({ medianLuminance: 120 }), photo(), [120, 121, 400]);
    expect(verdict.checks.find((check) => check.id === 'luminance')?.status).toBe('pass');
  });

  it('takes the mean of the middle pair for an even baseline', () => {
    const verdict = evaluateProtocol(candidate({ medianLuminance: 110 }), photo(), [100, 100, 120, 120]);
    expect(verdict.checks.find((check) => check.id === 'luminance')?.status).toBe('pass');
  });

  it('notes a capture taken without the overlay', () => {
    const verdict = evaluateProtocol(candidate({ alignmentReferenceId: null }), photo(), [120]);
    expect(verdict.checks.find((check) => check.id === 'alignment')?.status).toBe('advisory');
  });

  it('reports a missing field differently from a missing baseline', () => {
    const noValue = evaluateProtocol(candidate({ flash: null }), photo(), []);
    expect(noValue.checks.find((check) => check.id === 'flash')?.detail).toContain('was not recorded');

    const noBaseline = evaluateProtocol(candidate(), photo({ flash: null }), []);
    expect(noBaseline.checks.find((check) => check.id === 'flash')?.detail).toContain('No previous photo');
  });
});

describe('toProtocolBlock', () => {
  it('stores the score produced by the checks that actually ran', () => {
    const subject = candidate();
    const verdict = evaluateProtocol(subject, photo(), [120]);
    const block = toProtocolBlock(subject, verdict);
    expect(block.complianceScore).toBe(verdict.complianceScore);
    expect(block.region).toBe('face');
    expect(block.alignmentReferenceId).toBe('m1');
  });

  it('omits absent fields rather than writing nulls into the jsonb', () => {
    const subject = candidate({ poseId: null, distance: null, medianLuminance: null, alignmentReferenceId: null });
    const block = toProtocolBlock(subject, evaluateProtocol(subject, null, []));
    expect(Object.keys(block).sort()).toEqual(['flash', 'lighting', 'region', 'timeBucket']);
  });
});

describe('comparablePhotos', () => {
  const photos = [
    photo({ mediaObjectId: 'a', capturedAt: '2026-06-01T02:30:00.000Z', complianceScore: 1 }),
    photo({ mediaObjectId: 'b', capturedAt: '2026-07-01T02:30:00.000Z', complianceScore: 0.4 }),
    photo({ mediaObjectId: 'c', capturedAt: '2026-08-01T02:30:00.000Z', complianceScore: null }),
    photo({ mediaObjectId: 'd', poseId: 'left', capturedAt: '2026-08-02T02:30:00.000Z' }),
  ];

  it('defaults to compliant photos and keeps the unscored reference', () => {
    expect(comparablePhotos(photos, 'face', 'front').map((item) => item.mediaObjectId)).toEqual(['a', 'c']);
  });

  it('includes the rest behind the toggle, in capture order', () => {
    expect(
      comparablePhotos(photos, 'face', 'front', { includeNonCompliant: true }).map((item) => item.mediaObjectId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('admits a photo exactly at the threshold', () => {
    const borderline = [photo({ mediaObjectId: 'e', complianceScore: COMPLIANCE_THRESHOLD })];
    expect(comparablePhotos(borderline, 'face', 'front')).toHaveLength(1);
  });
});
