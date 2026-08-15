'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  CONDITION_STATUS_LABELS,
  LAB_FLAG_LABELS,
  describeOnset,
  describeWhen,
  formatDay,
  formatBloodPressure,
  isOutOfRange,
  medicationLabel,
} from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { HealthOverview } from '@/lib/platform/health';

/**
 * `/body/health` — §4.4's overview.
 *
 * The question §3.1 asks a pillar page to answer is *what is my clinical state,
 * what am I taking, and what has actually happened to me?* — so this page is
 * four short lists and no charts. A chart on an overview is a chart nobody
 * reads; the trends live one level down, per analyte, where the printed range
 * that makes them legible lives too.
 *
 * ## Two things are surfaced ahead of everything else
 *
 * An out-of-range lab result and an unreported side effect. Both are things a
 * person means to raise at an appointment and does not, and both are one tap
 * from the question list that exists to carry them there (P5).
 *
 * ## No status is invented
 *
 * A flag this system derived from the printed range says so, in words rather
 * than by being a paler colour. §8.13 forbids colour-alone status and §9.2
 * forbids treating a recomputation as a laboratory's judgement; one label
 * satisfies both.
 */
export function HealthOverviewScreen({
  overview,
  nowIso,
}: {
  readonly overview: HealthOverview;
  /* Resolved on the server. §11.3 confines wall-clock reads to `core/temporal`,
     and a client that read its own clock would also disagree with the server
     about which appointment is "next" for anyone whose device clock drifts. */
  readonly nowIso: string;
}): ReactNode {
  const attention = overview.analytes.filter((analyte) => isOutOfRange(analyte.flag));

  const nothingYet =
    overview.conditions.length === 0 &&
    overview.medications.length === 0 &&
    overview.analytes.length === 0 &&
    overview.nextAppointment === null;

  if (nothingYet) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.clinical"
          title="Nothing on file yet"
          description="Conditions, medications and lab results appear here. A lab report dropped into the document vault becomes results you can confirm."
        />
        {/* `EmptyState.action` takes a callback, and this is navigation — a
            router push behind a button would be a link that cannot be opened in
            a new tab or read by a screen reader as one. */}
        <Text role="body-sm" tone="secondary" align="center">
          <Link className="nos-inline-link" href="/life/documents">
            Open the document vault
          </Link>
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="6">
      {attention.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Worth asking about
          </Text>
          {attention.map((analyte) => (
            <Card key={analyte.slug} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Stack gap="1">
                    <Link className="nos-inline-link" href={`/body/health/labs/${analyte.slug}`}>
                      {analyte.displayName}
                    </Link>
                    <Text role="caption" tone="tertiary">
                      {analyte.latestValue ?? '—'}
                      {analyte.unit === null || analyte.unit === '' ? '' : ` ${analyte.unit}`}
                      {analyte.collectedAt === null ? '' : ` · ${formatDay(analyte.collectedAt) ?? ''}`}
                    </Text>
                  </Stack>
                  <Inline gap="2" align="center">
                    <Badge tone="caution">
                      {analyte.flag === null ? 'Unflagged' : LAB_FLAG_LABELS[analyte.flag]}
                    </Badge>
                    {analyte.flagSource === 'derived' && (
                      <Text role="caption" tone="tertiary">
                        computed here, not printed
                      </Text>
                    )}
                  </Inline>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {overview.unreportedSideEffects.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Not yet mentioned to a prescriber
          </Text>
          {overview.unreportedSideEffects.map((effect) => (
            <Card key={effect.id} variant="flat">
              <CardBody>
                <Stack gap="1">
                  <Text role="body" as="span">
                    {effect.effect}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {effect.onsetAt === null ? 'Onset not recorded.' : `Since ${formatDay(effect.onsetAt) ?? ''}.`}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {overview.nextAppointment !== null && (
        <Card variant="raised">
          <CardBody>
            <Stack gap="2">
              <Inline justify="between" align="center">
                <Text role="title-3" as="h2">
                  {overview.nextAppointment.title}
                </Text>
                <Badge tone="accent">{describeWhen(overview.nextAppointment, nowIso) ?? 'unscheduled'}</Badge>
              </Inline>
              <Text role="caption" tone="tertiary">
                {overview.nextAppointment.preVisitQuestions.length === 0
                  ? 'No questions prepared yet.'
                  : `${String(overview.nextAppointment.preVisitQuestions.length)} questions ready.`}
              </Text>
              <Link className="nos-inline-link" href="/body/health/appointments">
                Prepare for it
              </Link>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Stack gap="2">
        <Inline justify="between" align="center">
          <Text role="title-3" as="h2">
            Conditions
          </Text>
          <Link className="nos-inline-link" href="/body/health/conditions">
            All of them
          </Link>
        </Inline>
        {overview.conditions.length === 0 ? (
          <Text role="body-sm" tone="secondary">
            Nothing on the register.
          </Text>
        ) : (
          overview.conditions.map((condition) => (
            <Card key={condition.id} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {condition.name}
                    </Text>
                    {/* §4.4's two clocks, in a sentence. */}
                    <Text role="caption" tone="tertiary">
                      {describeOnset(condition)}
                    </Text>
                  </Stack>
                  <Badge tone="neutral">{CONDITION_STATUS_LABELS[condition.status]}</Badge>
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>

      <Stack gap="2">
        <Inline justify="between" align="center">
          <Text role="title-3" as="h2">
            Medications
          </Text>
          <Link className="nos-inline-link" href="/mind/meds">
            Adherence
          </Link>
        </Inline>
        {overview.medications.length === 0 ? (
          <Text role="body-sm" tone="secondary">
            Nothing in the register.
          </Text>
        ) : (
          <Inline gap="2" wrap>
            {overview.medications.map((medication) => (
              <Badge key={medication.id} tone="neutral">
                {medicationLabel(medication)}
              </Badge>
            ))}
          </Inline>
        )}
      </Stack>

      {overview.latestVitals !== null && (
        <Stack gap="2">
          <Inline justify="between" align="center">
            <Text role="title-3" as="h2">
              Latest vitals
            </Text>
            <Link className="nos-inline-link" href="/body/health/vitals">
              History
            </Link>
          </Inline>
          <Card variant="flat">
            <CardBody>
              <Inline gap="4" wrap>
                {formatBloodPressure(overview.latestVitals) !== null && (
                  <Text role="body" as="span">
                    {formatBloodPressure(overview.latestVitals)} mmHg
                  </Text>
                )}
                {overview.latestVitals.restingHeartRate !== null && (
                  <Text role="body" as="span">
                    {trim(overview.latestVitals.restingHeartRate)} bpm
                  </Text>
                )}
                {overview.latestVitals.temperatureCelsius !== null && (
                  <Text role="body" as="span">
                    {trim(overview.latestVitals.temperatureCelsius)} °C
                  </Text>
                )}
                {overview.latestVitals.oxygenSaturation !== null && (
                  <Text role="body" as="span">
                    {trim(overview.latestVitals.oxygenSaturation)}% SpO₂
                  </Text>
                )}
              </Inline>
            </CardBody>
          </Card>
        </Stack>
      )}
    </Stack>
  );
}

/** `58.000000` out of `numeric(20,6)` is not a heart rate anybody wants to read. */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}
