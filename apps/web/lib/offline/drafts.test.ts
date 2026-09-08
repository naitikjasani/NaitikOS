/**
 * Draft persistence — the §8.10 guarantee, asserted rather than assumed.
 *
 *   "**Autosave for anything long-form.** Journal entries save continuously.
 *    Losing a written reflection to a navigation is unforgivable."
 *
 * Two clauses of that sentence are testable here and both are tested: what is
 * written, and — the harder half — exactly when it stops existing. A draft that
 * outlives its save reappears as a phantom the operator cannot distinguish from
 * something they wrote, and a draft cleared a moment early is the data loss the
 * feature was built to prevent. The boundary is the feature, so it gets the most
 * assertions.
 *
 * No `fake-indexeddb` and no jsdom. Every function in `drafts.ts` takes its store
 * and its clock as arguments precisely so that a twenty-line `Map` is a
 * sufficient double — which means the expiry rule is exercised against real
 * arithmetic rather than a mocked global.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DRAFT_KEY_PREFIX,
  DRAFT_TTL_MS,
  type DraftFields,
  type DraftScope,
  type DraftStore,
  MAX_DRAFTS,
  MAX_DRAFT_CHARACTERS,
  clearAllDrafts,
  clearDraft,
  draftAgeLabel,
  draftInventory,
  draftKey,
  draftText,
  fieldSignature,
  isBlankFields,
  listDrafts,
  loadDraft,
  parseDraftKey,
  pruneDrafts,
  restoreDrafts,
  saveDraft,
} from './drafts';

/* -------------------------------------------------------------------------
 * A store double
 * ---------------------------------------------------------------------- */

type FakeStore = DraftStore & {
  /** Make the next `setItem` throw, as a full quota does. */
  readonly refuseWrites: (refuse: boolean) => void;
  readonly raw: Map<string, string>;
};

function fakeStore(): FakeStore {
  const raw = new Map<string, string>();
  let refusing = false;

  return {
    raw,
    get length(): number {
      return raw.size;
    },
    key: (index) => [...raw.keys()][index] ?? null,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      if (refusing) throw new Error('QuotaExceededError');
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
    refuseWrites: (refuse) => {
      refusing = refuse;
    },
  };
}

/** A fixed instant, so nothing here depends on when the suite runs. */
const NOW = 1_789_000_000_000;

const COMPOSE: DraftScope = { surface: 'journal.compose', target: '018f-entry-a' };
const CLOSE: DraftScope = { surface: 'daily-close', target: '2026-09-07' };

const REFLECTION: DraftFields = { title: 'A hard week', content: 'It started on Tuesday.' };

let store: FakeStore;

beforeEach(() => {
  store = fakeStore();
});

/* -------------------------------------------------------------------------
 * Keys — what identifies one draft
 * ---------------------------------------------------------------------- */

describe('draft keys', () => {
  it('namespaces and round-trips a scope', () => {
    const key = draftKey(COMPOSE);
    expect(key.startsWith(DRAFT_KEY_PREFIX)).toBe(true);
    expect(parseDraftKey(key)).toEqual(COMPOSE);
  });

  /**
   * The scoping rule §8.10 depends on. A new entry and an edit of the same id
   * are different drafts, because they recover differently — and two entries
   * drafted on the same day are different drafts, because each carries its own
   * client-generated id (§5.7) rather than a day key they would share.
   */
  it('separates composing from editing, and one entry from another', () => {
    const compose = draftKey({ surface: 'journal.compose', target: 'entry-1' });
    const edit = draftKey({ surface: 'journal.edit', target: 'entry-1' });
    const other = draftKey({ surface: 'journal.compose', target: 'entry-2' });

    expect(new Set([compose, edit, other]).size).toBe(3);
    expect(parseDraftKey(edit)?.surface).toBe('journal.edit');
  });

  it('separates one day of the Close from another', () => {
    expect(draftKey({ surface: 'daily-close', target: '2026-09-07' })).not.toBe(
      draftKey({ surface: 'daily-close', target: '2026-09-06' }),
    );
  });

  it('ignores keys that are not ours', () => {
    expect(parseDraftKey('naitikos.device.id')).toBeNull();
    expect(parseDraftKey(`${DRAFT_KEY_PREFIX}unknown-surface.x`)).toBeNull();
    // A surface with no target is not a scope.
    expect(parseDraftKey(`${DRAFT_KEY_PREFIX}journal.compose.`)).toBeNull();
  });
});

/* -------------------------------------------------------------------------
 * Save and load
 * ---------------------------------------------------------------------- */

