'use client';

/**
 * The autosave loop — §8.10's "continuously", made specific.
 *
 * `drafts.ts` decides what a draft *is* and where it lives. This decides *when*
 * it is written, and that is the half where the guarantee is actually won or
 * lost: a store nobody flushes at the right moment is a store that loses the
 * last paragraph.
 *
 * It lives in `lib/` rather than in a feature because two features need it — the
 * journal composer and the Daily Close — and §7.4 makes a feature importable
 * only through its own `index.ts`, so a hook shared between two of them cannot
 * live inside either. `features/capture/hooks/useOutboxHealth.ts` is the same
 * shape in the other direction: a hook over a `lib/offline` module.
 *
 * ## The cadence, and the failure each part of it survives
 *
 * Three mechanisms, because no one of them covers the four ways work is lost.
 *
 * **A trailing debounce of {@link DRAFT_DEBOUNCE_MS}.** Eight hundred
 * milliseconds. Above the inter-keystroke interval of fast typing (~150 ms at
 * eighty words a minute), so an ordinary sentence produces one write rather than
 * forty; below the second at which a person experiences a pause as a pause, so
 * anyone who stops to think has already been saved. This is what "continuously"
 * means in practice — not per keystroke, which would be a synchronous
 * `localStorage` write on the typing path for no additional safety.
 *
 * **A hard ceiling of {@link DRAFT_MAX_STALENESS_MS}.** Five seconds. The
 * debounce alone has a hole in it: someone typing without a single 800 ms gap
 * for a minute would never trigger a trailing flush, and would lose the minute.
 * The interval closes it, and it is what bounds the worst case of the *one*
 * failure that fires no event at all — a renderer killed outright by the OS.
 * Five seconds is about a dozen words. One second would cut that to two words
 * and multiply writes fivefold against a rare failure; thirty would lose a
 * paragraph.
 *
 * **`visibilitychange` and `pagehide`, flushed synchronously.** These are the
 * events that actually precede loss on the device this application is used on.
 * `visibilitychange` → `hidden` fires when the tab is switched, when the PWA is
 * backgrounded, and before the page is frozen or discarded — which is exactly
 * how iOS reclaims memory from a hidden tab. `pagehide` fires on navigation away
 * and on entry to the back/forward cache, including in iOS Safari where `unload`
 * does not. Because {@link drafts.saveDraft} is a synchronous `localStorage`
 * write, it has *completed* by the time either handler returns; that is the
 * entire reason for the storage choice, and it is why an interval alone would
 * not do.
 *
 * ## `beforeunload` is deliberately not used
 *
 * It is the event people reach for and it is the wrong one twice over. It is not
 * fired when iOS terminates a backgrounded tab — the case this feature exists
 * for — so it would give a false sense of coverage. And merely registering a
 * listener disqualifies the page from the back/forward cache, which would make
 * ordinary back-navigation slower on every route where an editor is mounted, to
 * buy nothing. Nor is it used for a "leave this page?" confirmation: §8.10's
 * answer to losing work is autosave, and §8.12's objection to confirm dialogs —
 * that they "train people to click through them" — applies with full force to a
 * dialog that appears every time somebody navigates away from the journal.
 *
 * ## The unmount flush is not optional
 *
 * In an App Router application the *common* way to leave an editor is a client
 * navigation, which fires neither `pagehide` nor `visibilitychange`. It is an
 * unmount and nothing else. So the teardown flushes, and that single line covers
 * the case §8.10 names by name: "losing a written reflection to a navigation".
 *
 * ## Autosave is suspended while a recovery offer is outstanding
 *
 * The subtle bug this avoids: the Daily Close's draft is keyed by day key, so a
 * draft found on open sits at the *same* key the editor is about to write to. An
 * unconditional first flush of an untouched Close would write an empty answer
 * map over it — and because {@link drafts.saveDraft} treats empty as a deletion,
 * it would not merely stale the draft, it would delete it before the operator
 * ever saw the offer.
 *
 * So while a draft at the live key is still on offer, nothing is written. The
 * offer is resolved by {@link UseDraft.accept}, by {@link UseDraft.discard}, or
 * by the operator typing — and the last of those resolves it in favour of what
 * is on screen, because what is on screen is the thing they are doing now and
 * that is what §8.10 protects. The offer says so, in words, before they touch
 * anything.
 *
 * ## No telemetry
 *
 * A count of recoveries would be genuinely interesting — it measures how often
 * this guarantee actually fires. Declined, because `TelemetryName` is a closed
 * union in `@naitikos/api` and adding a member is a change to a package outside
 * this one; and because §12's V1 phase names four things to instrument and this
 * is not one of them. Worth revisiting when the union is next touched.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { systemClock } from '@naitikos/core';

import {
  type Draft,
  type DraftFields,
  type DraftScope,
  clearDraft,
  draftAgeLabel,
  draftKey,
  draftStorage,
  fieldSignature,
  isBlankFields,
  listDrafts,
  pruneDrafts,
  saveDraft,
} from './drafts';

/** Trailing debounce after the last change. See the file header. */
export const DRAFT_DEBOUNCE_MS = 800;

