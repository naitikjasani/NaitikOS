import type { ReactNode } from 'react';
import { formatDay } from '@naitikos/core';
import { Card, CardBody, Divider, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type {
  OutstandingActionItem,
  TherapyBoard,
  TherapySessionSummary,
} from '@/lib/platform/therapy';

/**
 * `/mind/therapy` — sessions and between-session commitments (§3.2, §4.7).
 *
 * **A Server Component, and read-only.** There is no state on this page, no
 * form, and no `'use client'`. The reasoning for the absent write path is in
 * `lib/platform/therapy.ts`; the short version is that a therapy note is
 * written once and slowly, and a textarea at the bottom of a list is the wrong
 * instrument for the most careful writing the operator does.
 *
 * ## Thinking about what does *not* go here is most of the work
 *
 * §4.7 gives this module "the highest duty of care in the system", and the
 * failure modes for a therapy page are specific and easy to walk into:
 *
 * - **An attendance streak, or "sessions this month".** The single worst thing
 *   that could be on this page. It turns going to therapy into a number that
 *   can go down, on a screen opened by someone whose reason for not going last
 *   week may be the reason they are in therapy. §4.7: "No negative framing,
 *   ever." There is no count anywhere on this screen, deliberately — not even a
 *   neutral one, because "12 sessions" invites the arithmetic that produces the
 *   streak.
 * - **Sentiment, themes, or any summary of a note.** §4.7: content here is
 *   "user-authored only; nothing here is ever model-generated". This screen
 *   could not do it if it wanted to — the prose is not in its props.
 * - **A "you seem to be doing better since starting therapy" line.** A causal
 *   claim about mental state, which §4.7 rules out in as many words.
 * - **An excerpt in the list.** The journal's argument transfers exactly
 *   (`docs/mind.md` §2.1): a list that renders the first hundred and twenty
 *   characters puts the hardest thing in the record on screen on a train. The
 *   enforcement is in the repository, not here.
 *
 * ## The one piece of content that is shown, and why
 *
 * Action items. They are content in the same sense the notes are, and they are
 * on the page anyway, because a commitment you have to open a note to find is
 * not functioning as a commitment — §4.7 names "between-session action items"
 * as a feature precisely because that week between two Tuesdays is where they
 * do their work. They are short, forward-looking and practical rather than
 * reflective, which is the distinction being drawn.
 *
 * They are listed, not scored. No completion rate, no tally, no tick-boxes to
 * fill: outstanding items appear, completed ones simply stop appearing.
 *
 * ## Two stated gaps
 *
 * Notes cannot be read from this surface, and sessions cannot be recorded from
 * it. Both are said on the page. §3.3 R6's objection to empty rooms is about
 * screens that pretend to be finished; a screen that says plainly which half of
 * itself exists is the honest way to ship the half that does.
 */

export function TherapyScreen({ board }: { readonly board: TherapyBoard }): ReactNode {
  if (board.isEmpty) {
    return (
      <Stack gap="4">
        <EmptyState
          icon="domain.clinical"
          title="No sessions recorded"
          description="Sessions, what was agreed between them, and when the next one is. Nothing here is ever written by a model."
        />
        <NotYetWritable />
      </Stack>
    );
  }

  return (
    <Stack gap="5">
      {board.nextFollowUpAt !== null && (
        <Card variant="raised">
          <CardBody>
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Next session
              </Text>
              {/* A date, not a countdown. "In 3 days" is a nudge; a date is a fact. */}
              <Text role="title-3" as="p">
                {formatDay(board.nextFollowUpAt) ?? board.nextFollowUpAt.slice(0, 10)}
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Between sessions
            </Text>

            {board.outstanding.length === 0 ? (
              <Text role="body-sm" tone="secondary">
                Nothing outstanding. Items appear here until they are marked done in the session
                they belong to.
              </Text>
            ) : (
              <Stack gap="3">
                {/* Two identical commitments in one session is unlikely and
                    not impossible, so the position joins the key rather than
                    trusting the text to be unique. */}
                {board.outstanding.map((item, index) => (
                  <ActionItemRow key={`${item.sessionId}-${String(index)}`} item={item} />
                ))}
              </Stack>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Sessions
        </Text>
        {board.sessions.map((session) => (
          <SessionCard key={session.id} session={session} />
        ))}
      </Stack>

      <Divider />
      <NotYetWritable />
    </Stack>
  );
}

/**
 * One commitment.
 *
 * A due date that has passed is rendered exactly like one that has not — same
 * tone, same position, no icon, no `critical` colour. §8.2 reserves
 * `--color-critical` for destructive actions and says of health data "Never a
 * health metric. Ever."; a red date beside "ring the GP" would be the clearest
 * possible violation of that in the module that can least afford it.
 */
function ActionItemRow({ item }: { readonly item: OutstandingActionItem }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="body-sm">{item.text}</Text>
      <Text role="caption" tone="tertiary">
        {item.dueAt === null
          ? `Agreed ${formatDay(item.sessionDayKey) ?? item.sessionDayKey}`
          : `Due ${formatDay(item.dueAt) ?? item.dueAt.slice(0, 10)} · agreed ${
              formatDay(item.sessionDayKey) ?? item.sessionDayKey
            }`}
      </Text>
    </Stack>
  );
}

/**
 * One session, as scaffolding.
 *
 * The heading is the date because the date is the one thing every session has.
 * The therapist and the modality follow it when they were recorded, and are
 * silently absent when they were not — a "Therapist: —" row is a reproach for
 * not having filled in a field.
 */
function SessionCard({ session }: { readonly session: TherapySessionSummary }): ReactNode {
  const attribution = [session.therapist, session.modality].filter(
    (part): part is string => part !== null && part.trim() !== '',
  );

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="1">
          <Inline justify="between" align="center" gap="3" wrap>
            <Text role="body" as="h3">
              {formatDay(session.dayKey) ?? session.dayKey}
            </Text>
            {attribution.length > 0 && (
              <Text role="caption" tone="secondary" as="span">
                {attribution.join(' · ')}
              </Text>
            )}
          </Inline>

          {/*
            Whether there are notes, never what they say, and never how many
            words they run to. See `TherapySessionSummary` in the repository for
            why the word count the journal carries is wrong here.
          */}
          <Text role="caption" tone="tertiary">
            {session.hasNotes ? 'Notes recorded' : 'No notes recorded'}
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

/** The two gaps, stated rather than left to be discovered. */
function NotYetWritable(): ReactNode {
  return (
    <Text role="caption" tone="tertiary">
      Read-only. Sessions are inserted directly for now, and the notes themselves are not readable
      from this page — rendering therapy prose needs the same no-store treatment a journal entry
      gets, and half of that is worse than none.
    </Text>
  );
}
