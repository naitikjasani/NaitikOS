/**
 * The clearing decisions, and the sentences that report them.
 *
 * Everything here is a pure function of a count. It lives in a `.ts` module
 * rather than inside `LocalDataScreen.tsx` because the suite covers `lib/` and
 * `features/` `.ts` only, and the two rules below are the ones that must not
 * regress quietly:
 *
 * 1. **A discard is offered only for writes that have given up.** See
 *    {@link outboxDisposition}. The store enforces this too
 *    (`discardBlockedEntries`), and it is checked in both places because the
 *    §5.7 guarantee is worth two locks.
 * 2. **Every label carries its count.** "Clear 3 drafts" and "Clear drafts" are
 *    different acts. The operator cannot browse either store — there is no
 *    screen that lists drafts, and the queue is only visible as a banner — so
 *    the number in the label is the whole of their view into what they are about
 *    to destroy. A button that hid it would be asking for consent to an unknown
 *    quantity of §4.7 material.
 *
 * The copy itself is asserted in `localData.test.ts`, which is unusual and
 * deliberate: two sentences here have to keep saying that the *server record* is
 * untouched, and a well-meaning edit that dropped that clause would turn an
 * honest control into a frightening one.
 */

import { draftAgeLabel, type DraftInventory } from '@/lib/offline/drafts';
import type { OutboxHealth } from '@/lib/offline/outbox';

/** "1 draft", "3 drafts". Plural by irregularity, not by appending an s. */
function quantity(amount: number, singular: string, plural: string): string {
  return `${String(amount)} ${amount === 1 ? singular : plural}`;
}

/* -------------------------------------------------------------------------
 * The outbox — the store that may refuse
 * ---------------------------------------------------------------------- */

/**
 * What, if anything, may be discarded from the capture outbox.
 *
 * ## The refusal is per entry, not per queue
 *
 * The tempting rule is "refuse while the queue is non-empty", and it is wrong in
 * both directions. §5.7's requirement is about a *write*:
 *
 *   "A failed drain must never silently discard a write. Entries persist until
 *    acknowledged."
 *
 * A `pending` entry is a write that has not finished trying, and a `sending`
 * entry is one in flight. Neither is ever discardable from this surface — not
 * behind a dialog, not behind a typed confirmation — because the remedy for both
 * is free: connect, drain, or wait for the backoff. Refusing costs the operator
 * a few minutes; agreeing costs them a workout they believe is logged, and the
 * asymmetry is total.
 *
 * A `blocked` entry is the opposite case. It has spent every one of
 * `MAX_ATTEMPTS`, §5.7 puts it in "a visible unsynced state with a manual
 * retry", and it is waiting for a person to decide. Abandoning it is that
 * person's decision to make and the only route to a device with nothing unsent
 * on it — a queue that could never be emptied would mean the operator could
 * never honestly hand the laptop to anybody.
 *
 * So a queue with three pending and two blocked entries offers a discard of
 * exactly two, and says so. Blocking that on the three would be theatre: the
 * store's own filter cannot touch them regardless.
 */
export type OutboxDisposition =
  /** Nothing queued. Nothing to offer. */
  | { readonly kind: 'empty' }
  /** Everything queued is still trying. No discard is offered at all. */
  | { readonly kind: 'waiting'; readonly unsent: number }
  /** Some entries have given up. Those, and only those, may be discarded. */
  | { readonly kind: 'discardable'; readonly blocked: number; readonly unsent: number };

export function outboxDisposition(health: OutboxHealth): OutboxDisposition {
  /* `sending` counts as unsent: it is a request in flight whose response has not
   * arrived, and until it does the write is unacknowledged. */
  const unsent = health.pending + health.sending;

  if (health.blocked > 0) return { kind: 'discardable', blocked: health.blocked, unsent };
  if (unsent > 0) return { kind: 'waiting', unsent };
  return { kind: 'empty' };
}

/**
 * The sentence beneath the outbox heading.
 *
 * Every branch names the queue's contents as writes the *server has not
 * acknowledged*, because that is the only framing under which the refusal makes
 * sense and the only one that does not imply the record is at stake.
 */
export function outboxSummary(disposition: OutboxDisposition): string {
  switch (disposition.kind) {
    case 'empty':
      return 'Nothing is queued. Every capture made on this device has been acknowledged by the server.';
    case 'waiting':
      return `${quantity(disposition.unsent, 'write is', 'writes are')} queued and still being sent. None of them can be cleared from here — they have not been acknowledged yet, and the remedy for a queue that is still trying is to let it finish, not to delete it.`;
    case 'discardable':
      return `${quantity(disposition.blocked, 'write has', 'writes have')} stopped retrying and ${disposition.blocked === 1 ? 'is' : 'are'} waiting for a decision. ${
        disposition.unsent === 0 ?
          'Discarding them loses them permanently — they never reached the server, so there is nothing on the server to recover them from.'
        : `The other ${quantity(disposition.unsent, 'write is', 'writes are')} still being sent and will not be touched. Discarding the unsendable ones loses them permanently — they never reached the server, so there is nothing on the server to recover them from.`
      }`;
  }
}

/** The discard button's label, or `null` when no discard may be offered. */
export function discardLabel(disposition: OutboxDisposition): string | null {
  return disposition.kind === 'discardable' ?
      `Discard ${quantity(disposition.blocked, 'unsendable write', 'unsendable writes')}`
    : null;
}

