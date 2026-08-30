'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  NUTRIENTS,
  formatMeasured,
  nutrientForMetricKey,
  nutritionMetricKey,
  systemClock,
} from '@naitikos/core';
import type { NutritionTarget } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Inline,
  NumberField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@naitikos/design-system';

import { setTarget } from '../services/nutritionClient';

/**
 * `/body/nutrition/targets` — what a day is measured against.
 *
 * ## Targets are time-bounded, so the history survives a phase change
 *
 * A bulk and a cut have different targets. A single mutable row would erase the
 * bulk the moment the cut began, and §4.10 needs both to be able to say that a
 * bulk target and a visible-abs goal are in tension. Setting a new target
 * *closes* the previous one rather than overwriting it, which is why past
 * targets stay on this page instead of disappearing.
 *
 * ## The tolerance band has no default
 *
 * §4.3's contract says it plainly: an invented ±10% reading "within" is a claim
 * the operator never made (P5). Without a band the evaluation reports the bare
 * fact — under or over — and leaves the reading to the person who set it.
 */

export type TargetsScreenProps = {
  readonly targets: readonly NutritionTarget[];
  readonly todayIso: string;
};

export function TargetsScreen({ targets, todayIso }: TargetsScreenProps): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const active = targets.filter((target) => target.effectiveTo === null);
  const past = targets.filter((target) => target.effectiveTo !== null);

  return (
    <Stack gap="5">
      {adding ? (
        <TargetForm
          todayIso={todayIso}
          onCancel={() => {
            setAdding(false);
          }}
          onSaved={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            Set a target
          </Button>
        </Inline>
      )}

      {active.length === 0 ? (
        <EmptyState
          icon="nav.body"
          title="No targets in force"
          description="Meals are recorded either way. A target only decides whether the day gets compared to something — it is not required for anything else in the module to work."
        />
      ) : (
        <Stack gap="2">
          {active.map((target) => (
            <TargetCard key={target.id} target={target} />
          ))}
        </Stack>
      )}

      {past.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Previous
          </Text>
          {past.map((target) => (
            <TargetCard key={target.id} target={target} />
          ))}
          <Text role="caption" tone="tertiary">
            Kept rather than deleted. A day in March was measured against March&apos;s target, and a
            page that showed today&apos;s would misreport every past day at once.
          </Text>
        </Stack>
      )}
    </Stack>
  );
}

function TargetCard({ target }: { readonly target: NutritionTarget }): ReactNode {
  const nutrient = nutrientForMetricKey(target.metricKey);
  const band =
    target.toleranceLow === null && target.toleranceHigh === null
      ? 'no band'
      : `${target.toleranceLow === null ? '—' : formatMeasured(target.toleranceLow)} to ${target.toleranceHigh === null ? '—' : formatMeasured(target.toleranceHigh)}`;

  return (
    <Card variant="outlined">
      <CardBody>
        <Inline justify="between" align="center" wrap>
          <Stack gap="1">
            <Text role="body" as="span">
              {nutrient?.displayName ?? target.metricKey} · {formatMeasured(target.targetValue)} {target.unit}
            </Text>
            <Text role="caption" tone="tertiary">
              from {target.effectiveFrom.slice(0, 10)}
              {target.effectiveTo === null ? '' : ` to ${target.effectiveTo.slice(0, 10)}`} · {band}
            </Text>
          </Stack>
          {target.phase !== null && <Badge tone="neutral">{target.phase}</Badge>}
        </Inline>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * The form
 * ---------------------------------------------------------------------- */

function TargetForm({
  todayIso,
  onCancel,
  onSaved,
}: {
  readonly todayIso: string;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const { toast } = useToast();
  const macros = NUTRIENTS.filter((nutrient) => nutrient.isMacro);

  const [slug, setSlug] = useState<string>(macros[0]?.slug ?? 'protein');
  const [value, setValue] = useState<number | null>(null);
  const [phase, setPhase] = useState('');
  const [busy, setBusy] = useState(false);

  const nutrient = macros.find((entry) => entry.slug === slug) ?? macros[0];

  return (
    <Card variant="outlined">
      <CardHeader
        title="Set a target"
        description="This closes any target already in force for the same nutrient, rather than replacing it."
      />
      <CardBody>
        <Stack gap="4">
          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Nutrient
            </Text>
            <Inline gap="2" wrap>
              {macros.map((entry) => (
                <Button
                  key={entry.slug}
                  size="sm"
                  variant={entry.slug === slug ? 'primary' : 'ghost'}
                  onClick={() => {
                    setSlug(entry.slug);
                  }}
                >
                  {entry.displayName}
                </Button>
              ))}
            </Inline>
          </Stack>

          <NumberField
            label="Target"
            value={value}
            onValueChange={setValue}
            step={nutrient?.slug === 'energy' ? 50 : 5}
            min={0}
            unit={nutrient?.canonicalUnit ?? ''}
          />

          <TextField
            label="Phase (optional)"
            value={phase}
            onChange={(event) => {
              setPhase(event.target.value);
            }}
            placeholder="bulk, cut, maintenance"
            hint="Free text. It labels the target; nothing is derived from it."
          />

          {/* Deliberately no band control yet. Offering one with a prefilled
            * ±10% would be the invented claim §4.3 rules out, and a band is
            * only meaningful once there is a reason for its width. */}
          <Text role="caption" tone="tertiary">
            No tolerance band is set. Without one, a day is reported as under or over the bare number
            rather than as “within”, which is less helpful and considerably more honest.
          </Text>

          <Inline gap="2" justify="end">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={busy}
              disabled={value === null || value <= 0 || nutrient === undefined}
              onClick={() => {
                if (value === null || nutrient === undefined) return;
                setBusy(true);
                void setTarget({
                  id: uuidV7(systemClock.nowMillis()),
                  phase: phase.trim() === '' ? null : phase.trim(),
                  effectiveFrom: todayIso,
                  metricKey: nutritionMetricKey(nutrient.slug),
                  targetValue: String(value),
                  unit: nutrient.canonicalUnit,
                  toleranceLow: null,
                  toleranceHigh: null,
                })
                  .then(onSaved)
                  .catch(() => {
                    toast({ title: 'Could not set that target', tone: 'critical' });
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Set
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