/** The longest a change may go unwritten while an editor is open. */
export const DRAFT_MAX_STALENESS_MS = 5_000;

/** Why autosave is not currently working, for the editor to say out loud. */
export type DraftProblem = 'unavailable' | 'too-large';

export type DraftOffer = {
  readonly draft: Draft;
  /**
   * "four minutes ago" — computed when the editor opened, not during render.
   *
   * Reading the clock in a render would make the render impure and would put a
   * value in the markup that the server cannot produce. Fixing the label at open
   * time is also the more useful reading: it is the age at the moment the
   * operator is being asked to decide.
   */
  readonly ageLabel: string;
};

export type UseDraftOptions = {
  readonly scope: DraftScope;
  /** The editor's current state. Rebuilt per render is fine; it is compared by value. */
  readonly fields: DraftFields;
};

export type UseDraft = {
  /**
   * The drafts that existed under this surface when the editor opened.
   *
   * One rule, correct for both callers. The journal composer's key is a fresh
   * entry id, so its own key is never in here and the offers are strictly
   * earlier, abandoned compositions. The Close's key is the day, so the offer —
   * if there is one — sits at the live key, and {@link accept} restores it in
   * place.
   *
   * Re-read when the scope changes — `/today/close?day=…` moves to another day
   * without necessarily remounting, and the new day's draft has to be offered.
   * Anything the operator has already answered is remembered in `resolved` and
   * stays hidden, because accepting deliberately leaves the record on disk for
   * the editor to keep updating and a naive re-read would offer it straight back.
   */
  readonly offered: readonly DraftOffer[];
  /** Take this draft over: stop offering it, and resume autosave at its key. */
  readonly accept: (draft: Draft) => void;
  /** Delete it. The operator's explicit "no". */
  readonly discard: (draft: Draft) => void;
  /**
   * Drop the draft for the current scope, because the entry is durably saved.
   *
   * Call this **only** after `queueAndDrain` has resolved — see
   * {@link drafts.clearDraft} for why that, and nothing earlier, counts.
   */
  readonly clear: () => void;
  /** When the draft was last written, or `null` if there is nothing stored. */
  readonly savedAt: number | null;
  readonly problem: DraftProblem | null;
};

type DraftState = {
  readonly offered: readonly DraftOffer[];
  readonly savedAt: number | null;
  readonly problem: DraftProblem | null;
};

const EMPTY: DraftState = { offered: [], savedAt: null, problem: null };