describe('saveDraft / loadDraft', () => {
  it('round-trips an entry with its timestamp', () => {
    expect(saveDraft(store, COMPOSE, REFLECTION, NOW)).toBe('saved');

    const loaded = loadDraft(store, COMPOSE, NOW);
    expect(loaded?.fields).toEqual(REFLECTION);
    expect(loaded?.savedAt).toBe(NOW);
    expect(loaded?.scope).toEqual(COMPOSE);
  });

  it('keeps the numbers and booleans a Daily Close produces', () => {
    const answers: DraftFields = { mood: 3, 'medication.taken': false, note: 'Long day.' };
    expect(saveDraft(store, CLOSE, answers, NOW)).toBe('saved');
    expect(loadDraft(store, CLOSE, NOW)?.fields).toEqual(answers);
  });

  it('overwrites rather than accumulating, so one editor has one draft', () => {
    saveDraft(store, COMPOSE, { content: 'first' }, NOW);
    saveDraft(store, COMPOSE, { content: 'second' }, NOW + 1000);

    expect(store.raw.size).toBe(1);
    expect(loadDraft(store, COMPOSE, NOW + 1000)?.fields).toEqual({ content: 'second' });
  });

  it('reports an absent draft as absent', () => {
    expect(loadDraft(store, COMPOSE, NOW)).toBeNull();
  });

  /**
   * `null` is the shape of Safari's private mode and of any browser with storage
   * blocked. It must be an honest refusal rather than a throw, because the editor
   * uses it to tell the operator that autosave is not in force.
   */
  it('reports an unavailable store instead of throwing', () => {
    expect(saveDraft(null, COMPOSE, REFLECTION, NOW)).toBe('unavailable');
    expect(loadDraft(null, COMPOSE, NOW)).toBeNull();
    expect(listDrafts(null, 'journal.compose', NOW)).toEqual([]);
    expect(pruneDrafts(null, NOW)).toBe(0);
    expect(() => {
      clearDraft(null, COMPOSE);
    }).not.toThrow();
  });
});

/* -------------------------------------------------------------------------
 * The empty case — the phantom that must not exist
 * ---------------------------------------------------------------------- */

