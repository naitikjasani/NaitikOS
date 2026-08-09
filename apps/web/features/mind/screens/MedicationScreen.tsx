'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { medicationLabel, systemClock } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Progress,
  Stack,
  Text,
} from '@naitikos/design-system';

import { MedicationRegisterForm } from '@/features/registers';

import { fetchMedications, logDose } from '../services/mindClient';

/**
 * `/mind/meds` — the psychiatric medication lens.
 *
 * §3.3(3): "one row, three lenses." This is not a second medication register.
 * It is `/api/medications?lens=psychiatric` — the same rows Health will render
 * in full in V2, filtered to the two the operator is actually on.
 *
 * ## Every figure is shown with both of its inputs
 *
 * "94%" on its own is a verdict. "27 of 29 scheduled doses recorded as taken
 * across 27 days with a record, 3 days have no record either way" is a
 * description, and it is the sentence `core` builds so that no surface can
 * quietly drop the second half of it.
 *
 * The days with no record are the load-bearing part. A psychiatrist asking
 * "have you been taking it?" is asking a clinical question, and an adherence
 * figure that counted every un-logged day as a missed dose would answer it
 * wrongly in the direction that changes prescribing.
 *
 * ## Two buttons, and neither of them is red
 *
 * "Taken" and "Skipped". §4.7's no-negative-framing rule means skipped is a
 * neutral button, not a confession — a skipped dose is information, and an
 * interface that makes recording one feel like an admission is an interface
 * that stops being told about them.
 */

export function MedicationScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const lens = useQuery({
    queryKey: ['medications', dayKey, zone, 'psychiatric'],
    queryFn: () => fetchMedications(dayKey, zone, { psychiatricOnly: true, windowDays: 30 }),
  });

  const dose = useMutation({
    mutationFn: async (input: { readonly medicationId: string; readonly kind: 'taken' | 'skipped' }) => {
      await logDose({
        id: uuidV7(systemClock.nowMillis()),
        medicationId: input.medicationId,
        kind: input.kind,
        /*
         * The slot is *today*, resolved to the day's start in the operator's
         * zone rather than to "now".
         *
         * `scheduledFor` is the dose's identity — the repository dedupes on it —
         * so using `now` would make every tap a different dose and a
         * double-tapped morning would record two.
         */
        scheduledFor: `${dayKey}T00:00:00.000Z`,
        takenAt: input.kind === 'taken' ? nowIso : null,
        zone,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['medications'] });
    },
  });

  if (lens.isLoading) return <LoadingState label="Loading" />;

  const data = lens.data;
  if (data === undefined) return null;

  if (adding) {
    return (
      <MedicationRegisterForm
        zone={zone}
        onDone={() => {
          setAdding(false);
        }}
      />
    );
  }

  if (data.medications.length === 0) {
    return (
      <EmptyState
        icon="domain.medication"
        title="Nothing in the register yet"
        description="This view is a lens over the medication register, not a second copy of it. Adherence starts counting from the moment a medication and its schedule exist."
        action={{
          label: 'Add a medication',
          onAction: () => {
            setAdding(true);
          },
        }}
      />
    );
  }

  return (
    <Stack gap="5">
      <Inline justify="between" align="center">
        <Text role="caption" tone="tertiary">
          A filtered view of the register. Last {String(data.windowDays)} days.
        </Text>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setAdding(true);
          }}
        >
          Add
        </Button>
      </Inline>

      {data.medications.map((medication) => {
        const adherence = data.adherence.find((item) => item.medicationId === medication.id);
        const today = adherence?.days.at(-1);

        return (
          <Card key={medication.id} variant="raised">
            <CardBody>
              <Stack gap="3">
                <Text role="title-3" as="h2">
                  {medicationLabel(medication)}
                </Text>

                {medication.stoppedAt !== null ? (
                  <Text role="body-sm" tone="secondary">
                    Stopped on {medication.stoppedAt.slice(0, 10)}. Kept on record, and marked on every chart.
                  </Text>
                ) : (
                  <>
                    <Inline gap="2">
                      <Button
                        variant={today?.taken !== undefined && today.taken > 0 ? 'primary' : 'secondary'}
                        onClick={() => {
                          dose.mutate({ medicationId: medication.id, kind: 'taken' });
                        }}
                        disabled={dose.isPending}
                      >
                        Taken today
                      </Button>
                      {/* Neutral, never a warning tone. See the header. */}
                      <Button
                        variant="secondary"
                        onClick={() => {
                          dose.mutate({ medicationId: medication.id, kind: 'skipped' });
                        }}
                        disabled={dose.isPending}
                      >
                        Skipped
                      </Button>
                    </Inline>

                    {adherence !== undefined && (
                      <Stack gap="2">
                        {/* The whole sentence, always. Never the percentage alone. */}
                        <Text role="body-sm" tone="secondary">
                          {adherence.sentence}
                        </Text>
                        {adherence.ratio !== null && (
                          <Progress
                            value={adherence.ratio * 100}
                            label={`${String(adherence.dosesTaken)} of ${String(adherence.dosesExpected)} scheduled doses`}
                          />
                        )}
                      </Stack>
                    )}
                  </>
                )}
              </Stack>
            </CardBody>
          </Card>
        );
      })}

      <Text role="caption" tone="tertiary">
        A day with no record is not counted as a missed dose. Absence of data is not evidence of
        non-adherence, and conflating the two would make every figure on this page quietly wrong.
      </Text>
    </Stack>
  );
}
