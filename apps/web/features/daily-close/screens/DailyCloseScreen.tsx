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
 * Four consequences visible in this file:
 *
 * 1. **The fields are generated, not written.** `snapshot.fields` comes from the
 *    registry, so the budget is arithmetic over data rather than a comment
 *    somebody has to remember.
 * 2. **They are then cut into steps that fit.** See `services/steps.ts`. The
 *    form as generated is roughly nine hundred pixels of controls and a phone
 *    has about five hundred and forty; the screen that must not scroll is
 *    therefore *a* screen, and the Close is given three of them. Every other
 *    §4.0 constraint survives that reading intact.
 * 3. **There is no cancel, no reset, no confirm step.** Each is one more
 *    interactive element against a budget of eleven, and none of them is worth a
 *    field. Leaving is closing the tab; the answers are already durable.
 * 4. **Submitting cannot fail.** It queues to the outbox (§5.7) and returns.
 *    The banner reports sync state; the ritual does not wait on a network.
 *
 * ## Why Next never checks whether anything was answered
 *
 * §4.0: "Every field is optional. A partial close counts as a close. This is
 * deliberate: a system that rejects incomplete data trains you to skip it
 * entirely on a bad day, and bad days are the most clinically interesting days
 * you have." A stepped flow makes gating tempting — the button is right there
 * and the state is trivially available — and it is the one thing that would
 * turn this design against the constraint it exists to satisfy. Next always
 * advances. Three taps of Next and a submit is a legitimate, recorded Close.
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

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Progress,
  Stack,
  Text,
} from '@naitikos/design-system';

import { CloseFieldControl } from '../components/CloseFieldControl';
import { useDailyClose } from '../hooks/useDailyClose';
import { answeredCount, buildCloseSteps } from '../services/steps';

export type DailyCloseScreenProps = {
  readonly dayKey: string;
  readonly zone: string;
  /** Rendered when the day is not today — a back-fill reads differently. */
  readonly isToday: boolean;
};

