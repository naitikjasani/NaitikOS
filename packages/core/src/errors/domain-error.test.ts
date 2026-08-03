import { assertNever, sensitive } from '@naitikos/shared';
import { describe, expect, it } from 'vitest';

import {
  type DomainError,
  conflictError,
  isDomainError,
  isRetryable,
  notFoundError,
  preconditionFailedError,
  validationError,
} from './domain-error';

describe('DomainError', () => {
  it('constructs each variant with a stable code', () => {
    expect(validationError('bad_load', 'Load must be positive').code).toBe('bad_load');
    expect(notFoundError('observation', 'obs-1').code).toBe('not_found');
    expect(conflictError('medication', 'overlapping_interval').code).toBe(
      'conflict_overlapping_interval',
    );
    expect(preconditionFailedError('metric_registered', 'Unknown metric key').code).toBe(
      'precondition_failed',
    );
  });

  it('omits optional version fields rather than setting them undefined', () => {
    // exactOptionalPropertyTypes is on; an explicit `undefined` is not the same
    // as an absent key, and the difference shows up when the error is
    // serialised into the audit log (§9.4).
    const error = conflictError('goal', 'duplicate');
    expect('expectedVersion' in error).toBe(false);
  });

  it('carries version numbers for optimistic-concurrency failures', () => {
    const error = conflictError('goal', 'version_mismatch', {
      expectedVersion: 3,
      actualVersion: 4,
    });
    expect(error.expectedVersion).toBe(3);
    expect(error.actualVersion).toBe(4);
  });

  it('redacts the detail payload when serialised', () => {
    // §5.13: an error message is one of the easiest places for user content to
    // leak into a log aggregator.
    const error = validationError(
      'bad_entry',
      'Journal entry failed validation',
      [],
      sensitive('Felt anxious before the 1:1.', 'journalEntry'),
    );

    const serialised = JSON.stringify(error);
    expect(serialised).not.toContain('anxious');
    expect(serialised).toContain('[redacted]');
  });

  it('narrows unknown values', () => {
    expect(isDomainError(notFoundError('x', 'y'))).toBe(true);
    expect(isDomainError({ kind: 'something_else' })).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });

  it('marks only version mismatches as retryable', () => {
    expect(isRetryable(conflictError('g', 'version_mismatch'))).toBe(true);
    expect(isRetryable(conflictError('g', 'duplicate'))).toBe(false);
    expect(isRetryable(notFoundError('g', '1'))).toBe(false);
  });

  it('is exhaustively switchable — the union is closed', () => {
    // This is the test that enforces §5.12's "closed" requirement. Adding a
    // fifth variant without extending this switch is a compile error, which is
    // exactly the intended friction.
    const describeError = (error: DomainError): string => {
      switch (error.kind) {
        case 'validation':
          return 'validation';
        case 'not_found':
          return 'not_found';
        case 'conflict':
          return 'conflict';
        case 'precondition_failed':
          return 'precondition_failed';
        default:
          return assertNever(error, 'DomainError');
      }
    };

    expect(describeError(notFoundError('a', 'b'))).toBe('not_found');
    expect(describeError(validationError('c', 'd'))).toBe('validation');
  });
});
