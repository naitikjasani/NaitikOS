import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * `/settings/integrations` — §3.2's "Imports: Apple Health, calendar, bank".
 *
 * ## An index, not a second import surface
 *
 * Two of the three exist, and both live where the imported data lands: the ICS
 * import is on `/work/calendar` and the bank CSV import is on
 * `/money/transactions`. That placement is right and this page does not
 * duplicate it — an import that runs somewhere other than where its results
 * appear gives the operator nothing to check the result against, and a second
 * uploader for the same file would be a second place for the de-duplication
 * rule to drift.
 *
 * So this page answers one question — *what can get in, and from where* — and
 * hands off. §3.3 R6's logic applied to a settings page: a surface that repeats
 * a working one is worse than a link to it.
 *
 * A Server Component. Nothing here is interactive; every control is a link.
 */

export function IntegrationsSettingsScreen(): ReactNode {
  return (
    <Stack gap="5">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Calendar
              </Text>
              <Badge tone="positive">built</Badge>
            </Inline>
            <Text role="body-sm" tone="secondary">
              An ICS file, pasted or uploaded on the calendar page. Read-only in one direction: the import
              never writes back to the source, and a re-import does not overwrite a correction you made
              here — a travel flag you set by hand survives the next file.
            </Text>
            <Text role="caption" tone="tertiary">
              Events are imported into the zone the calendar declares, not the zone you are standing in.
              Importing while travelling files a floating event at home time, which is the answer §5.3
              wants.
            </Text>
            <Inline gap="2">
              <Button asChild size="sm" variant="secondary">
                <Link href="/work/calendar">Import a calendar</Link>
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Bank
              </Text>
              <Badge tone="positive">built</Badge>
            </Inline>
            <Text role="body-sm" tone="secondary">
              A CSV exported from your bank, dropped on the transactions page. Import is the path the Money
              pillar is built around; typing rows in is not.
            </Text>
            <Text role="caption" tone="tertiary">
              There is no bank API connection and there is not intended to be one. An aggregator is a
              third party holding a credential to every account, which is precisely the egress P7 exists to
              refuse.
            </Text>
            <Inline gap="2">
              <Button asChild size="sm" variant="secondary">
                <Link href="/money/transactions">Import transactions</Link>
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Apple Health
              </Text>
              <Badge tone="caution">not built</Badge>
            </Inline>
            <Text role="body-sm" tone="secondary">
              Apple Health import does not exist. Nothing in this application reads HealthKit, and no
              import path accepts its export.
            </Text>
            {/*
              Why this one is materially harder than the other two, stated so the
              gap does not read as an oversight. A PWA cannot reach HealthKit —
              the API is native-only — so the realistic path is the Health app's
              own XML export, which is a single multi-hundred-megabyte file that
              cannot be parsed the way a CSV is.
            */}
            <Text role="caption" tone="tertiary">
              It is not a small piece of work. HealthKit has no web API, so the only route is the Health
              app&rsquo;s own XML export — one file, frequently hundreds of megabytes, which has to be
              streamed rather than parsed whole, mapped onto the metric registry, and de-duplicated against
              observations that may already exist for the same days.
            </Text>
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Text role="title-3" as="h2">
              The other way data gets in
            </Text>
            <Text role="body-sm" tone="secondary">
              Documents. A lab PDF uploaded to the vault is stored in the private tier, which is
              server-readable on purpose — that readability is what makes structured lab results out of a
              scanned report possible at all.
            </Text>
            <Inline gap="2">
              <Button asChild size="sm" variant="ghost">
                <Link href="/life/documents">Document vault</Link>
              </Button>
            </Inline>
          </Stack>
        </CardBody>
      </Card>
    </Stack>
  );
}
