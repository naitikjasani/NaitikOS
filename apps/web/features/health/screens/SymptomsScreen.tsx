'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  MAX_SYMPTOM_INTENSITY,
  MIN_SYMPTOM_INTENSITY,
  SEVERITIES,
  SEVERITY_LABELS,
  formatDay,
  isoFromMillis,
  symptomDurationMinutes,
  symptomFrequency,
  systemClock,
} from '@naitikos/core';
import type { Severity, Symptom } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { endSymptom, logSymptom } from '../services/healthClient';

/**
 * `/body/health/symptoms` — the log.
 *
 * ## The trigger box says "suspected" and the screen never argues with it
 *
 * Nothing here ranks triggers, correlates them, or promotes one to a cause once
 * it has been entered often enough. P5, and a specific failure: telling this
 * operator their headache was caused by Venlafaxine would be a pharmacological
 * claim made by a phone, to a person who would reasonably act on it.
 *
 * The recurrence count at the bottom is a count. "Headache × 4" is a fact; a
 * rate, a rank, or a trend line over four events is not.
 */
export function SymptomsScreen({
  symptoms,
  zone,
}: {
  readonly symptoms: readonly Symptom[];
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [name, setName] = useState('');
  const [bodySite, setBodySite] = useState('');
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [intensity, setIntensity] = useState<number | null>(null);
  const [trigger, setTrigger] = useState('');
  const [note, setNote] = useState('');

  const log = useMutation({
    mutationFn: async () => {
      await logSymptom({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        bodySite: bodySite.trim() === '' ? null : bodySite.trim(),
        severity,
        intensity,
        startedAt: isoFromMillis(systemClock.nowMillis()),
        zone,
        suspectedTrigger: trigger.trim() === '' ? null : trigger.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setName('');
      setBodySite('');
      setSeverity(null);
      setIntensity(null);
      setTrigger('');
      setNote('');
      router.refresh();
    },
  });

  const close = useMutation({
    mutationFn: async (id: string) => {
      await endSymptom(id, isoFromMillis(systemClock.nowMillis()));
    },
    onSuccess: () => {
      router.refresh();
    },
  });

  const open = symptoms.filter((symptom) => symptom.endedAt === null);
  const closed = symptoms.filter((symptom) => symptom.endedAt !== null);
  const frequency = symptomFrequency(symptoms);

  return (
    <Stack gap="6">
      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            <Text role="title-3" as="h2">
              Log a symptom
            </Text>
            <TextField
              label="What"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="Headache"
            />
            <TextField
              label="Where (optional)"
              value={bodySite}
              onChange={(event) => {
                setBodySite(event.target.value);
              }}
              placeholder="Behind the eyes"
            />

            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                How bad, {String(MIN_SYMPTOM_INTENSITY)} to {String(MAX_SYMPTOM_INTENSITY)}
              </Text>
              <Inline gap="1" wrap>
                {Array.from({ length: MAX_SYMPTOM_INTENSITY }, (_, index) => index + 1).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={value === intensity ? 'primary' : 'secondary'}
                    aria-pressed={value === intensity}
                    onClick={() => {
                      setIntensity(value === intensity ? null : value);
                    }}
                  >
                    {String(value)}
                  </Button>
                ))}
              </Inline>
            </Stack>

            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                Severity (optional)
              </Text>
              <Inline gap="2" wrap>
                {SEVERITIES.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === severity ? 'primary' : 'secondary'}
                    aria-pressed={option === severity}
                    onClick={() => {
                      setSeverity(option === severity ? null : option);
                    }}
                  >
                    {SEVERITY_LABELS[option]}
                  </Button>
                ))}
              </Inline>
            </Stack>

            <TextField
              label="Suspected trigger (optional)"
              value={trigger}
              onChange={(event) => {
                setTrigger(event.target.value);
              }}
              hint="Your suspicion. Nothing here confirms or ranks it."
            />
            <TextAreaField
              label="Note (optional)"
              value={note}
              rows={2}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />

            <Inline justify="end">
              <Button
                variant="primary"
                disabled={name.trim() === '' || log.isPending}
                onClick={() => {
                  log.mutate();
                }}
              >
                Log it
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {open.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Still going
          </Text>
          {open.map((symptom) => (
            <Card key={symptom.id} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {symptom.name}
                      {symptom.intensity === null ? '' : ` · ${String(symptom.intensity)}/10`}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {symptom.startedAt === null ? '' : `Since ${formatDay(symptom.startedAt) ?? ''}`}
                      {symptom.suspectedTrigger === null ? '' : ` · suspected: ${symptom.suspectedTrigger}`}
                    </Text>
                  </Stack>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={close.isPending}
                    onClick={() => {
                      close.mutate(symptom.id);
                    }}
                  >
                    It has stopped
                  </Button>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {symptoms.length === 0 ? (
        <EmptyState
          icon="domain.clinical"
          title="Nothing logged"
          description="Symptoms you record appear here, with how long each lasted and what you suspected caused it."
        />
      ) : (
        closed.length > 0 && (
          <Stack gap="2">
            <Text role="title-3" as="h2">
              Resolved
            </Text>
            {closed.map((symptom) => {
              const minutes = symptomDurationMinutes(symptom);
              return (
                <Card key={symptom.id} variant="flat">
                  <CardBody>
                    <Stack gap="1">
                      <Inline justify="between" align="center" wrap>
                        <Text role="body" as="span">
                          {symptom.name}
                        </Text>
                        {symptom.severity !== null && (
                          <Badge tone="neutral">{SEVERITY_LABELS[symptom.severity]}</Badge>
                        )}
                      </Inline>
                      <Text role="caption" tone="tertiary">
                        {symptom.startedAt === null ? '' : formatDay(symptom.startedAt)}
                        {minutes === null ? '' : ` · lasted ${describeMinutes(minutes)}`}
                      </Text>
                    </Stack>
                  </CardBody>
                </Card>
              );
            })}
          </Stack>
        )
      )}

      {frequency.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            How often
          </Text>
          <Inline gap="2" wrap>
            {frequency.map((entry) => (
              <Badge key={entry.name} tone="neutral">
                {entry.name} × {String(entry.count)}
              </Badge>
            ))}
          </Inline>
          <Text role="caption" tone="tertiary">
            Counts, in the window shown. Nothing here says one caused another.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function describeMinutes(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour' : `${String(hours)} hours`;
  return `${String(Math.round(hours / 24))} days`;
}
