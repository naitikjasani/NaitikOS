'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { PROTEIN_SOURCE_LABELS, foodLabel, searchFoods } from '@naitikos/core';
import type { Food } from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Inline,
  SearchField,
  Stack,
  Text,
} from '@naitikos/design-system';

/**
 * `/body/nutrition/foods` — the register behind the log.
 *
 * ## Ordered by how often it is eaten, not alphabetically
 *
 * An alphabetical library puts almonds above oats forever. The counters
 * `food.timesEaten` and `food.lastEatenAt` already exist for the suggestion
 * ranking (§4.3 tier 1), and reusing them here means the list you scroll is the
 * list you eat from. Alphabetical order is available by searching, which is what
 * a person looking for one specific food does anyway.
 *
 * ## The search is `core`'s, not the database's
 *
 * `searchFoods` scores name and brand in memory. A personal library is a few
 * hundred rows; a trigram query would be a round trip for something that fits
 * in a prop. `pg_trgm` earns its place on documents, not here.
 */

export type FoodLibraryScreenProps = {
  readonly foods: readonly Food[];
};

export function FoodLibraryScreen({ foods }: FoodLibraryScreenProps): ReactNode {
  const [term, setTerm] = useState('');

  const shown = useMemo(() => {
    const trimmed = term.trim();
    if (trimmed === '') {
      return [...foods].sort((a, b) => b.timesEaten - a.timesEaten || a.name.localeCompare(b.name));
    }
    return searchFoods(foods, trimmed).map((result) => result.food);
  }, [foods, term]);

  if (foods.length === 0) {
    return (
      <EmptyState
        icon="nav.body"
        title="The library is empty"
        description="Foods are seeded rather than typed in — the starting set covers the usual staples. If nothing is here, the seed has not been run against this database."
      />
    );
  }

  return (
    <Stack gap="4">
      <SearchField
        label="Search foods"
        placeholder="paneer, oats, whey…"
        value={term}
        onValueChange={setTerm}
      />

      {shown.length === 0 ? (
        <Text role="body-sm" tone="tertiary">
          Nothing matches “{term}”.
        </Text>
      ) : (
        <Stack gap="2">
          {shown.map((food) => (
            <Card key={food.id} variant="outlined">
              <CardBody>
                <Inline justify="between" align="center" wrap>
                  <Stack gap="1">
                    <Link className="nos-inline-link" href={`/body/nutrition/foods/${food.id}`}>
                      {foodLabel(food)}
                    </Link>
                    <Text role="caption" tone="tertiary">
                      {food.timesEaten === 0
                        ? 'never logged'
                        : `logged ${String(food.timesEaten)} ${food.timesEaten === 1 ? 'time' : 'times'}`}
                      {food.lastEatenAt === null ? '' : ` · last ${food.lastEatenAt.slice(0, 10)}`}
                    </Text>
                  </Stack>
                  <Inline gap="2" align="center" wrap>
                    {food.proteinSource !== null && (
                      <Badge tone="neutral">{PROTEIN_SOURCE_LABELS[food.proteinSource]}</Badge>
                    )}
                    {food.isVegan === true && <Badge tone="neutral">vegan</Badge>}
                  </Inline>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      <Text role="caption" tone="tertiary">
        {String(shown.length)} of {String(foods.length)} foods.
      </Text>
    </Stack>
  );
}
