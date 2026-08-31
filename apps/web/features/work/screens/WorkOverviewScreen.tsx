import type { ReactNode } from 'react';
import Link from 'next/link';
import { AdherenceGrid, Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';
import { CAREER_KIND_LABELS, PROJECT_STATUS_LABELS, TASK_BUCKET_LABELS } from '@naitikos/core';

import type { WorkOverview } from '@/lib/platform/work';

/**
 * `/work` — the pillar overview (§3.2, §4.8).
 *
 * ## The closure strip is here to be laid next to something else
 *
 * §4.8's claim for this pillar is that it "is the missing variable that
 * explains a great many patterns in the others". The strip is the shape that
 * claim needs: day-keyed, four whole weeks, drawn with the same
 * `AdherenceGrid` the routine and medication screens use, so that comparing it
 * with them is a matter of looking at two pictures rather than reconciling two
 * conventions.
 *
 * It carries no interpretation. A quiet fortnight is drawn quietly and left
 * alone — §4.7's prohibition on "your mood is low because you skipped the gym"
 * is a prohibition on this system asserting a cause anywhere, and a productivity
 * page is where the temptation is strongest.
 *
 * ## The career gap is the only thing on this page that nudges
 *
 * §4.8's protocol is "every shipped thing gets one line on the day it ships",
 * and the failure it exists to prevent is reconstructing a year from memory. A
 * fortnight of silence is worth one sentence. It is a sentence, not a badge —
 * a log that shames you for a quiet fortnight is a log you stop opening.
 */
export function WorkOverviewScreen({ overview }: { readonly overview: WorkOverview }): ReactNode {
  const buckets = overview.buckets;
  const openCount =
    buckets.overdue.length + buckets.today.length + buckets.soon.length + buckets.undated.length;
  const maxClosed = overview.closures.reduce((max, day) => Math.max(max, day.closed), 0);
  const active = overview.projects.filter((project) => project.status === 'active');

  return (
    <Stack gap="6">
      <Stack gap="2">
        <Text role="title-3" as="h2">
          Open work
        </Text>
        {openCount === 0 ? (
          <EmptyState
            title="Nothing open"
            description="Tasks here exist for linkage — to a goal, a project, or a health action. An empty list is a fine state."
          />
        ) : (
          <Inline gap="2" wrap>
            {(['overdue', 'today', 'soon', 'undated'] as const).map((key) => (
              <Card key={key} variant="outlined">
                <CardBody>
                  <Stack gap="1">
                    <Text role="caption" tone="tertiary">
                      {TASK_BUCKET_LABELS[key]}
                    </Text>
                    <Text role="title-2" as="span">
                      {String(buckets[key].length)}
                    </Text>
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Inline>
        )}
        <Link href="/work/tasks">
          <Text role="body" tone="accent" as="span">
            Open the task board →
          </Text>
        </Link>
      </Stack>

      {overview.stale.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="1">
              <Text role="body" as="span">
                {String(overview.stale.length)} undated{' '}
                {overview.stale.length === 1 ? 'task has' : 'tasks have'} sat untouched for two months.
              </Text>
              {/* A question, not an instruction. Nothing here closes a task on
                  the operator's behalf — P5 holds at the smallest scale too. */}
              <Text role="caption" tone="tertiary">
                Still things you mean to do?
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      <AdherenceGrid
        title={`Tasks closed — last ${String(overview.closures.length)} days`}
        description="Day-keyed so it can be laid next to sleep, mood or training. It says nothing about why."
        fromDayKey={overview.closures[0]?.dayKey ?? overview.todayDayKey}
        toDayKey={overview.todayDayKey}
        data={{
          series: [
            {
              id: 'closures',
              label: 'Tasks closed',
              slot: 1,
              unit: 'tasks',
              points: overview.closures.map((day) => ({
                at: day.dayKey,
                /*
                 * Zero closures is a real zero here, not an absence: the query
                 * covered the day and found nothing. That differs from the
                 * routine grid, where a day with no log genuinely has no value.
                 */
                value: day.closed,
              })),
            },
          ],
          yAxis: { zeroBaseline: true, unit: 'tasks' },
        }}
      />
      {maxClosed === 0 && (
        <Text role="caption" tone="tertiary">
          Nothing closed in this window. The strip is drawn empty rather than hidden — §8.9: missing
          data is shown as missing.
        </Text>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Projects
        </Text>
        {active.length === 0 ? (
          <EmptyState title="No active projects" description="A project is the container tasks and career entries hang off." />
        ) : (
          active.map((project) => (
            <Card key={project.id} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {project.name}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {String(project.standing.openTasks)} open · {String(project.standing.doneTasks)} done ·{' '}
                      {String(project.standing.careerEntries)} logged
                    </Text>
                  </Stack>
                  <Badge tone="neutral">{PROJECT_STATUS_LABELS[project.status]}</Badge>
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
        <Link href="/work/projects">
          <Text role="body" tone="accent" as="span">
            All projects →
          </Text>
        </Link>
      </Stack>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Career log
        </Text>
        {overview.careerGapDays !== null && overview.careerGapDays >= overview.careerGapThreshold && (
          <Text role="body" tone="secondary">
            Nothing logged in {String(overview.careerGapDays)} days. The protocol is one line on the day
            it ships — a year reconstructed at review time is the problem this exists to avoid.
          </Text>
        )}
        {overview.recentCareer.length === 0 ? (
          <EmptyState
            title="The log is empty"
            description="Every shipped thing gets one line on the day it ships."
          />
        ) : (
          overview.recentCareer.slice(0, 5).map((entry) => (
            <Card key={entry.id} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Text role="body" as="span">
                    {entry.title}
                  </Text>
                  <Badge tone="neutral">{CAREER_KIND_LABELS[entry.kind]}</Badge>
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
        <Link href="/work/career">
          <Text role="body" tone="accent" as="span">
            The whole log →
          </Text>
        </Link>
      </Stack>
    </Stack>
  );
}
