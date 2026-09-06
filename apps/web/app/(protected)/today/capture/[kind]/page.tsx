/**
 * `/today/capture/:kind` — §3.2's quick capture sheet, as a URL.
 *
 * ## This page renders nothing, and that is the specification
 *
 * §3.3(4): *"Capture must never require navigation."* A capture page would be
 * navigation, so there is no capture page. Every path through this route is a
 * redirect, and the operator never sees it.
 *
 * It exists because the contexts §3.3(4) names — the PWA shortcut menu, a
 * notification action, a share target — can hand the application a URL and
 * nothing else. They cannot open a sheet. So this is the adaptor between "a URL
 * is the only thing I can give you" and "capture is not a place".
 *
 * A sheet kind lands on `/today?capture=<slug>`, which opens the rail over the
 * page the operator would have opened anyway. A route kind lands on the route,
 * because for those four the route *is* the fastest path — see
 * `lib/capture/entrances.ts` for which and why.
 *
 * ## An unknown kind is a 404
 *
 * A home-screen shortcut outlives the code it points at. If a slug is ever
 * retired, the icon on the operator's phone keeps working for months, and the
 * honest answer is "that is not a thing" rather than a silent landing on
 * `/today` with nothing open — which reads as the application being broken.
 */

import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';

import { requireServerPermission } from '@/lib/auth/session';
import { CAPTURE_PARAM, entranceFor } from '@/lib/capture/entrances';

export const dynamic = 'force-dynamic';

export default async function CaptureEntrancePage({
  params,
}: {
  readonly params: Promise<{ readonly kind: string }>;
}): Promise<ReactNode> {
  /* `observation:write`, not `:read`. This is an entrance to a write, and a
   * read-only grant reaching a capture sheet would offer an action it could not
   * complete — the failure arriving after the operator had typed the number. */
  const authorized = await requireServerPermission('observation:write');
  if (!authorized.ok) return null;

  const { kind } = await params;
  const entrance = entranceFor(kind);
  if (entrance === null) notFound();

  redirect(
    entrance.target.kind === 'route'
      ? entrance.target.href
      : `/today?${CAPTURE_PARAM}=${encodeURIComponent(entrance.slug)}`,
  );
}
