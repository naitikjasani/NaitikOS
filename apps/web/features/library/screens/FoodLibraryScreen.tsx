'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { PROTEIN_SOURCE_LABELS } from '@naitikos/core';
import { Badge, Card, CardBody, EmptyState, Inline, SearchField, Stack, Text } from '@naitikos/design-system';

import type { FoodEntry, FoodLibraryBoard } from '@/lib/platform/library';

/**
 * `/library/foods` — canonical food definitions (§3.2, §4.3).
 *
 * **A Client Component**, for the reason given on the exercise screen: foods
 * are the other registry the operator writes to incidentally. Every unfamiliar
 * thing eaten becomes a row, so the list grows monotonically for twenty years
 * and a search box is what keeps it a library rather than a scroll.
 *
 * The match is a plain substring over name and brand, not a fuzzy rank. §4.3's
 * ten-second rule belongs to the *logger*, where a typo under time pressure
 * must still land on the right food; this page is opened deliberately, and a
 * ranked list whose order changes as you type is harder to read than an
 * alphabetical one that shrinks.
 *
 * ## What each row says
 *
 * The name, the basis its nutrition is stated per, and how often it has been
 * eaten. The basis is not decoration: two rows called "Greek yoghurt" stated
 * per 100 g and per pot are different registry entries, and a library that does
 * not show the basis makes them look like a duplicate to be merged.
 *
 * `timesEaten` comes off the `food` row itself, so it is free — no aggregate
 * over `meal_item` is issued to render this page.
 */
export function FoodLibraryScreen({ board }: { readonly board: FoodLibraryBoard }): ReactNode {
  const [term, setTerm] = useState('');

  const matched = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (needle === '') return board.foods;
    return board.foods.filter((entry) => {
      const brand = entry.food.brand ?? '';
      return `${entry.food.name} ${brand}`.toLowerCase().includes(needle);
    });
  }, [board.foods, term]);

  if (board.foods.length === 0) {
    return (
      <EmptyState
        title="No foods registered"
        description="Foods are created as they are eaten. An empty library means nothing has been logged yet."
      />
    );
  }

  return (
    <Stack gap="4">
      <SearchField label="Find a food" value={term} onValueChange={setTerm} placeholder="yoghurt, oats, paneer…" />

      <Text role="body-sm" tone="secondary">
        {`${String(board.foods.length)} entries. Nutrition is stated per the basis shown; a food's numbers are versioned, so an old meal keeps the figures it was logged against.`}
      </Text>

      {matched.length === 0 ? (
        <EmptyState icon="action.search" title="Nothing matches" description="Try a shorter word." />
      ) : (
        <Stack gap="2">
          {matched.map((entry) => (
            <FoodCard key={entry.food.id} entry={entry} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function FoodCard({ entry }: { readonly entry: FoodEntry }): ReactNode {
  const food = entry.food;

  return (
    <Card variant="outlined">
      <CardBody>
        <Inline gap="3" align="start" justify="between" wrap>
          <Stack gap="1">
            <Text role="body" as="h2">
              {food.name}
            </Text>
            <Text role="caption" tone="tertiary">
              {[food.brand, entry.basis ?? 'no basis recorded', food.gtin === null ? null : `GTIN ${food.gtin}`]
                .filter((part): part is string => part !== null)
                .join(' · ')}
            </Text>
          </Stack>
          <Inline gap="1" wrap>
            {food.proteinSource !== null && (
              <Badge tone="neutral">{PROTEIN_SOURCE_LABELS[food.proteinSource]}</Badge>
            )}
            {/* `isVegan` and `isVegetarian` are three-valued. An unrecorded
                flag is not a "no", so only a true one draws a badge. */}
            {food.isVegan === true && <Badge tone="positive">vegan</Badge>}
            {food.isVegan !== true && food.isVegetarian === true && <Badge tone="positive">vegetarian</Badge>}
            {entry.versionCount > 1 && <Badge tone="neutral">{`${String(entry.versionCount)} versions`}</Badge>}
            <Badge tone={food.timesEaten === 0 ? 'neutral' : 'accent'}>{`eaten ${String(food.timesEaten)}×`}</Badge>
          </Inline>
        </Inline>
      </CardBody>
    </Card>
  );
}
