'use client';

/**
 * The Daily Close.
 *
 * §12 calls this "the week's actual deliverable and everything else is
 * supporting". §4.0 constrains it harder than any other screen in the system:
 *
 *   "Single screen, no scrolling on a phone. If it does not fit, something must
 *    be cut... Never more than eleven interactive elements. Adding a field
 *    requires removing a field."
 *
 * Three consequences visible in this file:
 *
 * 1. **The fields are generated, not written.** `snapshot.fields` comes from the
 *    registry, so the budget is arithmetic over data rather than a comment
 *    somebody has to remember.
 * 2. **There is no cancel, no reset, no confirm step.** Each is one more
 *    interactive element against a budget of eleven, and none of them is worth a
 *    field. Leaving is closing the tab; the answers are already durable.
 * 3. **Submitting cannot fail.** It queues to the outbox (§5.7) and returns.
 *    The banner reports sync state; the ritual does not wait on a network.
 *
 * ## The recovery offer and the element budget
 *
 * The draft card below adds two buttons, which §4.0 counts. It is a real cost
 * against a budget of eleven and it is worth paying, on two grounds. It appears
 * only after a failure — a crash, a kill, a navigation away mid-ritual — so on
 * every ordinary evening the budget is untouched. And what it recovers is the
 * answers the budget exists to make cheap to enter; a Close that silently threw
 * away eight of them would make the eleven-element discipline pointless.
 *
 * `snapshot.budget.count` is computed server-side from the registry and does not
 * know about these two, so the overflow warning above will under-report by two
 * while the card is on screen. That is stated here rather than papered over: the
 * budget is a rule about how many fields the *ritual* has, and a transient
 * recovery prompt is not a field.
 */

import type { ReactNode } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Stack,
  Text,
} from '@naitikos/design-system';

import { CloseFieldControl } from '../components/CloseFieldControl';
import { useDailyClose } from '../hooks/useDailyClose';

export type DailyCloseScreenProps = {
  readonly dayKey: string;
  readonly zone: string;
  /** Rendered when the day is not today — a back-fill reads differently. */
  readonly isToday: boolean;
};

export function DailyCloseScreen({ dayKey, zone, isToday }: DailyCloseScreenProps): ReactNode {
  const close = useDailyClose(dayKey, zone);

  if (close.isLoading) {
    return <LoadingState rows={7} label="Loading the Daily Close" />;
  }

  if (close.error !== null || close.snapshot === undefined) {
    return (
      <ErrorState
        title="The Close could not be loaded"
        description="The record is fine — this screen could not reach it. Try again in a moment."
      />
    );
  }

  const { snapshot } = close;
  const fields = snapshot.fields;

  if (fields.length === 0) {
    // Only reachable with an empty metric registry, which means the seed has
    // not run. Saying so beats an empty card.
    return (
      <EmptyState
        title="No Close fields are registered"
        description="The metric registry is empty. Run the database seed."
      />
    );
  }

  return (
    <Stack gap="5">
      {/*
        The status line. §P1's honesty applied to the one thing the operator
        wants to know before answering anything: has today already been closed?
        Without it, a re-close looks like a first close and the answers already
        recorded look like they were lost.
      */}
      <Inline gap="2">
        {snapshot.isClosed ? (
          <Badge tone="positive">Closed</Badge>
        ) : (
          <Badge tone="neutral">Not yet closed</Badge>
        )}
        {!isToday && <Badge tone="caution">Back-filling {dayKey}</Badge>}
      </Inline>

      {/*
        §4.0's budget, surfaced rather than silently enforced. "If it does not
        fit, something must be cut" is an instruction to a person, so the person
        has to be told when it stops fitting.
      */}
      {!snapshot.budget.withinBudget && (
        <Card variant="outlined">
          <CardBody>
            <Text role="body-sm" tone="critical">
              The Close has {snapshot.budget.count} elements against a budget of{' '}
              {snapshot.budget.limit}. {snapshot.overflow.length} field
              {snapshot.overflow.length === 1 ? ' is' : 's are'} not shown. §4.0: adding a field
              requires removing a field.
            </Text>
          </CardBody>
        </Card>
      )}

      {/*
        §8.10's recovery, offered rather than applied.

        The values are not shown. A Close answer is a fact about the operator's
        evening — a mood of 2, a "no" on medication — and putting a list of them
        in a recovery prompt would render the day's state before the operator has
        decided whether they want it back. The count and the age identify the
        draft; restoring it is what reads it.
      */}
      {close.recoverable.map((offer) => {
        const count = Object.keys(offer.draft.fields).length;

        return (
          <Card key={offer.draft.scope.target} variant="outlined">
            <CardBody>
              <Stack gap="3">
                <Stack gap="1">
                  <Text role="body-sm">
                    {count} {count === 1 ? 'answer' : 'answers'} for {dayKey} were entered{' '}
                    {offer.ageLabel} and never submitted.
                  </Text>
                  <Text role="caption" tone="tertiary">
                    Kept on this device only. Answering below replaces them.
                  </Text>
                </Stack>
                <Inline gap="2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      close.restoreDraft(offer.draft);
                    }}
                  >
                    Restore them
                  </Button>
                  {/* Ghost, not destructive. §4.7's no-alarm-colour rule reaches
                      Today as well: a red button is not the right frame for
                      "I would rather answer this again." */}
                  <Button
                    variant="ghost"
                    onClick={() => {
                      close.discardDraft(offer.draft);
                    }}
                  >
                    Discard them
                  </Button>
                </Inline>
              </Stack>
            </CardBody>
          </Card>
        );
      })}

      <Card>
        <CardBody>
          {/*
            A `<form>` so Enter submits and a password manager does not try to
            fill it. `noValidate` because every constraint the browser would
            enforce is enforced by the registry — and the browser's version
            would show a message in a different voice.
          */}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              close.submit();
            }}
          >
            <Stack gap="5">
              {fields.map((field) => (
                <CloseFieldControl
                  key={field.id}
                  field={field}
                  value={close.answers[field.id]}
                  onChange={(value) => {
                    close.setAnswer(field.id, value);
                  }}
                  disabled={close.isSubmitting}
                />
              ))}

              <Button type="submit" variant="primary" fullWidth isLoading={close.isSubmitting}>
                {snapshot.isClosed ? 'Update the Close' : 'Close the day'}
              </Button>

              {/*
                §4.0's most important sentence, said out loud on the screen it
                governs: "Every field is optional. A partial close counts as a
                close." An operator who does not know that will skip the whole
                thing on the day they have least to say — which is the day the
                record most wants.
              */}
              <Text role="caption" tone="tertiary" as="p">
                Every field is optional. A partial close still counts.
              </Text>

              {/*
                Only when it is *not* working. §P1: an honest system says when a
                guarantee is not in force, and stays quiet when it is — a "your
                answers are being saved" line on every ordinary evening would be
                one more thing to read inside a sixty-second ritual.
              */}
              {close.draftProblem !== null && (
                <Text role="caption" tone="secondary" as="p">
                  Answers are not being kept on this device while you enter them — storage is
                  unavailable here, so submit before you navigate away.
                </Text>
              )}

              {close.queuedAt !== null && (
                <div role="status">
                  <Text role="body-sm" tone="secondary">
                    Recorded. It syncs on its own — you can close this.
                  </Text>
                </div>
              )}
            </Stack>
          </form>
        </CardBody>
      </Card>
    </Stack>
  );
}
