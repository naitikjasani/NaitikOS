'use client';

import { useState, type ReactNode } from 'react';
import { Button, Card, CardBody, Inline, Stack, Text, ToggleField } from '@naitikos/design-system';

/**
 * `/settings/data/export` — the export builder.
 *
 * ## One toggle, and it is not the one you would expect
 *
 * The obvious builder offers a table picker and a date range. Both are wrong
 * here. §9.10's export is the discharge of P2 — *the record is yours* — and a
 * partial export is not that. An archive missing whichever tables the operator
 * did not tick, or truncated to a range they chose in 2029, is an archive that
 * looks complete and is not, discovered by a stranger in 2046 who has no way to
 * tell what was left out.
 *
 * So the export is everything, always, and the single toggle governs the one
 * genuine distinction: operational tables are bookkeeping rather than facts
 * about a person, and they are off by default.
 *
 * ## The download is a plain link, not a fetch
 *
 * A whole record is tens of megabytes and the browser is much better at
 * streaming one to disk than JavaScript is at holding it in memory first. An
 * anchor also means a failed export shows the browser's own error rather than a
 * spinner that never resolves.
 */
export function ExportBuilderScreen(): ReactNode {
  const [includeOperational, setIncludeOperational] = useState(false);
  const href = includeOperational ? '/api/export?operational=true' : '/api/export';

  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              What the archive contains
            </Text>
            <Stack gap="1">
              <Text role="body-sm" tone="secondary">
                Every domain table as newline-delimited JSON, one file each, with a checksum per file.
              </Text>
              <Text role="body-sm" tone="secondary">
                The metric registry, so a bare <code>74.2</code> is still legible without this application —
                which is the whole point of §9.2 keeping descriptions as data rather than documentation.
              </Text>
              <Text role="body-sm" tone="secondary">
                The clinical history as Markdown, readable by a person with no software at all.
              </Text>
              <Text role="body-sm" tone="secondary">
                A README and a schema document describing what every column means.
              </Text>
            </Stack>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <ToggleField
              label="Include operational tables"
              description="Sync state, idempotency keys, job runs, telemetry. Bookkeeping about how the application ran, not facts about you — wanted for a backup drill, noise in an archive."
              checked={includeOperational}
              onCheckedChange={setIncludeOperational}
            />

            <Text role="caption" tone="tertiary">
              {/*
                Said here rather than discovered on unzipping. The absence is a
                deliberate decision and an archive that silently lacked photos
                would be the most misleading kind of complete-looking export.
              */}
              Media is never included. Sensitive-tier photographs are encrypted with a key held on the device
              that captured them, so the server can only ship bytes nothing can open. The monthly job that has
              a filesystem is where media belongs.
            </Text>

            <Inline gap="2">
              <Button asChild>
                {/* A plain link. See the screen header. */}
                <a href={href} download>
                  Download the archive
                </a>
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              There is no table picker
            </Text>
            <Text role="body-sm" tone="secondary">
              A partial export is not an export. An archive missing whichever tables were unticked, or cut to a
              range chosen years ago, looks complete and is not — and the person who discovers the gap has no
              way to tell what was left out. Everything, or nothing.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
