'use client';

/**
 * The Daily Close's state.
 *
 * §7.3 puts "stateful logic, one concern each" in hooks. The one concern here is
 * *the answers* — what the operator has entered, seeded from what the day
 * already holds, and what of it is worth submitting.
 *
 * ## The rule that shapes everything
 *
 * §4.0: "Every field is optional. A partial close counts as a close." So the
 * answer map is sparse by construction — a field the operator has not touched
 * has *no entry*, which is different from an entry holding an empty value. The
 * distinction is what stops an untouched field being submitted as a blank
 * answer and recorded forever as one.
 *
 * ## Why the Close autosaves at all, when §8.10 is about long-form
 *
 * §8.10's sentence is "autosave for anything long-form", and the Close is the
 * opposite of long-form: §4.0 caps it at eleven interactive elements and sixty
 * seconds, and every field but the note is a single tap. Losing five taps is an
 * annoyance; losing a written reflection is unrecoverable, which is why the
 * journal is the case the blueprint names.
 *
 * It is included anyway, for a reason written down elsewhere in the codebase.
 * `app/(protected)/today/error.tsx` records the gap the per-pillar error
 * boundaries could not close:
 *
 *   "A render crash part-way through the Daily Close is a different animal:
 *    React unmounts the subtree, and whatever was typed into an unsubmitted step
 *    goes with it, at whatever depth the boundary sits. The fix for that is
 *    §8.10's autosave — drafts persisted as they are entered — not a boundary,
 *    and it belongs in the Close feature rather than here."
 *
 * So the mechanism is shared with the journal — `lib/offline/drafts.ts` and
 * `useDraft` — and the *whole* sparse edit map is persisted rather than only the
 * note. The expensive thing to lose halfway through the ritual is not any one
 * field, it is having answered the others; and eleven primitives cost nothing to
 * keep beside a journal entry that may run to twenty kilobytes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloseField } from '@naitikos/core';
import { systemClock } from '@naitikos/core';

import { writePrior } from '@/lib/capture/priors';
import { type Draft, type DraftScope } from '@/lib/offline/drafts';
import { type DraftOffer, type DraftProblem, useDraft } from '@/lib/offline/useDraft';
import { queryKeys } from '@/lib/query/QueryProvider';
import { record, recordCaptureLatency } from '@/lib/telemetry/client';
import {
  type CloseSnapshot,
  type SubmitAnswer,
  fetchClose,
  submitClose,
} from '../services/closeClient';

/** What the operator has entered, keyed by field id. Sparse, deliberately. */
export type DraftAnswers = Readonly<Record<string, number | string | boolean>>;

export type UseDailyClose = {
  readonly snapshot: CloseSnapshot | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
  /** Server answers merged with local edits. What the form renders. */
  readonly answers: DraftAnswers;
  readonly setAnswer: (fieldId: string, value: number | string | boolean) => void;
  readonly clearAnswer: (fieldId: string) => void;
  /** True once anything differs from what the day already holds. */
  readonly isDirty: boolean;
  readonly submit: () => void;
  readonly isSubmitting: boolean;
  readonly queuedAt: number | null;
  /**
   * Leave the completion state and go back to the questions.
   *
   * The submission is already durable, so this is not an undo — it is the
   * operator correcting an answer they got wrong thirty seconds ago. §9.4 keeps
   * the original either way, so re-submitting writes a correction rather than
   * overwriting a fact, and the only thing this clears is the screen state that
   * says "there is nothing left to do".
   */
  readonly resumeEditing: () => void;
  /**
   * Answers entered for this day that were never submitted (§8.10).
   *
   * Offered, never restored on the operator's behalf. A Close is a record of one
   * evening's state, and quietly re-populating it with values from an earlier
   * attempt would be the system answering questions on the operator's behalf —
   * which is worse in this module than anywhere else in the application.
   */
  readonly recoverable: readonly DraftOffer[];
  readonly restoreDraft: (draft: Draft) => void;
  readonly discardDraft: (draft: Draft) => void;
  /** Set when autosave is not working, so the screen can say so rather than imply it is. */
  readonly draftProblem: DraftProblem | null;
};

/** The stored value for a field, decoded into something a control can hold. */
function seedFor(field: CloseField, snapshot: CloseSnapshot | undefined): number | string | boolean | undefined {
  if (snapshot === undefined) return undefined;

  if (field.kind === 'note') return snapshot.note ?? undefined;
  if (field.kind === 'medication') return undefined;

  const stored = snapshot.answers[field.metricKey];
  if (stored === undefined || stored.decoded === null) return undefined;

  const decoded = stored.decoded;
  if (decoded.kind === 'integer') return decoded.value;
  if (decoded.kind === 'boolean') return decoded.value;
  if (decoded.kind === 'text' || decoded.kind === 'category') return decoded.value;
  /*
   * A `number` decodes to an exact `Decimal`, which a text input cannot hold.
   * The raw stored string is used instead — it is the same value, already at
   * the column's scale, and re-submitting it unchanged compares equal so no
   * spurious correction is written.
   */
  return stored.value;
}

