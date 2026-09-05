import type { ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { ProductEntry, ProductLibraryBoard } from '@/lib/platform/library';

/**
 * `/library/products` — the product register (§3.2, §4.2).
 *
 * **A Server Component.** The register is a handful of rows that change when a
 * bottle is bought or finished, which is a deliberate act on another screen.
 * There is nothing to search and nothing to toggle, so there is no reason to
 * ship JavaScript for it.
 *
 * ## Read-only, and the editor is one link away
 *
 * §4.2 puts introduction and discontinuation on `product_event` rather than on
 * the product row, because the payoff question — "my chest acne worsened three
 * weeks after starting that moisturiser" — needs the events. Writing those
 * events is the register's job and it already has a surface at
 * `/body/skin/products`. This page shows what is registered; that page is where
 * it is changed (§2.1).
 *
 * Reaction counts are counts. §4.2's question is not answered here and is not
 * answered anywhere — P5 forbids this system asserting the cause, and a number
 * next to a product name is adjacency, not attribution.
 *
 * ## Supplements are absent, deliberately
 *
 * §3.2 titles this route "skincare & supplement products", and supplements are
 * held in the `medication` register rather than in `skincare_product`. That
 * register has no `is_supplement` column — only `is_psychiatric` — so there is
 * no query that returns the supplements without also returning prescriptions.
 * Listing it here would put someone's psychiatric medication on a page called
 * "Products", which is not a display bug, it is the wrong page for that fact.
 * The register keeps its own surface at `/mind/meds`, and the gap is recorded
 * in `docs/library.md`.
 */
export function ProductLibraryScreen({ board }: { readonly board: ProductLibraryBoard }): ReactNode {
  if (board.products.length === 0) {
    return (
      <EmptyState
        title="Nothing registered"
        description="Products are added from the skin register. An empty register is a fine state — it means nothing is being tracked yet."
      />
    );
  }

  const active = board.products.filter((entry) => entry.product.isActive);
  const retired = board.products.filter((entry) => !entry.product.isActive);

  return (
    <Stack gap="6">
      <Text role="body-sm" tone="secondary">
        Read-only. Products are registered and their events recorded on{' '}
        <Link href="/body/skin/products">the skin product register</Link>, which is the one place a product row is
        written.
      </Text>

      <Section title="In the routine" entries={active} emptyNote="Nothing is currently in use." />
      <Section title="Not in use" entries={retired} emptyNote="Nothing has been retired." />
    </Stack>
  );
}

function Section({
  title,
  entries,
  emptyNote,
}: {
  readonly title: string;
  readonly entries: readonly ProductEntry[];
  readonly emptyNote: string;
}): ReactNode {
  return (
    <Stack gap="2">
      <Text role="title-3" as="h2">
        {title}
      </Text>
      {entries.length === 0 ? (
        <Text role="body-sm" tone="tertiary">
          {emptyNote}
        </Text>
      ) : (
        entries.map((entry) => <ProductCard key={entry.product.id} entry={entry} />)
      )}
    </Stack>
  );
}

function ProductCard({ entry }: { readonly entry: ProductEntry }): ReactNode {
  const product = entry.product;

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="2">
          <Inline gap="3" align="start" justify="between" wrap>
            <Stack gap="1">
              <Text role="body" as="h3">
                {product.name}
              </Text>
              <Text role="caption" tone="tertiary">
                {[product.brand, product.category].filter((part): part is string => part !== null).join(' · ') ||
                  'No brand or category recorded'}
              </Text>
            </Stack>
            <Inline gap="1" wrap>
              {/* Counted, never attributed. See the file header. */}
              {entry.reactionCount > 0 && (
                <Badge tone="caution">{`${String(entry.reactionCount)} recorded reactions`}</Badge>
              )}
              <Badge tone="neutral">{`${String(entry.eventCount)} events`}</Badge>
            </Inline>
          </Inline>

          {product.keyIngredients.length > 0 && (
            <Inline gap="1" wrap>
              {product.keyIngredients.map((ingredient) => (
                <Badge key={ingredient} tone="accent">
                  {ingredient}
                </Badge>
              ))}
            </Inline>
          )}

          {entry.introducedAt !== null && (
            <Text role="caption" tone="tertiary">
              {/* The date portion of the stored instant. The register's own
                  screens render the local time; a library row only needs the
                  day, and slicing avoids inventing a zone this page has no
                  business choosing. */}
              {`First introduced ${entry.introducedAt.slice(0, 10)}`}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
