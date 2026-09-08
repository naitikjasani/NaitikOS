/**
 * `/settings/data` — export, backup, and the audit log.
 *
 * ## Export is first because it is the obligation
 *
 * P2 makes the record the operator's, and §9.10 makes the export the discharge
 * of that: the archive is what survives this application. Everything else on
 * this page is context for it.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Data · Ekayu' };

export default async function DataPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:read');
  if (!authorized.ok) return null;

  return (
    <PageContainer title="Data" description="Getting the record out, and reading what has changed in it.">
      <Stack gap="5">
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Export
              </Text>
              <Text role="body-sm" tone="secondary">
                Every table, as JSON, plus the clinical history rendered as Markdown a person can read without
                this application. P2 makes the record yours; the export is what makes that true rather than
                stated.
              </Text>
              <Text role="caption" tone="tertiary">
                Media is not included. A photograph in the sensitive tier is encrypted with a key held on the
                capturing device, so the server could only ship bytes nothing can open — the monthly job with a
                filesystem is where media belongs.
              </Text>
              <Inline gap="2">
                <Link className="nos-inline-link" href="/settings/data/export">
                  <Text role="caption" as="span">
                    Build an export
                  </Text>
                </Link>
              </Inline>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Audit log
              </Text>
              <Text role="body-sm" tone="secondary">
                Every deletion, revision and restore, kept forever. §9.4 makes this domain data rather than
                operational logging — application logs expire, this does not.
              </Text>
              <Text role="caption" tone="tertiary">
                Nothing can amend it. The log is what makes every soft delete trustworthy, and a log with a
                write path would be evidence of nothing.
              </Text>
              <Inline gap="2">
                <Link className="nos-inline-link" href="/settings/data/audit">
                  <Text role="caption" as="span">
                    Read the log
                  </Text>
                </Link>
              </Inline>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Backup and restore
              </Text>
              <Text role="body-sm" tone="secondary">
                Backups are the hosting provider&rsquo;s, taken automatically. §13.2 is explicit that the
                control which matters is not the backup but the <em>tested restore</em> — the others are
                hypotheses without it.
              </Text>
              <Text role="caption" tone="tertiary">
                {/*
                  Stated plainly rather than dressed up as a feature. A restore
                  drill is an operational procedure with a runbook, not a button,
                  and a button here would make it look like one had been done.
                */}
                There is no restore button, and there should not be. The drill is a runbook, run against a
                clone, quarterly — and the date of the last one is not something this page can honestly claim
                to know.
              </Text>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Import
              </Text>
              <Text role="body-sm" tone="secondary">
                There is no whole-record import, deliberately. An export is for reading and for moving to
                whatever replaces this; an importer that rebuilt the database from one would be a second write
                path around every constraint the schema exists to enforce.
              </Text>
              <Inline gap="2">
                <Link className="nos-inline-link" href="/settings/integrations">
                  <Text role="caption" as="span">
                    Per-domain imports
                  </Text>
                </Link>
              </Inline>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Local copies
              </Text>
              {/*
                A pointer, not a control. An operator hunting for "delete my
                data" arrives on the page whose subject is the record, and the
                honest thing is to say which of the two things they might mean
                lives where — while being unambiguous that clearing a device
                removes nothing from the record. The buttons themselves are on
                `/settings/privacy`, because that page's subject is the exposure
                boundary rather than the record (§3.2).
              */}
              <Text role="body-sm" tone="secondary">
                Unsaved drafts, cached answers and writes still queued to be sent all sit in this browser
                rather than in the record. Clearing them changes nothing here — the export above, the audit log
                and every stored entry are untouched by it.
              </Text>
              <Text role="caption" tone="tertiary">
                Removing an entry from the record is a different act entirely: a soft delete with an audit
                entry (§9.4), made from the entry itself rather than from a settings page.
              </Text>
              <Inline gap="2">
                <Link className="nos-inline-link" href="/settings/privacy">
                  <Text role="caption" as="span">
                    Clear what this device is holding
                  </Text>
                </Link>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    </PageContainer>
  );
}