/** Turn a raw control value into the submission shape the metric expects. */
function toAnswerValue(field: CloseField, raw: number | string | boolean): SubmitAnswer | null {
  if (field.kind === 'note') {
    return typeof raw === 'string' ? { kind: 'note', text: raw } : null;
  }

  if (field.kind === 'medication') {
    return typeof raw === 'boolean'
      ? { kind: 'medication', medicationId: field.medicationId, taken: raw }
      : null;
  }

  if (field.control === 'scale') {
    return typeof raw === 'number'
      ? { kind: 'metric', metricKey: field.metricKey, value: { kind: 'integer', value: raw } }
      : null;
  }

  if (field.control === 'toggle') {
    return typeof raw === 'boolean'
      ? { kind: 'metric', metricKey: field.metricKey, value: { kind: 'boolean', value: raw } }
      : null;
  }

  if (field.control === 'text') {
    return typeof raw === 'string'
      ? { kind: 'metric', metricKey: field.metricKey, value: { kind: 'text', value: raw } }
      : null;
  }

  /*
   * A number, sent as a *string*.
   *
   * §5.3 bans floats for measured values, and `String(7.5)` is the last point
   * at which the value is still exactly what the operator typed. Everything
   * downstream — the contract, `parseDecimal`, the column — is decimal-exact;
   * this line is where that chain starts.
   */
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
  return text === null || text.trim() === ''
    ? null
    : { kind: 'metric', metricKey: field.metricKey, value: { kind: 'number', value: text } };
}

