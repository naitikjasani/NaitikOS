'use client';

/**
 * Draft persistence — §8.10's autosave, and nothing more than that.
 *
 *   "**Autosave for anything long-form.** Journal entries save continuously.
 *    Losing a written reflection to a navigation is unforgivable."
 *
 * §5.12 promises that "failure never loses user input", and until this file
 * existed that promise held for exactly one failure: a *save* that fails, where
 * the entered data stays on screen and enters the outbox. It did not hold for a
 * navigation, a tab close, an iOS tab killed under memory pressure, or a render
 * crash — which unmounts the subtree and takes in-progress form state with it,
 * at whatever depth the error boundary sits. `app/(protected)/today/error.tsx`
 * and `mind/error.tsx` both name this file as the remedy rather than pretending
 * a boundary is one.
 *
 * ## A draft is not an observation
 *
 * §9.1 makes the observation log append-only and immutable: "if a weight from
 * 2027 can be silently edited in 2031, then no number in the system can be
 * relied upon". A half-typed journal entry is not a recorded fact. It is not
 * something that *was true at a moment*; it is furniture being moved around a
 * room. So it never reaches the observation log, it never enters the §5.7
 * outbox, and it is never uploaded, synced or exported. It lives on one device
 * and it dies there — either when the entry it becomes is durably saved, or when
 * {@link DRAFT_TTL_MS} elapses.
 *
 * That local-only rule is also what makes the §4.7 exposure bounded. Journal
 * content is "the most sensitive data in the system", and `mindClient.ts` goes
 * to three layers of trouble to keep a *saved* entry out of every cache. A draft
 * is unavoidably the one exception — persisting it locally is the entire point —
 * so the compensating controls are that it is deleted the moment it is
 * redundant, expires without being read, and never leaves the device.
 *
 * ## `localStorage`, not IndexedDB — the opposite call from the outbox
 *
 * The outbox next door is IndexedDB, and this is not an inconsistency. The
 * deciding property is **what can be written in the last moment before a page
 * is destroyed.**
 *
 * The failures this must survive are a tab switch, a backgrounded PWA, and iOS
 * discarding a hidden tab. In all three the browser gives one synchronous
 * callback (`visibilitychange`, `pagehide`) and is then free to freeze or
 * terminate the page. `localStorage.setItem` has *already happened* when that
 * handler returns. An IndexedDB transaction opened in the same handler is a
 * promise the browser is under no obligation to keep, and the one it is least
 * likely to keep is the one that matters — a page being discarded. Using an
 * asynchronous store for a synchronous deadline would be building the feature
 * around the one thing it cannot do.
 *
 * The costs are real and are affordable here:
 *
 * - **Size.** `localStorage` is ~5 MB per origin against IndexedDB's hundreds.
 *   One journal entry is a few kilobytes; a very long reflection is perhaps
 *   twenty. {@link MAX_DRAFT_CHARACTERS} and {@link MAX_DRAFTS} bound the store
 *   at well under a megabyte, and {@link saveDraft} reports a refusal rather
 *   than swallowing it, so the operator is told when autosave stops working
 *   instead of discovering it afterwards.
 * - **Main-thread cost.** A synchronous write blocks. A few kilobytes of JSON is
 *   sub-millisecond, and it happens at most once per {@link DRAFT_TTL_MS}-free
 *   idle pause rather than per keystroke — see `useDraft.ts` for the cadence.
 * - **Strings only.** Handled by {@link parseRecord}, which validates on the way
 *   back in rather than trusting whatever is on disk.
 *
 * `device.ts` already set this precedent for the same reason ("`localStorage` is
 * synchronous, which matters here"); the outbox is IndexedDB because it holds an
 * unbounded queue of structured records that is drained asynchronously anyway.
 *
 * Neither store is encrypted at rest, so the choice is neutral on §4.7 — what
 * bounds the exposure is the clearing boundary and the expiry, not the API.
 *
 * ## Every function here is pure, and takes its clock as an argument
 *
 * No `systemClock` import, no `window` access outside {@link draftStorage}, no
 * module state. The store is threaded in and the current time is a parameter,
 * which is why `drafts.test.ts` can assert the expiry rule against a
 * `Map`-backed fake in a Node environment rather than mocking a global. §11.3
 * bans raw `Date` for exactly this reason — a clock that cannot be substituted
 * is a rule that cannot be tested.
 */

/* -------------------------------------------------------------------------
 * Policy
 * ---------------------------------------------------------------------- */

