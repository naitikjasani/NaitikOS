'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { systemClock } from '@naitikos/core';
import {
  AlertDialog,
  Badge,
  Button,
  Card,
  CardBody,
  Divider,
  Inline,
  Stack,
  Text,
  useToast,
} from '@naitikos/design-system';

import { drainOutbox } from '@/lib/offline/drain';
import {
  type DraftBackup,
  type DraftInventory,
  clearAllDrafts,
  draftInventory,
  draftStorage,
  restoreDrafts,
} from '@/lib/offline/drafts';
import { type OutboxHealth, allEntries, discardBlockedEntries, outboxHealth } from '@/lib/offline/outbox';

import {
  cacheLabel,
  cacheSummary,
  discardConfirmation,
  discardLabel,
  discardReport,
  draftsCleared,
  draftsLabel,
  draftsRestored,
  draftsSummary,
  outboxDisposition,
  outboxSummary,
} from '../services/localData';

/**
 * "On this device" — the surface that removes local copies, and only local ones.
 *
 * ## Why this exists at all, and why now
 *
 * `outbox.ts` has carried a comment promising a "clear local data path in
 * settings" since it was written, and nothing called it. That was tolerable
 * while the only local store was a queue of writes the operator wanted kept.
 * §8.10's draft autosave changed the position: journal prose and Daily Close
 * answers are now persisted to `localStorage` in plain text, and §4.7 is
 * unambiguous that "journal content is the most sensitive data in the system".
 * Until this screen existed, the only two ways that prose left the device were
 * the fourteen-day expiry and saving the entry it belonged to — neither of which
 * is something a person can reach for when they are about to hand the laptop to
 * somebody.
 *
 * ## Three controls, not one
 *
 * A single "clear local data" button is the obvious shape and it is the bug.
 * The three stores have nothing in common except where they live:
 *
 * | Store | Cost of clearing | Recovery |
 * |---|---|---|
 * | Cached reads | One refetch per screen | Automatic |
 * | Drafts | Unsaved writing, gone | Undo, for a few seconds |
 * | Capture outbox | **Writes the operator believes are saved** | None, ever |
 *
 * One button would have to price itself at the worst of those, which means the
 * cheap, frequently-wanted action inherits a warning about permanent data loss
 * and stops being read. Worse, it would couple the two real needs: "I am handing
 * this laptop to someone" wants the prose and the cached rows gone and does not
 * want to think about the queue, while "the sync looks stuck" wants the queue
 * looked at and must not touch the drafts. A combined button serves neither
 * without lying to one of them.
 *
 * They are ordered by ascending cost, so the page reads as an escalation. The
 * dangerous one is last because the first thing on the screen is the thing that
 * gets pressed while distracted.
 *
 * ## The confirmation model, per §8.12
 *
 *   "Destructive actions never rely solely on a confirm dialog. Deletion is soft
 *    (§9.4) and produces an undo toast. Confirmation dialogs train people to
 *    click through them; undo actually protects data."
 *
 * Applied literally rather than by defaulting to a modal three times:
 *
 * - **Cached reads: no confirmation.** Nothing is lost. A dialog in front of a
 *   free action is precisely the training §8.12 warns about, and the operator
 *   who learns to dismiss this one dismisses the outbox dialog too.
 * - **Drafts: no dialog, a real undo.** The removed records are held in memory
 *   and written back byte-identically, so `savedAt` — and therefore the expiry
 *   and the age shown in the recovery offer — survives the round trip. The count
 *   in the button is the pre-commitment; the undo is the protection.
 * - **Unsent writes: an `AlertDialog`, and no undo.** This is the one case where
 *   §8.12's preferred mechanism is unavailable rather than merely inconvenient.
 *   Undo works because a soft delete leaves the row in the database (§9.4); an
 *   unsent write has no copy anywhere by definition, so there is nothing to
 *   restore from. The dialog is what is left, and it names the count and says
 *   plainly that it cannot be undone.
 *
 * ## No permission gate, unlike the nightly-run trigger
 *
 * `NightlyRunTrigger` is offered only to a session holding `settings:write`,
 * because it posts to an endpoint the server re-checks. Nothing here crosses the
 * network: every byte these buttons remove is in this browser's own storage,
 * which anybody sitting at this machine can already read from a devtools console
 * and clear from the browser's site-data dialog. A permission check over that
 * would guard nothing while implying the data is held somewhere it is not — and
 * §5.4's rule is that a check decides whether a control is *offered*, never
 * whether it is allowed. There is no server to ask.
 *
 * ## What this must never be mistaken for
 *
 * Nothing here touches the server. Deleting a record is §9.4's soft delete with
 * its audit-log entry, reached from the entity that owns it — a button on a
 * settings page that could reach the database would be a different and far more
 * dangerous feature. Every sentence the operator reads on this screen says which
 * side of that line it is on, and `localData.test.ts` asserts the two that carry
 * the promise.
 */