export function useDailyClose(dayKey: string, zone: string): UseDailyClose {
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<string, number | string | boolean>>({});
  const [queuedAt, setQueuedAt] = useState<number | null>(null);
  const openedAt = useRef<number | null>(null);

  const query = useQuery({
    queryKey: queryKeys.close(dayKey, zone),
    queryFn: () => fetchClose(dayKey, zone),
  });

  /*
   * Reset when the day changes.
   *
   * `/today/close?day=…` is a search parameter on a Server Component, so moving
   * to another day re-renders this hook's owner rather than remounting it —
   * React reconciles the same element in the same position. Without this, edits
   * made against 6 September would still be in the map when the form re-renders
   * as 5 September, and §8.10's autosave would then write them into 5
   * September's draft. That would be the feature manufacturing the corruption it
   * exists to prevent.
   *
   * Adjusted during render rather than in an effect. React documents this as the
   * way to derive state from a changed prop: the re-render happens before
   * anything is painted, where an effect would let one frame of the wrong day's
   * answers reach the screen — and `set-state-in-effect` forbids it besides.
   */
  const [renderedDay, setRenderedDay] = useState(dayKey);
  if (renderedDay !== dayKey) {
    setRenderedDay(dayKey);
    setEdits({});
    setQueuedAt(null);
    /*
     * `openedAt` is deliberately left alone. Resetting it would be the more
     * accurate §12 measurement — a different day is a different ritual — but a
     * ref cannot be written during render (`react-hooks/refs`, and rightly: a
     * ref write is invisible to React's reconciliation). The cost is that a
     * back-fill reached by changing the search parameter is timed from the first
     * open of the session, which overstates one duration; the alternative was an
     * effect that fires on every render of the ordinary path.
     */
  }

  /*
   * §8.10's autosave, over the sparse edit map and nothing else.
   *
   * `edits` is exactly the right thing to persist and `answers` is exactly the
   * wrong thing: `answers` is the server's stored state with the edits merged on
   * top, so persisting it would write the *day's existing record* into a local
   * draft and then offer it back as though the operator had typed it. The draft
   * holds what is unsaved, which is what `edits` is.
   *
   * The scope is the day key, because the Close is idempotent per day — §5.7's
   * client-generated identity is the day here, and back-filling 3 August is a
   * different draft from closing today.
   */
  const draftScope = useMemo<DraftScope>(() => ({ surface: 'daily-close', target: dayKey }), [dayKey]);
  const draft = useDraft({ scope: draftScope, fields: edits });

  /*
   * §12's V1 phase instruments "Daily Close completion" and "drop-off points",
   * and a drop-off is only visible if the *opening* is recorded too. A Close
   * opened and left is the operator meeting the ritual and deciding against it,
   * which is precisely the friction the thirty days exist to find.
   *
   * Recorded once per mount, when the form is actually renderable — recording
   * it on mount would count a load that failed as an abandonment.
   */
  useEffect(() => {
    if (query.isLoading || openedAt.current !== null) return;
    openedAt.current = systemClock.nowMillis();
    record('daily_close.started', undefined, '/today/close');
  }, [query.isLoading]);

  const snapshot = query.data;

  /** Server state under local edits. Edits win; absence is not an edit. */
  const answers = useMemo<DraftAnswers>(() => {
    const merged: Record<string, number | string | boolean> = {};
    for (const field of snapshot?.fields ?? []) {
      const seed = seedFor(field, snapshot);
      if (seed !== undefined) merged[field.id] = seed;
    }
    return { ...merged, ...edits };
  }, [snapshot, edits]);

  const setAnswer = useCallback((fieldId: string, value: number | string | boolean) => {
    setEdits((current) => ({ ...current, [fieldId]: value }));
  }, []);

  const clearAnswer = useCallback((fieldId: string) => {
    setEdits((current) => {
      const next = { ...current };
      // Deleted rather than set to `undefined`: the sparse map is what tells
      // `submit` the field was never answered.
      delete next[fieldId];
      return next;
    });
  }, []);

  const mutation = useMutation({
    mutationFn: async () => {
      const fields = snapshot?.fields ?? [];
      const payload: SubmitAnswer[] = [];

      for (const field of fields) {
        const raw = answers[field.id];
        if (raw === undefined) continue;
        const answer = toAnswerValue(field, raw);
        if (answer !== null) payload.push(answer);
      }

      return submitClose(dayKey, zone, payload);
    },
    onSuccess: () => {
      const now = systemClock.nowMillis();
      setQueuedAt(now);

      /*
       * Remember the numeric answers as tomorrow's one-tap offer (§8.10).
       *
       * Only the `number` controls, and only here. A tap scale is excluded on
       * purpose: last night's mood is not a sensible prior for tonight's, and
       * offering it would be the system suggesting an answer to the one
       * question the record exists to hear honestly. A sleep duration is the
       * opposite — it moves by minutes, the stepper starts at zero, and
       * `CloseNumberField` explains what the fifteen presses cost.
       *
       * After the queue resolves, so an abandoned or failed submission never
       * changes what tomorrow opens with.
       */
      for (const field of snapshot?.fields ?? []) {
        if (field.kind !== 'metric' || field.control !== 'number') continue;
        const raw = answers[field.id];
        const numeric =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && raw.trim() !== ''
              ? Number(raw)
              : Number.NaN;
        if (Number.isFinite(numeric)) writePrior(field.metricKey, numeric);
      }

      /*
       * The draft is redundant now, and not one moment earlier.
       *
       * `submitClose` awaits `queueAndDrain`, which resolves only once the
       * mutation is committed to the IndexedDB outbox — after which §5.7
       * guarantees it "persists until acknowledged" and that a failed drain
       * "must never silently discard a write". That is what durable means here;
       * the network has not necessarily been touched at all.
       *
       * Clearing on the submit tap instead would open a window where the draft
       * is gone and the answers are nowhere. And if `queueAndDrain` throws,
       * this handler does not run: the mutation errors, the answers stay on
       * screen, and the draft stays on disk.
       */
      draft.clear();

      /*
       * The completion, and how long the ritual took.
       *
       * §4.0 budgets the Close at sixty seconds and §1.5's anti-goal warns that
       * the North Star "must never be pursued by making the Daily Close longer
       * or richer" — a duration that climbs while Compounding Days climbs is
       * exactly the gaming §1.5 describes, and `detectGaming` needs this number
       * to see it.
       */
      record('daily_close.submitted', undefined, '/today/close');
      if (openedAt.current !== null) {
        record('daily_close.duration', now - openedAt.current, '/today/close');
      }
      /*
       * The §1.4 health metric: cold start → fact persisted. Recorded here
       * because the Close is the capture path the budget is written about, and
       * `recordCaptureLatency` ignores every call after the first so a second
       * submission in the same session cannot drag the median warm.
       */
      recordCaptureLatency('/today/close');
      /*
       * Invalidated, not optimistically patched.
       *
       * The server decides what a submission *means* — which answers changed,
       * which were unchanged, whether the day was already closed. Patching the
       * cache here would mean re-implementing `planDailyClose` in the browser,
       * and the copy would drift. The refetch is one request against a warm
       * cache and the screen never blanks, because §5.7's persisted cache
       * serves the old value while it runs.
       */
      void queryClient.invalidateQueries({ queryKey: queryKeys.close(dayKey, zone) });
    },
  });

  const isDirty = Object.keys(edits).length > 0;

  /**
   * Merged over the current edits rather than replacing them.
   *
   * The map is sparse and per-field, so the union is well defined and anything
   * the operator has already answered in *this* attempt wins. Replacing would
   * mean an explicit restore could delete an answer given thirty seconds ago,
   * which is the loss this feature exists to prevent, arriving through the
   * recovery path.
   */
  const restoreDraft = useCallback(
    (recovered: Draft) => {
      setEdits((current) => ({ ...recovered.fields, ...current }));
      draft.accept(recovered);
    },
    [draft],
  );

  return {
    snapshot,
    isLoading: query.isLoading,
    error: query.error,
    answers,
    setAnswer,
    clearAnswer,
    isDirty,
    submit: () => {
      mutation.mutate();
    },
    isSubmitting: mutation.isPending,
    queuedAt,
    resumeEditing: () => {
      setQueuedAt(null);
    },
    recoverable: draft.offered,
    restoreDraft,
    discardDraft: draft.discard,
    draftProblem: draft.problem,
  };
}
