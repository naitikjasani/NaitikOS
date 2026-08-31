/**
 * `/api/settings` — the AI consent write (§10.10, §7).
 *
 * ## `settings:write`, and a step-up would be wrong here
 *
 * This changes what may leave the machine, which argues for the strictest
 * possible guard. But §5.4 reserves step-up for the *export* path, and the
 * asymmetry is deliberate: an export is irreversible egress of everything, and
 * a consent grant is a reversible decision about future calls. Putting a
 * re-authentication in front of the switch the operator most needs to reach in
 * a hurry — the kill switch — would make the safety control the slowest one.
 *
 * ## Turning it off is always allowed
 *
 * There is no confirmation on disabling. §8.12's rule is that confirmation
 * protects against loss, and nothing is lost by switching the AI layer off:
 * every figure in the application is computed without it. A dialog here would
 * be friction in front of the one action that can only make things safer.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AI_CONSENT_SCOPES,
  MAX_MONTHLY_CAP_MINOR,
  MIN_MONTHLY_CAP_MINOR,
  validatePreferences,
} from '@naitikos/core';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';
import { saveAiPreferences } from '@/lib/platform/settings';

export const dynamic = 'force-dynamic';

const aiSettingsSchema = z.object({
  kind: z.literal('ai'),
  enabled: z.boolean(),
  /*
   * Every scope required, not partial. §10.10 makes them independently
   * revocable, and a partial patch would mean a client that omitted `journal`
   * left it at whatever it was — so a UI bug could preserve a grant the
   * operator had just cleared. The form always sends all four.
   */
  consent: z.object(
    Object.fromEntries(AI_CONSENT_SCOPES.map((scope) => [scope, z.boolean()])) as Record<
      (typeof AI_CONSENT_SCOPES)[number],
      z.ZodBoolean
    >,
  ),
  monthlyCapMinor: z.number().int().min(MIN_MONTHLY_CAP_MINOR).max(MAX_MONTHLY_CAP_MINOR),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const guarded = await guard(request, 'settings:write');
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, aiSettingsSchema, traceId);
  if ('response' in parsed) return parsed.response;

  /*
   * Validated twice, and the second is not redundant. Zod checks the wire
   * shape; `validatePreferences` is the domain rule — it is what rejects an
   * unknown consent scope rather than silently dropping it, and it is the
   * function every other writer of preferences will go through.
   */
  const domain = validatePreferences({
    ai: {
      enabled: parsed.data.enabled,
      consent: parsed.data.consent,
      monthlyCapMinor: parsed.data.monthlyCapMinor,
    },
  });
  if (!domain.ok) return errorResponse(domain.error, traceId);

  try {
    const saved = await saveAiPreferences(platform.db, domain.value.ai);
    if (!saved.ok) return errorResponse(saved.error, traceId);

    return NextResponse.json({ ai: saved.value.ai });
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in settings.post', {
      traceId,
      component: 'settings.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
