'use client';

import { type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { productLabel } from '@naitikos/core';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  Inline,
  LoadingState,
  Stack,
  Text,
} from '@naitikos/design-system';

import { fetchProducts } from '../services/skinClient';

/**
 * `/body/skin/products` — the register and its reaction history (§4.2).
 *
 * ## "Started 9 days ago" is the whole point of this screen
 *
 * A skin reaction to a new product typically appears within weeks, so the days
 * since introduction is the context that makes today's log legible. It is
 * derived by replaying the product's events, not read from a column — a product
 * introduced, dropped and reintroduced has three events and one row, and only
 * the replay gets the current period right.
 *
 * ## Reactions are listed, never scored
 *
 * The operator's words, in date order, with the severity they chose. There is
 * no aggregate "problem products" ranking, because a ranking over a handful of
 * reactions is a claim the data does not support (P5).
 */
export function ProductsScreen({ dayKey }: { readonly dayKey: string }): ReactNode {
  const register = useQuery({
    queryKey: ['skin', 'products', dayKey],
    queryFn: () => fetchProducts(dayKey),
  });

  if (register.isLoading) return <LoadingState label="Loading" />;

  const data = register.data;
  if (data === undefined) return null;

  if (data.products.length === 0) {
    return (
      <EmptyState
        icon="domain.skin"
        title="No products on file"
        description="The register holds what you use, when you started, and what happened. Adding one is not built yet; rows are inserted directly for now."
      />
    );
  }

  const nameFor = (id: string): string =>
    data.products.find((item) => item.product.id === id)?.product.name ?? 'a product';

  return (
    <Stack gap="5">
      <Stack gap="2">
        {data.products.map(({ product, daysInUse }) => (
          <Card key={product.id} variant="outlined">
            <CardBody>
              <Stack gap="2">
                <Inline justify="between" align="center">
                  <Text role="body" as="span">
                    {productLabel(product)}
                  </Text>
                  {daysInUse === null ? (
                    <Badge tone="neutral">Not in use</Badge>
                  ) : (
                    <Badge tone="accent">
                      {daysInUse === 0 ? 'Started today' : `Started ${String(daysInUse)} days ago`}
                    </Badge>
                  )}
                </Inline>

                {product.keyIngredients.length > 0 && (
                  <Inline gap="1" wrap>
                    {product.keyIngredients.map((ingredient) => (
                      <Badge key={ingredient} tone="neutral">
                        {ingredient}
                      </Badge>
                    ))}
                  </Inline>
                )}

                {product.notes !== null && (
                  <Text role="caption" tone="tertiary">
                    {product.notes}
                  </Text>
                )}
              </Stack>
            </CardBody>
          </Card>
        ))}
      </Stack>

      {data.reactions.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="3">
              <Text role="title-3" as="h2">
                Reactions
              </Text>
              {data.reactions.map((reaction) => (
                <Inline key={`${reaction.productId}-${reaction.dayKey}`} justify="between" align="center">
                  <Text role="body-sm" as="span">
                    {nameFor(reaction.productId)}
                    {reaction.description === null ? '' : ` — ${reaction.description}`}
                  </Text>
                  <Text role="caption" tone="tertiary" as="span">
                    {reaction.dayKey}
                    {reaction.severity === null ? '' : ` · ${reaction.severity}`}
                  </Text>
                </Inline>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}
