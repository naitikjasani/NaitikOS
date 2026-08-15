'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import { awaitingNotes, describeWhen, formatDay, systemClock } from '@naitikos/core';
import type { Appointment } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextField,
} from '@naitikos/design-system';

import { scheduleAppointment } from '../services/healthClient';

/**
 * `/body/health/appointments` — what is coming, and what has been and gone.
 *
 * ## The "no notes yet" prompt is a prompt, not a nag
 *
 * §4.4 wants post-visit notes and the moment they are worth writing is the day
 * of the visit. So a past appointment with no notes is listed, once, plainly —
 * no badge count, no escalation, no red. §14.1 forbids guilt copy about gaps,
 * and a system that harangues you about paperwork after a hospital appointment
 * is a system you stop opening.
 */
export function AppointmentsScreen({
  appointments,
  nowIso,
  zone,
}: {
  readonly appointments: readonly Appointment[];
  readonly nowIso: string;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('09:00');

  const create = useMutation({
    mutationFn: async () => {
      await scheduleAppointment({
        id: uuidV7(systemClock.nowMillis()),
        title: title.trim(),
        provider: provider.trim() === '' ? null : provider.trim(),
        specialty: null,
        location: null,
        scheduledFor: `${day}T${time}:00.000Z`,
        zone,
      });
    },
    onSuccess: () => {
      setAdding(false);
      setTitle('');
      setProvider('');
      setDay('');
      router.refresh();
    },
  });

  const upcoming = appointments
    .filter((entry) => entry.scheduledFor !== null && entry.scheduledFor >= nowIso)
    .sort((a, b) => ((a.scheduledFor ?? '') < (b.scheduledFor ?? '') ? -1 : 1));
  const past = appointments
    .filter((entry) => entry.scheduledFor !== null && entry.scheduledFor < nowIso)
    .sort((a, b) => ((a.scheduledFor ?? '') < (b.scheduledFor ?? '') ? 1 : -1));
  const needNotes = new Set(awaitingNotes(appointments, nowIso).map((entry) => entry.id));

  const usable = title.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/u.test(day);

  return (
    <Stack gap="6">
      {adding ? (
        <Card variant="raised">
          <CardBody>
            <Stack gap="4">
              <Text role="title-3" as="h2">
                Schedule an appointment
              </Text>
              <TextField
                label="What it is"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                }}
                placeholder="Psychiatry review"
              />
              <TextField
                label="Who with (optional)"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value);
                }}
              />
              <Inline gap="2">
                <DateField label="Date" value={day} onValueChange={setDay} />
                <TextField
                  label="Time"
                  value={time}
                  onChange={(event) => {
                    setTime(event.target.value);
                  }}
                  placeholder="09:00"
                />
              </Inline>
              <Inline gap="2" justify="between" align="center">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!usable || create.isPending}
                  onClick={() => {
                    create.mutate();
                  }}
                >
                  Schedule
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            Schedule an appointment
          </Button>
        </Inline>
      )}

      {appointments.length === 0 ? (
        <EmptyState
          icon="domain.appointment"
          title="No appointments"
          description="Schedule one and the system will assemble the questions your record suggests you ask."
        />
      ) : (
        <>
          {upcoming.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Coming up
              </Text>
              {upcoming.map((entry) => (
                <Card key={entry.id} variant="outlined">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Stack gap="1">
                        <Link className="nos-inline-link" href={`/body/health/appointments/${entry.id}`}>
                          {entry.title}
                        </Link>
                        <Text role="caption" tone="tertiary">
                          {entry.scheduledFor === null ? '' : formatDay(entry.scheduledFor)}
                          {entry.provider === null ? '' : ` · ${entry.provider}`} ·{' '}
                          {entry.preVisitQuestions.length === 0
                            ? 'no questions yet'
                            : `${String(entry.preVisitQuestions.length)} questions ready`}
                        </Text>
                      </Stack>
                      <Badge tone="accent">{describeWhen(entry, nowIso) ?? ''}</Badge>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}

          {past.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Past
              </Text>
              {past.map((entry) => (
                <Card key={entry.id} variant="flat">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Stack gap="1">
                        <Link className="nos-inline-link" href={`/body/health/appointments/${entry.id}`}>
                          {entry.title}
                        </Link>
                        <Text role="caption" tone="tertiary">
                          {entry.scheduledFor === null ? '' : formatDay(entry.scheduledFor)}
                          {needNotes.has(entry.id) ? ' · no notes yet' : ''}
                        </Text>
                      </Stack>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}
