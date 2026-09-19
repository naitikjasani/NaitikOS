'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
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
 * The medication register, and its psychiatric lens.
 *
 * §3.3(3): "one row, three lenses." There is no second medication register —
 * this component is both `/body/health/medications` (every row) and
 * `/mind/meds` (`?lens=psychiatric`, the two the operator is actually on),
 * separated by one prop.
 *
 * It lives under `mind/` because that lens shipped first, in V2, while Health
 * core was still ahead. The canonical route in §3.2 is the Health one and the
 * Mind route is documented there as "→ /body/health/medications, filtered";
 * the file has simply not been moved, and moving it would drag
 * `fetchMedications` and `logDose` out of `mindClient` for no behavioural gain.
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
 *
 * ## Today's record is a sentence, not a button colour
 *
 * The "Taken today" button switches from `secondary` to `primary` once a dose
 * is recorded, and for a while that was the only indication that the tap had
 * landed. §8.13 is unconditional about this: "no information conveyed by colour
 * alone". A filled button is not a state a screen reader can read, it is not a
 * state that survives a high-contrast mode, and — worst here — it is not a state
 * anybody can distinguish from the *default* filled button they have seen on
 * every other screen in the application. Somebody unsure whether this morning's
 * dose went in taps again, and while the repository dedupes on `scheduledFor`
 * so the count stays right, the uncertainty is the failure.
 *
 * So `aria-pressed` carries it to assistive technology, and a plain line
 * underneath carries it to everyone else. It states counts and never a verdict:
 * a day with nothing recorded says so, and does not say "missed".
 */

export function MedicationScreen({
  dayKey,
  zone,
  nowIso,
  psychiatricOnly = true,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
  /**
   * Which lens this is.
   *
   * Defaults to the psychiatric one because that is the lens that shipped
   * first and is the more sensitive of the two — a component that defaulted to
   * showing every medication would put the full register on `/mind/meds` the
   * first time somebody forgot the prop, which is the wrong direction to fail
   * in for §4.7's duty of care.
   *
   * §3.3(3), "one row, three lenses", is why this is a parameter rather than a
   * second component. Two screens over one endpoint would drift on exactly the
   * detail that matters here — whether days with no record are counted as
   * missed doses.
   */
  readonly psychiatricOnly?: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const lens = useQuery({
    /* The lens is part of the key. Without it, opening the register after the
     * psychiatric view would render two medications from cache and look like
     * a register with two rows in it. */
    queryKey: ['medications', dayKey, zone, psychiatricOnly ? 'psychiatric' : 'all'],
    queryFn: () => fetchMedications(dayKey, zone, { psychiatricOnly, windowDays: 30 }),
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
        const takenToday = today?.taken ?? 0;
        const skippedToday = today?.skipped ?? 0;

        return (
          <Card key={medication.id} variant="raised">
            <CardBody>
              <Stack gap="3">
                <Inline gap="3" justify="between" align="baseline">
                  <Text role="title-3" as="h2">
                    {medicationLabel(medication)}
                  </Text>
                  {/*
                    The detail page, and the only route to it.
                    §3.2 gives it the dose history — the titration this row
                    cannot show, because a register shows the dose now and the
                    clinically interesting part is how it got there.
                  */}
                  <Link className="nos-inline-link" href={`/body/health/medications/${medication.id}`}>
                    <Text role="caption" as="span">
                      History →
                    </Text>
                  </Link>
                </Inline>

                {medication.stoppedAt !== null ? (
                  <Text role="body-sm" tone="secondary">
                    Stopped on {medication.stoppedAt.slice(0, 10)}. Kept on record, and marked on every chart.
                  </Text>
                ) : (
                  <>
                    <Inline gap="2">
                      <Button
                        variant={takenToday > 0 ? 'primary' : 'secondary'}
                        aria-pressed={takenToday > 0}
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
                        aria-pressed={skippedToday > 0}
                        onClick={() => {
                          dose.mutate({ medicationId: medication.id, kind: 'skipped' });
                        }}
                        disabled={dose.isPending}
                      >
                        Skipped
                      </Button>
                    </Inline>

                    {/*
                      Today, in words. See the header for why the button colour
                      is not allowed to be the only carrier of this.
                    */}
                    <Text role="caption" tone="tertiary" aria-live="polite">
                      {todaySentence(takenToday, skippedToday)}
                    </Text>

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

/**
 * What is on record for today, for one medication.
 *
 * Counts and nothing else. There is no "missed" branch and there deliberately
 * cannot be one: §4.7's no-negative-framing rule, and the same argument the
 * footnote at the bottom of the screen makes — a day with no record is a day
 * with no record, and calling it a missed dose is the system inventing a
 * clinical fact in the direction that changes prescribing.
 */
function todaySentence(taken: number, skipped: number): string {
  if (taken === 0 && skipped === 0) return 'Nothing recorded for today yet.';

  const parts: string[] = [];
  if (taken > 0) parts.push(`${String(taken)} recorded as taken`);
  if (skipped > 0) parts.push(`${String(skipped)} recorded as skipped`);
  return `Today: ${parts.join(', ')}.`;
}
