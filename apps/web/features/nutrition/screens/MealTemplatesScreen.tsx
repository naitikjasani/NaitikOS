'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { DEFAULT_SLOTS, foodLabel, formatMeasured, searchFoods, systemClock } from '@naitikos/core';
import type { Food, MealTemplate } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Inline,
  NumberField,
  SearchField,
  Stack,
  Text,
  TextField,
  useToast,
} from '@naitikos/design-system';

import { saveTemplate } from '../services/nutritionClient';

/**
 * `/body/nutrition/meals` — the saved meals behind the log's one-tap path.
 *
 * ## A template stores foods, not versions
 *
 * §9.2 makes a *logged* meal point at a food version, so it keeps the numbers
 * that were true when it was eaten. A template is the opposite kind of thing:
 * it is a standing intention, and "my usual breakfast" means the oats as they
 * are today, not as they were labelled in 2026. It stores `foodId` and is
 * resolved to the current version at the moment it is used.
 *
 * That is why a template can go stale — a food whose versions were all removed
 * leaves the template unresolvable. The log screen greys it out and says why
 * rather than quietly logging a shorter meal.
 *
 * ## No usage counters are edited here
 *
 * `timesUsed` and `lastUsedAt` are written by the log path, in the same
 * transaction as the meal. A screen that could set them would be a second
 * writer to a denormalised counter, which is how they drift.
 */

export type MealTemplatesScreenProps = {
  readonly templates: readonly MealTemplate[];
  readonly foods: readonly Food[];
};

export function MealTemplatesScreen({ templates, foods }: MealTemplatesScreenProps): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  const foodById = new Map(foods.map((food) => [food.id, food]));

  return (
    <Stack gap="4">
      {adding ? (
        <TemplateForm
          foods={foods}
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
            Save a meal
          </Button>
        </Inline>
      )}

      {templates.length === 0 ? (
        <EmptyState
          icon="nav.body"
          title="No saved meals"
          description="A saved meal is the one-tap path on the log screen. It is worth creating once you notice yourself picking the same three tiles every morning — not before."
        />
      ) : (
        <Stack gap="2">
          {templates.map((template) => (
            <Card key={template.id} variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Inline justify="between" align="center" wrap>
                    <Text role="body" as="span">
                      {template.name}
                    </Text>
                    <Inline gap="2" align="center">
                      {template.slot !== null && <Badge tone="neutral">{template.slot}</Badge>}
                      <Text role="caption" tone="tertiary">
                        {template.timesUsed === 0
                          ? 'never used'
                          : `used ${String(template.timesUsed)} times`}
                      </Text>
                    </Inline>
                  </Inline>

                  <Stack gap="1">
                    {template.items.map((item) => (
                      <Inline key={item.foodId} justify="between" align="center">
                        <Text role="caption" tone="secondary">
                          {foodById.has(item.foodId)
                            ? foodLabel(foodById.get(item.foodId) as Food)
                            : 'a food no longer in the library'}
                        </Text>
                        <Text role="caption" tone="tertiary">
                          {formatMeasured(item.quantity)} {item.unit}
                        </Text>
                      </Inline>
                    ))}
                  </Stack>
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/* -------------------------------------------------------------------------
 * The form
 * ---------------------------------------------------------------------- */

type Line = { readonly foodId: string; readonly name: string; readonly quantity: number; readonly unit: string };

function TemplateForm({
  foods,
  onCancel,
  onSaved,
}: {
  readonly foods: readonly Food[];
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [slot, setSlot] = useState<string | null>(null);
  const [term, setTerm] = useState('');
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [busy, setBusy] = useState(false);

  const matches = term.trim() === '' ? [] : searchFoods(foods, term.trim(), 6);

  return (
    <Card variant="outlined">
      <CardHeader title="Save a meal" description="Foods and amounts. The versions are resolved when it is used." />
      <CardBody>
        <Stack gap="4">
          <TextField
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            placeholder="Usual breakfast"
          />

          <Stack gap="2">
            <Text role="caption" tone="tertiary">
              Slot (optional — it only affects where this is offered)
            </Text>
            <Inline gap="2" wrap>
              {DEFAULT_SLOTS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={option === slot ? 'primary' : 'ghost'}
                  onClick={() => {
                    setSlot(option === slot ? null : option);
                  }}
                >
                  {option}
                </Button>
              ))}
            </Inline>
          </Stack>

          <SearchField label="Add a food" value={term} onValueChange={setTerm} placeholder="oats, paneer…" />

          {matches.length > 0 && (
            <Stack gap="1">
              {matches.map((match) => (
                <Button
                  key={match.food.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLines((current) => [
                      ...current.filter((line) => line.foodId !== match.food.id),
                      { foodId: match.food.id, name: foodLabel(match.food), quantity: 100, unit: 'g' },
                    ]);
                    setTerm('');
                  }}
                >
                  {foodLabel(match.food)}
                </Button>
              ))}
            </Stack>
          )}

          {lines.map((line) => (
            <Inline key={line.foodId} justify="between" align="center" gap="3" wrap>
              <Text role="body-sm" as="span">
                {line.name}
              </Text>
              <Inline gap="2" align="center">
                <NumberField
                  label={`Amount of ${line.name}`}
                  labelHidden
                  value={line.quantity}
                  step={10}
                  min={0}
                  unit={line.unit}
                  onValueChange={(value) => {
                    setLines((current) =>
                      current.map((entry) =>
                        entry.foodId === line.foodId ? { ...entry, quantity: value ?? 0 } : entry,
                      ),
                    );
                  }}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLines((current) => current.filter((entry) => entry.foodId !== line.foodId));
                  }}
                >
                  Remove
                </Button>
              </Inline>
            </Inline>
          ))}

          <Inline gap="2" justify="end">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              isLoading={busy}
              disabled={name.trim() === '' || lines.length === 0}
              onClick={() => {
                setBusy(true);
                void saveTemplate({
                  id: uuidV7(systemClock.nowMillis()),
                  name: name.trim(),
                  slot,
                  items: lines.map((line) => ({
                    foodId: line.foodId,
                    quantity: String(line.quantity),
                    unit: line.unit,
                  })),
                })
                  .then(onSaved)
                  .catch(() => {
                    toast({ title: 'Could not save that meal', tone: 'critical' });
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Save
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
