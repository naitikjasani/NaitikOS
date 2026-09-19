import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  AdherenceGrid,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Grid,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';
import { CAREER_KIND_LABELS, PROJECT_STATUS_LABELS, TASK_BUCKET_LABELS } from '@naitikos/core';

import type { WorkOverview } from '@/lib/platform/work';

/**
 * `/work` — the pillar overview (§3.2, §4.8).
 *
 * Laid out in the five bands settled in `HealthOverviewScreen` — act, attend,
 * state, record, doors. Work is the pillar where the ordering earns its keep:
 * it has the most things that could plausibly go first, and before this it went
 * open tasks, then a nag, then a chart, then two lists, each with its own
 * bare arrow-link convention that appeared nowhere else in the application.
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
 * a log that shames you for a quiet fortnight is a log you stop opening, and
 * §1.5's no-streaks reasoning is the same reasoning: a missed fortnight costs a
 * fortnight, not the year before it.
 *
 * ## Nothing here is a score and nothing here is coloured
 *
 * Four overdue tasks is a count. It is not amber, it does not carry a warning
 * icon, and there is no project health score for the reason §4.8 gives. §8.2's
 * valence rule is written about health data and applies just as literally to a
 * productivity page opened by the same person on the same bad morning.
 */
export function WorkOverviewScreen({ overview }: { readonly overview: WorkOverview }): ReactNode {
  const buckets = overview.buckets;
  const openCount =
    buckets.overdue.length + buckets.today.length + buckets.soon.length + buckets.undated.length;
  const maxClosed = overview.closures.reduce((max, day) => Math.max(max, day.closed), 0);
  const active = overview.projects.filter((project) => project.status === 'active');

  return (
    <Stack gap="6">
      {/* 1 — Act. §4.8's protocol is one line on the day it ships, so the door
          to writing that line is the first control on the page. */}
      <Inline gap="3" wrap>
        <Button asChild variant="primary">
          <Link href="/work/career">Log something shipped</Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href="/work/tasks">Open the task board</Link>
        </Button>
      </Inline>

      {/* 2 — Attend. Both conditional, and neither is rendered as a placeholder
          when there is nothing to say. */}
      {overview.stale.length > 0 && (
        <Card variant="outlined">
          <CardHeader
            as="h2"
            title={`${String(overview.stale.length)} undated ${overview.stale.length === 1 ? 'task has' : 'tasks have'} sat untouched for two months`}
          />
          <CardBody>
            {/* A question, not an instruction. Nothing here closes a task on
                the operator's behalf — P5 holds at the smallest scale too. */}
            <Text role="body-sm" tone="secondary">
              Still things you mean to do?
            </Text>
          </CardBody>
        </Card>
      )}

      {overview.careerGapDays !== null && overview.careerGapDays >= overview.careerGapThreshold && (
        <Card variant="outlined">
          <CardHeader as="h2" title="The career log has been quiet" />
          <CardBody>
            <Text role="body-sm" tone="secondary">
              Nothing logged in {String(overview.careerGapDays)} days. The protocol is one line on the
              day it ships — a year reconstructed at review time is the problem this exists to avoid.
            </Text>
          </CardBody>
        </Card>
      )}

      {/* 3 — State. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Open work"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/work/tasks">Task board</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'Nothing open',
            description:
              'Tasks here exist for linkage — to a goal, a project, or a health action. An empty list is a fine state and not a gap to fill.',
          }}
        >
          {openCount === 0 ? null : (
            /* A grid rather than a wrapping row of four separate cards. Four
               cards inside a card was a container nesting §8.8 warns about, and
               at 360px they wrapped two-and-two into a ragged block that could
               not be read across. */
            <Grid gap="4" minColumnWidth="7rem">
              {(['overdue', 'today', 'soon', 'undated'] as const).map((key) => (
                <Stack key={key} gap="1">
                  <Text role="caption" tone="tertiary">
                    {TASK_BUCKET_LABELS[key]}
                  </Text>
                  <Text role="metric-m" as="span">
                    {String(buckets[key].length)}
                  </Text>
                </Stack>
              ))}
            </Grid>
          )}
        </CardBody>
      </Card>

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

      {/* 4 — Record. */}
      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Projects"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/work/projects">All projects</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'No active projects',
            description:
              'A project is the container tasks and career entries hang off. Without one they are still recorded — they are just harder to find in three years.',
          }}
        >
          {active.length === 0 ? null : (
            <Stack gap="3">
              {active.map((project) => (
                <Inline key={project.id} gap="3" align="center" justify="between" wrap>
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {project.name}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {String(project.standing.openTasks)} open ·{' '}
                      {String(project.standing.doneTasks)} done ·{' '}
                      {String(project.standing.careerEntries)} logged
                    </Text>
                  </Stack>
                  <Badge tone="neutral">{PROJECT_STATUS_LABELS[project.status]}</Badge>
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardHeader
          as="h2"
          title="Career log"
          actions={
            <Button asChild variant="ghost" size="sm">
              <Link href="/work/career">The whole log</Link>
            </Button>
          }
        />
        <CardBody
          empty={{
            title: 'The log is empty',
            description:
              'Every shipped thing gets one line on the day it ships. The line takes ten seconds; the year it reconstructs takes an afternoon to remember badly.',
          }}
        >
          {overview.recentCareer.length === 0 ? null : (
            <Stack gap="3">
              {overview.recentCareer.slice(0, 5).map((entry) => (
                <Inline key={entry.id} gap="3" align="center" justify="between" wrap>
                  <Text role="body" as="span">
                    {entry.title}
                  </Text>
                  <Badge tone="neutral">{CAREER_KIND_LABELS[entry.kind]}</Badge>
                </Inline>
              ))}
            </Stack>
          )}
        </CardBody>
      </Card>

      {/* 5 — Doors. */}
      <Card variant="flat">
        <CardHeader as="h2" title="Everything in Work" />
        <CardBody>
          <Inline gap="3" wrap>
            {[
              { href: '/work/tasks', label: 'Tasks' },
              { href: '/work/projects', label: 'Projects' },
              { href: '/work/career', label: 'Career' },
              { href: '/work/learning', label: 'Learning' },
              { href: '/work/calendar', label: 'Calendar' },
              { href: '/work/focus', label: 'Focus' },
            ].map((door) => (
              <Button key={door.href} asChild variant="ghost" size="sm">
                <Link href={door.href}>{door.label}</Link>
              </Button>
            ))}
          </Inline>
        </CardBody>
      </Card>
    </Stack>
  );
}
