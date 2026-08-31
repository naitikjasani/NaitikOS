'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { REVIEW_KIND_LABELS, draftToMarkdown } from '@naitikos/core';
import { Badge, Button, Card, CardBody, Inline, Stack, Text, TextAreaField } from '@naitikos/design-system';

import type { ReviewDetail } from '@/lib/platform/reviews';
import { saveReviewEdit } from '../services/reviewClient';

/**
 * `/life/reviews/:id` — §4.12.
 *
 * ## Mark complete is disabled until the operator has written something
 *
 * §4.12, and this page is the enforcement point the operator actually sees:
 *
 *   "The draft is the labour-saving part; the editing is the value. A review the
 *    user did not edit is a review they did not do, and the system should treat
 *    an unedited draft as incomplete rather than as a completed review."
 *
 * So the button is disabled while the edited text is empty or byte-identical to
 * the draft, and the reason is printed beside it. The check exists three times —
 * here, in `core`'s `isReviewComplete`, and as the
 * `review_complete_requires_edit` constraint — because the failure it prevents
 * is a permanent archive full of documents nobody read, indistinguishable from
 * the ones somebody did.
 *
 * ## The draft is read-only, and it is not the model's opinion
 *
 * Every figure in it came from a query. Nothing on this page was written by a
 * model, and the same period drafted twice produces the same bytes (§10.0).
 *
 * ## Re-drafting never touches the edit
 *
 * The two columns are separate storage. `draftContent` is derived and can be
 * rebuilt from the record at any time; `editedContent` is not derived from
 * anything and nothing can reconstruct it. When the record has moved on since
 * the draft was stored, this page says so and offers both — it does not merge
 * them, because a merge needs a rule for which sentence wins and that rule
 * would be invented.
 */
export function ReviewDetailScreen({ detail }: { readonly detail: ReviewDetail }): ReactNode {
  const router = useRouter();
  const { review } = detail;

  const draftText = review.draftContent ?? '';
  const [text, setText] = useState(review.editedContent ?? draftText);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (state: 'editing' | 'complete') => {
      await saveReviewEdit({ id: review.id, editedContent: text, state });
    },
    onSuccess: () => {
      setProblem(null);
      router.refresh();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that review.');
    },
  });

  /*
   * Byte-identical, after trimming the trailing newline the Markdown renderer
   * adds. Not a similarity score: the question §4.12 asks is whether the
   * operator wrote anything, and "changed one character" is a yes. A threshold
   * would be this page deciding how much reflection counts, which is not a
   * judgement it is in any position to make.
   */
  const untouched = text.trim() === '' || text.trim() === draftText.trim();
  const canComplete = !untouched && !save.isPending;

  /*
   * The record has moved on since this draft was stored. Said, never merged.
   *
   * An exact comparison, which is only possible because `draftToMarkdown` is
   * documented to be byte-stable for the same inputs — it reads no clock and
   * sorts everything it emits. That guarantee is what makes "has anything
   * changed" a question this page can answer honestly rather than approximate.
   */
  const stale =
    detail.draft !== null &&
    review.draftContent !== null &&
    draftToMarkdown(detail.draft) !== review.draftContent;

  return (
    <Stack gap="6">
      <Stack gap="2">
        <Inline gap="3" align="center" justify="between" wrap>
          <Text role="title-3" as="h1">
            {REVIEW_KIND_LABELS[review.kind]} review
            {detail.period === null ? '' : ` — ${detail.period.label}`}
          </Text>
          <Inline gap="2" align="center">
            {detail.complete ? (
              <Badge tone="positive">Complete</Badge>
            ) : review.state === 'editing' ? (
              <Badge tone="accent">Being edited</Badge>
            ) : (
              <Badge tone="neutral">Drafted, not done</Badge>
            )}
          </Inline>
        </Inline>

        {detail.period !== null && (
          <Text role="caption" tone="tertiary">
            {detail.period.fromDayKey} to {detail.period.toDayKey}
          </Text>
        )}
      </Stack>

      {/* Coverage before any figure, so it cannot be read past. */}
      {detail.draft !== null && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                How much of the period is on record
              </Text>
              <Text role="body-sm" as="p">
                {detail.draft.coverage}
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {stale && (
        <Card variant="outlined">
          <CardBody>
            <Text role="body-sm" tone="secondary">
              The record has changed since this was drafted. Re-drafting from the list will refresh the
              figures and leave everything you wrote exactly where it is — the two are stored separately, and
              nothing here merges them for you.
            </Text>
          </CardBody>
        </Card>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          The draft
        </Text>
        <Text role="caption" tone="tertiary">
          Assembled from the record. Every figure came from a query; no model wrote any of this, and the same
          period drafted twice produces the same text.
        </Text>
        <Card variant="flat">
          <CardBody>
            {draftText === '' ? (
              <Text role="body-sm" tone="tertiary">
                This review has no stored draft. That is a defect rather than an empty period — draft it again
                from the list.
              </Text>
            ) : (
              /* §8.3 reserves the serif for long-form, and `nos-prewrap` keeps
                 the Markdown's own line breaks — the same pair a journal entry
                 uses. Rendering it as HTML would mean a Markdown parser in the
                 path of a document whose whole claim is that it is exactly what
                 was stored. */
              <Text role="body" className="nos-prewrap" serif>
                {draftText}
              </Text>
            )}
          </CardBody>
        </Card>
      </Stack>

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Your review
        </Text>

        <TextAreaField
          label="What actually happened"
          hint="Seeded from the draft. Change it, cut it, disagree with it — the editing is the part that makes this a review."
          value={text}
          rows={20}
          serif
          onChange={(event) => {
            setText(event.target.value);
          }}
        />

        {/* The reason, next to the disabled button rather than behind it. */}
        {untouched && (
          <Text role="body-sm" tone="secondary">
            §4.12 — a review you did not edit is a review you did not do. Mark complete stays disabled while
            this is empty or identical to the draft.
          </Text>
        )}

        {problem !== null && (
          <Text role="body-sm" tone="critical">
            {problem}
          </Text>
        )}

        <Inline gap="2" wrap>
          <Button
            size="sm"
            variant="secondary"
            disabled={text.trim() === '' || save.isPending}
            onClick={() => {
              save.mutate('editing');
            }}
          >
            Save and keep going
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!canComplete}
            onClick={() => {
              save.mutate('complete');
            }}
          >
            Mark complete
          </Button>
        </Inline>

        <Text role="caption" tone="tertiary">
          Saving needs a connection. A review is a state transition on one row rather than an append, and the
          offline queue replays in the order things were queued rather than the order they happened.
        </Text>
      </Stack>

      {detail.draft !== null && detail.draft.prompts.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Questions
          </Text>
          {/* Questions, never conclusions. §10.0 and §4.7: the system does not
              tell a tired person what their month meant. */}
          <Text role="caption" tone="tertiary">
            These are questions, not findings. Nothing here claims one thing caused another.
          </Text>
          <Stack gap="1">
            {detail.draft.prompts.map((prompt) => (
              <Text key={prompt} role="body-sm" tone="secondary" as="p" serif>
                {prompt}
              </Text>
            ))}
          </Stack>
        </Stack>
      )}

      <Inline gap="3" wrap>
        <Link className="nos-inline-link" href="/life/reviews">
          Back to the reviews
        </Link>
      </Inline>
    </Stack>
  );
}

