/**
 * The settings service — §3.2's `/settings/ai`, and §10.10's consent record.
 *
 * ## Why the consent state and the spend live in one read
 *
 * They are one decision. "Should I grant the journal scope" is not answerable
 * without knowing what the layer has cost and how often it has been blocked,
 * and a page that made the operator navigate between the two would be asking
 * them to consent with half the information.
 */

import 'server-only';

import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { AiPreferences, DomainError, NotificationPreferences, Preferences } from '@naitikos/core';
import { dayKeyInZone, isoFromMillis, systemClock, zonedDayBounds } from '@naitikos/core';
import type { Database, InteractionSummary } from '@naitikos/db';
import { createAiInteractionRepository, createProfileRepository } from '@naitikos/db';

export type AiSettings = {
  readonly preferences: AiPreferences;
  readonly spend: InteractionSummary;
  /** Whether a key is configured at all. A grant with no key grants nothing. */
  readonly transportConfigured: boolean;
  readonly monthStartIso: string;
};

/**
 * The first instant of the current calendar month, in the operator's zone.
 *
 * §10.11's cap is monthly, and a month is a *calendar* month rather than a
 * rolling thirty days — a rolling window would mean the cap never resets, and
 * the operator could not answer "how much have I spent this month" with the
 * same number their card statement shows.
 */
function monthStart(zone: string): string {
  const nowIso = isoFromMillis(systemClock.nowMillis());
  const today = dayKeyInZone(nowIso, zone);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  return zonedDayBounds(firstOfMonth, zone)?.start ?? nowIso;
}

export async function loadAiSettings(db: Database, zone: string): Promise<Result<AiSettings, DomainError>> {
  const sinceIso = monthStart(zone);

  const [preferences, spend] = await Promise.all([
    createProfileRepository(db).getPreferences(),
    createAiInteractionRepository(db).summarySince(sinceIso),
  ]);

  if (!preferences.ok) return preferences;
  if (!spend.ok) return spend;

  return ok({
    preferences: preferences.value.ai,
    spend: spend.value,
    /*
     * Read here rather than on the client. `ANTHROPIC_API_KEY` must never reach
     * a browser bundle, and the only thing a surface needs to know is whether
     * one exists — which is a boolean, not a secret.
     */
    transportConfigured: (process.env['ANTHROPIC_API_KEY'] ?? '').trim() !== '',
    monthStartIso: sinceIso,
  });
}

/**
 * Write the AI block, leaving every other preference untouched.
 *
 * Read-modify-write on the whole blob, because `setting` holds preferences as
 * one row of `jsonb` (§9.2). A partial write would drop the theme, and a
 * settings page that silently reset an unrelated preference is the kind of bug
 * that gets found months later by someone wondering why the app went light.
 */
export async function saveAiPreferences(
  db: Database,
  next: AiPreferences,
): Promise<Result<Preferences, DomainError>> {
  const profiles = createProfileRepository(db);

  const current = await profiles.getPreferences();
  if (!current.ok) return current;

  return profiles.updatePreferences({ ...current.value, ai: next });
}

export type { InteractionSummary };

/**
 * The stored notification preferences.
 *
 * Read for display only. §3.2 promises "Reminders — opt-in only" and the
 * preference block is real — it sits in `setting` and it is what a delivery
 * path will read on the day one exists — but nothing sends anything today. The
 * page shows the stored values and says so, rather than rendering controls
 * wired to nothing: a toggle that changes no behaviour teaches the operator
 * that the interface lies, which is a more expensive thing to lose than a
 * feature.
 */
export async function loadNotificationPreferences(
  db: Database,
): Promise<Result<NotificationPreferences, DomainError>> {
  const preferences = await createProfileRepository(db).getPreferences();
  if (!preferences.ok) return preferences;
  return ok(preferences.value.notifications);
}

