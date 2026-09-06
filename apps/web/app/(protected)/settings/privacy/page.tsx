/**
 * `/settings/privacy` — where the boundaries actually are.
 *
 * ## It has no controls, and that is the finding rather than a gap
 *
 * The obvious shape for this page is a set of switches: encrypt this, redact
 * that, share nothing. Every one of them would be a lie of a particular kind.
 *
 * The encryption boundary is a property of the storage tier a media object was
 * written into (§9.8), decided at capture and not afterwards — a switch here
 * could not re-encrypt what is already stored, and one that pretended to would
 * be the worst control in the system. The egress boundary is `/settings/ai`,
 * where the consent scopes and the kill switch already live, and a second set
 * of switches over the same decision is exactly the drift §9.3(4) forbids.
 *
 * So this page states the posture and points at the two places that change it.
 * §8.9's honesty rule applied to a settings surface: a control that does not
 * control anything is worse than a sentence saying who does.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { PageContainer } from '@/components/shell';
import { requireServerPermission } from '@/lib/auth/session';

export const metadata = { title: 'Privacy · NaitikOS' };

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
      description="Where the encryption boundary sits, what each tier holds, and what leaves this machine."
    >
      <Stack gap="5">
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Nothing on this page is a switch
              </Text>
              <Text role="body-sm" tone="secondary">
                Encryption is decided when a photograph is captured, by which tier it is written into. A control
                here could not re-encrypt what is already stored, and one that appeared to would be the most
                dangerous control in the application.
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
      </Stack>
    </PageContainer>
  );
}