/** Namespaced and versioned, so a shape change cannot be read as the old shape. */
export const DRAFT_KEY_PREFIX = 'naitikos.draft.v1.';

/**
 * How long an unclaimed draft is kept. Fourteen days.
 *
 * An operator who starts a reflection and returns to it at the weekend is doing
 * something ordinary, so an hour or a day is far too short. An operator who has
 * not returned in a fortnight has abandoned it, and past that point the §4.7
 * cost of holding their prose in plaintext local storage outweighs a recovery
 * they are not going to make. Expired drafts are never *offered* (see
 * {@link loadDraft}) and are deleted by the next {@link pruneDrafts}.
 */
export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The largest draft that will be stored, in UTF-16 code units of serialised
 * JSON. 64 KiB — roughly ten thousand words.
 *
 * The cap exists to stop one pathological paste consuming the origin's whole
 * quota and thereby breaking autosave for *every other* draft. It is a policy
 * limit rather than the browser's, so the refusal is predictable and reportable
 * instead of arriving as a `QuotaExceededError` at an arbitrary keystroke.
 *
 * **Nothing is truncated.** Silently storing the first 64 KiB would be the exact
 * data loss this file exists to prevent, and it would be worse than the loss it
 * replaced because it would look like a success. {@link saveDraft} returns
 * `'too-large'` and leaves any earlier, smaller draft of the same entry in
 * place — an earlier version of the same text is a strictly better thing to
 * survive a tab kill than nothing.
 */
export const MAX_DRAFT_CHARACTERS = 64 * 1024;

/**
 * The most drafts kept at once, across every surface. Twenty.
 *
 * Reaching this means twenty entries were started and abandoned without ever
 * being saved, which is a signal that something upstream is wrong rather than a
 * usage pattern to support. An unbounded pile of journal prose in local storage
 * is a worse failure than evicting the oldest of twenty, so the cap is enforced
 * and the eviction is oldest-first.
 */
export const MAX_DRAFTS = 20;

/** Bumped only when {@link StoredRecord} changes shape. See {@link parseRecord}. */
const SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------
 * Scope — what identifies one draft
 * ---------------------------------------------------------------------- */

/**
 * The editors that persist drafts.
 *
 * Three, and the split between the first two is load-bearing. Composing a new
 * entry and revising a stored one are different drafts even when they carry the
 * same id, because they recover differently: one is "you were writing this and
 * never saved it", the other is "you had unsaved changes to an entry that
 * already exists". Collapsing them would mean offering the wrong sentence, and
 * the sentence is how the operator decides.
 *
 * `journal.edit` has no editor yet — `JournalEntryScreen` is deliberately
 * read-only — but the surface is named here so the key space is already correct
 * when one arrives, rather than requiring a migration of live drafts.
 */
export type DraftSurface = 'journal.compose' | 'journal.edit' | 'daily-close';

const SURFACES: readonly DraftSurface[] = ['journal.compose', 'journal.edit', 'daily-close'];

/**
 * What a draft is scoped to.
 *
 * The `target` is the identity of the thing being written, never a timestamp and
 * never "the current editor":
 *
 * - **`journal.compose`** — the client-generated UUIDv7 of the entry the draft
 *   will become. §5.7's first property is that "a record created offline has its
 *   permanent identity from the moment it exists", and a draft is the moment it
 *   exists. Two entries drafted on the same day get two ids and therefore two
 *   drafts; a day key would have silently merged them into one. It also means
 *   restoring a draft re-adopts its id, so restore-then-save cannot produce a
 *   second entry from the same draft.
 * - **`journal.edit`** — the id of the stored entry being revised.
 * - **`daily-close`** — the day key. The Close is idempotent per day, so the day
 *   *is* the identity, and back-filling 3 August is a different draft from
 *   closing today.
 */
export type DraftScope = {
  readonly surface: DraftSurface;
  readonly target: string;
};

/**
 * A field value a draft can hold.
 *
 * Three primitives, because that is what the two editors produce: the journal's
 * title and prose are strings, and the Close's sparse answer map holds a scale's
 * integer, a toggle's boolean, and a note's text. Widening this to `unknown`
 * would make {@link parseRecord} unable to validate what came back off disk.
 */
export type DraftFieldValue = string | number | boolean;

/** One editor's in-progress state, keyed however that editor keys its fields. */
export type DraftFields = Readonly<Record<string, DraftFieldValue>>;

