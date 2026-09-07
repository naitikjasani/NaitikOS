import type { ReactNode } from 'react';
import { Badge, Card, CardBody, Divider, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { DeveloperDiagnostics } from '@/lib/platform/diagnostics';

import { NightlyRunTrigger } from '../components/NightlyRunTrigger';

/**
 * `/settings/developer` — the three things §3.2 names, and the button §5.2 asks for.
 *
 * > "`/settings/developer` — Feature flags, diagnostics, schema version"
 *
 * ## This screen's subject is the machinery, not the record
 *
 * Every other surface in this application is about a person. This one is about
 * whether the system that keeps their record is running, and the distinction
 * changes what honesty requires. A chart with a gap in it prompts a question. An
 * operational dashboard with a gap in it prompts a *conclusion* — "the job ran",
 * "the flags are set", "the schema is at 18" — and a maintainer acts on that
 * conclusion at 11pm without checking. §8.9's rule about showing missing data as
 * missing is therefore not a courtesy here; it is the only thing separating this
 * page from an actively misleading one.
 *
 * So three of the five sections below lead with an absence:
 *
 * - **The nightly run has never run.** `job_run` is empty, which is precisely
 *   the condition §5.16's alert exists to catch, so the page states it as a
 *   finding rather than rendering a tidy empty list.
 * - **`schema_migration` has no writer.** The number that would look most
 *   authoritative on this page is the one it declines to show. See the schema
 *   section.
 * - **The feature flags are inert.** Four rows, seeded, consulted by nothing.
 *   There is no toggle, because a toggle would be the page's first lie.
 *
 * ## Nothing here can be edited
 *
 * One button, which starts a job that was going to run at 03:00 anyway. That is
 * the whole of the write surface. §5.15's argument for flags is that a bad
 * change can be turned off without a deploy; the counter-argument to shipping a
 * flag editor *first* is that the control would appear to do that and would not,
 * and the operator would find out on the night they needed it.
 */

export function DiagnosticsScreen({
  diagnostics,
  canTrigger,
}: {
  readonly diagnostics: DeveloperDiagnostics;
  /**
   * Whether this session holds `settings:write`.
   *
   * Checked as a permission rather than a role (§5.4's rule), and it decides
   * whether the button is *offered*, never whether it is allowed — the endpoint
   * re-checks on the request itself. A caller who forged this would gain a
   * button that returns 403.
   */
  readonly canTrigger: boolean;
}): ReactNode {
  const { nightly, schema, flags, runtime } = diagnostics;

  return (
    <Stack gap="6">
      {/* --- The nightly run (§5.2, §5.16) ------------------------------ */}
      <Stack gap="3">
        <Inline gap="3" justify="between" align="baseline">
          <Text role="title-2" as="h2">
            The nightly run
          </Text>
          <Badge tone={nightly.healthy ? 'accent' : 'caution'}>
            {nightly.healthy ? 'Ran in the last 24 hours' : 'No cron run in the last 24 hours'}
          </Badge>
        </Inline>

        <Text role="body-sm" tone="secondary">
          One scheduled entry point, at 03:00 in {runtime.zone} (§5.2). The badge follows §5.16&rsquo;s own
          test — a <em>successful, non-manual</em> run inside 24 hours — so pressing the button below
          cannot turn it green. Debugging a dead cron must not be what makes the symptom disappear.
        </Text>

        {nightly.last === null ?
          <EmptyState
            icon="status.warning"
            title="No run has ever been recorded"
            description="`job_run` is empty. Either the cron has never fired against this database or every invocation died before writing its completion record — and §5.16 alerts on exactly this absence, so it is a finding rather than a blank slate. The button below writes the first row."
          />
        : <RunCard run={nightly.last} heading="Most recent run" />
        }

        {nightly.abandoned.length > 0 && (
          <Card variant="outlined">
            <CardBody>
              <Stack gap="2">
                <Inline gap="2" align="center">
                  <Badge tone="caution">Abandoned</Badge>
                  <Text role="title-3" as="h3">
                    {nightly.abandoned.length === 1 ?
                      'One run started and never finished'
                    : `${String(nightly.abandoned.length)} runs started and never finished`}
                  </Text>
                </Inline>

                <Text role="body-sm" tone="secondary">
                  Still <code>running</code> well past the fifteen-minute budget, which means the
                  invocation was killed mid-step with no chance to write <code>finish</code>. This is not
                  the same as a failure — the work may have completed — and treating it as one would make
                  the failure count meaningless.
                </Text>

                {nightly.abandoned.map((run) => (
                  <Inline key={run.id} gap="2" justify="between" align="baseline">
                    <Text role="body-sm">{run.jobName}</Text>
                    <Text role="caption" tone="tertiary">
                      started {formatInstant(run.startedAt)}
                    </Text>
                  </Inline>
                ))}

                <Text role="caption" tone="tertiary">
                  Nothing clears these. There is no sweep for stranded <code>job_run</code> rows — the
                  runner recovers stranded <em>tasks</em>, which is a different table — so they will stay
                  until someone deletes them by hand.
                </Text>
              </Stack>
            </CardBody>
          </Card>
        )}

        {canTrigger ?
          <NightlyRunTrigger />
        : <Card variant="outlined">
            <CardBody>
              <Text role="body-sm" tone="secondary">
                This session cannot start a run: the endpoint requires <code>settings:write</code>, which
                this role does not hold. The button is not shown rather than shown and refused.
              </Text>
            </CardBody>
          </Card>
        }

        {nightly.runs.length > 1 && (
          <Card variant="outlined">
            <CardBody>
              <Stack gap="2">
                <Text role="title-3" as="h3">
                  Earlier runs
                </Text>
                {nightly.runs.slice(1).map((run) => (
                  <Inline key={run.id} gap="2" justify="between" align="baseline">
                    <Inline gap="2" align="center">
                      <Badge tone={toneForStatus(run.status)}>{run.status}</Badge>
                      <Text role="body-sm">{run.jobName}</Text>
                      {run.isManual && (
                        <Text role="caption" tone="tertiary">
                          manual
                        </Text>
                      )}
                    </Inline>
                    <Text role="caption" tone="tertiary">
                      {formatInstant(run.startedAt)} · {formatDuration(run.durationMs)}
                    </Text>
                  </Inline>
                ))}
              </Stack>
            </CardBody>
          </Card>
        )}
      </Stack>

      <Divider />

      {/* --- Which steps are wired up ----------------------------------- */}
      <Stack gap="3">
        <Inline gap="3" justify="between" align="baseline">
          <Text role="title-2" as="h2">
            Steps
          </Text>
          <Text role="body-sm" tone="secondary">
            {String(nightly.registeredCount)} of {String(nightly.steps.length)} registered
          </Text>
        </Inline>

        <Text role="body-sm" tone="secondary">
          The full sequence, in execution order. The unregistered ones do domain work and arrive with
          their domains — a rollup step is meaningless before there is anything to roll up — so their
          absence is a statement about which modules exist, not about the pipeline being broken. Two
          orderings are load-bearing: <code>resolve-predictions</code> before{' '}
          <code>make-predictions</code>, and <code>maintain-partitions</code> before{' '}
          <code>downsample-samples</code>.
        </Text>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="1">
              {nightly.steps.map((step) => (
                <Inline key={step.name} gap="2" justify="between" align="baseline">
                  <Text role="body-sm" tone={step.registered ? 'primary' : 'tertiary'}>
                    {step.name}
                  </Text>
                  <Badge tone={step.registered ? 'accent' : 'neutral'}>
                    {step.registered ? 'registered' : 'not yet'}
                  </Badge>
                </Inline>
              ))}
            </Stack>
          </CardBody>
        </Card>

        <Text role="caption" tone="tertiary">
          {/*
            The honest caveat on this table. The registered set is declared in
            `lib/platform/diagnostics.ts` because `stepsFor` lives inside the
            route handler and a page cannot import from `app/api` without making
            a route module a library. A duplicated list drifts, so the drift is
            checked against the last complete run's own account of itself rather
            than being assumed away.
          */}
          {nightly.declarationDrift === null ?
            'This table is a declaration, not a reading: it restates the list inside the route handler, which a page cannot import. It is cross-checked against the step names a completed run records — and no run has completed yet, so nothing has checked it.'
          : nightly.declarationDrift.length === 0 ?
            'Cross-checked against the step names the last complete run recorded, and they agree.'
          : `The last complete run disagrees with this table about: ${nightly.declarationDrift.join(', ')}. Worth a look — a partial run started with "only" is indistinguishable from a full one in the record, so this can be a false alarm.`
          }
        </Text>

        <Text role="caption" tone="tertiary">
          Each step also returns a short <code>note</code> — &ldquo;3 recovered, 0 pending&rdquo; — and
          none of them is shown here, because none is stored. The runner builds its summary from the
          name, status, duration, row count and error code only, so the note is discarded before the
          recorder sees it. Fixing that means widening the summary in <code>core</code>, not this page.
        </Text>
      </Stack>

      <Divider />

      {/* --- Schema version --------------------------------------------- */}
      <Stack gap="3">
        <Text role="title-2" as="h2">
          Schema version
        </Text>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="3">
              <Stack gap="1">
                <Text role="metric-l" as="p">
                  {String(schema.applied.length)}
                </Text>
                <Text role="body-sm" tone="secondary">
                  migrations recorded in <code>public.schema_migration</code>
                </Text>
              </Stack>

              {schema.applied.length === 0 && (
                <Text role="body-sm" tone="critical">
                  Zero, and that is not because none has been applied.
                </Text>
              )}

              <Text role="body-sm" tone="secondary">
                <code>schema_migration</code> is the ledger the <em>application</em> owns — §9.4 gives it
                a checksum, an applied-by and a data-migration flag so that an archive opened in 2046 can
                state which schema produced it without understanding a particular migration tool. Nothing
                writes to it. The ledger that actually records what has been applied is{' '}
                <code>{schema.authoritativeLedger}</code>, maintained by drizzle-kit.
              </Text>

              <Text role="body-sm" tone="secondary">
                This page does not read that table, deliberately. It is another tool&rsquo;s private
                bookkeeping — its own schema, a double-underscore name, no compatibility promise across
                versions — and reaching into it from application code would buy a confident-looking number
                at the price of a hidden dependency on drizzle-kit&rsquo;s internals. It would also hide
                the actual defect, which is that the application&rsquo;s own ledger has no writer.
              </Text>

              <Text role="caption" tone="tertiary">
                The fix is a migration runner that records what it applied, in{' '}
                <code>packages/db/src/migrate.ts</code>. Until then the count above is the truthful
                answer to &ldquo;what does this application know about its own schema&rdquo;, and{' '}
                <code>psql -c &apos;select * from {schema.authoritativeLedger}&apos;</code> is the answer
                to what has been applied.
              </Text>

              {schema.applied.length > 0 && (
                <Stack gap="1">
                  {schema.applied.map((migration) => (
                    <Inline key={migration.id} gap="2" justify="between" align="baseline">
                      <Text role="body-sm">{migration.id}</Text>
                      <Text role="caption" tone="tertiary">
                        {formatInstant(migration.appliedAt)}
                        {migration.isDataMigration ? ' · data' : ''}
                        {migration.appliedBy === null ? '' : ` · ${migration.appliedBy}`}
                      </Text>
                    </Inline>
                  ))}
                </Stack>
              )}
            </Stack>
          </CardBody>
        </Card>
      </Stack>

      <Divider />

      {/* --- Feature flags (§5.15, §5.10) ------------------------------- */}
      <Stack gap="3">
        <Inline gap="3" justify="between" align="baseline">
          <Text role="title-2" as="h2">
            Feature flags
          </Text>
          <Badge tone="caution">Read by nothing</Badge>
        </Inline>

        <Text role="body-sm" tone="secondary">
          §5.15 wants a flag on anything touching the substrate, so a bad change can be turned off
          without a deploy. These rows are seeded and no code path consults any of them — including the
          AI kill switch, which is currently enforced by there being no model call to switch off rather
          than by the flag. Until something reads them, a deploy is the only rollback lever.
        </Text>

        {flags.length === 0 ?
          <EmptyState
            title="No flags in the table"
            description="`feature_flag` is seeded by the database package. An empty table means the seed has not been run against this database."
          />
        : <Card variant="outlined">
            <CardBody>
              <Stack gap="3">
                {flags.map((flag) => (
                  <Stack key={flag.key} gap="1">
                    <Inline gap="2" justify="between" align="baseline">
                      <Text role="body-sm">
                        <code>{flag.key}</code>
                      </Text>
                      <Badge tone={flag.enabled ? 'accent' : 'neutral'}>
                        {flag.enabled ? 'on' : 'off'}
                      </Badge>
                    </Inline>
                    <Text role="caption" tone="tertiary">
                      {flag.description}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      stored {formatInstant(flag.updatedAt)}
                      {flag.changeReason === null ? ' · never flipped' : ` · ${flag.changeReason}`}
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </CardBody>
          </Card>
        }

        <Text role="caption" tone="tertiary">
          There is no toggle here on purpose. A control that wrote <code>enabled</code> into a table
          nothing queries would look like a kill switch and be a checkbox, and the operator would
          discover the difference on the night they reached for it. A flag surface is worth building
          when the first code path reads a flag — with an audit row per flip (§9.4) and the change
          reason that column is waiting for.
        </Text>
      </Stack>

      <Divider />

      {/* --- Diagnostics ------------------------------------------------ */}
      <Stack gap="3">
        <Text role="title-2" as="h2">
          Diagnostics
        </Text>

        <Text role="body-sm" tone="secondary">
          Only what is genuinely measurable from inside a request. There is no uptime figure, no error
          rate and no request count on this page: §5.11 keeps telemetry in <code>app_event</code> with
          names and numbers only, and the §1.4 metrics that table does support are on the panel below
          rather than invented again here.
        </Text>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Fact label="Environment" value={runtime.environment} />
              <Fact
                label="Build"
                value={runtime.commit === null ? 'unknown' : runtime.commit.slice(0, 12)}
                note={
                  runtime.commit === null ?
                    'No commit is injected outside a platform build, and every package in this monorepo is at version 0.0.0 because nothing is published — so there is no build identifier to fall back on. Shown as unknown rather than as "local".'
                  : null
                }
              />
              <Fact label="Database" value={`PostgreSQL ${runtime.database.serverVersion}`} />
              <Fact label="Database name" value={runtime.database.databaseName} />
              <Fact
                label="Connectivity"
                value={`reachable, ${String(runtime.readMillis)} ms`}
                note="Not a health check but the consequence of one: this page is rendered from four queries, so a figure here at all means they returned."
              />
              <Fact
                label="Profile zone"
                value={runtime.zone}
                note="A constant in the platform context, not yet read from the profile row. The nightly's 03:00 and every day boundary in the record are local to it (§5.3)."
              />
              <Fact label="Rendered" value={formatInstant(runtime.generatedAt)} />
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    </Stack>
  );
}

/* =========================================================================
 * Small parts
 * ====================================================================== */

function RunCard({ run, heading }: { readonly run: DeveloperDiagnostics['nightly']['runs'][number]; readonly heading: string }): ReactNode {
  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" justify="between" align="baseline">
            <Text role="title-3" as="h3">
              {heading}
            </Text>
            <Badge tone={toneForStatus(run.status)}>{run.status}</Badge>
          </Inline>

          <Inline gap="4" wrap>
            <Fact label="Job" value={run.jobName} />
            <Fact label="Started" value={formatInstant(run.startedAt)} />
            <Fact
              label="Finished"
              value={run.finishedAt === null ? 'no ending recorded' : formatInstant(run.finishedAt)}
            />
            <Fact label="Duration" value={formatDuration(run.durationMs)} />
            <Fact
              label="Started by"
              value={run.isManual ? 'a person' : 'cron'}
              /* §5.16 depends on this distinction, so it is shown rather than
                 folded into the status badge. */
            />
            <Fact
              label="Rows touched"
              value={run.rowsAffected === null ? 'not reported' : String(run.rowsAffected)}
            />
          </Inline>

          {run.errorMessage !== null && (
            <Stack gap="1">
              <Text role="body-sm" tone="critical">
                {run.errorMessage}
              </Text>
              <Text role="caption" tone="tertiary">
                Step names and error codes only. §5.11&rsquo;s &ldquo;no payloads, ever&rdquo; applies to
                a job&rsquo;s account of itself too, so the message from the underlying failure is in the
                application log and not in this column.
              </Text>
            </Stack>
          )}

          {run.steps.length === 0 ?
            <Text role="body-sm" tone="secondary">
              No per-step detail was recorded. A run in progress has not written its steps yet; a
              finished run without them was recorded by a build that predates the column.
            </Text>
          : <Stack gap="1">
              {run.steps.map((step) => (
                <Inline key={step.name} gap="2" justify="between" align="baseline">
                  <Inline gap="2" align="center">
                    <Badge tone={toneForStatus(step.status)}>{step.status}</Badge>
                    <Text role="body-sm">{step.name}</Text>
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {formatDuration(step.durationMs)}
                    {/* Absent is not zero: a step that reported no row count did
                        not report having touched nothing. */}
                    {step.rowsAffected === null ? '' : ` · ${String(step.rowsAffected)} rows`}
                    {step.errorCode === null ? '' : ` · ${step.errorCode}`}
                  </Text>
                </Inline>
              ))}
            </Stack>
          }
        </Stack>
      </CardBody>
    </Card>
  );
}

function Fact({
  label,
  value,
  note = null,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | null;
}): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="body-sm">{value}</Text>
      {note !== null && (
        <Text role="caption" tone="tertiary">
          {note}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Status to badge tone.
 *
 * `failed` is critical; `running` and `skipped` are caution rather than
 * neutral, because both mean "this did not happen" and a neutral chip reads as
 * fine. Note that `halted` never appears — the recorder maps it to `failed` on
 * write — so a halted run is recognised by the skipped steps trailing a failed
 * one rather than by its own label.
 */
function toneForStatus(status: string): 'accent' | 'caution' | 'critical' | 'neutral' {
  if (status === 'succeeded') return 'accent';
  if (status === 'failed') return 'critical';
  if (status === 'running' || status === 'skipped' || status === 'pending') return 'caution';
  return 'neutral';
}

/**
 * An instant, to the second, in the stored zone.
 *
 * Matching `AuditScreen`: a slice of the ISO string rather than a locale format.
 * Two reasons hold on both pages — a maintainer correlating this against a log
 * line needs the same form the log uses, and a server-rendered locale format is
 * the classic hydration mismatch.
 */
function formatInstant(iso: string): string {
  return iso.slice(0, 19).replace('T', ' ');
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'not recorded';
  if (ms < 1000) return `${String(ms)} ms`;
  return `${String(Math.round(ms / 100) / 10)} s`;
}
