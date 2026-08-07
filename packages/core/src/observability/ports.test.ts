/**
 * Observability ports.
 *
 * There is not much behaviour here to test — these are ports. What *is* worth
 * asserting is the property §5.11 depends on: the no-op bundle must be usable
 * everywhere, on every path, without a backend. If it were not, some code path
 * would end up constructing a real telemetry client to satisfy a type, and
 * `core` would have acquired an infrastructure dependency by the back door.
 *
 * The metric-name assertions are here because the closed union is the only thing
 * stopping §5.11's narrow purpose — "usage telemetry to protect the metrics in
 * §1.4" — from becoming a free-form event namespace, which §1.4 warns is
 * "actively harmful in a single-user product because there is no one to impress".
 */

import { describe, expect, it } from 'vitest';

import { METRIC_NAMES, createNoopObservability } from './ports';

describe('the metric namespace', () => {
  it('is closed and has no duplicates', () => {
    expect(new Set(METRIC_NAMES).size).toBe(METRIC_NAMES.length);
  });

  it('includes the §1.4 P1 budget', () => {
    // §1.4 budgets capture latency at under five seconds p50 and calls a sustained
    // rise "a P1 defect". A metric that is not recorded cannot be alerted on.
    expect(METRIC_NAMES).toContain('capture.latency');
  });

  it('includes the two §5.16 alarms this milestone adds', () => {
    expect(METRIC_NAMES).toContain('event.dead_lettered');
    // An outbox entry older than 24h means data the user believes is saved is not.
    expect(METRIC_NAMES).toContain('sync.outbox.oldest_age_seconds');
  });

  it('uses dotted lowercase names throughout', () => {
    for (const name of METRIC_NAMES) {
      expect(name, `${name} is not dotted lowercase`).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });
});

describe('the no-op bundle', () => {
  it('provides every signal', () => {
    const observability = createNoopObservability();

    // A caller must never be given a logger but no metrics — that is how latency
    // recording quietly stops.
    expect(observability.logger).toBeDefined();
    expect(observability.metrics).toBeDefined();
    expect(observability.tracer).toBeDefined();
    expect(observability.errors).toBeDefined();
    expect(observability.audit).toBeDefined();
  });

  it('accepts every logger call and every level', () => {
    const { logger } = createNoopObservability();

    expect(() => {
      logger.error('boom', { code: 'x' });
      logger.warn('careful');
      logger.info('fine', { measurements: { durationMs: 12 } });
      logger.debug('detail', { identifiers: { eventId: 'evt-1' } });
    }).not.toThrow();
  });

  it('returns a working logger from child(), recursively', () => {
    const { logger } = createNoopObservability();
    const bound = logger.child({ traceId: 'trace-1' }).child({ component: 'events.bus' });

    // The mechanism that makes §5.13's "traceId on every entry" survivable. A
    // child that returned undefined would fail on the fifth log line of a request.
    expect(() => bound.info('still works')).not.toThrow();
  });

  it('still runs the function passed to metrics.time', async () => {
    const { metrics } = createNoopObservability();
    let ran = false;

    const value = await metrics.time('capture.latency', {}, async () => {
      ran = true;
      return Promise.resolve(42);
    });

    // The trap this catches: a no-op that skips `fn` turns "record how long this
    // took" into "do not do this", and only in the configuration used by tests.
    expect(ran).toBe(true);
    expect(value).toBe(42);
  });

  it('still runs the function passed to withSpan, and passes it a span', async () => {
    const { tracer } = createNoopObservability();

    const name = await tracer.withSpan('publish', (span) => {
      span.setMeasurement('events', 3);
      span.setIdentifier('correlationId', 'corr-1');
      span.recordFailure('none');
      span.end();
      return Promise.resolve(span.name);
    });

    expect(name).toBe('publish');
  });

  it('reports no current span rather than inventing one', () => {
    expect(createNoopObservability().tracer.currentSpan()).toBeNull();
  });

  it('accepts a span started explicitly', () => {
    const span = createNoopObservability().tracer.startSpan('media.upload');
    expect(span.name).toBe('media.upload');
    expect(() => span.end()).not.toThrow();
  });

  it('accepts every metric shape', () => {
    const { metrics } = createNoopObservability();

    expect(() => {
      metrics.increment('event.published', { eventType: 'Medication.Taken' });
      metrics.increment('event.dead_lettered', {}, 3);
      metrics.observe('timeline.query.duration', 42, { route: '/timeline' });
      metrics.gauge('sync.outbox.depth', 7);
    }).not.toThrow();
  });

  it('accepts an error report', () => {
    const { errors } = createNoopObservability();

    expect(() => {
      errors.report({
        code: 'handler_threw',
        message: 'Handler "timeline.project" threw.',
        component: 'events.bus',
        isUnexpected: true,
      });
    }).not.toThrow();
  });

  it('accepts an audit call', async () => {
    const { audit } = createNoopObservability();

    await expect(
      audit.recordDomainEvent({
        entityType: 'medication',
        entityId: 'med-1',
        operation: 'update',
        actor: 'sub-1',
        changeReason: 'dose adjusted',
      }),
    ).resolves.toBeUndefined();
  });
});
