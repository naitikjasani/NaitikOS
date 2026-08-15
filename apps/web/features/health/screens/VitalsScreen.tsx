'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { formatBloodPressure, formatDay, isoFromMillis, systemClock } from '@naitikos/core';
import type { VitalReading } from '@naitikos/core';
import { Button, Card, CardBody, EmptyState, Inline, Stack, Text, TextField } from '@naitikos/design-system';

import { recordVitals } from '../services/healthClient';

/**
 * `/body/health/vitals` — capture and history.
 *
 * ## The blood-pressure fields are one control, not two
 *
 * They are adjacent, they clear together, and submitting one without the other
 * is refused by `core` before anything is written. A systolic with no diastolic
 * is a slip of the keyboard, and a record that accepts it produces a number
 * that plots on a chart forever with no partner and no way to tell it apart
 * from a real one.
 *
 * ## Nothing here says whether a reading is good
 *
 * No colour, no badge, no category. Guideline thresholds differ between bodies
 * and they assume measurement conditions this system does not capture — rested,
 * seated, correct cuff, the average of three. P5: the deliverable is a better
 * question at the next appointment, and a number with its history is that
 * question. "Elevated" on a phone screen is an answer nobody is entitled to.
 */
export function VitalsScreen({
  readings,
  zone,
}: {
  readonly readings: readonly VitalReading[];
  readonly zone: string;
}): ReactNode {
  const router = useRouter();

  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [heartRate, setHeartRate] = useState('');
  const [temperature, setTemperature] = useState('');
  const [spo2, setSpo2] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await recordVitals({
        id: uuidV7(systemClock.nowMillis()),
        observedAt: isoFromMillis(systemClock.nowMillis()),
        observedZone: zone,
        systolic: intOrNull(systolic),
        diastolic: intOrNull(diastolic),
        restingHeartRate: intOrNull(heartRate),
        temperatureCelsius: temperature.trim() === '' ? null : temperature.trim(),
        oxygenSaturation: intOrNull(spo2),
      });
    },
    onSuccess: () => {
      setSystolic('');
      setDiastolic('');
      setHeartRate('');
      setTemperature('');
      setSpo2('');
      setProblem(null);
      router.refresh();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that reading.');
    },
  });

  const anything =
    [systolic, diastolic, heartRate, temperature, spo2].some((value) => value.trim() !== '');

  return (
    <Stack gap="5">
      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            <Text role="title-3" as="h2">
              Record a reading
            </Text>

            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                Blood pressure — both numbers, or neither
              </Text>
              <Inline gap="2">
                <TextField
                  label="Systolic"
                  value={systolic}
                  inputMode="numeric"
                  onChange={(event) => {
                    setSystolic(event.target.value);
                  }}
                  placeholder="118"
                />
                <TextField
                  label="Diastolic"
                  value={diastolic}
                  inputMode="numeric"
                  onChange={(event) => {
                    setDiastolic(event.target.value);
                  }}
                  placeholder="76"
                />
              </Inline>
            </Stack>

            <Inline gap="2" wrap>
              <TextField
                label="Resting heart rate"
                value={heartRate}
                inputMode="numeric"
                onChange={(event) => {
                  setHeartRate(event.target.value);
                }}
                placeholder="58"
                hint="Beats per minute, at rest."
              />
              <TextField
                label="Temperature"
                value={temperature}
                inputMode="decimal"
                onChange={(event) => {
                  setTemperature(event.target.value);
                }}
                placeholder="36.8"
                hint="Degrees Celsius."
              />
              <TextField
                label="Oxygen saturation"
                value={spo2}
                inputMode="numeric"
                onChange={(event) => {
                  setSpo2(event.target.value);
                }}
                placeholder="98"
                hint="Percent, from a pulse oximeter."
              />
            </Inline>

            <Inline justify="between" align="center">
              <Text role="caption" tone="tertiary" aria-live="polite">
                {problem ?? ''}
              </Text>
              <Button
                variant="primary"
                disabled={!anything || save.isPending}
                onClick={() => {
                  save.mutate();
                }}
              >
                Save
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {readings.length === 0 ? (
        <EmptyState
          icon="domain.vitals"
          title="No readings yet"
          description="Readings you record appear here, most recent first, with their date."
        />
      ) : (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            History
          </Text>
          {readings.map((reading) => (
            <Card key={reading.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Inline gap="4" wrap>
                    {formatBloodPressure(reading) !== null && (
                      <Text role="body" as="span">
                        {formatBloodPressure(reading)} mmHg
                      </Text>
                    )}
                    {reading.restingHeartRate !== null && (
                      <Text role="body" as="span">
                        {trim(reading.restingHeartRate)} bpm
                      </Text>
                    )}
                    {reading.temperatureCelsius !== null && (
                      <Text role="body" as="span">
                        {trim(reading.temperatureCelsius)} °C
                      </Text>
                    )}
                    {reading.oxygenSaturation !== null && (
                      <Text role="body" as="span">
                        {trim(reading.oxygenSaturation)}% SpO₂
                      </Text>
                    )}
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {formatDay(reading.observedAt) ?? reading.observedAt}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}