/**
 * The confirmation text for the discard.
 *
 * The only `AlertDialog` on the surface, and §8.12 explains why it is here and
 * not on the other two: "Destructive actions never rely solely on a confirm
 * dialog … undo actually protects data." A draft can be undone from memory and a
 * cached read costs a refetch, so both get an undo or nothing. An unsent write
 * has no copy anywhere — that is what unsent means — so there is no undo to
 * offer and the dialog is the only protection available.
 */
export function discardConfirmation(disposition: OutboxDisposition): string {
  const blocked = disposition.kind === 'discardable' ? disposition.blocked : 0;
  return `${quantity(blocked, 'write', 'writes')} the server never acknowledged. They cannot be recovered and this cannot be undone. Nothing already saved to the record changes — these captures never reached it. Anything queued behind a discarded write will be attempted again and, failing, will appear here as unsendable itself.`;
}

/* -------------------------------------------------------------------------
 * Drafts — the §4.7 store
 * ---------------------------------------------------------------------- */

/**
 * The drafts button's label, or `null` when the store is empty.
 *
 * `live` leads, because that is the unsaved prose the operator might still want.
 * When only expired records remain the label says so rather than claiming to
 * clear drafts that could not have been offered anyway — `loadDraft` has already
 * stopped returning those, so "clear 2 drafts" would name something the operator
 * cannot see and does not believe exists.
 */
export function draftsLabel(inventory: DraftInventory): string | null {
  if (inventory.live > 0) return `Clear ${quantity(inventory.live, 'draft', 'drafts')}`;
  if (inventory.stale > 0) return `Clear ${quantity(inventory.stale, 'expired draft', 'expired drafts')}`;
  return null;
}

/**
 * The sentence beneath the drafts heading.
 *
 * Dates the newest draft, because that is the fact that stops a mis-tap. A draft
 * written four minutes ago is almost certainly the reflection the operator is in
 * the middle of; one from nine days ago is almost certainly not, and the two
 * deserve different amounts of hesitation from the person reading the screen.
 */
export function draftsSummary(inventory: DraftInventory, nowMillis: number): string {
  if (inventory.live === 0 && inventory.stale === 0) {
    return 'Nothing unsaved is stored on this device. A draft appears here while a journal entry or a Daily Close is part-written, and is removed the moment that entry is saved.';
  }

  const stale =
    inventory.stale === 0 ? ''
    : ` A further ${quantity(inventory.stale, 'record', 'records')} ${inventory.stale === 1 ? 'is' : 'are'} past the fourteen-day expiry or unreadable: never offered for recovery, and still on the disk until this is cleared.`;

  if (inventory.live === 0) {
    return `No draft can still be recovered.${stale}`;
  }

  const newest =
    inventory.newestSavedAt === null ?
      ''
    : ` The most recent was written ${draftAgeLabel(inventory.newestSavedAt, nowMillis)}.`;

  return `${quantity(inventory.live, 'part-written entry is', 'part-written entries are')} held on this device, in plain text.${newest} Clearing them destroys writing that has not been saved anywhere else. No saved entry is affected.${stale}`;
}

/** What the toast says after the drafts have gone. The undo is the protection (§8.12). */
export function draftsCleared(removed: number): string {
  return `${quantity(removed, 'draft', 'drafts')} removed from this device. Nothing saved to the record changed.`;
}

/**
 * What the toast says after an undo.
 *
 * The partial case is reported rather than rounded off. `restoreDrafts` refuses
 * to overwrite a draft written during the undo window, so a restore of two out
 * of three is a correct outcome the operator has to be told about — silently
 * reporting three would leave them believing they had recovered something they
 * had not.
 */
export function draftsRestored(restored: number, requested: number): string {
  if (restored === requested) {
    return `${quantity(restored, 'draft', 'drafts')} put back, exactly as ${restored === 1 ? 'it was' : 'they were'}.`;
  }
  if (restored === 0) {
    return 'Nothing was put back — newer drafts have been written on this device since.';
  }
  return `${String(restored)} of ${String(requested)} put back. The rest were left alone because newer drafts have been written since.`;
}

/** What the toast says after unsendable writes were discarded. */
export function discardReport(discarded: number): string {
  return `${quantity(discarded, 'unsent write', 'unsent writes')} discarded. ${discarded === 1 ? 'It' : 'They'} never reached the server, so the record is unchanged.`;
}

/* -------------------------------------------------------------------------
 * Cached reads — the store with no cost
 * ---------------------------------------------------------------------- */

/** The cache button's label, or `null` when there is nothing cached. */
export function cacheLabel(cachedQueries: number): string | null {
  return cachedQueries === 0 ?
      null
    : `Clear ${quantity(cachedQueries, 'cached response', 'cached responses')}`;
}

/**
 * The sentence beneath the cache heading.
 *
 * This is the one control with no confirmation of any kind, and the copy has to
 * earn that by being clear that nothing is lost. §8.12's warning is that
 * "confirmation dialogs train people to click through them" — putting one in
 * front of a free, reversible action is how the operator learns to dismiss the
 * one in front of the expensive one.
 */
export function cacheSummary(cachedQueries: number): string {
  if (cachedQueries === 0) {
    return 'Nothing is cached yet. Answers from the server are kept here so the record still reads with no signal, and each one states its own age.';
  }
  return `${quantity(cachedQueries, 'answer', 'answers')} from the server ${cachedQueries === 1 ? 'is' : 'are'} kept on this device so the record still reads with no signal. Clearing them costs one refetch per screen and loses nothing — but it does remove the copy of the record that was sitting in this browser's storage.`;
}
