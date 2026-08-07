/**
 * Payload validation.
 *
 * This runs on every publish, in `core`, on events our own code constructed — a
 * different job from `packages/api`'s Zod contracts, which parse untrusted input
 * from the wire. A bug in a domain service produces a malformed event that never
 * touched HTTP, and only this catches it.
 *
 * The unknown-key rejection is the interesting case and has its own section: it
 * is the mechanical enforcement of ADR 0005, and the failure mode it prevents
 * (`{ metricKey: 'body.weight', weightKg: 74.2 }` sailing through because the
 * extra field was not in the spec) is exactly how a second system of record gets
 * created by accident.
 */

import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@naitikos/shared';

import type { ValidationError } from '../errors/domain-error';
import { validateEventPayload } from './validate';

/** The issue paths from a failed validation, for concise assertions. */
function issuePaths(payload: unknown, type: Parameters<typeof validateEventPayload>[0]): string[] {
  const result = validateEventPayload(type, payload);
  if (isOk(result)) return [];
  return (result.error as ValidationError).issues.map((issue) => issue.path.join('.'));
}

describe('accepting a valid payload', () => {
  it('accepts a complete payload', () => {
    expect(
      isOk(
        validateEventPayload('Medication.Taken', {
          medicationId: 'med-1',
          scheduleId: 'sched-1',
          substanceLabel: 'Venlafaxine XR',
        }),
      ),
    ).toBe(true);
  });

  it('accepts a payload with optional fields absent', () => {
    expect(
      isOk(
        validateEventPayload('Medication.Taken', {
          medicationId: 'med-1',
          substanceLabel: 'Venlafaxine XR',
        }),
      ),
    ).toBe(true);
  });

  it('accepts an empty object for a subject-only type', () => {
    expect(isOk(validateEventPayload('Sleep.Recorded', {}))).toBe(true);
    expect(isOk(validateEventPayload('AnxietyEpisode.Logged', {}))).toBe(true);
  });

  it('accepts zero and false, which are falsy but present', () => {
    // A truthiness check instead of an `undefined` check would reject a Daily
    // Close where nothing was filled — §4.0's partial close, and the clinically
    // interesting case.
    expect(
      isOk(
        validateEventPayload('DailyClose.Completed', {
          closedOn: '2026-08-03',
          fieldsCompleted: 0,
          fieldsAvailable: 7,
        }),
      ),
    ).toBe(true);

    expect(isOk(validateEventPayload('Journal.Created', { hasPrompt: false }))).toBe(true);
  });
});

describe('rejecting a malformed payload', () => {
  it('reports every missing required field, not just the first', () => {
    // All of them, so a caller fixes one round-trip rather than five.
    expect(issuePaths({}, 'Workout.SetLogged').sort()).toEqual([
      'payload.exerciseId',
      'payload.exerciseLabel',
      'payload.isPersonalRecord',
      'payload.orderIndex',
      'payload.sessionId',
    ]);
  });

  it('rejects a wrong primitive type', () => {
    const result = validateEventPayload('Workout.Completed', {
      setCount: '12',
      exerciseCount: 4,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect((result.error as ValidationError).issues[0]?.message).toContain('Expected number');
    }
  });

  it('rejects a non-finite number', () => {
    // NaN and Infinity serialise to `null` in JSON and reappear on replay as a
    // missing field — a value that validated on write and does not on read.
    expect(issuePaths({ setCount: Number.NaN, exerciseCount: 4 }, 'Workout.Completed')).toContain(
      'payload.setCount',
    );
    expect(
      issuePaths({ setCount: Number.POSITIVE_INFINITY, exerciseCount: 4 }, 'Workout.Completed'),
    ).toContain('payload.setCount');
  });

  it('rejects a payload that is not an object', () => {
    for (const value of [null, undefined, 'text', 42, true, ['a']]) {
      const result = validateEventPayload('Sleep.Recorded', value);
      expect(isErr(result), `${String(value)} should be rejected`).toBe(true);
    }
  });

  it('rejects an array, which is an object but not a record', () => {
    expect(issuePaths([], 'Sleep.Recorded')).toEqual(['payload']);
  });

  it('uses a stable error code so callers can branch on it', () => {
    const result = validateEventPayload('Sleep.Recorded', { unexpected: 1 });
    if (isOk(result)) throw new Error('expected err');
    expect(result.error.kind).toBe('validation');
    expect(result.error.code).toBe('event_payload_invalid');
  });
});

describe('the unknown-key rejection (ADR 0005)', () => {
  it('rejects an authoritative value smuggled alongside a reference', () => {
    const result = validateEventPayload('Weight.Logged', {
      metricKey: 'body.weight',
      // The canonical violation, straight out of the ADR. Accepting this creates
      // a second copy of a number that `observation` already owns.
      // eslint-disable-next-line @naitikos/no-bare-quantity -- The violation under test; see the assertion below. Two rules agree this line is wrong, which is the point.
      weightKg: 74.2,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const issue = (result.error as ValidationError).issues[0];
      expect(issue?.path.join('.')).toBe('payload.weightKg');
      // The message has to teach, because whoever hits it is mid-feature and will
      // otherwise just add the field to the spec.
      expect(issue?.message).toContain('ADR 0005');
      expect(issue?.message).toContain('reference');
    }
  });

  it('rejects an unknown key even when every required field is present', () => {
    expect(
      issuePaths(
        // eslint-disable-next-line @naitikos/no-bare-quantity -- The violation under test. A dose belongs in `medication_schedule`, not in an event; that is what this asserts.
        { medicationId: 'med-1', substanceLabel: 'Escitalopram', doseMg: 10 },
        'Medication.Taken',
      ),
    ).toEqual(['payload.doseMg']);
  });

  it('rejects content on a journal event', () => {
    // §4.7. The one payload where an extra field would be actively harmful.
    expect(issuePaths({ hasPrompt: true, text: 'a bad day' }, 'Journal.Created')).toEqual([
      'payload.text',
    ]);
  });

  it('reports missing and unknown fields together', () => {
    expect(issuePaths({ surprise: true }, 'Journal.Created').sort()).toEqual([
      'payload.hasPrompt',
      'payload.surprise',
    ]);
  });

  it('does not treat an inherited property as a payload field', () => {
    // `Object.hasOwn`, not `in`. A payload built by spreading something with a
    // prototype would otherwise smuggle keys past the check — or, in the other
    // direction, `toString` would count as provided.
    const payload = Object.create({ inherited: 'value' }) as Record<string, unknown>;
    payload['hasPrompt'] = true;

    expect(isOk(validateEventPayload('Journal.Created', payload))).toBe(true);
  });
});
