'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { WearablePlatform } from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  FileField,
  Inline,
  Progress,
  SegmentedControl,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { DeviceBoard } from '@/lib/platform/devices';
import {
  MAX_SAMPLE_BATCH,
  importSamples,
  parseSampleFile,
  type ImportSummary,
  type RawSampleRow,
} from '../services/devicesClient';

/**
 * `/body/devices` — where wearable data lands, and therefore where it is
 * imported (§2.3).
 *
 * ## The import lives with its results, not on the settings page
 *
 * `/settings/integrations` argues this for the other two imports: "an import
 * that runs somewhere other than where its results appear gives the operator
 * nothing to check the result against." A device import needs that more than
 * the others, not less — nobody can eyeball four hundred thousand heart-rate
 * readings, so the coverage table *is* the check, and it has to be on the same
 * page as the button.
 *
 * ## Coverage, not charts
 *
 * There is no trend line here. Charts over device metrics read the nightly
 * rollups (§5.6) like every other chart in the system; a page that computed its
 * own would be a second definition of what a daily average means, and it would
 * drift the first time the rollup changed. This page answers what got in.
 *
 * ## The aggregate count is shown beside the row count
 *
 * §9.7 drops raw rows after ninety days and keeps hourly means. An operator
 * looking at "412,000 samples" would reasonably assume minute resolution
 * throughout. §8.9 requires missing data be shown as missing; coarsened data
 * has to be shown as coarsened for the same reason.
 *
 * ## A skip is not an error, and the screen says which is which
 *
 * Three numbers come back and they mean different things: *already present* is
 * a re-import working correctly, *skipped* is a metric this system does not
 * track, and *rejected* is a reading that could not be trusted. Collapsing
 * them into one failure count would train the operator to stop re-importing,
 * which is how a month goes missing.
 */
