import type { ReactNode } from 'react';
import {
  MIN_CALIBRATION_SAMPLE,
  PREDICTION_KIND_LABELS,
  PREDICTION_METHOD_LABELS,
  describePrediction,
} from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { CalibrationBoard } from '@/lib/platform/predictions';

/**
 * `/insights/calibration` — §10.9.
 *
 * ## This page is the engine's own report card, and it is not optional
 *
 * §10.9: "every prediction is stored and compared against what actually
 * happened, with the calibration record visible to the user. **A prediction
 * engine that does not report its own track record is asking for trust it has
 * not earned.**"
 *
 * A prediction surface without this page would be the exact thing that sentence
 * forbids, so the two ship together.
 *
 * ## Three numbers, and the third is the honest one
 *
 * Hits, misses, and *unscorable*. A horizon that arrived with nothing recorded
 * on it is an unanswered question — counting it as a miss would punish the
 * engine for the operator's silence, and counting it as a hit would flatter it.
 * It is shown separately and excluded from the rate, and the verdict says so in
 * words rather than leaving it to be inferred from three numbers that do not
 * add up.
 *
 * ## A perfect record is displayed as a problem
 *
 * The direction nobody expects. A well-calibrated 95% interval should miss
 * about one time in twenty; an interval that never misses is too wide to be a
 * claim. The verdict names both failure directions, and this page does not
 * decorate a clean sheet — there is no green tick anywhere on it.
 *
 * ## No rate below the minimum sample
 *
 * A 100% hit rate over two predictions is not a track record. Below
 * `MIN_CALIBRATION_SAMPLE` the page says how many have been scored and stops
 * (§10.9's "degrade to insufficient data rather than guessing", applied to the
 * engine's own self-assessment).
 *
 * Server-rendered, no `'use client'`: nothing here is interactive. The
 * predictions are written by the nightly job and scored by it, and there is
 * deliberately no button on this page that would let a person make one — a
 * prediction the operator asked for at the moment they wanted an answer is not
 * a prediction the calibration record should count.
 */
export function CalibrationScreen({ board }: { readonly board: CalibrationBoard }): ReactNode {
  const report = board.report;
  const misses = report.resolved - report.withinInterval;

  return (
    <Stack gap="6">
      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              The track record
            </Text>
            <Text role="body" tone="secondary">
              {report.verdict}
            </Text>

            <Inline gap="4" wrap>
              <Figure label="Inside the interval" value={String(report.withinInterval)} />
              <Figure label="Outside" value={String(misses)} />
              {/* Named "unscorable", not "missing" — the distinction is the
                  point, and a vaguer word would let it be read as a failure. */}
              <Figure label="Unscorable" value={String(report.unresolvable)} />
              <Figure label="Still open" value={String(report.pending)} />
              <Figure
                label="Hit rate"
                value={
                  report.hitRate === null
                    ? `withheld below ${String(MIN_CALIBRATION_SAMPLE)}`
                    : `${String(Math.round(report.hitRate * 100))}%`
                }
              />
              <Figure
                label="Mean error"
                value={
                  report.meanAbsoluteError === null
                    ? 'not comparable'
                    : report.meanAbsoluteError.toFixed(2)
                }
              />
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      {report.byKind.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            By kind
          </Text>
          {report.byKind.map((row) => (
            <Card key={row.kind} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Text role="body" as="span">
                    {PREDICTION_KIND_LABELS[row.kind]}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {String(row.withinInterval)} of {String(row.resolved)} inside
                    {row.hitRate === null
                      ? ' · rate withheld until there are enough'
                      : ` · ${String(Math.round(row.hitRate * 100))}%`}
                  </Text>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Open predictions
        </Text>
        {board.open.length === 0 ? (
          <EmptyState
            title="Nothing outstanding"
            description={`Predictions are written by the nightly run, ${String(board.horizonDays)} days ahead, and scored on the day they were about.`}
          />
        ) : (
          board.open.map((prediction) => (
            <Card key={prediction.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Text role="body" as="span">
                    {describePrediction(prediction)}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {PREDICTION_METHOD_LABELS[prediction.method]} over{' '}
                    {String(prediction.observationCount)} days · resolves {prediction.horizonDayKey}
                  </Text>
                  {/* Shown on every row, because §10.9 requires a prediction to
                      state its assumptions and an assumption nobody reads is
                      not stated. */}
                  <Text role="caption" tone="tertiary">
                    {prediction.assumptions}
                  </Text>
                </Stack>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Scored
        </Text>
        {board.recent.length === 0 ? (
          <EmptyState
            title="Nothing scored yet"
            description="The first prediction cannot be scored until its horizon arrives, so this page is empty for a fortnight after the first one is written."
          />
        ) : (
          board.recent.map((prediction) => (
            <Card key={prediction.id} variant="flat">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body-sm" tone="secondary" as="span">
                      {describePrediction(prediction)}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {prediction.horizonDayKey}
                      {prediction.resolvedValue === null ? '' : ` · actual ${prediction.resolvedValue}`}
                      {prediction.unresolvableReason === null
                        ? ''
                        : ` · ${prediction.unresolvableReason}`}
                    </Text>
                  </Stack>
                  <Badge tone={verdictTone(prediction.wasWithinInterval)}>
                    {verdictLabel(prediction.wasWithinInterval)}
                  </Badge>
                </Inline>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>

      <Text role="caption" tone="tertiary">
        Predictions are capped at {String(board.maxHorizonDays)} days. Beyond that, extrapolating a
        fitted line is arithmetic rather than information — and nothing here predicts a clinical
        outcome, a symptom course or a medication response, which §10.9 prohibits outright.
      </Text>
    </Stack>
  );
}

/**
 * `null` is its own state, not a miss.
 *
 * `neutral` rather than `critical`: an unscorable prediction is not a failure of
 * the engine, and colouring it like one would put the operator's logging gaps
 * into the same visual channel as the engine's errors.
 */
function verdictTone(withinInterval: boolean | null): 'positive' | 'caution' | 'neutral' {
  if (withinInterval === null) return 'neutral';
  return withinInterval ? 'positive' : 'caution';
}

function verdictLabel(withinInterval: boolean | null): string {
  if (withinInterval === null) return 'Unscorable';
  /* "Outside", not "Wrong". A reading outside a 95% interval is expected one
   * time in twenty; calling it wrong would misdescribe a working engine. */
  return withinInterval ? 'Inside' : 'Outside';
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
    </Stack>
  );
}
