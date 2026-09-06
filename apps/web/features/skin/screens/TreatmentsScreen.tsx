import type { ReactNode } from 'react';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TreatmentsBoard, TreatmentView } from '@/lib/platform/treatments';

/**
 * `/body/skin/treatments` — treatment courses, and the cumulative dose.
 *
 * ## The cumulative total is the reason the page exists
 *
 * `treatment_course.cumulative_dose` is on the table for one clinical reason:
 * isotretinoin is dosed to a lifetime cumulative total, and *how much have I
 * had across every course* is a question a dermatologist asks and a person
 * cannot answer from memory five years later. That figure is the deliverable;
 * everything else here is the context that makes it legible.
 *
 * The system does not compute mg/kg and does not compare against a target.
 * Both need a weight at the time of dosing and guidance that differs by
 * jurisdiction and by year — §10.0 keeps the application out of clinical
 * judgement, and a number carrying an implied threshold is a judgement whatever
 * label sits beside it.
 *
 * ## Totals are per unit, never summed across units
 *
 * Two lines rather than one number if two units are recorded. Adding mg to g is
 * §6.2's failure exactly, and the version that silently converts is worse than
 * the version that shows two lines — a conversion is an assumption about which
 * unit was meant, on a page about drug dosing.
 *
 * ## Every course is listed, not just dermatological ones
 *
 * A course points at a condition and neither carries a pillar. §9.3's design is
 * that pillars are queries over one record rather than separate databases, so
 * there is no `is_dermatological` flag to filter on — and inventing one to make
 * this page tidier would be inventing a taxonomy. A filter that guessed would
 * eventually hide a course, and a treatment missing from the treatment page is
 * worse than one that is not strictly about skin appearing on it.
 *
 * A Server Component. Courses are recorded through Health, where the clinical
 * context and the bitemporal revision path already live.
 */
export function TreatmentsScreen({ board }: { readonly board: TreatmentsBoard }): ReactNode {
  const current = board.treatments.filter((entry) => entry.isCurrent);
  const past = board.treatments.filter((entry) => !entry.isCurrent);

  return (
    <Stack gap="5">
      {board.cumulativeByUnit.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Cumulative dose
              </Text>
              {board.cumulativeByUnit.map((entry) => (
                <Text key={entry.unit} role="body">
                  {entry.total} {entry.unit}
                </Text>
              ))}
              <Text role="caption" tone="tertiary">
                Summed across every course that records one, per unit — never across units. This is the total
                taken, not a dose per kilogram and not a figure measured against any threshold; both depend on
                a weight at the time and on guidance this system does not hold.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {board.treatments.length === 0 ?
        <EmptyState
          title="No treatment courses recorded"
          description="A course is a treatment run over a period — a round of isotretinoin, a topical over three months. Recorded through Health, where the clinical context lives; shown here because the cumulative total is a dermatological question."
        />
      : <Stack gap="4">
          {current.length > 0 && (
            <Section title="Running now" treatments={current} />
          )}
          {past.length > 0 && <Section title="Finished" treatments={past} />}
        </Stack>
      }

      <Text role="caption" tone="tertiary">
        Every course is listed, not only dermatological ones. A course points at a condition and neither
        carries a pillar — filtering would mean guessing, and a treatment missing from this page would be
        worse than one that is not strictly about skin appearing on it.
      </Text>
    </Stack>
  );
}

function Section({
  title,
  treatments,
}: {
  readonly title: string;
  readonly treatments: readonly TreatmentView[];
}): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            {title}
          </Text>
          {treatments.map((entry) => (
            <TreatmentRow key={entry.course.id} entry={entry} />
          ))}
        </Stack>
      </CardBody>
    </Card>
  );
}

function TreatmentRow({ entry }: { readonly entry: TreatmentView }): ReactNode {
  const { course } = entry;

  return (
    <Stack gap="1">
      <Inline gap="3" justify="between" align="baseline">
        <Stack gap="0">
          <Inline gap="2" align="center">
            <Text role="body">{course.name}</Text>
            {course.outcome !== null && <Badge tone="neutral">{course.outcome.replace(/_/gu, ' ')}</Badge>}
          </Inline>
          <Text role="caption" tone="tertiary">
            {describePeriod(course.startedAt, course.endedAt)}
            {entry.conditionName === null ? '' : ` · for ${entry.conditionName}`}
            {course.prescriber === null ? '' : ` · ${course.prescriber}`}
          </Text>
        </Stack>

        {course.cumulativeDose !== null && (
          <Text role="body-sm">
            {course.cumulativeDose} {course.cumulativeDoseUnit ?? ''}
          </Text>
        )}
      </Inline>

      {course.outcomeNote !== null && (
        <Text role="caption" tone="tertiary">
          {course.outcomeNote}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Dates only, never a duration in days.
 *
 * "Ran for 147 days" is a computed figure nobody asked for, and on a page about
 * drug courses a derived number reads as clinically meaningful. The two dates
 * say the same thing without implying anything.
 */
function describePeriod(startedAt: string | null, endedAt: string | null): string {
  if (startedAt === null) return endedAt === null ? 'no dates recorded' : `until ${endedAt.slice(0, 10)}`;
  return endedAt === null ? `since ${startedAt.slice(0, 10)}` : `${startedAt.slice(0, 10)} to ${endedAt.slice(0, 10)}`;
}