export function DevicesScreen({ board }: { readonly board: DeviceBoard }): ReactNode {
  const router = useRouter();
  const [platform, setPlatform] = useState<WearablePlatform>('apple_health');
  const [problem, setProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);

  const run = useMutation({
    mutationFn: async (file: File): Promise<ImportSummary> => {
      const rows: readonly RawSampleRow[] = parseSampleFile(await file.text());
      setProgress({ sent: 0, total: rows.length });
      return importSamples(platform, '1', rows, (sent, total) => {
        setProgress({ sent, total });
      });
    },
    onSuccess: (result) => {
      setSummary(result);
      setProblem(null);
      setProgress(null);
      router.refresh();
    },
    onError: (error: unknown) => {
      setSummary(null);
      setProgress(null);
      setProblem(error instanceof Error ? error.message : 'The import did not finish.');
    },
  });

  const support = board.platforms.find((entry) => entry.platform === platform);

  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Import
            </Text>

            <SegmentedControl<WearablePlatform>
              label="Where it came from"
              value={platform}
              onValueChange={setPlatform}
              options={board.platforms.map((entry) => ({ value: entry.platform, label: entry.label }))}
            />

            <FileField
              label="The export"
              accept=".json,application/json"
              hint={`Read here in the browser and sent in batches of ${MAX_SAMPLE_BATCH.toLocaleString()}. Nothing fetches a file on your behalf.`}
              onFilesSelected={(files) => {
                const file = files[0];
                /* `noUncheckedIndexedAccess` is on, and an empty selection is a
                   real thing a file input produces. */
                if (file === undefined) return;
                run.mutate(file);
              }}
            />

            {progress !== null && (
              <Stack gap="1">
                <Progress
                  value={progress.total === 0 ? 0 : (progress.sent / progress.total) * 100}
                  label="Sending"
                />
                <Text role="caption" tone="tertiary">
                  {progress.sent.toLocaleString()} of {progress.total.toLocaleString()} readings sent. A
                  failure part-way through leaves what already landed; re-running the same file adds only
                  what is missing.
                </Text>
              </Stack>
            )}

            {problem !== null && (
              <Text role="body-sm" tone="critical">
                {problem}
              </Text>
            )}

            {summary !== null && <ImportSummaryPanel summary={summary} />}

            {support !== undefined && (
              <Text role="caption" tone="tertiary">
                {support.label} readings this system has a metric for:{' '}
                {support.identifiers.length.toLocaleString()} types. Anything else in the file is counted
                and left alone rather than failing the import.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                What is in the record
              </Text>
              {board.totalSamples > 0 && (
                <Badge tone="neutral">{board.totalSamples.toLocaleString()} readings</Badge>
              )}
            </Inline>

            {board.coverage.length === 0 ?
              <EmptyState
                title="No device data yet"
                description="Nothing has been imported. This page will show which metrics arrived, how many readings each has, and over what span."
              />
            : <Stack gap="2">
                {board.coverage.map((entry) => (
                  <Inline key={entry.metricKey} gap="3" align="baseline" justify="between">
                    <Stack gap="0">
                      <Text role="body">{entry.displayName}</Text>
                      <Text role="caption" tone="tertiary">
                        {formatSpan(entry.earliest, entry.latest)}
                      </Text>
                    </Stack>
                    <Stack gap="0" align="end">
                      <Text role="body-sm">{entry.samples.toLocaleString()}</Text>
                      {entry.aggregates > 0 && (
                        <Text role="caption" tone="tertiary">
                          {entry.aggregates.toLocaleString()} hourly averages
                        </Text>
                      )}
                    </Stack>
                  </Inline>
                ))}
              </Stack>
            }

            <Text role="caption" tone="tertiary">
              Readings are kept at full resolution for {board.retentionDays} days, then collapsed into
              hourly averages and the originals dropped. That is irreversible, so an export taken before
              the collapse is the only copy of the minute-by-minute record.
            </Text>

            {board.stranded > 0 && (
              <Text role="body-sm" tone="critical">
                {board.stranded.toLocaleString()} readings carry a timestamp outside every month this
                system has a place for — almost always an epoch artefact from the exporting device. They
                are stored and findable rather than discarded.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

function ImportSummaryPanel({ summary }: { readonly summary: ImportSummary }): ReactNode {
  return (
    <Stack gap="2">
      <Text role="body-sm">
        {summary.received.toLocaleString()} readings read, {summary.inserted.toLocaleString()} new.
      </Text>

      {summary.alreadyPresent > 0 && (
        <Text role="caption" tone="tertiary">
          {summary.alreadyPresent.toLocaleString()} were already here. Re-importing an overlapping export
          is the expected case, not a failure.
        </Text>
      )}

      {summary.duplicatesInBatch > 0 && (
        <Text role="caption" tone="tertiary">
          {summary.duplicatesInBatch.toLocaleString()} appeared twice inside the file itself.
        </Text>
      )}

      {summary.skippedTotal > 0 && (
        <Stack gap="0">
          <Text role="caption" tone="tertiary">
            {summary.skippedTotal.toLocaleString()} readings are of things this system does not track:
          </Text>
          <Text role="caption" tone="tertiary">
            {Object.entries(summary.skipped)
              .sort(([, a], [, b]) => b - a)
              .slice(0, 6)
              .map(([identifier, count]) => `${identifier} (${count.toLocaleString()})`)
              .join(', ')}
          </Text>
        </Stack>
      )}

      {summary.rejectedTotal > 0 && (
        <Stack gap="0">
          <Text role="body-sm" tone="critical">
            {summary.rejectedTotal.toLocaleString()} readings were refused because their value could not be
            trusted.
          </Text>
          {summary.rejected.slice(0, 5).map((entry) => (
            <Text key={`${entry.identifier}-${entry.observedAt}`} role="caption" tone="tertiary">
              {entry.observedAt} — {entry.reason}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * A span, in whole days.
 *
 * Rendered from the two instants the query already returned rather than
 * formatted in a zone, because the question this line answers is "how much
 * history is here" and not "which local day did it start on".
 */
function formatSpan(earliest: string, latest: string): string {
  const from = earliest.slice(0, 10);
  const to = latest.slice(0, 10);
  return from === to ? from : `${from} to ${to}`;
}
