import type { ReactNode } from 'react';
import Link from 'next/link';
import { AdherenceGrid, Badge, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import type { DosePeriod, MedicationDetail } from '@/lib/platform/medication';

/**
 * `/body/health/medications/:id` — one medication, its dose history, and the
 * side effects the operator suspected it of.
 *
 * ## Three sections, and the order is an argument
 *
 * The dose history comes first, above adherence. That is deliberate: adherence
 * is the figure a person comes here for, and it is the figure most likely to be
 * read as a verdict. Putting the titration above it frames the quarter as
 * *what was being taken*, so that a run of skipped days beside a dose increase
 * reads as a fact about the increase rather than a fact about the person.
 *
 * ## Nothing is red, and nothing says "missed"
 *
 * §4.7's no-negative-framing rule. The grid's blank days are days with no
 * record, and the sentence beneath it counts them explicitly — a psychiatrist
 * asking "have you been taking it?" is asking a clinical question, and a figure
 * that quietly counted un-logged days as misses would answer it wrongly in the
 * direction that changes prescribing.
 *
 * ## The side effects are labelled as suspicions
 *
 * The column is `suspectedMedicationId`, §9.2 says "linked but never asserted
 * as causal by the system", and this is the page where the distinction has to
 * survive contact with a layout — because a list of effects under a
 * medication's name *looks* like an attribution whatever the data means. So the
 * heading says whose suspicion it is, in the heading, not in a footnote.
 *
 * A Server Component. Recording a dose happens on the register, and changing
 * one is a new schedule rather than an edit (§9.5) — see the loader for why
 * there is no inline dose field here.
 */
export function MedicationDetailScreen({ detail }: { readonly detail: MedicationDetail }): ReactNode {
  const { medication, adherence } = detail;

  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h2">
                {detail.label}
              </Text>
              <Inline gap="2" align="center">
                {/* §8.2: colour is never the only carrier. Both states are
                    words. */}
                {medication.isPsychiatric && <Badge tone="accent">Psychiatric</Badge>}
                <Badge tone="neutral">{medication.stoppedAt === null ? 'Active' : 'Stopped'}</Badge>
              </Inline>
            </Inline>

            <Stack gap="1">
              {medication.brandName !== null && medication.brandName !== medication.substance && (
                <Text role="body-sm" tone="secondary">
                  {medication.substance}
                </Text>
              )}
              {medication.startedAt !== null && (
                <Text role="caption" tone="tertiary">
                  Started {medication.startedAt.slice(0, 10)}
                </Text>
              )}
              {medication.stoppedAt !== null && (
                <Text role="caption" tone="tertiary">
                  {/*
                    The reason travels with the stop, always. "Stopped" alone
                    invites the reading that it did not work; §4.4 records why
                    precisely so a later prescriber does not have to guess, and
                    a page that dropped it would waste the record.
                  */}
                  Stopped {medication.stoppedAt.slice(0, 10)}
                  {medication.stopReason === null ? '' : ` — ${medication.stopReason.replaceAll('_', ' ')}`}
                </Text>
              )}
            </Stack>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Dose history
            </Text>

            {detail.doseHistory.length === 0 ?
              <Text role="caption" tone="tertiary">
                No schedule on record. Doses can still be logged against the medication, but there is no
                denominator to compare them to — which is why the adherence figure below reports counts
                and not a ratio.
              </Text>
            : <Stack gap="2" as="ul">
                {detail.doseHistory.map((period) => (
                  <DoseRow key={period.scheduleId} period={period} />
                ))}
              </Stack>
            }

            <Text role="caption" tone="tertiary">
              {/*
                Stated on the page because it explains why the list is a list.
                A reader expecting a single current dose needs to know the older
                rows are not stale duplicates.
              */}
              A dose change is a new schedule with its own dates, never an edit of the old one. That is
              what makes this a history rather than a current value.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h2">
                Adherence
              </Text>
              <Text role="caption" tone="tertiary">
                last {String(detail.windowDays)} days
              </Text>
            </Inline>

            {adherence.recordedDays === 0 ?
              <Text role="caption" tone="tertiary">
                No doses recorded in this window. That is a gap in the log — it is not a record of doses
                not taken.
              </Text>
            : <AdherenceGrid
                title="Doses recorded"
                description="One square per day. Darker means a larger share of the day's scheduled doses was recorded as taken. Blank days have no record either way."
                fromDayKey={detail.fromDayKey}
                toDayKey={detail.toDayKey}
                data={{
                  yAxis: { label: 'Share of scheduled doses', zeroBaseline: true, min: 0, max: 1 },
                  series: [
                    {
                      id: medication.id,
                      label: detail.label,
                      slot: 1,
                      points: adherence.days
                        .filter((day) => day.recorded)
                        .map((day) => ({ at: day.dayKey, value: day.ratio })),
                    },
                  ],
                }}
              />
            }

            {/*
              `core` assembles this sentence so that no surface can render the
              ratio without the count of days that have no record. It is the
              load-bearing half.
            */}
            <Text role="body-sm" tone="secondary">
              {adherence.sentence}
            </Text>

            {adherence.dosesSkipped > 0 && (
              <Text role="caption" tone="tertiary">
                {String(adherence.dosesSkipped)}{' '}
                {adherence.dosesSkipped === 1 ? 'dose was' : 'doses were'} recorded as skipped. A skipped
                dose is information, recorded deliberately — it is a different thing from a day with no
                record.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Side effects you suspected of this
            </Text>

            {detail.suspectedEffects.length === 0 ?
              <Text role="caption" tone="tertiary">
                None recorded against this medication. Effects logged without a suspected cause are not
                listed here — an effect with no attribution is not evidence about this one.
              </Text>
            : <Stack gap="2" as="ul">
                {detail.suspectedEffects.map((effect) => (
                  <Inline key={effect.id} gap="3" justify="between" align="baseline" as="li">
                    <Stack gap="0">
                      <Text role="body" as="span">
                        {effect.effect}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {effect.onsetAt === null ? 'onset not recorded' : `from ${effect.onsetAt.slice(0, 10)}`}
                        {effect.resolvedAt === null ? ' · ongoing' : ` to ${effect.resolvedAt.slice(0, 10)}`}
                      </Text>
                    </Stack>
                    {!effect.reportedToPrescriber && (
                      /* §9.2: the one fact whose *absence of an action* is the
                         interesting part, and the reason the Consultation Pack
                         ranks it second only to a critical lab value. */
                      <Badge tone="neutral">not yet raised</Badge>
                    )}
                  </Inline>
                ))}
              </Stack>
            }

            <Text role="caption" tone="tertiary">
              Recorded as your suspicion, and left as one. This system does not judge whether a
              medication caused an effect — overlapping documented effects between an SNRI, an SSRI and
              isotretinoin make that a guess, and a confident interface around a guess is worse than
              none.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Link className="nos-inline-link" href="/body/health/medications">
        <Text role="caption" as="span">
          ← All medications
        </Text>
      </Link>
    </Stack>
  );
}

/** One schedule: what was taken, how often, and over which dates. */
function DoseRow({ period }: { readonly period: DosePeriod }): ReactNode {
  return (
    <Inline gap="3" justify="between" align="baseline" as="li">
      <Stack gap="0">
        <Text role="body" as="span">
          {period.dose} {period.doseUnit}
          <Text role="body-sm" tone="secondary" as="span">
            {' '}
            · {period.frequency.replaceAll('_', ' ')}
            {period.times.length === 0 ? '' : ` at ${period.times.join(', ')}`}
          </Text>
        </Text>
        {period.expectedPerDay === null && (
          <Text role="caption" tone="tertiary">
            {/*
              Named rather than left to be inferred from a missing ratio.
              `expectedDosesPerDay` refuses a daily denominator here on purpose:
              a weekly medication forced into one reports 0 of 1 on six days in
              seven for a perfectly adherent operator.
            */}
            No daily denominator — adherence over this period is counted, not rated.
          </Text>
        )}
      </Stack>
      <Text role="caption" tone="tertiary" as="span">
        {period.fromDayKey} → {period.toDayKey ?? 'now'}
      </Text>
    </Inline>
  );
}
