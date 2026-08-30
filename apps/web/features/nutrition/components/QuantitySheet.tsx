'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { PSEUDO_UNITS, foodLabel, formatMeasured } from '@naitikos/core';
import { Button, Inline, NumberField, Sheet, Stack, Text } from '@naitikos/design-system';

import type { SuggestionView } from '@/lib/platform/nutrition';

/**
 * The quantity editor, reached by a long press.
 *
 * ## Why this is off the critical path
 *
 * §4.3's design assumes the overwhelming majority of meals are repeats of an
 * amount already logged, so the tile carries the last quantity and this sheet
 * never opens. It opens for the two cases where the system genuinely does not
 * know: a food never eaten, and a day the amount is different.
 *
 * A bottom sheet rather than an inline expander because §8.12 makes it "the
 * primary mobile pattern — bottom sheets are reachable one-handed", and this is
 * the one part of the log flow that involves aiming at something.
 *
 * ## The steppers know the unit
 *
 * §8.10: "steppers over text entry for bounded values". A gram step of 1 makes
 * 100 g of oats a hundred taps, so the step is chosen from the unit — 10 for
 * mass, 50 for volume, 1 for a pseudo-unit where the whole point is that you
 * count them. The text input stays for the large jump.
 */

export type QuantitySheetProps = {
  readonly entry: SuggestionView;
  readonly onClose: () => void;
  readonly onConfirm: (quantity: string, unit: string) => void;
};

/**
 * The steps, per unit, in the unit's own terms.
 *
 * Keyed by the **registered unit code**, which is `mL` and not `ml`. The
 * registry is case-sensitive and an unregistered code is refused at the write
 * rather than coerced, so a lower-cased key here would offer the operator a
 * button that produces `unknown_unit`.
 */
const STEPS: Readonly<Record<string, number>> = Object.freeze({ g: 10, mL: 50, kg: 1, L: 1 });

export function QuantitySheet({ entry, onClose, onConfirm }: QuantitySheetProps): ReactNode {
  const units = useMemo(() => unitsFor(entry), [entry]);
  const [unit, setUnit] = useState<string>(entry.defaultUnit ?? units[0] ?? 'serving');
  const [value, setValue] = useState<number | null>(
    entry.defaultQuantity === null ? null : Number(entry.defaultQuantity),
  );

  const step = STEPS[unit] ?? 1;
  const canConfirm = value !== null && value > 0 && entry.versionId !== null;

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={foodLabel(entry.food)}
      description={
        entry.defaultQuantity === null
          ? 'Not eaten before, so there is no amount to reuse.'
          : `Last logged as ${formatMeasured(entry.defaultQuantity)} ${entry.defaultUnit ?? ''}.`.trim()
      }
      footer={
        <Button
          variant="primary"
          size="lg"
          fullWidth
          disabled={!canConfirm}
          onClick={() => {
            if (value === null) return;
            onConfirm(String(value), unit);
          }}
        >
          Add
        </Button>
      }
    >
      <Stack gap="4">
        <NumberField
          label="Amount"
          value={value}
          onValueChange={setValue}
          step={step}
          min={0}
          unit={unit}
        />

        {units.length > 1 && (
          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Unit
            </Text>
            <Inline gap="2" wrap>
              {units.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === unit ? 'primary' : 'ghost'}
                  onClick={() => {
                    setUnit(option);
                  }}
                >
                  {option}
                </Button>
              ))}
            </Inline>
          </Stack>
        )}

        {entry.versionId === null && (
          /* §9.2 makes a meal item point at a *version*. A food with none can
           * not be logged at all, and saying why beats a disabled button. */
          <Text role="body-sm" tone="critical">
            This food has no current version, so it cannot be logged. Add one from the food's page.
          </Text>
        )}
      </Stack>
    </Sheet>
  );
}

/**
 * The units offered for a food.
 *
 * Its own last-used unit first — that is the one that will be picked — then the
 * pseudo-units, which resolve against the version's serving row. Deliberately
 * not every registered unit: offering `µg` for a bowl of dal is noise, and the
 * cross-dimension case is refused by `basisMultiple` anyway.
 */
function unitsFor(entry: SuggestionView): readonly string[] {
  const preferred = entry.defaultUnit === null ? [] : [entry.defaultUnit];
  return [...new Set([...preferred, 'g', 'mL', ...PSEUDO_UNITS])];
}
