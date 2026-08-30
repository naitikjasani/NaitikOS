'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  LABEL_REVIEW_FLOOR,
  PROTEIN_SOURCE_LABELS,
  foodLabel,
  formatMeasured,
  nutrientByKey,
  systemClock,
  isoFromMillis,
} from '@naitikos/core';
import type { FoodNutrient, FoodVersion, ParsedLabel } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Inline,
  Stack,
  Text,
  TextAreaField,
  useToast,
} from '@naitikos/design-system';

import type { FoodDetail } from '@/lib/platform/nutrition';
import { addFoodVersion, parseLabelText } from '../services/nutritionClient';

/**
 * `/body/nutrition/foods/[id]` — one food, and every version it has had.
 *
 * ## Versions are listed, never replaced
 *
 * §9.2: "historical meals keep pointing at the version that was true when
 * eaten." A reformulation is a *new version* with its own `effectiveFrom`, so a
 * 2026 meal still reports 2026's macros after a 2029 label change. Editing the
 * numbers in place would silently rewrite three years of dinners, which is the
 * single most damaging thing this screen could offer to do.
 *
 * That is why there is no edit control here and there is an "add a version"
 * one. The absence is the feature.
 *
 * ## The label paste is tier 2, and it says its confidence out loud
 *
 * `parseNutritionLabel` is deterministic — a regex and the nutrient catalogue,
 * no model. Rows it is not confident about are flagged for review rather than
 * dropped, because a nutrient silently missing from a version is a food that
 * quietly stops counting towards a target.
 */

export type FoodDetailScreenProps = {
  readonly detail: FoodDetail;
};

export function FoodDetailScreen({ detail }: FoodDetailScreenProps): ReactNode {
  const router = useRouter();
  const { toast } = useToast();
  const [pasting, setPasting] = useState(false);

  const byVersion = new Map<string, FoodNutrient[]>();
  for (const nutrient of detail.nutrients) {
    const bucket = byVersion.get(nutrient.foodVersionId) ?? [];
    bucket.push(nutrient);
    byVersion.set(nutrient.foodVersionId, bucket);
  }

  const ordered = [...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <Stack gap="5">
      <Inline gap="2" align="center" wrap>
        <Text role="title-2" as="h1">
          {foodLabel(detail.food)}
        </Text>
        {detail.food.proteinSource !== null && (
          <Badge tone="neutral">{PROTEIN_SOURCE_LABELS[detail.food.proteinSource]}</Badge>
        )}
      </Inline>

      <Text role="caption" tone="tertiary">
        {detail.food.timesEaten === 0
          ? 'Never logged.'
          : `Logged ${String(detail.food.timesEaten)} times${detail.food.lastEatenAt === null ? '' : `, last on ${detail.food.lastEatenAt.slice(0, 10)}`}.`}
        {detail.food.proteinSource === null &&
          ' No protein source recorded, so this food is left out of the protein split rather than guessed at.'}
      </Text>

      {pasting ? (
        <LabelPaste
          food={detail}
          onCancel={() => {
            setPasting(false);
          }}
          onSaved={() => {
            setPasting(false);
            toast({ title: 'Version added', tone: 'positive' });
            router.refresh();
          }}
        />
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setPasting(true);
            }}
          >
            Add a version
          </Button>
        </Inline>
      )}

      <Stack gap="3">
        {ordered.map((version) => (
          <VersionCard key={version.id} version={version} nutrients={byVersion.get(version.id) ?? []} />
        ))}
      </Stack>

      <Text role="caption" tone="tertiary">
        Versions are never edited. A reformulation is a new version with its own start date, so meals
        already logged keep the numbers that were true when they were eaten.
      </Text>
    </Stack>
  );
}