export function DailyCloseScreen({ dayKey, zone, isToday }: DailyCloseScreenProps): ReactNode {
  const close = useDailyClose(dayKey, zone);
  const [stepIndex, setStepIndex] = useState(0);

  /*
   * Reset the position when the day changes.
   *
   * `?day=…` is a search parameter on a Server Component, so moving to another
   * day re-renders this component rather than remounting it — the same reason
   * `useDailyClose` clears its edit map during render. Landing on step three of
   * yesterday's Close because that is where the operator left today's is a small
   * disorientation, and this screen is opened half-awake.
   */
  const [renderedDay, setRenderedDay] = useState(dayKey);
  if (renderedDay !== dayKey) {
    setRenderedDay(dayKey);
    setStepIndex(0);
  }

  const steps = useMemo(() => buildCloseSteps(close.snapshot?.fields ?? []), [close.snapshot]);

  /*
   * Focus the step heading when the step changes, and never on arrival.
   *
   * §8.13 requires "a keyboard-navigation E2E path through the Daily Close —
   * the one flow that must never regress". Without this, tapping Next leaves
   * focus on a button that has just been re-labelled and a screen reader
   * announces nothing at all: the operator has no idea the questions changed.
   * The mount guard is what stops it stealing focus from the page heading on
   * the first render, which would skip the `h1` for everyone.
   */
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!settled.current) {
      settled.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [stepIndex]);

  if (close.isLoading) {
    return <LoadingState rows={5} label="Loading the Daily Close" />;
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

  if (steps.length === 0) {
    // Only reachable with an empty metric registry, which means the seed has
    // not run. Saying so beats an empty card.
    return (
      <EmptyState
        title="No Close fields are registered"
        description="The metric registry is empty. Run the database seed."
      />
    );
  }

  /*
   * The completion state, and why it replaces the form rather than sitting under
   * it.
   *
   * This is the one moment the ritual pays the operator back, and the previous
   * version of it was a line of grey text below a form that still looked
   * unfinished. The screen changing completely is the feedback: the questions
   * are gone, there is nothing left to do, and the phone can be put down.
   *
   * What it deliberately does not do is score the day. §1.5 bans streaks
   * outright — "a missed day costs one day", never everything before it — and
   * P6 bans the badge-and-confetti register that would make a missed day feel
   * like a loss. There is no count here, no comparison to yesterday, and no
   * celebration. Nothing animates either (§8.6): the state change *is* the
   * motion, and a thing that flourishes on screen at 1am is a thing the
   * operator learns to close before it finishes.
   */
  if (close.queuedAt !== null) {
    const recorded = steps.reduce((total, step) => total + answeredCount(step, close.answers), 0);

    return (
      <Stack gap="5">
        <Card>
          <CardBody>
            <Stack gap="3">
              {/* `status`, not `alert`: this is the expected outcome of an
                  action the operator just took, and `alert` interrupts. */}
              <div role="status">
                <Stack gap="2">
                  <Text role="title-2" as="h2">
                    {isToday ? 'The day is closed.' : `${dayKey} is closed.`}
                  </Text>
                  <Text role="body" tone="secondary">
                    {recorded === 0
                      ? 'Recorded with nothing filled in, which still counts. Nothing else is needed tonight.'
                      : `${String(recorded)} ${recorded === 1 ? 'answer' : 'answers'} recorded. Nothing else is needed tonight.`}
                  </Text>
                </Stack>
              </div>

              {/* §5.7's guarantee, stated once and plainly. The write is durable
                  on this device already; the network is the system's problem
                  from here and not the operator's. */}
              <Text role="caption" tone="tertiary" as="p">
                Saved on this device. It syncs on its own — you can close this.
              </Text>
            </Stack>
          </CardBody>
        </Card>

        <Stack gap="2">
          <Button asChild variant="primary" fullWidth>
            <Link href="/today">Back to Today</Link>
          </Button>
          {/*
            The way back in, because an answer given at 1am is sometimes wrong at
            1:01. §9.4: the original is kept either way, so changing one costs
            nothing and hiding the door behind a navigation would cost a
            correction that never gets made.
          */}
          <Button
            variant="ghost"
            fullWidth
            onClick={() => {
              close.resumeEditing();
              setStepIndex(0);
            }}
          >
            Change an answer
          </Button>
        </Stack>
      </Stack>
    );
  }

  const step = steps[stepIndex] ?? steps[0];
  if (step === undefined) return null;

  const isLastStep = stepIndex >= steps.length - 1;
  const position = `Step ${String(stepIndex + 1)} of ${String(steps.length)}`;

  const advance = (): void => {
    setStepIndex((current) => Math.min(current + 1, steps.length - 1));
  };

  return (
    <Stack gap="4">
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
            <Text role="body-sm">
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

            Enter advances rather than submits while there are steps left. A
            keyboard operator pressing Enter on step one means "next", and a form
            that read it as "record the day and stop asking" would end the ritual
            two thirds of the way through it.
          */}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (isLastStep) close.submit();
              else advance();
            }}
          >
            <Stack gap="5">
              <Stack gap="1">
                <Text role="title-3" as="h2">
                  {/* `tabIndex={-1}` makes it programmatically focusable without
                      adding a tab stop — §4.0 counts elements, and a heading
                      that the Tab key stops on is a tap target that does
                      nothing. */}
                  <span ref={headingRef} tabIndex={-1}>
                    {step.title}
                  </span>
                </Text>
                {/*
                  Position, not achievement. A bar showing how far through a
                  three-step form you are is functional (§8.6); a bar showing how
                  many days in a row you have done it would be a streak, which
                  §1.5 rules out of this product entirely.
                */}
                <Progress
                  value={((stepIndex + 1) / steps.length) * 100}
                  label={position}
                  size="sm"
                />
              </Stack>

              {step.fields.map((field) => (
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
            </Stack>
          </form>
        </CardBody>
      </Card>

      {/*
        The action row sits below the card and is the last thing on the screen,
        which on a phone is where the thumb already is (§8.12's reasoning for
        bottom sheets applies to the primary action of a full-page flow too).
        `wrap={false}` so Back and Next stay on one line at 360px; both are
        full-height buttons, so the 44px target and the 8px separation §8.13
        requires are the gap token, not a guess.
      */}
      <Inline gap="2" wrap={false}>
        {stepIndex > 0 && (
          <Button
            variant="ghost"
            iconStart="nav.back"
            onClick={() => {
              setStepIndex((current) => Math.max(current - 1, 0));
            }}
          >
            Back
          </Button>
        )}
        <div style={{ flex: 1 }}>
          {isLastStep ? (
            <Button
              variant="primary"
              fullWidth
              isLoading={close.isSubmitting}
              onClick={() => {
                close.submit();
              }}
            >
              {snapshot.isClosed ? 'Update the Close' : 'Close the day'}
            </Button>
          ) : (
            <Button variant="primary" fullWidth iconEnd="nav.next" onClick={advance}>
              Next
            </Button>
          )}
        </div>
      </Inline>

      {/*
        §4.0's most important sentence, said out loud on the screen it governs:
        "Every field is optional. A partial close counts as a close." An operator
        who does not know that will skip the whole thing on the day they have
        least to say — which is the day the record most wants. It is on every
        step rather than only the last, because the day it matters is the day the
        operator gives up on step one.
      */}
      <Text role="caption" tone="tertiary" as="p">
        Every field is optional — skip anything. A partial close still counts.
      </Text>

      {/*
        Only when it is *not* working. §P1: an honest system says when a
        guarantee is not in force, and stays quiet when it is — a "your answers
        are being saved" line on every ordinary evening would be one more thing
        to read inside a sixty-second ritual.
      */}
      {close.draftProblem !== null && (
        <Text role="caption" tone="secondary" as="p">
          Answers are not being kept on this device while you enter them — storage is unavailable
          here, so finish and submit before you navigate away.
        </Text>
      )}
    </Stack>
  );
}