export type Draft = {
  readonly scope: DraftScope;
  readonly fields: DraftFields;
  /** Milliseconds since the epoch, from the caller's clock. */
  readonly savedAt: number;
};

export function draftKey(scope: DraftScope): string {
  return `${DRAFT_KEY_PREFIX}${scope.surface}.${scope.target}`;
}

/**
 * The inverse, used when walking the store.
 *
 * Matched against the known surfaces rather than split on the separator, because
 * a surface name contains dots (`journal.compose`) and a target may too. A key
 * that does not resolve to a surface this build knows about is not ours to
 * interpret.
 */
export function parseDraftKey(key: string): DraftScope | null {
  if (!key.startsWith(DRAFT_KEY_PREFIX)) return null;
  const rest = key.slice(DRAFT_KEY_PREFIX.length);

  for (const surface of SURFACES) {
    const marker = `${surface}.`;
    if (!rest.startsWith(marker)) continue;
    const target = rest.slice(marker.length);
    return target === '' ? null : { surface, target };
  }
  return null;
}

/* -------------------------------------------------------------------------
 * The store
 * ---------------------------------------------------------------------- */

/**
 * The slice of `Storage` this module uses.
 *
 * Narrowed to five members so a test can supply a `Map` in twenty lines, and so
 * nothing here can reach for `clear()` — which would take the device id and the
 * HLC in `device.ts` with it.
 */
export type DraftStore = {
  readonly length: number;
  key: (index: number) => string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/**
 * The real store, or `null` when there is not one.
 *
 * `null` on the server, and `null` in Safari's private mode and anywhere storage
 * is blocked — both of which throw on *access*, not on use. Returning an absence
 * rather than throwing is what lets {@link saveDraft} report `'unavailable'` so
 * the editor can say autosave is not working, instead of the operator trusting a
 * guarantee that is silently not in force.
 */
export function draftStorage(): DraftStore | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------
 * Serialisation
 * ---------------------------------------------------------------------- */

type StoredRecord = {
  readonly v: number;
  readonly savedAt: number;
  readonly fields: DraftFields;
};

/**
 * Read one record back, or `null`.
 *
 * Everything in `localStorage` is a string that anything on the origin could
 * have written, including a previous build of this application and the operator
 * with a devtools console open. So the shape is checked rather than asserted.
 *
 * A record is rejected whole rather than field-by-field. Dropping one
 * unrecognised value and keeping the rest would hand the editor a draft that is
 * *nearly* what was written, which is the most dangerous of the available
 * outcomes — it looks restored. Note that `JSON.stringify` maps `NaN` and
 * `Infinity` to `null`, which fails the value check below, so a non-finite
 * number cannot come back disguised as one.
 *
 * A rejected record is deleted by {@link pruneDrafts}. That is not a discard of
 * something recoverable: an unreadable draft cannot be offered, so removing it
 * is the only action available.
 */
function parseRecord(raw: string): { readonly savedAt: number; readonly fields: DraftFields } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (record['v'] !== SCHEMA_VERSION) return null;

  const savedAt = record['savedAt'];
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt <= 0) return null;

  const rawFields = record['fields'];
  if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) return null;

  const fields: Record<string, DraftFieldValue> = {};
  for (const [name, value] of Object.entries(rawFields as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'boolean') {
      fields[name] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      fields[name] = value;
      continue;
    }
    return null;
  }

  return { savedAt, fields };
}

/**
 * A stable string for a set of fields, used to decide whether anything changed.
 *
 * Keys are sorted, so a re-ordered object with identical contents compares
 * equal. Without this the Close's answer map — rebuilt by `useMemo` on every
 * edit — would look different on every render and rewrite the same draft
 * forever.
 */
export function fieldSignature(fields: DraftFields): string {
  const keys = Object.keys(fields).sort();
  return JSON.stringify(keys.map((key) => [key, fields[key]]));
}

/**
 * Is there anything here worth keeping?
 *
 * A string field counts only if it holds more than whitespace. A number or a
 * boolean always counts: a Close scale of 3 and a toggle set to `false` are both
 * real input, and treating `false` as absence would drop the answer.
 *
 * An empty object is blank, which is what an untouched Daily Close looks like.
 */
export function isBlankFields(fields: DraftFields): boolean {
  return Object.values(fields).every((value) => typeof value === 'string' && value.trim() === '');
}

/* -------------------------------------------------------------------------
 * Reading
 * ---------------------------------------------------------------------- */

