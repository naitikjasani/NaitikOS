'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isUuid, uuidV7 } from '@naitikos/shared';
import { promptForDay, systemClock, wordCount } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { type Draft, type DraftFields, type DraftScope, draftText } from '@/lib/offline/drafts';
import { useDraft } from '@/lib/offline/useDraft';

import { fetchJournalIndex, logJournalEntry } from '../services/mindClient';

/**
 * `/mind/journal` — write, and a list of what has been written.
 *
 * ## The list shows headings, never prose
 *
 * The list is titles and word counts. §4.7 calls journal content the most
 * sensitive data in the system, and the obvious design — date, first hundred
 * and twenty characters, chevron — puts the darkest thing the operator has ever
 * written on screen the moment they open the tab, on a train, at work.
 *
 * The enforcement is three layers down, not here: `journalList` in the
 * repository does not select `content`, so this component *could not* render an
 * excerpt if someone added one. That is deliberate — a rule enforced in a
 * component is a rule that survives until the next component.
 *
 * The same rule governs the draft recovery offer below. It shows a title, a word
 * count and an age, because those are what identify a draft, and it shows no
 * prose at all — the operator has to restore it to read it.
 *
 * ## The prompt is an offer, not a form
 *
 * Today's prompt sits above the box as a sentence. Tapping it puts nothing in
 * the box. A prompt that pre-filled the textarea would make the operator delete
 * something before writing, and the blank page is easier to face than someone
 * else's opening line.
 *
 * ## The entry id is minted when the composer opens, not when Save is tapped
 *
 * §5.7's first property: "a record created offline has its permanent identity
 * from the moment it exists." For a journal entry that moment is when somebody
 * starts writing, which is why {@link JournalScreen} holds the id rather than
 * generating one inside the mutation. Two things follow, and both are the point:
 *
 * - The draft's key *is* the entry id, so restoring a draft re-adopts its id and
 *   restore-then-save cannot produce a second entry from the same draft.
 * - The id is re-minted after a successful save. Without that, a second entry
 *   written in the same session would carry the first entry's id — and the
 *   repository upserts, so it would silently overwrite it.
 *
 * The id is never rendered, so minting it in a `useState` initialiser is not a
 * hydration hazard: the server and the client disagree about a value that
 * reaches no markup.
 */

