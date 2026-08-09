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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CloseField } from '@naitikos/core';
import { systemClock } from '@naitikos/core';

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
  };
}
