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

          {contacts.length > 0 && (
            <>
              <Divider />
              <Stack gap="2">
                <Text role="caption" tone="tertiary">
                  People you listed
                </Text>
                {contacts.map((contact) => (
                  <Stack gap="1" key={`${contact.name}-${contact.phone ?? ''}`}>
                    {/*
                      A real `tel:` link, so it is one tap.
                      A phone number rendered as text is a number to be copied,
                      and copying a number is four interactions at the moment
                      somebody has the fewest to spare.
                    */}
                    {contact.phone === null ? (
                      <Text role="body">{contact.name}</Text>
                    ) : (
                      <a className="nos-inline-link" href={`tel:${contact.phone}`}>
                        <Text role="body" as="span">
                          {contact.name}
                          {contact.relationship === null ? '' : ` · ${contact.relationship}`}
                        </Text>
                      </a>
                    )}
                    {contact.notes === null ? null : (
                      <Text role="caption" tone="tertiary">
                        {contact.notes}
                      </Text>
                    )}
                  </Stack>
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
