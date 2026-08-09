import { describe, expect, it } from 'vitest';
import { METRIC_NAMES } from '@naitikos/core';

import { telemetryBatchSchema, telemetryNameSchema, routePatternSchema } from './telemetry';

describe('telemetryNameSchema', () => {
  it('is exactly the metric vocabulary core declares', () => {
    /*
     * The two lists disagreeing means a client emits an event the server
     * silently drops — a metric that reads as zero rather than as broken, which
     * is the failure mode this whole phase exists to avoid.
     */
    expect([...telemetryNameSchema.options].sort()).toEqual([...METRIC_NAMES].sort());
  });

  it('rejects a name outside the vocabulary', () => {
    expect(telemetryNameSchema.safeParse('capture.latency.mood_2').success).toBe(false);
  });
});

describe('routePatternSchema', () => {
  it('accepts a pattern', () => {
    expect(routePatternSchema.safeParse('/mind/journal/:id').success).toBe(true);
  });

  it('rejects a populated path — an id in telemetry is permanent', () => {
    const populated = '/mind/journal/018f4b2c-9e1a-7c3d-8f42-6a1b2c3d4e5f';
    expect(routePatternSchema.safeParse(populated).success).toBe(false);
  });
});

describe('telemetryBatchSchema', () => {
  it('accepts a name and a number and nothing else', () => {
    const parsed = telemetryBatchSchema.safeParse({
      events: [{ name: 'capture.latency', value: 1840, route: '/today' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('strips anything resembling a payload', () => {
    const parsed = telemetryBatchSchema.parse({
      events: [
        {
          name: 'capture.latency',
          value: 900,
          // Not in the schema, so Zod drops it. §5.11: leakage is impossible
          // rather than prohibited.
          payload: { mood: 2, note: 'a rough evening' },
        },
      ],
    });
    expect(Object.keys(parsed.events[0] ?? {})).toEqual(['name', 'value']);
  });

  it('rejects a negative duration — a clock going backwards is not a measurement', () => {
    expect(
      telemetryBatchSchema.safeParse({ events: [{ name: 'capture.latency', value: -5 }] }).success,
    ).toBe(false);
  });

  it('rejects a value longer than a day', () => {
    expect(
      telemetryBatchSchema.safeParse({ events: [{ name: 'capture.latency', value: 86_400_001 }] }).success,
    ).toBe(false);
  });

  it('requires at least one event and caps the batch', () => {
    expect(telemetryBatchSchema.safeParse({ events: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 51 }, () => ({ name: 'route.transition' as const }));
    expect(telemetryBatchSchema.safeParse({ events: tooMany }).success).toBe(false);
  });
});
