'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import { DOCUMENT_KIND_LABELS, REVIEW_FLOOR, describeRange, formatDay, systemClock } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextField,
  ToggleField,
} from '@naitikos/design-system';

import type { DocumentDetail } from '@/lib/platform/documents';
import { confirmResults } from '../services/documentClient';

/**
 * `/life/documents/:id` — the review, and the only gate between a PDF and a
 * permanent medical record.
 *
 * ## Why this screen exists at all
 *
 * §9.1 makes observations append-only: a mis-read decimal point putting a
 * vitamin D of 142 ng/mL into the log is there for as long as the record is,
 * indistinguishable from a measurement. This is the moment — the only moment —
 * at which that can still be stopped, so it is a deliberate step rather than a
 * confirmation dialog with a default.
 *
 * ## Low-confidence candidates arrive unticked
 *
 * A line the parser fully understood — name, value, unit, printed range — comes
 * in ticked. A bare `Ferritin 45` might be a result or a page reference, so it
 * comes in unticked and requires a decision. §9.9 keeps the confidence rather
 * than consuming it, and this is what keeping it is *for*.
 *
 * ## Every value is editable, and editing promotes it
 *
 * A retyped value is a manual entry that happened to arrive beside a document.
 * It is stored at full confidence, because the operator read it off the page
 * themselves — keeping the parser's score on a number a person corrected would
 * permanently understate it.
 *
 * ## The unmatched count is shown
 *
 * A report with thirty result lines and eleven candidates is a partial
 * extraction. Saying so is the difference between "the panel had eleven
 * analytes" and "this system recognised eleven of them", and only the second is
 * true.
 */
