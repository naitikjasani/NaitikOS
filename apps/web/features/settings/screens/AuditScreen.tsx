'use client';

import { useState, type ReactNode } from 'react';
import { Badge, Card, CardBody, EmptyState, Inline, SegmentedControl, Stack, Text } from '@naitikos/design-system';

import type { AuditBoard } from '@/lib/platform/audit';

/**
 * `/settings/data/audit` — §9.4's permanent log, read.
 *
 * ## The before and after states are not shown, and that is the design
 *
 * `audit_log` holds whole entity snapshots in `before_state` and `after_state`
 * — a journal entry, a symptom note, a crisis plan. §5.11's rule is names and
 * numbers, never content, and a viewer that rendered those columns would put
 * the most sensitive text in the database onto a settings page: the one screen
 * most likely to be open while somebody is looking over a shoulder.
 *
 * So this answers *what changed, when, and who did it*. What it changed to is
 * the entity's own surface to show, behind that entity's own permission.
 *
 * ## Nothing here can write
 *
 * The log is what makes every soft delete trustworthy. A screen that could
 * amend it would make it evidence of nothing, so the repository behind this has
 * no write path and will not grow one.
 *
 * ## A quiet log is a good log
 *
 * The empty state does not apologise. Most weeks nothing is deleted or revised,
 * and a page that framed that as "no activity" would imply something was
 * missing.
 */
export function AuditScreen({ board }: { readonly board: AuditBoard }): ReactNode {
  const [entityType, setEntityType] = useState<string>('');

  const shown = entityType === '' ? board.entries : board.entries.filter((e) => e.entityType === entityType);

  return (
    <Stack gap="5">
      <Inline gap="3" justify="between" align="baseline">
        <Text role="body-sm" tone="secondary">
          {board.total === 0 ?
            'Nothing recorded'
          : `${String(board.total)} ${board.total === 1 ? 'entry' : 'entries'}, showing the most recent ${String(board.limit)}`}
        </Text>
      </Inline>

      {board.entityTypes.length > 1 && (
        <SegmentedControl<string>
          label="Filter"
          value={entityType}
          onValueChange={setEntityType}
          size="sm"
          options={[{ value: '', label: 'Everything' }, ...board.entityTypes.map((t) => ({ value: t, label: t }))]}
        />
      )}

      {shown.length === 0 ?
        <EmptyState
          title="Nothing to show"
          description="Deletions, revisions and restores appear here and stay forever. Most weeks there are none, which is the ordinary case rather than a gap."
        />
      : <Stack gap="2">
          {shown.map((entry) => (
            <Card key={entry.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Inline gap="2" align="baseline" justify="between">
                    <Inline gap="2" align="center">
                      <Badge tone={entry.operation === 'purge' ? 'caution' : 'neutral'}>
                        {entry.operation.replace(/_/gu, ' ')}
                      </Badge>
                      <Text role="body-sm">{entry.entityType}</Text>
                    </Inline>
                    <Text role="caption" tone="tertiary">
                      {entry.occurredAt.slice(0, 19).replace('T', ' ')}
                    </Text>
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {entry.actor}
                    {entry.changeReason === null ? '' : ` · ${entry.changeReason}`}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      }

      <Text role="caption" tone="tertiary">
        What each change contained is not shown here. The log records that something changed and who changed
        it; the content belongs to the entity, behind that entity&rsquo;s own permission.
      </Text>
    </Stack>
  );
}
