/**
 * `/settings/privacy` — where the boundaries actually are.
 *
 * ## It had no controls, and that was the finding rather than a gap
 *
 * The obvious shape for this page is a set of switches: encrypt this, redact
 * that, share nothing. Almost every one of them would be a lie of a particular
 * kind.
 *
 * The encryption boundary is a property of the storage tier a media object was
 * written into (§9.8), decided at capture and not afterwards — a switch here
 * could not re-encrypt what is already stored, and one that pretended to would
 * be the worst control in the system. The egress boundary is `/settings/ai`,
 * where the consent scopes and the kill switch already live, and a second set
 * of switches over the same decision is exactly the drift §9.3(4) forbids.
 *
 * So this page states the posture and points at the places that change it.
 * §8.9's honesty rule applied to a settings surface: a control that does not
 * control anything is worse than a sentence saying who does.
 *
 * ## One exception, and why it is one
 *
 * There is now a single set of buttons here, and it clears **local** copies —
 * `LocalDataScreen`. It is the exception because it is the one boundary on this
 * page that a control genuinely moves: the drafts, the cached reads and the
 * unsent queue are all on this device, none of them belongs to another settings
 * page, and there was no way for the operator to remove any of them short of
 * the browser's own site-data dialog.
 *
 * §8.10's draft autosave is what made that a gap rather than a curiosity.
 * Journal prose and Daily Close answers are persisted to `localStorage` in
 * plain text while they are being written, and §4.7 makes journal content "the
 * most sensitive data in the system". A privacy page that described a boundary
 * it could not move, while the most sensitive store in the application had no
 * clearing path at all, was describing the wrong thing.
 *
 * ## Why here and not `/settings/data`
 *
 * §3.2 splits them: privacy is "encryption, media keys, redaction" — where the
 * exposure boundary sits — and data is "export, import, backup, audit log",
 * which is the record itself and its portability. Clearing local copies is
 * entirely a question about exposure on this machine and touches the record
 * nowhere, so it belongs to the first.
 *
 * The reverse placement is actively worse. `/settings/data` is the page whose
 * subject *is* the record; a button labelled "clear data" sitting under the
 * export builder and the audit log would invite exactly the reading this feature
 * must never permit — that something was deleted from the database. Deletion of
 * a record is §9.4's soft delete with its audit entry, reached from the entity
 * that owns it, and it is nowhere near either page.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { LocalDataScreen } from '@/features/settings';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Privacy · Ekayu' };

const TIERS = [
  {
    tier: 'sensitive',
    holds: 'Skin and physique photography.',
    posture:
      'Encrypted in the browser before it is uploaded. The key never leaves this device, so the server holds bytes it cannot read and neither can anybody who reaches the storage bucket.',
  },
  {
    tier: 'private',
    holds: 'Lab reports, prescriptions, scanned documents.',
    posture:
      'Server-readable on purpose. That readability is what makes structured lab results out of a scanned PDF possible at all — a document nobody can open is a document that cannot be extracted from.',
  },
  {
    tier: 'public',
    holds: 'Nothing, currently.',
    posture: 'The tier exists for anything that would be shared deliberately. No path writes to it today.',
  },
] as const;

export default async function PrivacyPage(): Promise<ReactNode> {
  const authorized = await requireServerPermission('settings:read');
  if (!authorized.ok) return null;

  return (
    <PageContainer
      title="Privacy"
      description="Where the encryption boundary sits, what each tier holds, what leaves this machine, and what this browser is still holding."
    >
      <Stack gap="5">
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Almost nothing on this page is a switch
              </Text>
              <Text role="body-sm" tone="secondary">
                Encryption is decided when a photograph is captured, by which tier it is written into. A control
                here could not re-encrypt what is already stored, and one that appeared to would be the most
                dangerous control in the application.
              </Text>
              <Text role="body-sm" tone="secondary">
                The one exception is at the foot of the page, and it is the only boundary here that a button
                genuinely moves: what this browser is still holding. Nothing in it reaches the server.
              </Text>
              <Text role="body-sm" tone="secondary">
                What <em>can</em> be changed is what the AI layer is permitted to read, and whether it runs at
                all. Both live in one place, because two places deciding one thing is how they come to disagree.
              </Text>
              <Inline gap="3">
                <Link className="nos-inline-link" href="/settings/ai">
                  <Text role="caption" as="span">
                    AI consent and the kill switch
                  </Text>
                </Link>
                <Link className="nos-inline-link" href="/settings/data">
                  <Text role="caption" as="span">
                    Export and the audit log
                  </Text>
                </Link>
              </Inline>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="3">
              <Text role="title-3" as="h2">
                Storage tiers
              </Text>
              {TIERS.map((entry) => (
                <Stack key={entry.tier} gap="0">
                  <Text role="body">{entry.tier}</Text>
                  <Text role="caption" tone="tertiary">
                    {entry.holds}
                  </Text>
                  <Text role="body-sm" tone="secondary">
                    {entry.posture}
                  </Text>
                </Stack>
              ))}
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                What leaves this machine
              </Text>
              <Text role="body-sm" tone="secondary">
                One thing, and only when the AI layer is on: a context pack of summarised figures — a mean, a
                trend, a count of missing days — never rows, never photographs, and never a document&rsquo;s
                text. Every call is written to a ledger with the consent that was in force at the time, so a
                later change cannot retroactively justify an earlier one.
              </Text>
              <Text role="body-sm" tone="secondary">
                With the layer off, nothing leaves. Every figure in the application is computed here either
                way; turning it on adds prose and nothing else.
              </Text>
            </Stack>
          </CardBody>
        </Card>

        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Row-level security
              </Text>
              <Text role="body-sm" tone="secondary">
                Enabled and forced on every table, with no policies at all. That combination denies everything
                — which is the intent: no client reaches the database directly, so the anonymous key that ships
                in a browser bundle reaches a database that returns nothing even if it leaks.
              </Text>
            </Stack>
          </CardBody>
        </Card>

        {/*
          The page's only controls, last rather than first.
          
          Everything above is a statement about a boundary this page cannot move,
          and the operator needs that context before they reach a button —
          particularly the sentence about the sensitive tier, which is why a
          photograph is *not* among the things listed below.
        */}
        <Stack gap="3">
          <Text role="title-2" as="h2">
            On this device
          </Text>
          <LocalDataScreen />
        </Stack>
      </Stack>
    </PageContainer>
  );
}