/**
 * Snapshot the key list before touching it.
 *
 * `Storage` is index-addressed and re-indexes on removal, so walking it with
 * `key(i)` while deleting skips entries. Every caller here either deletes or may
 * be called next to one, so the list is materialised first, always.
 */
function collectKeys(store: DraftStore): readonly string[] {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function isExpired(savedAt: number, nowMillis: number): boolean {
  /*
   * A phone's clock is untrustworthy — §5.7 adopts hybrid logical clocks for
   * precisely this reason — so a draft that appears to come from the future is
   * treated as fresh rather than expired. A backwards clock jump must not
   * silently delete somebody's writing.
   */
  return nowMillis - savedAt > DRAFT_TTL_MS;
}

/** The draft at one scope, or `null` if it is absent, unreadable or expired. */
export function loadDraft(store: DraftStore | null, scope: DraftScope, nowMillis: number): Draft | null {
  if (store === null) return null;

  let raw: string | null;
  try {
    raw = store.getItem(draftKey(scope));
  } catch {
    return null;
  }
  if (raw === null) return null;

  const record = parseRecord(raw);
  if (record === null || isExpired(record.savedAt, nowMillis)) return null;

  return { scope, fields: record.fields, savedAt: record.savedAt };
}

/**
 * Every live draft for one surface, newest first.
 *
 * The journal composer needs this rather than {@link loadDraft} because its key
 * is a fresh entry id — it cannot look up "my draft", it has to ask what is
 * waiting. Nothing is deleted here; expired records are filtered out and left
 * for {@link pruneDrafts}, so reading is separable from writing and therefore
 * testable on its own.
 */
export function listDrafts(
  store: DraftStore | null,
  surface: DraftSurface,
  nowMillis: number,
): readonly Draft[] {
  if (store === null) return [];

  const found: Draft[] = [];
  for (const key of collectKeys(store)) {
    const scope = parseDraftKey(key);
    if (scope === null || scope.surface !== surface) continue;

    const draft = loadDraft(store, scope, nowMillis);
    if (draft !== null) found.push(draft);
  }

  return found.sort((a, b) => b.savedAt - a.savedAt);
}

/* -------------------------------------------------------------------------
 * Writing
 * ---------------------------------------------------------------------- */

export type SaveOutcome =
  /** Written, and durable the instant this returns. */
  | 'saved'
  /** Nothing worth keeping; any earlier draft at this scope was removed. */
  | 'cleared'
  /** No local storage at all — private mode, or storage blocked. */
  | 'unavailable'
  /** Over {@link MAX_DRAFT_CHARACTERS}, or the quota refused it after a prune. */
  | 'too-large';

/**
 * Persist one editor's state, or remove the draft if there is nothing in it.
 *
 * **The empty case is a deletion, not a no-op.** An operator who selects all and
 * deletes has decided the draft is worthless; leaving the old text on disk would
 * resurrect it on the next open as a phantom the operator cannot distinguish
 * from something they wrote. Being wrong in that direction is the failure mode
 * this whole file is arranged around.
 *
 * On a quota error the expired and surplus records are pruned and the write is
 * retried exactly once. One retry, because the second failure means the quota is
 * consumed by something other than drafts and hammering it would not help.
 */
export function saveDraft(
  store: DraftStore | null,
  scope: DraftScope,
  fields: DraftFields,
  nowMillis: number,
): SaveOutcome {
  if (store === null) return 'unavailable';
  const key = draftKey(scope);

  if (isBlankFields(fields)) {
    try {
      store.removeItem(key);
    } catch {
      return 'unavailable';
    }
    return 'cleared';
  }

  const record: StoredRecord = { v: SCHEMA_VERSION, savedAt: nowMillis, fields };
  const payload = JSON.stringify(record);

  /*
   * Refused, and the earlier draft is deliberately left alone. See
   * {@link MAX_DRAFT_CHARACTERS}: an older version of the same entry is a better
   * thing to survive a tab kill than nothing, and the editor is told autosave
   * has stopped so the operator can save manually.
   */
  if (payload.length > MAX_DRAFT_CHARACTERS) return 'too-large';

  try {
    store.setItem(key, payload);
    return 'saved';
  } catch {
    pruneDrafts(store, nowMillis);
    try {
      store.setItem(key, payload);
      return 'saved';
    } catch {
      return 'too-large';
    }
  }
}

/**
 * Delete one draft.
 *
 * Called from exactly two places, and the distinction between them is the whole
 * feature: when the operator discards an offered draft, and when the entry it
 * held has been *durably saved*. Durable here means what §5.7 means — the
 * mutation is in the IndexedDB outbox, keyed by an idempotency key, and the
 * outbox "must never silently discard a write". So `queueAndDrain` resolving is
 * the acknowledgement, and nothing earlier is: not the submit tap, not an
 * optimistic update, not a hopeful network call.
 *
 * Clearing any earlier than that would leave a window in which the draft is gone
 * and the entry is not yet anywhere.
 */
export function clearDraft(store: DraftStore | null, scope: DraftScope): void {
  if (store === null) return;
  try {
    store.removeItem(draftKey(scope));
  } catch {
    // A store that refuses a delete will refuse a write too, so there is
    // nothing to recover from and nothing to tell the operator that the
    // `'unavailable'` outcome does not already say.
  }
}

/**
 * Remove what can never be offered again, and enforce {@link MAX_DRAFTS}.
 *
 * Three categories, all of them unofferable rather than merely old:
 *
 * 1. **Expired** — past {@link DRAFT_TTL_MS}, so {@link loadDraft} already
 *    refuses to return it. Deleting is what stops §4.7 prose sitting on disk
 *    indefinitely after the recovery window has closed.
 * 2. **Unreadable** — a record {@link parseRecord} rejects, including one
 *    written by an older schema version. It cannot be shown, so keeping it
 *    achieves nothing.
 * 3. **Surplus** — the oldest beyond {@link MAX_DRAFTS}.
 *
 * @returns how many records were removed.
 */
export function pruneDrafts(store: DraftStore | null, nowMillis: number): number {
  if (store === null) return 0;

  let removed = 0;
  const survivors: { readonly key: string; readonly savedAt: number }[] = [];

  const remove = (key: string): void => {
    try {
      store.removeItem(key);
      removed += 1;
    } catch {
      // Nothing useful to do. The next prune will try again.
    }
  };

  for (const key of collectKeys(store)) {
    if (parseDraftKey(key) === null) continue;

    let raw: string | null;
    try {
      raw = store.getItem(key);
    } catch {
      // Unreadable entry. Leave it and move on; the next prune tries again.
      continue;
    }

    const record = raw === null ? null : parseRecord(raw);
    if (record === null || isExpired(record.savedAt, nowMillis)) {
      remove(key);
      continue;
    }
    survivors.push({ key, savedAt: record.savedAt });
  }

  if (survivors.length > MAX_DRAFTS) {
    const surplus = [...survivors].sort((a, b) => b.savedAt - a.savedAt).slice(MAX_DRAFTS);
    for (const entry of surplus) remove(entry.key);
  }

  return removed;
}

/* -------------------------------------------------------------------------
 * Presentation
 * ---------------------------------------------------------------------- */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * "when it was written", for the recovery offer.
 *
 * Recovery must be explicit, and an offer the operator cannot date is not a
 * choice they can make — a draft from four minutes ago is almost certainly the
 * one they were just writing, and one from nine days ago is almost certainly not.
 *
 * **Relative durations only, never a calendar word.** "Yesterday" from a
 * thirty-hour-old draft is a claim about the operator's local calendar day, and
 * this function has a millisecond delta rather than a zone — §5.3 does not allow
 * that inference to be guessed at. So the label degrades to "9 days ago", which
 * is less charming and always true. It also means no `Date` is constructed here
 * at all, which §11.3 requires outside `**\/temporal/**`.
 */
export function draftAgeLabel(savedAt: number, nowMillis: number): string {
  // A negative age means the device's clock moved backwards. Reporting "moments
  // ago" is the honest floor; reporting a negative duration is not.
  const age = Math.max(nowMillis - savedAt, 0);

  if (age < 45 * 1000) return 'moments ago';
  if (age < 90 * 1000) return 'a minute ago';
  if (age < HOUR_MS) {
    const minutes = Math.round(age / MINUTE_MS);
    return `${String(minutes)} minutes ago`;
  }
  if (age < 2 * HOUR_MS) return 'an hour ago';
  if (age < DAY_MS) {
    const hours = Math.round(age / HOUR_MS);
    return `${String(hours)} hours ago`;
  }
  if (age < 2 * DAY_MS) return 'a day ago';

  const days = Math.round(age / DAY_MS);
  return `${String(days)} days ago`;
}

/** The text of a draft field, or `''`. Narrows the primitive union at the edge. */
export function draftText(fields: DraftFields, name: string): string {
  const value = fields[name];
  return typeof value === 'string' ? value : '';
}
