'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import type { CrisisPlan } from '@naitikos/core';
import { systemClock } from '@naitikos/core';
import {
  Button,
  Card,
  CardBody,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { saveCrisisPlan, type CrisisContactDraft } from '../services/registerClient';

/**
 * Writing the crisis plan — §4.7's "entered by them when well".
 *
 * ## Why it lives in settings and not in Mind
 *
 * §3.2 puts "clinical context" on `/settings/profile`, and the placement is
 * doing real work. §4.7 requires the plan to be written *when well*; a form
 * sitting on `/mind` would be met on the days Mind is opened, which are
 * disproportionately the days it should not be met.
 *
 * `/mind` instead surfaces an invitation when `invitePlanning` is true — which
 * `core` computes as "no plan on file **and** no current run of severe days".
 * The invitation and the form are deliberately in different places, so the path
 * to writing one always starts on a settled day.
 *
 * ## No prompts, no templates, no examples in the fields
 *
 * The placeholders describe the *kind* of thing that goes in each box and give
 * no content. A pre-filled "call a friend" would be the system suggesting a
 * coping strategy, which is precisely the model-generated message §4.7 forbids —
 * and it would be worse for being written by a stranger months in advance.
 */
export function CrisisPlanScreen({ initial }: { readonly initial: CrisisPlan | null }): ReactNode {
  const [planId] = useState(() => initial?.id ?? uuidV7(systemClock.nowMillis()));
  const [warningSigns, setWarningSigns] = useState(initial?.warningSigns ?? '');
  const [copingStrategies, setCopingStrategies] = useState(initial?.copingStrategies ?? '');
  const [reasonsToLive, setReasonsToLive] = useState(initial?.reasonsToLive ?? '');
  const [contacts, setContacts] = useState<readonly CrisisContactDraft[]>(
    initial?.contacts.map((contact) => ({
      name: contact.name,
      relationship: contact.relationship,
      phone: contact.phone,
    })) ?? [{ name: '', relationship: null, phone: null }],
  );
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      await saveCrisisPlan({
        id: planId,
        warningSigns: blank(warningSigns),
        copingStrategies: blank(copingStrategies),
        reasonsToLive: blank(reasonsToLive),
        contacts: contacts.filter((contact) => contact.name.trim() !== ''),
      });
    },
    onSuccess: () => {
      setSaved(true);
    },
  });

  const usable =
    blank(warningSigns) !== null ||
    blank(copingStrategies) !== null ||
    blank(reasonsToLive) !== null ||
    contacts.some((contact) => contact.name.trim() !== '');

  return (
    <Stack gap="4">
      <Card variant="flat">
        <CardBody>
          <Text role="body-sm" tone="secondary">
            This is shown back to you, unchanged, if a run of hard days is recorded. Nothing here is
            ever sent to a model, and nothing is ever added to it by the system.
          </Text>
        </CardBody>
      </Card>

      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            <TextAreaField
              label="Warning signs"
              value={warningSigns}
              onChange={(event) => {
                setWarningSigns(event.target.value);
              }}
              rows={4}
              hint="What it looks like when things are going wrong, in your words."
            />

            <TextAreaField
              label="What has helped"
              value={copingStrategies}
              onChange={(event) => {
                setCopingStrategies(event.target.value);
              }}
              rows={4}
              hint="Things that have actually worked before."
            />

            <TextAreaField
              label="Reasons"
              value={reasonsToLive}
              onChange={(event) => {
                setReasonsToLive(event.target.value);
              }}
              rows={4}
            />

            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                People to contact
              </Text>
              {contacts.map((contact, index) => (
                <Inline gap="2" key={`contact-${String(index)}`}>
                  <TextField
                    label="Name"
                    value={contact.name}
                    onChange={(event) => {
                      const value = event.target.value;
                      setContacts((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, name: value } : item,
                        ),
                      );
                    }}
                  />
                  <TextField
                    label="Phone"
                    value={contact.phone ?? ''}
                    inputMode="tel"
                    onChange={(event) => {
                      const value = event.target.value;
                      setContacts((current) =>
                        current.map((item, position) =>
                          position === index ? { ...item, phone: value === '' ? null : value } : item,
                        ),
                      );
                    }}
                  />
                </Inline>
              ))}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setContacts((current) => [...current, { name: '', relationship: null, phone: null }]);
                }}
              >
                Add someone
              </Button>
            </Stack>

            <Inline justify="between" align="center">
              {/*
                An assertive live region, and one of very few in the system. A
                silent save on this form is the one place where "did that work?"
                is a question worth avoiding entirely.
              */}
              <Text role="caption" tone="tertiary" aria-live="polite">
                {saved ? 'Saved.' : ''}
              </Text>
              <Button
                variant="primary"
                disabled={!usable || save.isPending}
                onClick={() => {
                  setSaved(false);
                  save.mutate();
                }}
              >
                Save
              </Button>
            </Inline>

            {save.error !== null && (
              <Text role="body-sm" tone="secondary">
                {save.error instanceof Error ? save.error.message : 'Could not save.'}
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

function blank(value: string): string | null {
  return value.trim() === '' ? null : value.trim();
}
