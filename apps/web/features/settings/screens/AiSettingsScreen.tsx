'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  AI_CONSENT_DESCRIPTIONS,
  AI_CONSENT_SCOPES,
  MAX_MONTHLY_CAP_MINOR,
  aiIsUsable,
} from '@naitikos/core';
import type { AiConsent, AiPreferences } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Inline,
  NumberField,
  Stack,
  Text,
  ToggleField,
  useToast,
} from '@naitikos/design-system';

import type { AiSettings } from '@/lib/platform/settings';
import { saveAiSettings } from '../services/settingsClient';

/**
 * `/settings/ai` — §3.2's "model tier, consent scopes, spend cap".
 *
 * ## This page is the consent model
 *
 * §10.10 requires the four scopes to be "individually revocable in
 * `/settings/ai`, all defaulting to off". Until this screen existed the
 * guardrail was fully enforced in code and read a value nothing could write —
 * a control the operator could not reach. That is worse than an absent control,
 * because it looks like a decision was made.
 *
 * ## Off is the resting state, and the page says so
 *
 * Everything here defaults off, and the page leads with what still works
 * without it: all of it. §7 makes the AI layer "a sidecar, not a dependency"
 * and gives the kill switch an acceptance test — "the whole product still works
 * with it off". A settings page that framed disabling as a loss would be
 * arguing against its own architecture.
 *
 * ## No confirmation on turning it off
 *
 * §8.12 makes confirmation a protection against loss, and nothing is lost here.
 * Putting a dialog in front of the one action that can only make things safer
 * would make the safety control the slowest one on the page.
 */

export type AiSettingsScreenProps = {
  readonly settings: AiSettings;
};

export function AiSettingsScreen({ settings }: AiSettingsScreenProps): ReactNode {
  const router = useRouter();
  const { toast } = useToast();

  const [draft, setDraft] = useState<AiPreferences>(settings.preferences);
  const [busy, setBusy] = useState(false);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings.preferences);
  const usable = aiIsUsable(draft);

  const save = (next: AiPreferences): void => {
    setBusy(true);
    void saveAiSettings(next)
      .then(() => {
        router.refresh();
      })
      .catch(() => {
        toast({ title: 'Could not save that', tone: 'critical' });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="5">
      {/* --- what is true right now ------------------------------------- */}
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <ToggleField
              label="Use a model at all"
              description="Off by default. Every number, chart, projection and detector in this application is computed without one — turning this off removes prose, and nothing else."
              checked={draft.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => {
                const next = { ...draft, enabled };
                setDraft(next);
                /*
                 * The switch saves immediately rather than waiting for the Save
                 * button. It is the kill switch (§7); a version of it that
                 * needed a second action to take effect would not be one.
                 */
                save(next);
              }}
            />

            {draft.enabled && !settings.transportConfigured && (
              /* Stated plainly. A grant with no key configured grants nothing,
               * and letting the operator believe otherwise would be the page
               * misreporting its own state. */
              <Text role="body-sm" tone="critical">
                No API key is configured on the server, so nothing will run regardless of what is granted
                below.
              </Text>
            )}

            {draft.enabled && settings.transportConfigured && !usable && (
              <Text role="body-sm" tone="secondary">
                Nothing is granted below, so nothing will be sent. That is a working configuration, not an
                error.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      {/* --- the four scopes -------------------------------------------- */}
      <Card variant="outlined">
        <CardHeader
          title="What may be sent"
          description="Each is separate. Granting one grants nothing else, and any of them can be withdrawn at any time."
        />
        <CardBody>
          <Stack gap="4">
            {AI_CONSENT_SCOPES.map((scope) => (
              <ToggleField
                key={scope}
                label={scopeLabel(scope)}
                description={AI_CONSENT_DESCRIPTIONS[scope]}
                checked={draft.consent[scope]}
                disabled={busy}
                onCheckedChange={(granted) => {
                  setDraft({ ...draft, consent: { ...draft.consent, [scope]: granted } as AiConsent });
                }}
              />
            ))}

            <Divider />

            {/* P7, stated where the decision is made rather than in a policy
                document nobody opens. */}
            <Text role="caption" tone="tertiary">
              Anything sent leaves this machine. It cannot be recalled afterwards, which is why all four
              start off and why nothing here is granted on your behalf.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {/* --- the cap ------------------------------------------------------ */}
      <Card variant="outlined">
        <CardHeader
          title="Monthly cap"
          description="Checked before every call, not after. A call that would cross the cap is not made."
        />
        <CardBody>
          <Stack gap="3">
            <NumberField
              label="Cap"
              value={draft.monthlyCapMinor / 100}
              step={5}
              min={0}
              max={MAX_MONTHLY_CAP_MINOR / 100}
              unit="USD"
              disabled={busy}
              onValueChange={(value) => {
                setDraft({ ...draft, monthlyCapMinor: Math.round((value ?? 0) * 100) });
              }}
            />

            <SpendBreakdown settings={settings} draft={draft} />
          </Stack>
        </CardBody>
      </Card>

      {dirty && (
        <Inline gap="2" justify="end">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(settings.preferences);
            }}
          >
            Discard
          </Button>
          <Button
            variant="primary"
            isLoading={busy}
            onClick={() => {
              save(draft);
            }}
          >
            Save
          </Button>
        </Inline>
      )}
    </Stack>
  );
}

/**
 * What has actually been spent, and on what.
 *
 * §10.11: "the spend breakdown by task type is visible in settings." Shown
 * beside the cap rather than on its own page, because the cap is only a
 * meaningful number next to what it is capping.
 */
function SpendBreakdown({
  settings,
  draft,
}: {
  readonly settings: AiSettings;
  readonly draft: AiPreferences;
}): ReactNode {
  const { spend } = settings;
  const capMinor = draft.monthlyCapMinor;
  const overWarn = capMinor > 0 && spend.totalMinor > capMinor * 0.7;

  return (
    <Stack gap="2">
      <Inline justify="between" align="center">
        <Text role="body-sm" as="span">
          Used this month
        </Text>
        <Inline gap="2" align="center">
          <Text role="body-sm" tone="secondary">
            {money(spend.totalMinor)} of {money(capMinor)}
          </Text>
          {overWarn && <Badge tone="caution">over 70%</Badge>}
        </Inline>
      </Inline>

      {spend.calls === 0 ? (
        <Text role="caption" tone="tertiary">
          No calls have been made since {settings.monthStartIso.slice(0, 10)}.
        </Text>
      ) : (
        <Stack gap="1">
          {spend.byPurpose.map((entry) => (
            <Inline key={entry.purpose} justify="between" align="center">
              <Text role="caption" tone="tertiary">
                {entry.purpose.replace(/_/gu, ' ')}
              </Text>
              <Text role="caption" tone="tertiary">
                {money(entry.costMinor)} · {String(entry.calls)}{' '}
                {entry.calls === 1 ? 'call' : 'calls'}
              </Text>
            </Inline>
          ))}

          {spend.blocked > 0 && (
            /*
             * §10.10 makes a blocked output a defect that drives an eval case,
             * so it is surfaced rather than buried in the ledger. A rising
             * count here is a prompt problem, not a usage statistic.
             */
            <Text role="caption" tone="tertiary">
              {String(spend.blocked)} {spend.blocked === 1 ? 'response was' : 'responses were'} withheld by
              the safety layer and never shown.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case 'metrics':
      return 'Numbers';
    case 'clinical':
      return 'Clinical records';
    case 'journal':
      return 'Journal and therapy notes';
    default:
      return 'Images';
  }
}

function money(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}