export function useDraft({ scope, fields }: UseDraftOptions): UseDraft {
  /*
   * Resolved once. `draftStorage()` touches `window.localStorage`, which throws
   * rather than returning undefined when storage is blocked, so calling it per
   * render would mean a try/catch per render for a value that cannot change.
   */
  const store = useMemo(() => draftStorage(), []);

  const { surface, target } = scope;
  /*
   * Rebuilt from the two primitives rather than passed through, so the hook's
   * callbacks change identity when the *scope* changes and not merely when the
   * caller re-creates the object. The journal composer re-mints its target after
   * a save, and that is a real change; a re-render is not.
   */
  const stable = useMemo<DraftScope>(() => ({ surface, target }), [surface, target]);
  const key = useMemo(() => draftKey(stable), [stable]);
  const signature = useMemo(() => fieldSignature(fields), [fields]);

  const [state, setState] = useState<DraftState>(EMPTY);

  /** The latest committed fields, for the handlers that run outside React. */
  const latest = useRef<DraftFields>(fields);
  /**
   * `key` and signature of the last write, so an unchanged editor is not
   * rewritten every five seconds — and, more importantly, so a timer that fires
   * after {@link UseDraft.clear} cannot resurrect the draft it just removed.
   */
  const written = useRef<string>('');
  const timer = useRef<number | undefined>(undefined);
  /** Mirrors `state.offered` for {@link flush}, which runs outside React. */
  const outstanding = useRef<Set<string>>(new Set());
  /**
   * Offers the operator has already answered, in any way.
   *
   * Survives the snapshot effect re-running, which it does when the scope
   * changes. Without it, moving between days in the Close would re-offer a draft
   * that was accepted a moment ago — accepting deliberately leaves the record on
   * disk, so it is still there to be found.
   */
  const resolved = useRef<Set<string>>(new Set());

  const stamp = useCallback(
    (of: DraftFields): string => `${key} ${fieldSignature(of)}`,
    [key],
  );

  const flush = useCallback(() => {
    if (store === null) return;
    const current = latest.current;

    if (outstanding.current.has(key)) {
      // Untouched. The offered draft is left exactly as it is — writing a blank
      // editor over it would delete it before the operator answered.
      if (isBlankFields(current)) return;
      // Typed over. See the file header: the live text wins, and the offer said
      // it would.
      outstanding.current.delete(key);
      resolved.current.add(key);
      setState((prev) => ({
        ...prev,
        offered: prev.offered.filter((offer) => draftKey(offer.draft.scope) !== key),
      }));
    }

    const next = stamp(current);
    if (next === written.current) return;

    const now = systemClock.nowMillis();
    const outcome = saveDraft(store, stable, current, now);
    written.current = next;

    setState((prev) => {
      const problem = outcome === 'saved' || outcome === 'cleared' ? null : outcome;
      const savedAt = outcome === 'saved' ? now : outcome === 'cleared' ? null : prev.savedAt;
      // Returning `prev` lets React bail out. A flush that changed nothing
      // observable must not cost a render every five seconds for a whole day.
      return prev.problem === problem && prev.savedAt === savedAt ? prev : { ...prev, problem, savedAt };
    });
  }, [store, key, stable, stamp]);

  /*
   * What is waiting, read once when the editor opens.
   *
   * The pruning runs first and in the same pass: it is the only thing that
   * deletes expired prose, an editor opening is the natural moment for it, and
   * it costs one walk of a store holding at most {@link MAX_DRAFTS} records.
   *
   * Anything already answered is filtered out rather than re-offered — see
   * {@link UseDraft.offered} and `resolved`.
   */
  useEffect(() => {
    const now = systemClock.nowMillis();

    let offered: readonly DraftOffer[] = [];
    if (store !== null) {
      pruneDrafts(store, now);
      offered = listDrafts(store, surface, now)
        .filter((draft) => !resolved.current.has(draftKey(draft.scope)))
        .map((draft) => ({ draft, ageLabel: draftAgeLabel(draft.savedAt, now) }));
    }
    outstanding.current = new Set(offered.map((offer) => draftKey(offer.draft.scope)));

    /*
     * The one state write in an effect, and it is here rather than derived
     * during render for a reason `QuickCapture.tsx` records for the launch URL:
     * local storage is an external system, it does not exist on the server, and
     * reading it in a render would be both impure and a hydration mismatch.
     *
     * No `set-state-in-effect` suppression is needed because it is an updater
     * function — it reads the previous state rather than replacing it, which is
     * exactly what the rule is asking for, and it is also correct here: a flush
     * that raced this effect must not have its `savedAt` discarded.
     */
    setState((prev) => ({ ...prev, offered, problem: store === null ? 'unavailable' : null }));
    // `target` is listed although the body does not read it: a change of scope
    // is precisely when this must run again. See {@link UseDraft.offered}.
  }, [store, surface, target]);

  /*
   * The trailing debounce.
   *
   * Re-running on every change clears the previous timer and sets a new one,
   * which *is* a trailing debounce, expressed with the lifecycle rather than
   * around it. The ref update belongs here too and not in a render: this effect
   * runs on every committed change, and React runs a component's cleanups before
   * its setups — so the unmount flush below still sees the value from the commit
   * it is tearing down rather than one that never rendered.
   */
  useEffect(() => {
    latest.current = fields;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, DRAFT_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fields` is depended on through `signature`, which is its value rather than its identity; listing the object itself would reset the debounce on every render.
  }, [signature, flush]);

  useEffect(() => {
    const onVisibility = (): void => {
      // Only on the way out. A tab becoming *visible* has nothing to save.
      if (document.visibilityState === 'hidden') flush();
    };
    const onPageHide = (): void => {
      flush();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    const ceiling = window.setInterval(flush, DRAFT_MAX_STALENESS_MS);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.clearInterval(ceiling);
      /*
       * The navigation case, and the reason §8.10 exists. A client-side route
       * change fires none of the events above; the editor simply unmounts. This
       * is the last moment anything can be written.
       */
      flush();
    };
  }, [flush]);

  const accept = useCallback(
    (draft: Draft) => {
      const accepted = draftKey(draft.scope);
      /*
       * Preserve whatever is on screen under its own key before the editor's
       * state is replaced — unless the draft being accepted *is* the live key,
       * where flushing first would overwrite the very thing being restored.
       */
      if (accepted !== key) flush();

      outstanding.current.delete(accepted);
      resolved.current.add(accepted);
      setState((prev) => ({
        ...prev,
        offered: prev.offered.filter((offer) => draftKey(offer.draft.scope) !== accepted),
      }));
    },
    [flush, key],
  );

  const discard = useCallback(
    (draft: Draft) => {
      const dropped = draftKey(draft.scope);
      clearDraft(store, draft.scope);
      outstanding.current.delete(dropped);
      resolved.current.add(dropped);
      setState((prev) => ({
        ...prev,
        offered: prev.offered.filter((offer) => draftKey(offer.draft.scope) !== dropped),
      }));
    },
    [store],
  );

  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    clearDraft(store, stable);
    /*
     * Mark the current contents as written.
     *
     * The editor's own state has not been reset yet — `clear` is called from a
     * mutation's success handler, in the same batch as the `setState` calls that
     * empty the form — so a debounce or interval firing in between would find
     * the saved text still in `latest` and write the draft straight back. That
     * phantom is the failure this boundary exists to prevent, and this line is
     * what closes the window.
     */
    written.current = stamp(latest.current);
    setState((prev) => (prev.savedAt === null ? prev : { ...prev, savedAt: null }));
  }, [store, stable, stamp]);

  return {
    offered: state.offered,
    accept,
    discard,
    clear,
    savedAt: state.savedAt,
    problem: state.problem,
  };
}
