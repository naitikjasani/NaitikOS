import type { ReactNode } from 'react';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_DAILY_CAP } from '@naitikos/core';
import type { NotificationCategory, NotificationPreferences } from '@naitikos/core';
import { Badge, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * `/settings/notifications` — §3.2's "Reminders — opt-in only".
 *
 * ## There is nothing to toggle here, and that is the honest version
 *
 * The domain has notification *preferences* — `NOTIFICATION_CATEGORIES` and
 * their defaults are declared in `core/auth/preferences.ts` and survive a
 * round trip through `parsePreferences`. What does not exist is everything that
 * would make a toggle mean something:
 *
 * - no Web Push registration, no VAPID keys, no service-worker push handler;
 * - no subscription table — there is nowhere to store an endpoint;
 * - `schedule-notifications` is a *name* in `JOB_STEPS` with no implementation,
 *   so the nightly run enqueues nothing;
 * - `/api/settings` accepts `kind: 'ai'` only, so the preference block cannot
 *   be written from a browser at all.
 *
 * A switch wired to that is not a setting, it is a claim. §5.9's guarantee is
 * worth stating in advance — the operator should be able to read what will
 * happen before it happens — and the categories below are printed as
 * *specification*, labelled as such, rather than as live state.
 *
 * A Server Component: nothing here changes, so nothing here needs a client.
 */

export type NotificationsSettingsScreenProps = {
  /**
   * The stored preference block, for display only.
   *
   * Shown because it is real — it is in the `setting` row and it is what the
   * delivery path will read on the day one exists. Not shown as a control,
   * because nothing can change it and nothing consumes it.
   */
  readonly stored: NotificationPreferences;
};

export function NotificationsSettingsScreen({ stored }: NotificationsSettingsScreenProps): ReactNode {
  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="2" align="center">
              <Text role="title-3" as="h2">
                Nothing is sent
              </Text>
              <Badge tone="caution">not built</Badge>
            </Inline>
            <Text role="body" tone="secondary">
              Reminders are not built. This application has never sent a notification and cannot: there is
              no push registration, no stored subscription, and the nightly job&rsquo;s
              <code> schedule-notifications</code> step is a registered name with no implementation behind
              it.
            </Text>
            <Text role="body-sm" tone="secondary">
              When they are built they will be opt-in per category and off by default, with no exceptions
              — §5.9. The commitment is recorded here rather than deferred to the day the feature lands,
              because the point of writing it down in advance is that it constrains the implementation.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              The categories, as specified
            </Text>
            <Text role="body-sm" tone="secondary">
              Five, and the list is closed. Each will be a separate opt-in.
            </Text>

            <Stack gap="2">
              {NOTIFICATION_CATEGORIES.map((category) => (
                <Inline key={category} gap="3" align="start" justify="between">
                  <Stack gap="0">
                    <Text role="body" as="span">
                      {categoryLabel(category)}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {CATEGORY_NOTES[category]}
                    </Text>
                  </Stack>
                  {/*
                    The stored default, badged as a default rather than as a
                    state. `sync_failure` is the one that ships on — §5.9 calls
                    it "a correctness signal, not engagement", and a write the
                    operator believes synced and did not is the failure §5.7
                    says would end their trust in the system.
                  */}
                  <Badge tone={stored[category] ? 'accent' : 'neutral'}>
                    {stored[category] ? 'would be on' : 'would be off'}
                  </Badge>
                </Inline>
              ))}
            </Stack>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              What will never be sent
            </Text>
            {/*
              §5.9's prohibitions are listed as prominently as the categories on
              purpose. They are the part of the specification that is easy to
              erode later, and P6 is enforced by the absence of the affordance
              rather than by restraint at the time.
            */}
            <Text role="body-sm" tone="secondary">
              No streaks. No &ldquo;we miss you&rdquo;. No notification whose content is a metric intended
              to induce guilt. There is deliberately no category above that could carry one.
            </Text>
            <Text role="body-sm" tone="secondary">
              No more than {String(NOTIFICATION_DAILY_CAP)} in any 24 hours, enforced server-side as a rate
              limit rather than left to good intentions.
            </Text>
            <Text role="caption" tone="tertiary">
              On iOS, Web Push requires the app to be installed to the home screen. That is a platform
              constraint rather than a defect, and it will be said during onboarding rather than
              discovered as a bug.
            </Text>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}

const CATEGORY_NOTES: Readonly<Record<NotificationCategory, string>> = Object.freeze({
  daily_close_reminder: 'One, at a time you choose.',
  medication_reminder: 'Per medication schedule, from the register.',
  appointment_reminder: 'Ahead of a booked appointment.',
  insight_ready: 'An insight has been surfaced. Off by default.',
  sync_failure: 'A write did not reach the server. On by default — this one is correctness, not engagement.',
});

function categoryLabel(category: NotificationCategory): string {
  return category
    .split('_')
    .map((word, index) => (index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word))
    .join(' ');
}
