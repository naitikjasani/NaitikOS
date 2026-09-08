/**
 * The clearing decisions — the two that must never regress quietly.
 *
 * The first is §5.7's guarantee applied to a settings button: a write that is
 * still being sent is not offered for deletion, at any count, in any
 * combination. `outbox.test.ts` asserts the same rule at the store, which is
 * where it is actually enforced; this asserts that the surface never even
 * proposes it, because a button that has to be refused is a button that should
 * not have been drawn.
 *
 * The second is the copy. Asserting prose is normally a way to write a test that
 * fails on every edit, and it is done here for two sentences only: the ones that
 * promise the operator that the record on the server is untouched. That promise
 * is the entire reason a "clear data" control is safe to ship (§9.4 owns
 * deletion of the record, and it is nowhere near this screen), so an edit that
 * dropped it should fail rather than ship.
 */

import { describe, expect, it } from 'vitest';

import type { DraftInventory } from '@/lib/offline/drafts';
import type { OutboxHealth } from '@/lib/offline/outbox';

import {
  cacheLabel,
  cacheSummary,
  discardConfirmation,
  discardLabel,
  draftsCleared,
  draftsLabel,
  draftsSummary,
  outboxDisposition,
  outboxSummary,
} from './localData';

const QUIET: OutboxHealth = { pending: 0, sending: 0, blocked: 0, oldestPendingAgeMs: null };

function health(patch: Partial<OutboxHealth>): OutboxHealth {
  return { ...QUIET, ...patch };
}

function inventory(patch: Partial<DraftInventory>): DraftInventory {
  return { live: 0, stale: 0, newestSavedAt: null, ...patch };
}

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = 1_789_000_000_000;

/* -------------------------------------------------------------------------
 * The outbox
 * ---------------------------------------------------------------------- */

describe('outboxDisposition', () => {
  it('offers nothing for an empty queue', () => {
    expect(outboxDisposition(QUIET)).toEqual({ kind: 'empty' });
    expect(discardLabel(outboxDisposition(QUIET))).toBeNull();
  });

  /**
   * The rule. A pending or in-flight entry has not been acknowledged, and its
   * remedy — connect, drain, or wait out the backoff — costs nothing. §5.7 does
   * not permit a settings button to be the cheaper option.
   */
  it('offers no discard while every entry is still trying', () => {
    for (const queue of [health({ pending: 3 }), health({ sending: 1 }), health({ pending: 2, sending: 1 })]) {
      const disposition = outboxDisposition(queue);
      expect(disposition.kind).toBe('waiting');
      expect(discardLabel(disposition)).toBeNull();
    }
  });

  it('counts an in-flight entry as unsent rather than as gone', () => {
    expect(outboxDisposition(health({ pending: 2, sending: 1 }))).toEqual({ kind: 'waiting', unsent: 3 });
  });

  /**
   * The refusal is per entry, not per queue. Three pending alongside two
   * blocked offers a discard of exactly two — refusing on account of the three
   * would be theatre, since the store's own filter cannot touch them.
   */
  it('offers exactly the entries that have given up, whatever else is queued', () => {
    expect(outboxDisposition(health({ pending: 3, blocked: 2 }))).toEqual({
      kind: 'discardable',
      blocked: 2,
      unsent: 3,
    });
    expect(discardLabel(outboxDisposition(health({ pending: 3, blocked: 2 })))).toBe(
      'Discard 2 unsendable writes',
    );
    expect(discardLabel(outboxDisposition(health({ blocked: 1 })))).toBe('Discard 1 unsendable write');
  });
});

