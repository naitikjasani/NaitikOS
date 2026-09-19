import 'server-only';

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
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Grid,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

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
 * ## The pillar shape, and this is the file that states it
 *
 * Every overview in the application — Health, Mind, Nutrition, Skin, Teeth,
 * Work, Money — is laid out in the same five bands, in the same order. §8.4:
 * "layout consistency is what makes a sixteen-domain application feel like one
 * product rather than sixteen." With sixteen domains the operator cannot afford
 * to re-learn per module where the log button is and where the lists end.
 *
 *   1. **Act.** The one thing this domain is opened to do, as a button, above
 *      everything else. Not behind a second navigation, and not at the bottom.
 *   2. **Attend.** Things worth raising, rendered *only when they exist.* Never
 *      a placeholder: a permanent "nothing needs attention" card trains the eye
 *      to skip the band on the morning something is finally in it.
 *   3. **State.** The two-second read — the figures or the chart.
 *   4. **Record.** The lists. One outlined card each, the header carrying the
 *      single link into the full surface, the body carrying a designed empty
 *      state rather than a sentence of grey apology.
 *   5. **Doors.** §3.2's children of this route, as a row of real targets.
 *
 * Bands 2 and 3 may be absent when the pillar has no such thing to show. Bands
 * 4 and 5 always render, because §8.8 makes "an empty card a designed state,
 * not a blank rectangle" — and a section that vanishes when empty teaches the
 * operator that the module is smaller than it is, which is the same lesson
 * §3.3 R6 spends a paragraph trying to avoid teaching.
 *
 * ## Two things are surfaced ahead of everything else
 *
 * An out-of-range lab result and an unreported side effect. Both are things a
 * person means to raise at an appointment and does not, and both are one tap
 * from the question list that exists to carry them there (P5).
 *
 * ## No status is invented, and no status is coloured
 *
 * A flag this system derived from the printed range says so, in words rather
 * than by being a paler colour. §8.13 forbids colour-alone status and §9.2
 * forbids treating a recomputation as a laboratory's judgement; one label
 * satisfies both.
 *
 * Every badge on this screen is `neutral`, and that is load-bearing rather than
 * incidental — see {@link FlagBadge}.
 *
 * ## A Server Component
 *
 * There is no interaction on this page: every control is a link, and the data
 * arrives as props from an `async` page. It carried `'use client'` for no
 * reason anyone recorded, which shipped a hydration bundle to render four
 * lists. §5.1 chose the App Router precisely so a read-only clinical page could
 * be HTML on first paint.
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
    overview.latestVitals === null &&
    overview.nextAppointment === null;

  if (nothingYet) {
    return (
      <Stack gap="6">
        <EmptyState
          icon="domain.clinical"
          title="Nothing on file yet"
          description="Conditions, medications, vitals and lab results appear here. A lab report dropped into the document vault becomes results you can confirm."
        />
        {/* `EmptyState.action` takes a callback and this is navigation, so the
            action is rendered beside it instead: a router push behind a button
            is a link that cannot be opened in a new tab, and §8.13's 44px
            target rules out the 13px inline link this used to be. */}
        <Inline gap="3" justify="center" wrap>
          <Button asChild variant="primary">
            <Link href="/body/health/symptoms">Log a symptom</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link href="/life/documents">Open the document vault</Link>
          </Button>
        </Inline>
        {/* Band 5 renders even here. An empty module that is also a dead end is
            how a person concludes there is nothing behind it. */}
        <HealthDoors />
      </Stack>
    );
  }

  return (
    <Stack gap="6">
      {/* 1 — Act. §4.4's most frequent write by a wide margin: a symptom is
          recorded on the day it happens or it is not recorded at all. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/body/health/symptoms">Log a symptom</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/body/health/vitals">Record vitals</Link>
        </Button>
      </Inline>

      {/* 2 — Attend. Both sections are conditional by design; see the header. */}
      {attention.length > 0 && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title="Worth asking about"
            description="Results outside the range printed on the report. What to do about one is a conversation, not a calculation (P5)."
          />
          <CardBody>
            <Stack gap="3">
              {attention.map((analyte) => (
                <Inline key={analyte.slug} justify="between" align="center" gap="3" wrap>
                  <Stack gap="1">
                    <Link className="nos-inline-link" href={`/body/health/labs/${analyte.slug}`}>
                      {analyte.displayName}
                    </Link>
                    <Text role="caption" tone="tertiary">
                      {analyte.latestValue ?? '—'}
                      {analyte.unit === null || analyte.unit === '' ? '' : ` ${analyte.unit}`}
                      {analyte.collectedAt === null
                        ? ''
                        : ` · ${formatDay(analyte.collectedAt) ?? ''}`}
                    </Text>
                  </Stack>
                  <FlagBadge
                    flag={analyte.flag}
                    derived={analyte.flagSource === 'derived'}
                  />
                </Inline>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}

      {overview.unreportedSideEffects.length > 0 && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title="Not yet mentioned to a prescriber"
            description="Recorded here and not yet said out loud."
          />
          <CardBody>
            <Stack gap="3">
              {overview.unreportedSideEffects.map((effect) => (
                <Stack key={effect.id} gap="1">
                  <Text role="body" as="span">
                    {effect.effect}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {effect.onsetAt === null
                      ? 'Onset not recorded.'
                      : `Since ${formatDay(effect.onsetAt) ?? ''}.`}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}

      {/* 3 — State. The next appointment is the only forward-looking fact this
          module holds, and the vitals are the only figures. */}
      {overview.nextAppointment !== null && (
        <Card variant="raised">
          <CardHeader
            as="h2"
            title={overview.nextAppointment.title}
            /* Neutral, not `accent`. §8.2 reserves accent for "interactive
               elements, primary actions, the current selection" and rules it
               out explicitly for "emphasis on data" — and "in 4 days" is data.
               It sat in accent here and read as a highlight the operator was
               meant to feel something about. */
            actions={
              <Badge tone="neutral">
                {describeWhen(overview.nextAppointment, nowIso) ?? 'unscheduled'}
              </Badge>
            }
          />
          <CardBody>
            <Stack gap="3">
              <Text role="body-sm" tone="secondary">
                {overview.nextAppointment.preVisitQuestions.length === 0
                  ? 'No questions prepared yet. The list is what stops a fifteen-minute appointment being reconstructed from memory afterwards.'
                  : `${String(overview.nextAppointment.preVisitQuestions.length)} questions ready.`}
              </Text>
              <Inline gap="3" wrap>
                <Button asChild variant="secondary" size="sm">
                  <Link href="/body/health/appointments">Prepare for it</Link>
                </Button>
                {/* §10.7's payoff, one link from the appointment it exists
                    for. A pack reachable only from a settings menu is a pack
                    nobody prints on the morning of a consultation. */}
                <Button asChild variant="ghost" size="sm">
                  <Link href="/timeline/medical/pack">Build a consultation pack</Link>
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      )}

      {overview.latestVitals !== null && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title="Latest vitals"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/body/health/vitals">History</Link>
              </Button>
            }
          />
          <CardBody>
            {/* A grid rather than a wrapping row: four readings of very
                different widths in an `Inline` re-flow into a ragged line that
                cannot be scanned down. §8.4's `Grid` is intrinsically
                responsive, so this is one column at 360px without a query. */}
            <Grid gap="4" minColumnWidth="8rem">
              <Vital
                label="Blood pressure"
                value={formatBloodPressure(overview.latestVitals)}
                unit="mmHg"
              />
              <Vital
                label="Resting heart rate"
                value={
                  overview.latestVitals.restingHeartRate === null
                    ? null
                    : trim(overview.latestVitals.restingHeartRate)
                }
                unit="bpm"
              />
              <Vital
                label="Temperature"
                value={
                  overview.latestVitals.temperatureCelsius === null
                    ? null
                    : trim(overview.latestVitals.temperatureCelsius)
                }
                unit="°C"
              />
              <Vital
                label="Oxygen saturation"
                value={
                  overview.latestVitals.oxygenSaturation === null
                    ? null
                    : trim(overview.latestVitals.oxygenSaturation)
                }
                unit="%"
              />
            </Grid>
          </CardBody>
        </Card>
      )}

      {/* 4 — Record. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Conditions"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/body/health/conditions">All of them</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing on the register',
            description:
              'A condition recorded here carries its own two clocks — when it started and when it was diagnosed — and dates every entry on the medical timeline.',
          }}
        >
          {overview.conditions.length === 0 ? null : (
            <Stack gap="3">
              {overview.conditions.map((condition) => (
                <Inline key={condition.id} justify="between" align="center" gap="3" wrap>
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
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Medications"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/mind/meds">Adherence</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing in the register',
            description:
              'One row per medication or supplement, read by three lenses: the clinical register, the psychiatric view, and the medical timeline.',
          }}
        >
          {overview.medications.length === 0 ? null : (
            <Inline gap="2" wrap>
              {overview.medications.map((medication) => (
                <Badge key={medication.id} tone="neutral">
                  {medicationLabel(medication)}
                </Badge>
              ))}
            </Inline>
          )}
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <HealthDoors />
    </Stack>
  );
}

/**
 * §3.2's children of `/body/health`, as a row of real targets.
 *
 * Buttons rather than the 13px inline links this band used to be: §8.13 wants
 * ≥44×44px with ≥8px separation, and `size="sm"` carries a full-size hit area
 * on a small box (see `.nos-button--sm::after`), which is why the gap here is
 * `3` rather than `2` — two small buttons closer than that share pixels.
 */
function HealthDoors(): ReactNode {
  const doors = [
    { href: '/body/health/vitals', label: 'Vitals' },
    { href: '/body/health/labs', label: 'Labs' },
    { href: '/body/health/conditions', label: 'Conditions' },
    { href: '/body/health/symptoms', label: 'Symptoms' },
    { href: '/body/health/appointments', label: 'Appointments' },
  ] as const;

  return (
    <Card variant="flat">
      <CardHeader as="h2" title="Everything in Health" />
      <CardBody>
        <Inline gap="3" wrap>
          {doors.map((door) => (
            <Button key={door.href} asChild variant="ghost" size="sm">
              <Link href={door.href}>{door.label}</Link>
            </Button>
          ))}
        </Inline>
      </CardBody>
    </Card>
  );
}

/**
 * A lab flag, and the reason it is not amber.
 *
 * This badge was `tone="caution"`. §8.2's table names `--color-caution` as
 * "requires attention, expiring, unsynced" and rules it out explicitly for
 * "'concerning' readings" — and then states the rule in one line: **health data
 * is never coloured by valence.** An out-of-range ferritin rendered amber is
 * the application telling somebody with an anxiety disorder to be alarmed,
 * every time they open the page, about a number a clinician has not yet looked
 * at. "Colour-as-judgement turns a tool into a critic, and a critic is not
 * something you open every day."
 *
 * The deviation is still communicated, and more precisely than colour managed:
 * the flag's own word — High, Low — is §8.2's "position relative to a
 * baseline", and it survives forced-colours mode, greyscale printing and
 * §8.13's colour-alone prohibition, none of which amber does.
 */
function FlagBadge({
  flag,
  derived,
}: {
  readonly flag: HealthOverview['analytes'][number]['flag'];
  readonly derived: boolean;
}): ReactNode {
  return (
    <Inline gap="2" align="center">
      <Badge tone="neutral">{flag === null ? 'Unflagged' : LAB_FLAG_LABELS[flag]}</Badge>
      {derived && (
        <Text role="caption" tone="tertiary">
          computed here, not printed
        </Text>
      )}
    </Inline>
  );
}

/**
 * One reading, labelled.
 *
 * A missing reading is rendered as an em dash under its own label rather than
 * omitted from the row. §8.9(3): missing data is shown as missing — and on a
 * vitals card the difference between "SpO₂ was not taken" and "SpO₂ is fine"
 * is the whole value of the card.
 */
function Vital({
  label,
  value,
  unit,
}: {
  readonly label: string;
  readonly value: string | null;
  readonly unit: string;
}): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Inline gap="1" align="baseline">
        <Text role="metric-m" as="span">
          {value ?? '—'}
        </Text>
        {value !== null && (
          <Text role="caption" tone="tertiary" as="span">
            {unit}
          </Text>
        )}
      </Inline>
    </Stack>
  );
}

/** `58.000000` out of `numeric(20,6)` is not a heart rate anybody wants to read. */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}
