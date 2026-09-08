/**
 * `/settings/developer` — §3.2's maintainer page and §5.11's internal dashboard.
 *
 * §3.2 gives the route one line — "Feature flags, diagnostics, schema version" —
 * and §5.2 adds the button: the nightly run is "manually triggerable from
 * `/settings/developer`". §5.11 then puts the counter-metrics here too, because
 * "a single internal dashboard at `/settings/developer` renders it".
 *
 * ## Two reports, one page, and they are not the same subject
 *
 * The operational report answers *is the machinery running* — the nightly job,
 * the schema ledger, the flags, the database. The validation report answers *is
 * the product working*: §1.4's counter-metrics and the V1 gate. They share a
 * route because they share a reader and an intent, and they are kept visually
 * separate because conflating "the cron fired" with "the record is being kept"
 * is how a green dashboard hides a dead product.
 *
 * The operational half goes first. When something is wrong at 11pm, it is
 * almost always in that half.
 *
 * ## Read once, no polling
 *
 * A Server Component that reads once and hands whole reports down. There is no
 * client query here on purpose: the dashboard is opened deliberately, rarely,
 * and by the maintainer — polling it would add exactly the kind of background
 * request that makes §1.4's counter-metric, displayed further down this same
 * page, worse. The one interactive element refreshes the route after it acts.
 */

import type { ReactNode } from 'react';
import { dayKeyInZone, isoFromMillis, roleHasPermission, systemClock } from '@naitikos/core';

import { PageContainer } from '@/components/shell';
import { DiagnosticsScreen } from '@/features/settings';
import { DeveloperScreen } from '@/features/validation';
import { getDb, requireServerPermission } from '@/lib/auth/session';
import { DEFAULT_PROFILE_ZONE } from '@/lib/platform/context';
import { loadDeveloperDiagnostics } from '@/lib/platform/diagnostics';
import { loadValidationReport } from '@/lib/platform/validation';

export const metadata = { title: 'Developer · Ekayu' };
export const dynamic = 'force-dynamic';

export default async function DeveloperPage(): Promise<ReactNode> {
  /*
   * Authorized here as well as in the layout, per §5.4's single-authorization-
   * site-per-data-path rule — a Server Component that reads without asking is a
   * second way in. Both permissions are checked, because this page now reads two
   * genuinely different things and each is authorized where it is read.
   *
   * `settings:read` is the deliberate one, and it is the stricter of the two.
   * This page exposes operational internals: which background steps are wired
   * up, what the last run failed on, what the flags are set to, which Postgres
   * is answering. In `ROLE_PERMISSIONS` that keeps it to `owner` and `service`,
   * where `observation:read` alone would also admit a `clinician` — a role
   * defined for a shared export (§4.7), which has no business knowing the state
   * of this deployment's job queue. It is also the permission the endpoint this
   * page reads from already guards its GET with, so the page and the API agree
   * about who may see the same rows.
   *
   * `audit:read` was considered and is wrong: nothing here is §9.4's log, and
   * borrowing that permission would make the audit viewer's grant imply access
   * to a run trigger. `security:manage` is also wrong — it demands step-up
   * (§5.4), which is right for a key or a purge and disproportionate for reading
   * a job's status.
   */
  const authorized = await requireServerPermission('settings:read');
  if (!authorized.ok) return null;

  const forValidation = await requireServerPermission('observation:read');
  if (!forValidation.ok) return null;

  const zone = DEFAULT_PROFILE_ZONE;
  const db = getDb();
  const todayDayKey = dayKeyInZone(isoFromMillis(systemClock.nowMillis()), zone);

  const [diagnostics, report] = await Promise.all([
    loadDeveloperDiagnostics(db, { zone }),
    loadValidationReport(db, { todayDayKey, zone }),
  ]);

  /*
   * Whether to *offer* the trigger. A permission check, never a role check
   * (`roles.ts`: "Never branch on a role. Branch on a permission."), and it is
   * decided with the pure matrix rather than `requireServerPermission` because
   * this is a rendering decision — auditing an authorization denial for a button
   * that was never pressed would put noise in §9.4's log. The endpoint performs
   * the real check on the request itself.
   */
  const canTrigger = roleHasPermission(authorized.value.role, 'settings:write');

  return (
    <PageContainer
      title="Developer"
      description="What the machinery is doing, and the metrics that protect the metrics. §3.2, §5.2, §5.11."
      width="wide"
    >
      {diagnostics.ok ?
        <DiagnosticsScreen diagnostics={diagnostics.value} canTrigger={canTrigger} />
        /*
         * A plain sentence rather than an ErrorState, matching the treatment
         * below: this page failing is a maintenance signal, not something the
         * operator needs recovering from. The half that did load still renders —
         * a diagnostics page that goes blank because one of its five reads
         * failed is least useful exactly when it is most needed.
         */
      : <p>Diagnostics are unavailable: {diagnostics.error.message}</p>}

      {report.ok ?
        <DeveloperScreen report={report.value} />
      : <p>Telemetry is unavailable: {report.error.message}</p>}
    </PageContainer>
  );
}
