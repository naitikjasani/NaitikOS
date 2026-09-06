/**
 * Reading §9.4's permanent audit log — `/settings/data/audit`.
 *
 * ## Read-only, all the way down
 *
 * There is no write path here and there is none in the repository either. The
 * log is what makes every soft delete in this system trustworthy: §9.4 keeps
 * prior state so a deletion is recoverable and a revision is inspectable. A
 * surface that could amend it would make it evidence of nothing.
 *
 * ## The most recent hundred, not a paged history
 *
 * A person opening this page is asking *what changed recently*, not reading
 * five years of it. Paging a table nobody browses would be machinery for a use
 * that has not happened; the total is reported so a page of a hundred is
 * legible as a page of a hundred rather than as everything there is.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError } from '@naitikos/core';
import type { AuditEntry, Database } from '@naitikos/db';
import { createAuditReader } from '@naitikos/db';

/** How many entries the viewer shows. See the header. */
export const AUDIT_PAGE_SIZE = 100;

export type AuditBoard = {
  readonly entries: readonly AuditEntry[];
  /** Distinct entity types present, for the filter. */
  readonly entityTypes: readonly string[];
  readonly total: number;
  readonly limit: number;
};

export async function loadAudit(db: Database): Promise<Result<AuditBoard, DomainError>> {
  const reader = createAuditReader(db);

  const [entries, entityTypes, total] = await Promise.all([
    reader.recent(AUDIT_PAGE_SIZE),
    reader.entityTypes(),
    reader.total(),
  ]);
  if (!entries.ok) return entries;
  if (!entityTypes.ok) return entityTypes;
  if (!total.ok) return total;

  return ok({
    entries: entries.value,
    entityTypes: entityTypes.value,
    total: total.value,
    limit: AUDIT_PAGE_SIZE,
  });
}
