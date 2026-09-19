'use client';

import { type ReactNode } from 'react';
import type { CrisisPlan } from '@naitikos/core';
import { Card, CardBody, Divider, Stack, Text } from '@naitikos/design-system';

/**
 * The crisis plan, shown back.
 *
 * §4.7: "Sustained severe readings surface one thing only: the user's own
 * pre-configured crisis plan and contacts, entered by them when well. Not an
 * insight. Not a suggestion. Not a model-generated message. A stored plan, shown
 * back."
 *
 * Every string this component renders came out of the database, and every one of
 * them was typed by the operator. There is no copy in this file except the four
 * section headings, and there is deliberately no explanation of *why* it
 * appeared — the operator does not need to be told which number crossed which
 * line about their own head.
 *
 * ## What it does not have
 *
 * No dismiss button. Not because it should be inescapable — navigating away
 * works, and the card is gone the moment the readings are — but because a
 * dismiss control turns the plan into a notification, and the next time it
 * appeared the reflex would already be to close it.
 *
 * No alarm colouring. §4.7's first principle: "No red." The card is a plain
 * raised surface, and the phone numbers are the only emphasis in it.
 *
 * ## The people come first, above the prose
 *
 * They used to sit below all three written sections, behind a divider. On a
 * phone that is up to three paragraphs of scrolling between the card appearing
 * and the first phone number — and the person reading it is, by construction,
 * the person with the least capacity to scroll past their own writing about
 * what going wrong looks like. §10.10 gives this card exactly one job, and the
 * part of it that is an *action* has to be the part that is on screen first.
 *
 * The prose is not softened, shortened, or put behind a disclosure to make room
 * for it. It is still all there, in full, immediately below. Only the order
 * changed.
 *
 * ## Each contact is a 44px row, and the number is visible
 *
 * `tel:` on a caption-sized inline link was a roughly 20px target, which fails
 * §8.13's 44×44 minimum on the one control in the application where a mistap
 * costs the most. `nos-option-row` gives the whole row the button height and
 * the focus ring without changing how it looks at rest.
 *
 * The number is printed as well as linked. A `tel:` href does nothing on a
 * desktop browser with no handler registered, and a card that had *only* the
 * link would, in that case, be a list of first names — the number has to be
 * readable so it can be dialled on something else.
 */
export function CrisisCard({ plan }: { readonly plan: CrisisPlan }): ReactNode {
  const sections: readonly { readonly heading: string; readonly body: string | null }[] = [
    { heading: 'What you wrote about the warning signs', body: plan.warningSigns },
    { heading: 'What has helped', body: plan.copingStrategies },
    { heading: 'Reasons you wrote down', body: plan.reasonsToLive },
  ];

  const contacts = [...plan.contacts, ...plan.professionalContacts];

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="4">
          <Text role="title-3" as="h2">
            Your plan
          </Text>

          {contacts.length > 0 && (
            <>
              <Stack gap="2">
                <Text role="caption" tone="tertiary">
                  People you listed
                </Text>
                {contacts.map((contact) => {
                  const who =
                    contact.relationship === null
                      ? contact.name
                      : `${contact.name} · ${contact.relationship}`;

                  return (
                    <Stack gap="1" key={`${contact.name}-${contact.phone ?? ''}`}>
                      {/*
                        A real `tel:` link, so it is one tap.
                        A phone number rendered as text alone is a number to be
                        copied, and copying a number is four interactions at the
                        moment somebody has the fewest to spare.
                      */}
                      {contact.phone === null ? (
                        <Text role="body">{who}</Text>
                      ) : (
                        <a className="nos-option-row nos-inline-link" href={`tel:${contact.phone}`}>
                          <Text role="body" as="span">
                            {who}
                          </Text>
                          <Text role="caption" tone="tertiary" as="span">
                            {' '}
                            — call {contact.phone}
                          </Text>
                        </a>
                      )}
                      {contact.notes === null ? null : (
                        <Text role="caption" tone="tertiary">
                          {contact.notes}
                        </Text>
                      )}
                    </Stack>
                  );
                })}
              </Stack>
              <Divider />
            </>
          )}

          {sections.map((section) =>
            section.body === null ? null : (
              <Stack gap="1" key={section.heading}>
                <Text role="caption" tone="tertiary">
                  {section.heading}
                </Text>
                {/* Preserving line breaks: they typed it in lines for a reason. */}
                <Text role="body" className="nos-prewrap">
                  {section.body}
                </Text>
              </Stack>
            ),
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