describe('the outbox copy', () => {
  it('says why a queue that is still trying cannot be cleared', () => {
    const summary = outboxSummary(outboxDisposition(health({ pending: 2 })));
    expect(summary).toContain('2 writes are queued');
    expect(summary).toContain('None of them can be cleared from here');
  });

  it('states that the queued entries are unacknowledged rather than unsaved', () => {
    expect(outboxSummary(outboxDisposition(health({ blocked: 1 })))).toContain('never reached the server');
  });

  it('names the untouched entries when only some are discardable', () => {
    const summary = outboxSummary(outboxDisposition(health({ pending: 4, blocked: 1 })));
    expect(summary).toContain('4 writes are still being sent and will not be touched');
  });

  /**
   * The promise the whole surface rests on. A "clear data" control that could
   * be read as touching the database would be a different and far more
   * dangerous feature — §9.4's soft delete with its audit log is reached from
   * the entity, not from here.
   */
  it('promises the saved record is unchanged, and that the discard cannot be undone', () => {
    const confirmation = discardConfirmation(outboxDisposition(health({ blocked: 2 })));
    expect(confirmation).toContain('Nothing already saved to the record changes');
    expect(confirmation).toContain('cannot be undone');
    expect(confirmation).toContain('2 writes');
  });

  /** The known consequence, named to the operator rather than discovered later. */
  it('warns that dependants of a discarded write resurface as unsendable', () => {
    expect(discardConfirmation(outboxDisposition(health({ blocked: 1 })))).toContain(
      'queued behind a discarded write',
    );
  });
});

/* -------------------------------------------------------------------------
 * Drafts
 * ---------------------------------------------------------------------- */

describe('draftsLabel', () => {
  it('carries the count, because the operator cannot browse the store', () => {
    expect(draftsLabel(inventory({ live: 3 }))).toBe('Clear 3 drafts');
    expect(draftsLabel(inventory({ live: 1 }))).toBe('Clear 1 draft');
  });

  /** Expired records cannot be offered for recovery, so they are not called drafts. */
  it('names expired records as expired when nothing else is held', () => {
    expect(draftsLabel(inventory({ stale: 2 }))).toBe('Clear 2 expired drafts');
    expect(draftsLabel(inventory({ live: 1, stale: 2 }))).toBe('Clear 1 draft');
  });

  it('offers no button for an empty store', () => {
    expect(draftsLabel(inventory({}))).toBeNull();
  });
});

describe('draftsSummary', () => {
  /**
   * The fact that stops a mis-tap. A draft from four minutes ago is almost
   * certainly the reflection being written right now.
   */
  it('dates the newest draft and says the writing is unsaved', () => {
    const summary = draftsSummary(inventory({ live: 2, newestSavedAt: NOW - 4 * 60_000 }), NOW);
    expect(summary).toContain('2 part-written entries are held');
    expect(summary).toContain('written 4 minutes ago');
    expect(summary).toContain('has not been saved anywhere else');
    expect(summary).toContain('No saved entry is affected');
  });

  it('reports expired records separately from recoverable ones', () => {
    expect(draftsSummary(inventory({ live: 1, stale: 3, newestSavedAt: NOW }), NOW)).toContain(
      'A further 3 records are past the fourteen-day expiry',
    );
    expect(draftsSummary(inventory({ stale: 1 }), NOW)).toContain('No draft can still be recovered.');
  });

  it('does not frame an empty store as a problem', () => {
    expect(draftsSummary(inventory({}), NOW)).toContain('Nothing unsaved is stored on this device');
  });
});

describe('draftsCleared', () => {
  it('reports the count and keeps the record out of it', () => {
    expect(draftsCleared(3)).toBe('3 drafts removed from this device. Nothing saved to the record changed.');
    expect(draftsCleared(1)).toContain('1 draft removed');
  });
});

/* -------------------------------------------------------------------------
 * Cached reads
 * ---------------------------------------------------------------------- */

describe('the cache copy', () => {
  it('carries the count and states that nothing is lost', () => {
    expect(cacheLabel(42)).toBe('Clear 42 cached responses');
    expect(cacheLabel(1)).toBe('Clear 1 cached response');
    expect(cacheLabel(0)).toBeNull();
    expect(cacheSummary(42)).toContain('loses nothing');
  });

  /** It is still a copy of the record sitting in a browser store, and says so. */
  it('does not pretend a cache is not a copy of the record', () => {
    expect(cacheSummary(42)).toContain("copy of the record that was sitting in this browser's storage");
  });

  it('does not frame an empty cache as a problem', () => {
    expect(cacheSummary(0)).toContain('Nothing is cached yet');
  });
});
