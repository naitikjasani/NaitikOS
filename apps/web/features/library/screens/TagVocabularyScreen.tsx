import type { ReactNode } from 'react';
import { Badge, Card, CardBody, EmptyState, Inline, Stack, Text } from '@naitikos/design-system';

import type { TagVocabularyBoard } from '@/lib/platform/library';

/**
 * `/library/tags` — the controlled tag vocabulary (§3.2, §9.2).
 *
 * **A Server Component.** It renders a list, and today it renders the reason
 * there is no list.
 *
 * ## The gap this page exists to state
 *
 * §9.2 specifies the vocabulary and the schema has it: `tag` and `entity_tag`
 * are declared in `packages/db/src/schema/substrate.ts`, with a unique slug and
 * a polymorphic application row so that anything can be tagged. What does not
 * exist is a repository. No `TagRepository` is exported from `@naitikos/db`, no
 * other repository touches either table, and `apps/web` has no Drizzle
 * dependency — §6.2 keeps queries behind repositories precisely so that a page
 * cannot quietly grow its own.
 *
 * So the route exists and says so. §3.3 R6 makes unbuilt routes **absent**, and
 * this one is not unbuilt: the vocabulary is part of the substrate and is
 * referenced by §9.2's cross-cutting query — "everything tagged *travel*". A
 * page that showed an empty list would claim there are no tags, which is a
 * different and possibly false statement. §10.9 asks for "insufficient data"
 * rather than a guess, and an unreadable table is exactly that.
 *
 * When a `TagRepository` lands, `loadTagVocabulary` is the only thing that
 * changes; this screen already renders the populated case.
 */
export function TagVocabularyScreen({ board }: { readonly board: TagVocabularyBoard }): ReactNode {
  if (!board.reachable) {
    return (
      <Stack gap="4">
        <EmptyState
          title="The vocabulary is not readable yet"
          description="The tag tables exist in the schema and nothing reads them. No repository exposes `tag` or `entity_tag`, so this page cannot say how many tags there are — which is not the same as saying there are none."
        />
        <Card variant="flat">
          <CardBody>
            <Stack gap="2">
              <Text role="body-sm" tone="secondary">
                What is defined, and where:
              </Text>
              <Text role="mono" tone="tertiary" as="code">
                packages/db/src/schema/substrate.ts — tag, entity_tag
              </Text>
              <Text role="caption" tone="tertiary">
                §9.2 wants a controlled vocabulary applied across every domain, so that &ldquo;everything tagged
                travel&rdquo; is one query. Controlled rather than free-form: an uncontrolled tag set becomes
                `travel`, `Travel` and `travelling` within a year and stops being queryable.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Stack>
    );
  }

  if (board.tags.length === 0) {
    return (
      <EmptyState
        title="No tags defined"
        description="The vocabulary is deliberately small. A tag earns its place by being applied to things in more than one domain."
      />
    );
  }

  return (
    <Stack gap="2">
      {board.tags.map((tag) => (
        <Card key={tag.slug} variant="outlined">
          <CardBody>
            <Inline gap="3" align="start" justify="between" wrap>
              <Stack gap="1">
                <Text role="body" as="h2">
                  {tag.label}
                </Text>
                <Text role="mono" tone="tertiary" as="code">
                  {tag.slug}
                </Text>
                {tag.description !== null && (
                  <Text role="body-sm" tone="secondary">
                    {tag.description}
                  </Text>
                )}
              </Stack>
              {/* `null` is "not counted", not "counted zero". */}
              {tag.appliedTo !== null && <Badge tone="neutral">{`applied to ${String(tag.appliedTo)}`}</Badge>}
            </Inline>
          </CardBody>
        </Card>
      ))}
    </Stack>
  );
}