export function JournalScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [entryId, setEntryId] = useState(() => uuidV7(systemClock.nowMillis()));
  /*
   * Whether the last thing that happened on this screen was a successful save.
   *
   * §8.10 makes losing a written reflection "unforgivable", and the durability
   * this screen actually provides is real — but it was entirely invisible at the
   * one moment it is being relied on. Tapping Save cleared the box and said
   * nothing, which is indistinguishable, from the operator's side, from the
   * writing having been dropped. A guarantee nobody can see is a guarantee
   * nobody can lean on, and this is the surface where leaning on it matters.
   *
   * Cleared on the next keystroke rather than on a timer: a stale "Saved."
   * hanging over a half-written second entry is a false statement about the
   * text currently on screen, which is worse than no statement at all.
   */
  const [savedNotice, setSavedNotice] = useState(false);

  const index = useQuery({ queryKey: ['mind', 'journal'], queryFn: fetchJournalIndex });

  const prompt = promptForDay(index.data?.prompts ?? [], dayKey);

  /* §8.10's autosave. `lib/offline/drafts.ts` carries the reasoning; the two
     things this screen owns are the scope (the entry id, above) and what counts
     as the editor's state (these two fields and nothing else — the prompt is not
     the operator's writing). */
  const scope = useMemo<DraftScope>(() => ({ surface: 'journal.compose', target: entryId }), [entryId]);
  const fields = useMemo<DraftFields>(() => ({ title, content }), [title, content]);
  const draft = useDraft({ scope, fields });

  const write = useMutation({
    mutationFn: async () => {
      await logJournalEntry({
        id: entryId,
        writtenAt: nowIso,
        zone,
        title: title.trim() === '' ? null : title.trim(),
        content,
        promptId: prompt?.id ?? null,
      });
    },
    /*
     * `onSuccess` is the durability boundary, and it is the whole feature.
     *
     * `logJournalEntry` awaits `queueAndDrain`, which awaits `enqueue`, which
     * resolves only once the mutation is committed to the IndexedDB outbox. §5.7
     * then guarantees that entry "persists until acknowledged" and that a failed
     * drain "must never silently discard a write" — so reaching this line means
     * the entry is somewhere that survives the tab, and the draft has become
     * redundant.
     *
     * Nothing earlier qualifies. Clearing on the tap, or optimistically, would
     * open a window in which the draft is gone and the entry is nowhere; and if
     * `queueAndDrain` throws — IndexedDB is unavailable in Safari's private mode
     * — the mutation errors instead, the text stays on screen, and the draft
     * stays on disk. That is §5.12's "failure never loses user input" holding for
     * a case it previously did not cover.
     */
    onSuccess: async () => {
      draft.clear();
      setSavedNotice(true);
      setTitle('');
      setContent('');
      // A fresh identity for the next entry. See the file header.
      setEntryId(uuidV7(systemClock.nowMillis()));
      await queryClient.invalidateQueries({ queryKey: ['mind', 'journal'] });
    },
  });

  const words = wordCount(content);

  /*
   * One line, four states, in the order the operator needs to hear them.
   *
   * A failed save comes first and says where the words are, because the failure
   * mode being defended against is somebody assuming the text is gone and
   * closing the tab. §5.12's "failure never loses user input" is only true if
   * the person believes it at the moment it matters, and the outbox write and
   * the on-device draft are both still intact here — so the sentence says so.
   *
   * Then the confirmation, then the two ways autosave can be *unavailable*, then
   * the ordinary case. Saying autosave is off when it is off is not a
   * degradation to hide (§10.6): the alternative is somebody relying on a
   * promise that is not in force on this device.
   */
  const status: { readonly message: string; readonly tone: 'tertiary' | 'secondary' } =
    write.error !== null
      ? {
          message: 'That did not save. Your words are still here and still on this device — try again.',
          tone: 'secondary',
        }
      : savedNotice
        ? { message: 'Saved to the record.', tone: 'secondary' }
        : draft.problem === 'unavailable'
          ? {
              message: 'Autosave is unavailable on this device — save before you navigate.',
              tone: 'secondary',
            }
          : draft.problem === 'too-large'
            ? {
                message: 'This entry is too long to autosave — save it before you navigate.',
                tone: 'secondary',
              }
            : draft.savedAt !== null
              ? { message: 'Kept on this device as you write. Never sent to any model.', tone: 'tertiary' }
              : { message: 'Stays on this device until it syncs. Never sent to any model.', tone: 'tertiary' };

  const restore = (recovered: Draft): void => {
    setSavedNotice(false);
    setTitle(draftText(recovered.fields, 'title'));
    setContent(draftText(recovered.fields, 'content'));
    /*
     * Adopt the id the draft was written under, so the entry it becomes is the
     * one the draft always was — that is what makes restore-then-save unable to
     * produce a second entry from one draft.
     *
     * Checked rather than trusted. The target comes back off a `localStorage`
     * key, which anything on the origin could have written; a malformed id would
     * be rejected by the contract and walk the outbox entry to `blocked`, so a
     * mangled key costs a fresh identity rather than the writing. The abandoned
     * key expires on its own.
     */
    setEntryId(
      isUuid(recovered.scope.target) ? recovered.scope.target : uuidV7(systemClock.nowMillis()),
    );
    draft.accept(recovered);
  };

  return (
    <Stack gap="5">
      {/*
        Recovery is an offer, never a restoration.

        Populating the textarea on open would be the easy version and it is
        wrong twice: the operator may have deliberately abandoned this, and they
        may have written the entry on another device since. Silently putting text
        someone chose to leave behind back under their cursor is its own kind of
        data loss — and worse, it is indistinguishable from the entry having been
        saved, which is the state §8.10's phantom draft must never create.

        So: what it is, when it was written, and two explicit answers.
      */}
      {draft.offered.map((offer) => {
        const heading = draftText(offer.draft.fields, 'title').trim();
        const draftWords = wordCount(draftText(offer.draft.fields, 'content'));

        return (
          <Card key={offer.draft.scope.target} variant="outlined">
            <CardBody>
              <Stack gap="3">
                <Stack gap="1">
                  <Text role="body-sm">
                    {heading === '' ? 'An untitled entry' : `“${heading}”`} was being written{' '}
                    {offer.ageLabel} and never saved.
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {draftWords} {draftWords === 1 ? 'word' : 'words'}, kept on this device only.
                    Writing below replaces it.
                  </Text>
                </Stack>
                <Inline gap="2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      restore(offer.draft);
                    }}
                  >
                    Restore it
                  </Button>
                  {/*
                    Ghost rather than destructive. §8.2 keeps alarm colour off
                    the Mind surfaces, and a red button beside somebody's
                    unfinished reflection reads as a judgement on it.
                  */}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      draft.discard(offer.draft);
                    }}
                  >
                    Discard it
                  </Button>
                </Inline>
              </Stack>
            </CardBody>
          </Card>
        );
      })}

      <Card variant="raised">
        <CardBody>
          <Stack gap="3">
            {/*
              The prompt, labelled as a prompt.

              An unlabelled sentence sitting above a textarea is ambiguous in the
              worst possible way: it reads as instruction, or as something the
              system has decided about the evening. Naming it, and saying it is
              optional in the same breath, is what keeps it an offer — §4.7's
              journal is meant to be written in, and a question you are allowed
              to ignore is easier to ignore than an unattributed one.

              Set in the serif with the textarea below it (§8.3), so the card
              reads as one writing surface rather than a notice above a form.
            */}
            <Stack gap="1">
              {prompt !== null && (
                <>
                  <Text role="caption" tone="tertiary">
                    Tonight&rsquo;s prompt, if you want one
                  </Text>
                  <Text role="body" serif tone="secondary">
                    {prompt.prompt}
                  </Text>
                </>
              )}
              {/*
                The library was previously reachable only from the sidebar, which
                is the wrong place for it: the moment somebody wants a different
                question is the moment they are already looking at the blank box.

                A ghost button rather than a caption link, so it clears §8.13's
                44px minimum. `asChild` keeps the anchor, so it is still a link
                that can be opened in a new tab.
              */}
              <div>
                <Button variant="ghost" asChild>
                  <Link href="/mind/journal/prompts">All prompts</Link>
                </Button>
              </div>
            </Stack>

            <TextField
              label="Title (optional)"
              value={title}
              onChange={(event) => {
                setSavedNotice(false);
                setTitle(event.target.value);
              }}
            />

            <TextAreaField
              label="Entry"
              value={content}
              onChange={(event) => {
                setSavedNotice(false);
                setContent(event.target.value);
              }}
              rows={10}
              /* §8.3's long-form serif. This is the one field in the system
                 that is read as prose rather than scanned as data. */
              serif
              {...(words === 0
                ? {}
                : { hint: `${String(words)} ${words === 1 ? 'word' : 'words'}` })}
            />

            <Inline justify="between" align="center">
              {/*
                The autosave state, said plainly.

                §P1: a guarantee the operator cannot see is a guarantee they
                cannot rely on. And when autosave is *not* working — private
                browsing, blocked storage, an entry past the size cap — saying so
                is the only honest option, because the alternative is somebody
                trusting a promise that is not in force.
              */}
              <Text
                role="caption"
                tone={status.tone}
                /*
                  Polite, not assertive. The string changes at most a handful of
                  times per entry — autosave engaging, a save landing, a save
                  failing — so this announces the state changes that matter
                  without narrating the typing. §8.13's live regions, on the one
                  screen where "did that save?" must never be a question.
                */
                aria-live="polite"
              >
                {status.message}
              </Text>
              <Button
                variant="primary"
                onClick={() => {
                  write.mutate();
                }}
                disabled={content.trim() === '' || write.isPending}
              >
                Save
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {index.isLoading ? (
        <LoadingState label="Loading entries" />
      ) : (index.data?.entries.length ?? 0) === 0 ? (
        <EmptyState
          icon="domain.journal"
          title="No entries yet"
          description="Entries appear here as headings and word counts. Opening one is a deliberate act."
        />
      ) : (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Entries
          </Text>
          {(index.data?.entries ?? []).map((entry) => (
            <Card key={entry.id} variant="outlined">
              <CardBody>
                <Link className="nos-card__link" href={`/mind/journal/${entry.id}`}>
                  <Inline justify="between" align="center">
                    <Text role="body-sm" as="span">
                      {entry.heading}
                    </Text>
                    <Text role="caption" tone="tertiary" as="span">
                      {entry.dayKey}
                    </Text>
                  </Inline>
                </Link>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