export function DocumentReviewScreen({
  detail,
  zone,
}: {
  readonly detail: DocumentDetail;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const { document, candidates } = detail;

  const [accepted, setAccepted] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(candidates.map((candidate) => [candidate.key, candidate.preAccepted])),
  );
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(candidates.map((candidate) => [candidate.key, candidate.printedValue])),
  );
  const [collectedDay, setCollectedDay] = useState(detail.collectedOn ?? '');
  const [panelName, setPanelName] = useState(document.title);
  const [laboratory, setLaboratory] = useState(document.issuer ?? '');
  const [outcome, setOutcome] = useState<string | null>(null);

  const confirm = useMutation({
    mutationFn: async () => {
      return confirmResults({
        documentId: document.id,
        panelId: uuidV7(systemClock.nowMillis()),
        panelName: panelName.trim(),
        laboratory: laboratory.trim() === '' ? null : laboratory.trim(),
        /* Noon, for the same reason every other day-anchored instant in this
         * codebase uses it: midnight sits on a boundary a DST rule can push
         * into the previous day. */
        collectedAt: `${collectedDay}T12:00:00.000Z`,
        zone,
        decisions: candidates.map((candidate) => ({
          key: candidate.key,
          accept: accepted[candidate.key] ?? false,
          correctedValue:
            (values[candidate.key] ?? candidate.printedValue) === candidate.printedValue
              ? null
              : (values[candidate.key] ?? null),
          correctedUnit: null,
        })),
      });
    },
    onSuccess: (response) => {
      const skipped =
        response.withoutTrend.length === 0
          ? ''
          : ` ${String(response.withoutTrend.length)} of them are on the report but will not appear on a chart: ${response.withoutTrend
              .map((entry) => `${entry.analyte} (${reasonLabel(entry.reason)})`)
              .join(', ')}.`;
      setOutcome(`Recorded ${String(response.written)} results.${skipped}`);
      router.refresh();
    },
  });

  const acceptedCount = candidates.filter((candidate) => accepted[candidate.key] === true).length;
  const usable = acceptedCount > 0 && /^\d{4}-\d{2}-\d{2}$/u.test(collectedDay) && panelName.trim() !== '';

  return (
    <Stack gap="6">
      <Card variant="flat">
        <CardBody>
          <Stack gap="1">
            <Text role="body" as="span">
              {document.title}
            </Text>
            <Text role="caption" tone="tertiary">
              {DOCUMENT_KIND_LABELS[document.kind]}
              {document.issuer === null ? '' : ` · ${document.issuer}`}
              {document.issuedAt === null ? '' : ` · ${formatDay(document.issuedAt) ?? ''}`}
            </Text>
            {document.mediaObjectId === null && (
              <Text role="caption" tone="tertiary">
                The file itself is not stored — only its text and what you confirm from it. Encrypted storage is
                not built yet, and a plaintext copy of a medical document is not an acceptable interim.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      {candidates.length === 0 ? (
        <EmptyState
          icon="domain.clinical"
          title="No results recognised"
          description="The text is on file and searchable. Nothing in it matched an analyte this system knows, so there is nothing to confirm."
        />
      ) : (
        <Stack gap="4">
          <Stack gap="2">
            <Text role="title-3" as="h2">
              Results found
            </Text>
            <Text role="body-sm" tone="secondary">
              Check each value against the report before confirming. Once written, a value is part of the record
              permanently — corrections are recorded as corrections, never as edits.
            </Text>
            {detail.unmatchedLines > 0 && (
              <Text role="caption" tone="tertiary">
                {detail.unmatchedLines === 1
                  ? 'One other line looked like a result and matched no analyte this system knows.'
                  : `${String(detail.unmatchedLines)} other lines looked like results and matched no analyte this system knows.`}{' '}
                They stay in the searchable text and produce no trend.
              </Text>
            )}
          </Stack>

          <Stack gap="2">
            {candidates.map((candidate) => (
              <Card key={candidate.key} variant="outlined">
                <CardBody>
                  <Stack gap="3">
                    <Inline justify="between" align="center" wrap>
                      <Text role="body" as="span">
                        {candidate.displayName}
                      </Text>
                      {candidate.confidence < REVIEW_FLOOR && <Badge tone="caution">Check this one</Badge>}
                    </Inline>

                    {/* The source line, verbatim. The operator is comparing
                        against a page; showing what was read is what makes the
                        comparison possible at all. */}
                    <Text role="caption" tone="tertiary" className="nos-prewrap">
                      {candidate.sourceLine}
                    </Text>

                    <Inline gap="2" wrap>
                      <TextField
                        label="Value"
                        value={values[candidate.key] ?? ''}
                        inputMode="decimal"
                        onChange={(event) => {
                          const next = event.target.value;
                          setValues((current) => ({ ...current, [candidate.key]: next }));
                        }}
                      />
                      <Stack gap="1">
                        <Text role="caption" tone="tertiary">
                          Unit
                        </Text>
                        <Text role="body-sm" as="span">
                          {candidate.printedUnit ?? 'none printed'}
                          {candidate.printedUnit !== null && candidate.normalisedUnit === null
                            ? ' — not a unit this system knows, so this value will have no trend'
                            : ''}
                        </Text>
                      </Stack>
                    </Inline>

                    <Text role="caption" tone="tertiary">
                      Range as printed:{' '}
                      {describeRange({
                        low: candidate.rangeLow,
                        high: candidate.rangeHigh,
                        text: candidate.rangeText,
                        unit: candidate.printedUnit,
                      })}
                      {candidate.printedFlag === null ? ' · no flag printed' : ` · flagged ${candidate.printedFlag}`}
                    </Text>

                    <ToggleField
                      label="Record this result"
                      description="Unticked results are ignored entirely."
                      checked={accepted[candidate.key] ?? false}
                      onCheckedChange={(checked) => {
                        setAccepted((current) => ({ ...current, [candidate.key]: checked }));
                      }}
                    />
                  </Stack>
                </CardBody>
              </Card>
            ))}
          </Stack>

          <Card variant="raised">
            <CardBody>
              <Stack gap="4">
                <Text role="title-3" as="h2">
                  About this panel
                </Text>
                <TextField
                  label="Panel name"
                  value={panelName}
                  onChange={(event) => {
                    setPanelName(event.target.value);
                  }}
                />
                <TextField
                  label="Laboratory (optional)"
                  value={laboratory}
                  onChange={(event) => {
                    setLaboratory(event.target.value);
                  }}
                />
                <DateField
                  label="Collected on"
                  value={collectedDay}
                  onValueChange={setCollectedDay}
                  hint={
                    detail.collectedOn === null
                      ? 'The report did not state this unambiguously — a date like 12/09/2026 means two different days depending on who printed it, so it is not guessed.'
                      : 'Read from the report. Change it if that is wrong.'
                  }
                />

                <Inline justify="between" align="center" wrap>
                  <Text role="caption" tone="tertiary" aria-live="polite">
                    {outcome ?? `${String(acceptedCount)} of ${String(candidates.length)} selected.`}
                  </Text>
                  <Button
                    variant="primary"
                    disabled={!usable || confirm.isPending}
                    onClick={() => {
                      setOutcome(null);
                      confirm.mutate();
                    }}
                  >
                    Confirm into the record
                  </Button>
                </Inline>

                {confirm.error !== null && (
                  <Text role="body-sm" tone="secondary">
                    {confirm.error instanceof Error ? confirm.error.message : 'Could not record those.'}
                  </Text>
                )}
              </Stack>
            </CardBody>
          </Card>
        </Stack>
      )}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/life/documents">
          All documents
        </Link>
        {' · '}
        <Link className="nos-inline-link" href="/body/health/labs">
          Lab results
        </Link>
      </Text>
    </Stack>
  );
}

/** The repository's reason codes, in words a person reads once and understands. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case 'not_catalogued':
      return 'analyte not known to this system';
    case 'unknown_unit':
      return 'unit not recognised';
    case 'incomparable':
      return 'unit cannot be converted';
    case 'implausible':
      return 'value outside the plausible range';
    case 'no_numeric_value':
      return 'no number';
    default:
      return reason;
  }
}