export function LocalDataScreen(): ReactNode {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState<Store | null>(null);
  const [confirming, setConfirming] = useState(false);

  /*
   * The undo payload, in a ref rather than in state.
   *
   * It is never rendered — only the toast's action reads it — so putting it in
   * state would re-render the screen twice per clearance for no visible change.
   * A ref also survives the `refresh` that follows the clearance without
   * sequencing games.
   */
  const undoable = useRef<readonly DraftBackup[]>([]);

  /**
   * Read all three stores.
   *
   * The synchronous halves — `localStorage` and the query cache's own count —
   * are read first and the state is set inside the outbox's promise, so there is
   * exactly one render per refresh and no synchronous `setState` in an effect
   * (`react-hooks/set-state-in-effect`, and the cascading render it exists to
   * catch).
   *
   * Reading during render was the alternative and it is not available: a `'use
   * client'` component still renders on the server, where `localStorage` does
   * not exist, so a count read in a state initialiser would disagree with the
   * client's first paint and produce a hydration mismatch.
   */
  const refresh = useCallback(() => {
    const store = draftStorage();
    const drafts = draftInventory(store, systemClock.nowMillis());
    const cachedQueries = queryClient.getQueryCache().getAll().length;

    void Promise.all([outboxHealth(), allEntries()])
      .then(([health, entries]) => {
        setSnapshot({
          drafts,
          storageAvailable: store !== null,
          cachedQueries,
          outbox: health,
          outboxReadable: true,
          unsendable: entries.filter((entry) => entry.status === 'blocked').map((entry) => entry.label),
        });
      })
      .catch(() => {
        /*
         * IndexedDB is unreachable — private mode on some browsers, or storage
         * denied. Reported as unreadable rather than as empty: §8.9's rule is
         * that missing data is shown as missing, and "nothing is queued" is the
         * one sentence this screen must not say on no evidence.
         */
        setSnapshot({
          drafts,
          storageAvailable: store !== null,
          cachedQueries,
          outbox: NO_QUEUE,
          outboxReadable: false,
          unsendable: [],
        });
      });
  }, [queryClient]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  /* --- Cached reads ------------------------------------------------------ */

  const clearCache = useCallback(() => {
    setBusy('cache');

    queryClient.clear();
    /*
     * `clear()` empties the in-memory cache, and `QueryProvider`'s subscription
     * then writes the now-empty dehydrated state back to `localStorage` a second
     * later. Waiting for that is not good enough: a tab closed inside the
     * debounce window would leave the *old* payload — every cached row —
     * untouched on the disk, which for a "clear this device" control is the
     * whole failure. So the persisted copy is removed immediately as well, and
     * the debounced write that follows lands an empty state on top.
     */
    forgetPersistedCache();

    void forgetShellCache().then((shellRemoved) => {
      setBusy(null);
      refresh();
      toast({
        title: 'Cached copies cleared',
        description:
          shellRemoved ?
            'Each screen refetches from the server as it is opened, and the offline shell is fetched again on the next load.'
          : 'Each screen refetches from the server as it is opened. The offline shell was left in place — see the note below.',
        tone: 'neutral',
      });
    });
  }, [queryClient, refresh, toast]);

  /* --- Drafts ----------------------------------------------------------- */

  /*
   * No loading state, because there is nothing to wait for.
   *
   * `localStorage` is synchronous — which is the whole reason `drafts.ts` chose
   * it over IndexedDB — so the records are gone before this function returns and
   * a spinner would flash for zero milliseconds. The other two controls await
   * something real and say so.
   */
  const clearDrafts = useCallback(() => {
    const removed = clearAllDrafts(draftStorage());
    undoable.current = removed;
    refresh();

    /*
     * The button is disabled when the count is zero, so this is the race: the
     * last draft was saved in another tab between the read and the tap. Saying
     * "0 drafts removed" would be technically true and read as a malfunction.
     */
    if (removed.length === 0) {
      toast({ title: 'There was nothing left to remove', tone: 'neutral' });
      return;
    }

    toast({
      title: draftsCleared(removed.length),
      description: 'Undo puts them back for the next few seconds only.',
      tone: 'neutral',
      action: {
        label: 'Undo',
        onAction: () => {
          const requested = undoable.current.length;
          const restored = restoreDrafts(draftStorage(), undoable.current);
          undoable.current = [];
          refresh();
          toast({ title: draftsRestored(restored, requested), tone: 'neutral' });
        },
      },
    });
  }, [refresh, toast]);

  /* --- Unsent writes ---------------------------------------------------- */

  const discard = useCallback(() => {
    setBusy('outbox');
    void discardBlockedEntries()
      .then((discarded) => {
        setBusy(null);
        refresh();
        toast({ title: discardReport(discarded.length), tone: 'caution' });
      })
      .catch(() => {
        setBusy(null);
        refresh();
        toast({
          title: 'Nothing was discarded',
          description: 'The queue could not be opened, so it is unchanged. Reload and try again.',
          tone: 'critical',
        });
      });
  }, [refresh, toast]);

  const retryNow = useCallback(() => {
    setBusy('outbox');
    void drainOutbox()
      .then(() => {
        setBusy(null);
        refresh();
      })
      .catch(() => {
        setBusy(null);
        refresh();
      });
  }, [refresh]);

  /* --- Render ----------------------------------------------------------- */

  const disposition = snapshot === null ? null : outboxDisposition(snapshot.outbox);
  const discardable = disposition === null ? null : discardLabel(disposition);
  const cacheButton = snapshot === null ? null : cacheLabel(snapshot.cachedQueries);
  const draftsButton = snapshot === null ? null : draftsLabel(snapshot.drafts);

  return (
    <Stack gap="4">
      <Text role="body-sm" tone="secondary">
        Three separate stores sit in this browser, and clearing one is not clearing another. None of them is
        the record: everything below is a copy or a queue held on this machine, and removing any of it leaves
        what is on the server exactly as it is.
      </Text>

      {/* --- 1. Cached reads: free to drop ------------------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h3">
              Cached answers from the server
            </Text>
            <Text role="body-sm" tone="secondary">
              {snapshot === null ? READING : cacheSummary(snapshot.cachedQueries)}
            </Text>

            <Inline gap="3" align="center">
              <Button
                variant="secondary"
                disabled={snapshot === null || snapshot.cachedQueries === 0 || busy !== null}
                isLoading={busy === 'cache'}
                onClick={clearCache}
              >
                {/* The count is in the label, not in a paragraph above it — it is
                    what the operator is agreeing to, so it belongs on the thing
                    they press. */}
                {buttonLabel(snapshot !== null, cacheButton, 'Clear the cached answers', 'Nothing cached')}
              </Button>
              <Text role="caption" tone="tertiary">
                No confirmation, because nothing is lost.
              </Text>
            </Inline>

            <Text role="caption" tone="tertiary">
              {/*
                The shell cache is deliberately not dropped while the device is
                offline. It holds fingerprinted assets and the `/offline` page and
                nothing about the operator, so removing it is worth no privacy at
                all — while removing it in the gym basement §5.7 is written for
                would delete the fallback page and leave a reload showing the
                browser's own error instead of the application.
              */}
              The offline shell — the fallback page and the static assets — is dropped too, but only while
              this device has a connection to fetch it again. It holds no part of the record.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* --- 2. Drafts: destroys unsaved writing ------------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h3">
                Unsaved drafts
              </Text>
              {/*
                Neutral, not `caution`. §4.7's first design principle is "no
                negative framing, ever" for anything touching Mind, and this
                count is mostly a count of half-written journal entries. It is a
                fact about a store, not a problem with the operator — the
                consequence of clearing it is stated in prose below, where it can
                be read rather than inferred from a colour. The queue's badge is
                a caution because a blocked write genuinely awaits a decision.
              */}
              {snapshot !== null && snapshot.drafts.live > 0 && (
                <Badge tone="neutral">{String(snapshot.drafts.live)} unsaved</Badge>
              )}
            </Inline>

            <Text role="body-sm" tone="secondary">
              {snapshot === null ?
                READING
              : !snapshot.storageAvailable ?
                'This browser is not allowing local storage, so no draft has been kept and autosave is not in force. There is nothing here to clear.'
              : draftsSummary(snapshot.drafts, systemClock.nowMillis())}
            </Text>

            <Text role="caption" tone="tertiary">
              Journal prose and Daily Close answers are held here in plain text while they are being written.
              §4.7 makes that the most sensitive material in the system, which is why this control exists — and
              why clearing it destroys work that is not saved anywhere else.
            </Text>

            <Inline gap="3" align="center">
              <Button
                variant="destructive"
                disabled={snapshot === null || draftsButton === null || busy !== null}
                onClick={clearDrafts}
              >
                {buttonLabel(snapshot !== null, draftsButton, 'Clear the drafts', 'No drafts stored')}
              </Button>
              <Text role="caption" tone="tertiary">
                Undoable for a few seconds afterwards, and not after that.
              </Text>
            </Inline>

            <Text role="caption" tone="tertiary">
              An editor open in another tab writes its draft again on the next keystroke. Close the entry, or
              save it, before clearing.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* --- 3. The capture outbox: the dangerous one -------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h3">
                Writes waiting to be sent
              </Text>
              {snapshot !== null && snapshot.outboxReadable && (
                <Badge tone={snapshot.outbox.blocked > 0 ? 'caution' : 'neutral'}>
                  {describeQueue(snapshot.outbox)}
                </Badge>
              )}
            </Inline>

            <Text role="body-sm" tone="secondary">
              {snapshot === null ?
                READING
              : !snapshot.outboxReadable ?
                'The queue could not be opened, so nothing can be said about what is in it. That is not the same as it being empty — reload before drawing a conclusion.'
              : outboxSummary(outboxDisposition(snapshot.outbox))}
            </Text>

            <Text role="caption" tone="tertiary">
              This is the queue that makes a capture in a basement with no signal survive. §5.7 requires that a
              failed send never silently discards a write, so this control will not offer to delete a write
              that is still trying — however much else is being cleared.
            </Text>

            {snapshot !== null && snapshot.unsendable.length > 0 && (
              <>
                <Divider />
                <Stack gap="1">
                  <Text role="caption" tone="tertiary">
                    Unsendable:
                  </Text>
                  {/* Named, not just counted. "Daily Close, 3 August" is what lets
                      the operator decide whether abandoning it is acceptable; a
                      bare number is a decision they cannot make. The label is a
                      kind and a date — never the captured content (§5.13). */}
                  {snapshot.unsendable.map((label, index) => (
                    <Text key={`${label}-${String(index)}`} role="body-sm">
                      {label}
                    </Text>
                  ))}
                </Stack>
              </>
            )}

            <Inline gap="3" align="center">
              {/* Disabled on an empty queue rather than left as a button that
                  does nothing. The summary directly above has just said nothing
                  is waiting, and an enabled control contradicting it invites the
                  operator to distrust the sentence rather than the button. */}
              <Button
                variant="secondary"
                disabled={
                  snapshot === null || !snapshot.outboxReadable || disposition?.kind === 'empty' || busy !== null
                }
                isLoading={busy === 'outbox'}
                onClick={retryNow}
              >
                Try sending now
              </Button>

              {discardable !== null && (
                <Button
                  variant="destructive"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  {discardable}
                </Button>
              )}
            </Inline>

            {disposition !== null && disposition.kind === 'waiting' && (
              <Text role="caption" tone="tertiary">
                There is nothing to discard here yet. An entry becomes discardable only after it has stopped
                retrying on its own, which takes about an hour of failures.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      {snapshot !== null && disposition !== null && (
        <AlertDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Discard the writes that cannot be sent?"
          description={discardConfirmation(disposition)}
          confirmLabel="Discard them"
          cancelLabel="Keep them"
          onConfirm={discard}
        />
      )}

      <Text role="caption" tone="tertiary">
        {/*
          The handover recipe, stated rather than built as a fourth button. A
          combined control would have to inherit the outbox's refusal, which
          would make the common case — nothing unsent, two stores to empty —
          impossible to complete on the one occasion the operator most needs it.
        */}
        Handing this machine to someone else: clear the cached answers and the drafts, and check that nothing
        is waiting to be sent. Two things stay behind either way — this device&rsquo;s id and the last clock
        reading the server issued it, both of which the browser&rsquo;s own site-data dialog removes and
        neither of which contains anything about you. Clearing site data that way also gives this device a new
        id, which is harmless: what it has already written is untouched.
      </Text>
    </Stack>
  );
}

/* -------------------------------------------------------------------------
 * Internals
 * ---------------------------------------------------------------------- */

/**
 * What a button says, given whether the stores have been read yet.
 *
 * Before the first read the label names the *act* rather than a count, because
 * a count of nothing is a claim — "No drafts stored" on a screen that has not
 * looked would be the one sentence on this page most likely to be believed
 * wrongly. Afterwards it is the count, or the honest empty label.
 */
function buttonLabel(read: boolean, label: string | null, act: string, empty: string): string {
  if (!read) return act;
  return label ?? empty;
}

/**
 * Which asynchronous control is mid-flight. A union, so two cannot be at once.
 *
 * Drafts are absent because clearing them is synchronous — see {@link
 * LocalDataScreen}'s note — and a member that could never be set would invite a
 * loading state that never appears.
 */
type Store = 'cache' | 'outbox';

type Snapshot = {
  readonly drafts: DraftInventory;
  /** `false` in private mode or wherever storage is denied — autosave is then off. */
  readonly storageAvailable: boolean;
  readonly cachedQueries: number;
  readonly outbox: OutboxHealth;
  /** `false` when IndexedDB refused. Distinct from an empty queue (§8.9). */
  readonly outboxReadable: boolean;
  /** The labels of entries that have stopped retrying. A kind and a date, never content. */
  readonly unsendable: readonly string[];
};

const NO_QUEUE: OutboxHealth = { pending: 0, sending: 0, blocked: 0, oldestPendingAgeMs: null };

/**
 * What every section says before the first read completes.
 *
 * Not a skeleton and not a zero. A count of nothing is a claim, and for two of
 * these three stores it is the claim most likely to be acted on wrongly.
 */
const READING = 'Reading what this device is holding…';

/** The badge on the queue. Blocked entries lead, because they are the ones needing a decision. */
function describeQueue(health: OutboxHealth): string {
  const unsent = health.pending + health.sending;
  if (health.blocked > 0) {
    return `${String(health.blocked)} unsendable${unsent > 0 ? `, ${String(unsent)} sending` : ''}`;
  }
  return unsent > 0 ? `${String(unsent)} waiting` : 'Nothing queued';
}

/**
 * Remove the persisted read cache from `localStorage`.
 *
 * Matched by prefix rather than by importing the key, because `CACHE_KEY` is
 * private to `lib/query/QueryProvider.tsx` and that file is not this change's to
 * edit. The prefix is stable — it is the namespace every key in this
 * application shares — but this is a coupling, and exporting the constant is the
 * right fix the next time that file is touched.
 *
 * Keys are collected before any are removed: `Storage` is index-addressed and
 * re-indexes on deletion, so removing while walking skips entries.
 */
function forgetPersistedCache(): void {
  if (typeof window === 'undefined') return;

  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.startsWith('naitikos.query.')) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // Storage denied. The in-memory cache has already been emptied, which is
    // the part that was holding the rows this session read.
  }
}

/**
 * Delete the service worker's caches, but only with a connection.
 *
 * `navigator.onLine` is not trusted as a gate on *sending* anywhere in
 * `lib/offline/` — it reports a network interface, not a reachable server, and
 * `drain.ts` says so at length. It is trusted here because the asymmetry runs
 * the other way: a false "online" costs one re-download, while a false
 * "offline" leaves a shell cache in place that holds nothing about the operator.
 * Deleting it in the gym basement §5.7 was written for would remove the
 * `/offline` fallback and turn the next reload into the browser's error page.
 *
 * @returns whether anything was removed, so the toast can say which happened.
 */
async function forgetShellCache(): Promise<boolean> {
  if (typeof window === 'undefined' || !('caches' in window)) return false;
  if (!navigator.onLine) return false;

  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    return keys.length > 0;
  } catch {
    return false;
  }
}