function VersionCard({
  version,
  nutrients,
}: {
  readonly version: FoodVersion;
  readonly nutrients: readonly FoodNutrient[];
}): ReactNode {
  return (
    <Card variant="outlined">
      <CardHeader
        title={`Version ${String(version.versionNumber)}`}
        description={`Per ${formatMeasured(version.basisQuantity)} ${version.basisUnit} · from ${version.effectiveFrom.slice(0, 10)}`}
      />
      <CardBody>
        <Stack gap="2">
          {version.servingQuantity !== null && version.servingUnit !== null && (
            <Text role="caption" tone="tertiary">
              One serving is {formatMeasured(version.servingQuantity)} {version.servingUnit}
              {version.servingLabel === null ? '' : ` (${version.servingLabel})`}.
            </Text>
          )}

          {nutrients.length === 0 ? (
            <Text role="body-sm" tone="tertiary">
              No nutrients recorded on this version.
            </Text>
          ) : (
            <Stack gap="1">
              {nutrients.map((nutrient) => (
                <Inline key={nutrient.nutrientKey} justify="between" align="center">
                  <Text role="body-sm" as="span">
                    {nutrientByKey(nutrient.nutrientKey)?.displayName ?? nutrient.nutrientKey}
                  </Text>
                  <Text role="body-sm" tone="secondary">
                    {formatMeasured(nutrient.amount)} {nutrient.unit}
                  </Text>
                </Inline>
              ))}
            </Stack>
          )}

          {version.sourceNote !== null && (
            <>
              <Divider />
              {/* §9.9's provenance argument, for a label. Where a number came
               * from is part of the number. */}
              <Text role="caption" tone="tertiary">
                {version.sourceNote}
              </Text>
            </>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * The paste
 * ---------------------------------------------------------------------- */

function LabelPaste({
  food,
  onCancel,
  onSaved,
}: {
  readonly food: FoodDetail;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParsedLabel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card variant="outlined">
      <CardHeader
        title="Paste the nutrition panel"
        description="Typed out or copied from a photo. Nothing is saved until the rows below have been read."
      />
      <CardBody>
        <Stack gap="3">
          <TextAreaField
            label="Label text"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            rows={6}
            placeholder={'Energy 389 kcal\nProtein 16.9 g\nCarbohydrate 66.3 g'}
          />

          {error !== null && (
            <Text role="body-sm" tone="critical">
              {error}
            </Text>
          )}

          {parsed !== null && (
            <Stack gap="2">
              {parsed.fields.length === 0 ? (
                <Text role="body-sm" tone="critical">
                  No nutrients were recognised. Nothing was saved.
                </Text>
              ) : (
                parsed.fields.map((field) => (
                  <Inline key={`${String(field.line)}:${field.nutrientKey}`} justify="between" align="center" wrap>
                    <Text role="body-sm" as="span">
                      {field.displayName}
                    </Text>
                    <Inline gap="2" align="center">
                      <Text role="body-sm" tone="secondary">
                        {formatMeasured(field.amount)} {field.canonicalUnit}
                        {field.fromIU ? ' (from IU)' : ''}
                      </Text>
                      {/* Flagged, not dropped. A nutrient that quietly went
                       * missing is a food that quietly stops counting. */}
                      {field.confidence < LABEL_REVIEW_FLOOR && <Badge tone="caution">check</Badge>}
                    </Inline>
                  </Inline>
                ))
              )}
            </Stack>
          )}

          <Inline gap="2" justify="end" wrap>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            {parsed === null ? (
              <Button
                variant="secondary"
                isLoading={busy}
                disabled={text.trim() === ''}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void parseLabelText(text)
                    .then(setParsed)
                    .catch(() => {
                      setError('The parse could not be reached. Typing the rows still works.');
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                Read it
              </Button>
            ) : (
              <Button
                variant="primary"
                isLoading={busy}
                disabled={parsed.fields.length === 0}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void save(food, parsed)
                    .then(onSaved)
                    .catch(() => {
                      setError('Could not save the version.');
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                Save as a new version
              </Button>
            )}
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}

async function save(food: FoodDetail, parsed: ParsedLabel): Promise<void> {
  const latest = [...food.versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];

  await addFoodVersion({
    foodId: food.food.id,
    id: uuidV7(systemClock.nowMillis()),
    /*
     * The basis carries over from the previous version unless the label states
     * one. A panel that says "per 100 g" and a previous version recorded per
     * serving are different bases, and assuming they match would scale every
     * future meal wrongly with nothing on screen to show it.
     */
    basisQuantity: parsed.basis?.quantity ?? latest?.basisQuantity ?? '100',
    basisUnit: parsed.basis?.unit ?? latest?.basisUnit ?? 'g',
    servingQuantity: latest?.servingQuantity ?? null,
    servingUnit: latest?.servingUnit ?? null,
    servingLabel: latest?.servingLabel ?? null,
    effectiveFrom: isoFromMillis(systemClock.nowMillis()),
    sourceNote: 'Entered from a pasted nutrition panel.',
    nutrients: parsed.fields.map((field) => ({
      key: field.nutrientKey,
      amount: field.amount,
      unit: field.canonicalUnit,
    })),
  });
}