describe('an emptied editor', () => {
  /**
   * An operator who selects all and deletes has decided the draft is worthless.
   * Leaving the old text on disk would resurrect it on the next open, and they
   * would have no way to tell it from something they had written and saved.
   */
  it('deletes the draft rather than leaving stale text behind', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    expect(saveDraft(store, COMPOSE, { title: '', content: '   ' }, NOW + 1000)).toBe('cleared');
    expect(loadDraft(store, COMPOSE, NOW + 1000)).toBeNull();
  });

  it('treats an untouched Daily Close as empty', () => {
    expect(isBlankFields({})).toBe(true);
    expect(saveDraft(store, CLOSE, {}, NOW)).toBe('cleared');
    expect(store.raw.size).toBe(0);
  });

  /**
   * A scale of 3 and a toggle set to `false` are answers, not absences. Treating
   * `false` as blank would drop "no, I did not take it" — which is the answer the
   * adherence lens most needs.
   */
  it('does not treat a zero, a false or a whitespace-free string as empty', () => {
    expect(isBlankFields({ mood: 0 })).toBe(false);
    expect(isBlankFields({ taken: false })).toBe(false);
    expect(isBlankFields({ note: '.' })).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Clearing — the boundary the whole feature rests on
 * ---------------------------------------------------------------------- */

describe('clearDraft', () => {
  it('removes exactly one draft and leaves the rest alone', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    saveDraft(store, { surface: 'journal.compose', target: 'other' }, { content: 'x' }, NOW);
    saveDraft(store, CLOSE, { mood: 4 }, NOW);

    clearDraft(store, COMPOSE);

    expect(loadDraft(store, COMPOSE, NOW)).toBeNull();
    expect(loadDraft(store, { surface: 'journal.compose', target: 'other' }, NOW)).not.toBeNull();
    expect(loadDraft(store, CLOSE, NOW)).not.toBeNull();
  });

  it('is idempotent, so a second durable save cannot fail on it', () => {
    clearDraft(store, COMPOSE);
    clearDraft(store, COMPOSE);
    expect(store.raw.size).toBe(0);
  });

  /**
   * The one thing the store must never do: leave a draft behind after the entry
   * it held has been queued. `clearDraft` is called only once `queueAndDrain` has
   * resolved — see `drafts.ts` — and this asserts the store's half of that
   * contract: cleared means gone, not merely marked.
   */
  it('leaves nothing readable behind', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    clearDraft(store, COMPOSE);

    expect(store.raw.has(draftKey(COMPOSE))).toBe(false);
    expect(listDrafts(store, 'journal.compose', NOW)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Listing — what the recovery offer is built from
 * ---------------------------------------------------------------------- */

describe('listDrafts', () => {
  it('returns only the requested surface, newest first', () => {
    saveDraft(store, { surface: 'journal.compose', target: 'old' }, { content: 'old' }, NOW - 5000);
    saveDraft(store, { surface: 'journal.compose', target: 'new' }, { content: 'new' }, NOW);
    saveDraft(store, CLOSE, { mood: 3 }, NOW);

    const journal = listDrafts(store, 'journal.compose', NOW);
    expect(journal.map((draft) => draft.scope.target)).toEqual(['new', 'old']);

    expect(listDrafts(store, 'daily-close', NOW).map((draft) => draft.scope.target)).toEqual([
      CLOSE.target,
    ]);
    expect(listDrafts(store, 'journal.edit', NOW)).toEqual([]);
  });

  it('ignores foreign keys in the same store', () => {
    // `device.ts` keeps the device id and the HLC in the same `localStorage`.
    store.raw.set('naitikos.device.id', 'a-uuid');
    store.raw.set('unrelated', 'x');
    saveDraft(store, COMPOSE, REFLECTION, NOW);

    expect(listDrafts(store, 'journal.compose', NOW)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * Staleness
 * ---------------------------------------------------------------------- */

describe('expiry', () => {
  it('offers a draft right up to the limit', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    expect(loadDraft(store, COMPOSE, NOW + DRAFT_TTL_MS)).not.toBeNull();
  });

  it('stops offering it past the limit', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    expect(loadDraft(store, COMPOSE, NOW + DRAFT_TTL_MS + 1)).toBeNull();
    expect(listDrafts(store, 'journal.compose', NOW + DRAFT_TTL_MS + 1)).toEqual([]);
  });

  /**
   * Reading does not delete. Separating the two is what makes the expiry rule
   * testable on its own — and what stops a read on a device with a wrong clock
   * from destroying prose that a corrected clock would have offered back.
   */
  it('does not delete on read; only pruning deletes', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    const later = NOW + DRAFT_TTL_MS + 1;

    expect(loadDraft(store, COMPOSE, later)).toBeNull();
    expect(store.raw.size).toBe(1);

    expect(pruneDrafts(store, later)).toBe(1);
    expect(store.raw.size).toBe(0);
  });

  /**
   * §5.7 adopts hybrid logical clocks because "physical time on a phone is
   * untrustworthy". A clock that jumps backwards must not silently delete
   * somebody's writing, so a draft from the apparent future is fresh.
   */
  it('treats a draft from the future as fresh rather than expired', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    expect(loadDraft(store, COMPOSE, NOW - DRAFT_TTL_MS * 2)).not.toBeNull();
    expect(pruneDrafts(store, NOW - DRAFT_TTL_MS * 2)).toBe(0);
  });
});

describe('pruneDrafts', () => {
  it('leaves live drafts and foreign keys untouched', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    store.raw.set('naitikos.device.id', 'a-uuid');

    expect(pruneDrafts(store, NOW)).toBe(0);
    expect(store.raw.size).toBe(2);
  });

  /**
   * Unreadable records cannot be offered, so removing them is the only action
   * available — it is not a discard of something recoverable. This covers a
   * record from a future schema version and one a devtools console mangled.
   */
  it('removes records it cannot read', () => {
    store.raw.set(draftKey(COMPOSE), 'not json at all');
    store.raw.set(draftKey(CLOSE), JSON.stringify({ v: 99, savedAt: NOW, fields: {} }));
    store.raw.set(
      draftKey({ surface: 'journal.edit', target: 'e' }),
      JSON.stringify({ v: 1, savedAt: NOW, fields: { mood: null } }),
    );

    expect(pruneDrafts(store, NOW)).toBe(3);
    expect(store.raw.size).toBe(0);
  });

  it('rejects a record whose timestamp is not a usable number', () => {
    store.raw.set(draftKey(COMPOSE), JSON.stringify({ v: 1, savedAt: 'today', fields: {} }));
    expect(loadDraft(store, COMPOSE, NOW)).toBeNull();
  });

  /**
   * The cap. Twenty abandoned drafts means something upstream is wrong, and an
   * unbounded pile of §4.7 prose in local storage is a worse failure than
   * evicting the oldest.
   */
  it('evicts the oldest beyond the cap', () => {
    for (let index = 0; index < MAX_DRAFTS + 3; index += 1) {
      saveDraft(
        store,
        { surface: 'journal.compose', target: `entry-${String(index)}` },
        { content: `draft ${String(index)}` },
        // Ascending, so `entry-0` is the oldest.
        NOW + index,
      );
    }

    expect(pruneDrafts(store, NOW + 100)).toBe(3);
    expect(store.raw.size).toBe(MAX_DRAFTS);

    const survivors = listDrafts(store, 'journal.compose', NOW + 100).map(
      (draft) => draft.scope.target,
    );
    expect(survivors).not.toContain('entry-0');
    expect(survivors).not.toContain('entry-2');
    expect(survivors).toContain('entry-22');
  });
});

/* -------------------------------------------------------------------------
 * Refusals — reported, never swallowed
 * ---------------------------------------------------------------------- */

describe('when the draft will not fit', () => {
  /**
   * Nothing is truncated. Silently storing the first 64 KiB would be the exact
   * loss this file prevents, dressed as a success — and the earlier, smaller
   * draft is deliberately left in place, because an older version of the same
   * writing is a better thing to survive a tab kill than nothing.
   */
  it('refuses an oversized draft and keeps the earlier one', () => {
    saveDraft(store, COMPOSE, { content: 'a modest first paragraph' }, NOW);

    const huge = { content: 'x'.repeat(MAX_DRAFT_CHARACTERS + 1) };
    expect(saveDraft(store, COMPOSE, huge, NOW + 1000)).toBe('too-large');

    expect(loadDraft(store, COMPOSE, NOW + 1000)?.fields).toEqual({
      content: 'a modest first paragraph',
    });
  });

  /** A full quota is retried once, after pruning what was going to be deleted anyway. */
  it('prunes and retries once when the quota refuses a write', () => {
    saveDraft(store, { surface: 'journal.compose', target: 'stale' }, { content: 'old' }, NOW);
    const later = NOW + DRAFT_TTL_MS + 1;

    store.refuseWrites(true);
    expect(saveDraft(store, COMPOSE, REFLECTION, later)).toBe('too-large');
    // The prune still happened, so the expired record is gone either way.
    expect(store.raw.has(draftKey({ surface: 'journal.compose', target: 'stale' }))).toBe(false);

    store.refuseWrites(false);
    expect(saveDraft(store, COMPOSE, REFLECTION, later)).toBe('saved');
  });
});

/* -------------------------------------------------------------------------
 * Clearing — the `/settings/privacy` path
 *
 * §4.7 makes this the most consequential arithmetic in the file. The count the
 * surface prints is a promise about how much unsaved prose is about to be
 * destroyed, and the undo is the only thing standing between a mis-tap and work
 * that exists nowhere else. Both are asserted here rather than trusted.
 * ---------------------------------------------------------------------- */

describe('draftInventory', () => {
  it('counts what could still be recovered separately from what could not', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    saveDraft(store, CLOSE, { mood: 3 }, NOW - 60_000);
    // Past the TTL: `loadDraft` already refuses it, and it is still on the disk.
    saveDraft(store, { surface: 'journal.compose', target: 'abandoned' }, REFLECTION, NOW - DRAFT_TTL_MS - 1);
    // Unreadable: written by a schema this build does not recognise.
    store.raw.set(`${DRAFT_KEY_PREFIX}journal.edit.entry-9`, '{"v":99}');

    expect(draftInventory(store, NOW)).toEqual({ live: 2, stale: 2, newestSavedAt: NOW });
  });

  it('ignores every key that is not a draft', () => {
    store.raw.set('naitikos.device.id', 'device-1');
    store.raw.set('naitikos.query.cache', '{"version":1}');
    saveDraft(store, COMPOSE, REFLECTION, NOW);

    expect(draftInventory(store, NOW).live).toBe(1);
    expect(draftInventory(store, NOW).stale).toBe(0);
  });

  it('reports nothing held when there is no store at all', () => {
    expect(draftInventory(null, NOW)).toEqual({ live: 0, stale: 0, newestSavedAt: null });
  });

  /** Counting must not be a disguised prune — the same read twice reads the same. */
  it('does not delete what it counts', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW - DRAFT_TTL_MS - 1);
    expect(draftInventory(store, NOW).stale).toBe(1);
    expect(draftInventory(store, NOW).stale).toBe(1);
  });
});

describe('clearAllDrafts', () => {
  it('removes every draft, expired ones included', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW);
    saveDraft(store, CLOSE, { mood: 3 }, NOW);
    saveDraft(store, { surface: 'journal.compose', target: 'abandoned' }, REFLECTION, NOW - DRAFT_TTL_MS - 1);

    expect(clearAllDrafts(store)).toHaveLength(3);
    expect(draftInventory(store, NOW)).toEqual({ live: 0, stale: 0, newestSavedAt: null });
  });

  /**
   * The reason {@link DraftStore} has no `clear()`. The device id and the last
   * HLC share this origin, and re-keying the device as a side effect of tidying
   * up some prose would drop the outbox's causal clock (§5.7).
   */
  it('leaves the device identity and the read cache alone', () => {
    store.raw.set('naitikos.device.id', 'device-1');
    store.raw.set('naitikos.device.hlc', 'hlc-1');
    store.raw.set('naitikos.query.cache', '{"version":1}');
    saveDraft(store, COMPOSE, REFLECTION, NOW);

    clearAllDrafts(store);

    expect(store.raw.get('naitikos.device.id')).toBe('device-1');
    expect(store.raw.get('naitikos.device.hlc')).toBe('hlc-1');
    expect(store.raw.get('naitikos.query.cache')).toBe('{"version":1}');
  });

  it('does nothing, and claims nothing, without a store', () => {
    expect(clearAllDrafts(null)).toEqual([]);
  });
});

describe('restoreDrafts', () => {
  /**
   * §8.12's undo, and the assertion that matters: a restored draft is the draft
   * that was written, not a copy stamped with the moment of the undo. Re-dating
   * it would extend its §4.7 lifetime by up to a fortnight and would lie in the
   * recovery offer.
   */
  it('puts the drafts back exactly as they were', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW - 3 * 60_000);
    const before = loadDraft(store, COMPOSE, NOW);

    const removed = clearAllDrafts(store);
    expect(loadDraft(store, COMPOSE, NOW)).toBeNull();

    expect(restoreDrafts(store, removed)).toBe(1);
    expect(loadDraft(store, COMPOSE, NOW)).toEqual(before);
    expect(draftAgeLabel(before?.savedAt ?? 0, NOW)).toBe('3 minutes ago');
  });

  /** The undo window is real time, and an open editor may have autosaved into it. */
  it('refuses to overwrite a draft written since the clearance', () => {
    saveDraft(store, COMPOSE, REFLECTION, NOW - 60_000);
    const removed = clearAllDrafts(store);

    saveDraft(store, COMPOSE, { title: 'A hard week', content: 'It started on Tuesday. And then' }, NOW);
    expect(restoreDrafts(store, removed)).toBe(0);
    expect(draftText(loadDraft(store, COMPOSE, NOW)?.fields ?? {}, 'content')).toBe(
      'It started on Tuesday. And then',
    );
  });

  /** Not a general-purpose writer sitting next to the device id. */
  it('will not write a key that is not a draft', () => {
    expect(restoreDrafts(store, [{ key: 'naitikos.device.id', raw: 'forged' }])).toBe(0);
    expect(store.raw.has('naitikos.device.id')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Helpers the editors rely on
 * ---------------------------------------------------------------------- */

describe('fieldSignature', () => {
  it('is stable across key order, so an unchanged editor is not rewritten', () => {
    expect(fieldSignature({ title: 'a', content: 'b' })).toBe(
      fieldSignature({ content: 'b', title: 'a' }),
    );
  });

  it('changes when any value changes', () => {
    expect(fieldSignature({ content: 'a' })).not.toBe(fieldSignature({ content: 'a ' }));
    expect(fieldSignature({ mood: 3 })).not.toBe(fieldSignature({ mood: 4 }));
    // A number and its string form are different answers to a Close field.
    expect(fieldSignature({ mood: 3 })).not.toBe(fieldSignature({ mood: '3' }));
  });
});

describe('draftAgeLabel', () => {
  it('says how old the draft is in relative units only', () => {
    expect(draftAgeLabel(NOW, NOW)).toBe('moments ago');
    expect(draftAgeLabel(NOW - 4 * 60_000, NOW)).toBe('4 minutes ago');
    expect(draftAgeLabel(NOW - 5 * 3_600_000, NOW)).toBe('5 hours ago');
    expect(draftAgeLabel(NOW - 9 * 86_400_000, NOW)).toBe('9 days ago');
  });

  /** A clock that moved backwards reads as "moments ago", never as a negative. */
  it('floors a negative age', () => {
    expect(draftAgeLabel(NOW + 60_000, NOW)).toBe('moments ago');
  });
});

describe('draftText', () => {
  it('narrows to a string and treats anything else as absent', () => {
    expect(draftText({ title: 'A hard week' }, 'title')).toBe('A hard week');
    expect(draftText({}, 'title')).toBe('');
    expect(draftText({ title: 3 }, 'title')).toBe('');
  });
});
