'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, Divider, Inline, Spinner, Stack, Text, TextAreaField } from '@naitikos/design-system';

import type { AskResult } from '@/lib/platform/ask';
import { askQuestion } from '../services/askClient';
import { AnsweredParagraph, UnresolvedNote } from '../components/AnsweredParagraph';

/**
 * `/ask` — §4.13, and §2.5's deliberate demotion of it.
 *
 *   "Ask — the conversational surface over the graph. **Deliberately not the
 *    primary interface** (§2.5). Its value is the question you cannot express
 *    as a filter: *'what changed in the six weeks before my skin got worse?'*"
 *
 * ## It is not a chat
 *
 * One question, one answer, and the box clears. No thread, no history sidebar,
 * no typing indicator. §2.5 is explicit that a chat-first interface would be
 * the wrong shape for this system, and every affordance that makes a surface
 * feel conversational is an invitation to spend time in it — which §1.4 counts
 * as a counter-metric, not a success.
 *
 * §3.2's `/ask/:threadId` — "a saved line of enquiry" — now exists, and this
 * screen deliberately does not become it. Asking here answers and forgets. A
 * question worth returning to is saved to a thread by choosing one, which is an
 * act; a surface that saved every question by itself would be a chat log
 * nobody chose to keep.
 *
 * ## Figures are marked, because §10.10 is invisible otherwise
 *
 * The model emitted `{0}` and an observation id; the server read the row and
 * substituted the stored value. That guarantee — "the model is never the source
 * of a figure the user reads" — means nothing to a person if a resolved number
 * looks exactly like a written one, so a resolved figure is marked and an
 * unresolvable one renders as an explicit gap.
 *
 * ## Every answer shows what was not read
 *
 * §10.4 forbids silent truncation, and the pack's `omitted` line is rendered
 * whether or not there is an answer. An answer assembled from a partial context
 * reads as complete, and the operator has no way to tell.
 *
 * ## The examples are not placeholders
 *
 * They are the two questions §4.13 gives, shown as buttons. A blank box with a
 * blinking cursor is the worst possible onboarding for a surface whose value is
 * "the question you could not express as a filter" — most people cannot think
 * of one on demand.
 */

const EXAMPLES: readonly string[] = Object.freeze([
  'What changed in the six weeks before my skin got worse?',
  'How has my sleep moved over the last three months?',
  'Why has my energy been low this month?',
]);

export function AskScreen(): ReactNode {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length < 3 || busy) return;

    setBusy(true);
    setError(null);
    void askQuestion(trimmed)
      .then((next) => {
        setResult(next);
        /* The box clears. It is one question, not a thread. */
        setQuestion('');
      })
      .catch(() => {
        setError('Could not reach the answer. Every figure in the app is computed without a model and is unaffected.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Stack gap="5">
      <Stack gap="3">
        <TextAreaField
          label="Ask"
          labelHidden
          value={question}
          rows={3}
          placeholder="What changed in the six weeks before my skin got worse?"
          disabled={busy}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          onKeyDown={(event) => {
            /* Enter submits, shift-enter breaks the line. The question is one
             * or two sentences; requiring a mouse for the common case would be
             * friction on the only action this page has. */
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(question);
            }
          }}
        />

        <Inline justify="between" align="center" wrap>
          <Text role="caption" tone="tertiary">
            Every number in an answer comes from a query this system ran, never from the model.
          </Text>
          <Button
            variant="primary"
            isLoading={busy}
            disabled={question.trim().length < 3}
            onClick={() => {
              submit(question);
            }}
          >
            Ask
          </Button>
        </Inline>
      </Stack>

      {result === null && !busy && (
        <Stack gap="2">
          <Text role="caption" tone="tertiary">
            Questions this is for
          </Text>
          <Stack gap="1">
            {EXAMPLES.map((example) => (
              <Button
                key={example}
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuestion(example);
                  submit(example);
                }}
              >
                {example}
              </Button>
            ))}
          </Stack>
        </Stack>
      )}

      {busy && (
        <Inline gap="2" align="center">
          <Spinner size="sm" label="Thinking" />
          <Text role="body-sm" tone="tertiary">
            Reading your records.
          </Text>
        </Inline>
      )}

      {error !== null && (
        <Text role="body-sm" tone="critical">
          {error}
        </Text>
      )}

      {result !== null && <AnswerCard result={result} />}
    </Stack>
  );
}

function AnswerCard({ result }: { readonly result: AskResult }): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline justify="between" align="center" wrap>
            <Text role="body-sm" tone="secondary">
              {result.question}
            </Text>
            <Inline gap="2" align="center">
              <Badge tone="neutral">{result.kind}</Badge>
              <Text role="caption" tone="tertiary">
                {String(result.windowDays)} days read
              </Text>
            </Inline>
          </Inline>

          <Divider />

          {result.answer === null ? (
            <Stack gap="2">
              <Text role="body-sm" as="p">
                {result.problem ?? 'No answer was produced.'}
              </Text>
              {result.problem?.includes('AI settings') === true && (
                <Link className="nos-inline-link" href="/settings/ai">
                  Open AI settings
                </Link>
              )}
            </Stack>
          ) : (
            <Stack gap="3">
              {result.answer.answerable ? (
                result.paragraphs.map((paragraph, index) => (
                  <AnsweredParagraph key={index} paragraph={paragraph} />
                ))
              ) : (
                <Text role="body" as="p">
                  {/* §10.9's principle generalised: degrade to "insufficient
                      data" rather than guessing. */}
                  There is not enough in the record to answer that.
                </Text>
              )}

              <Divider />

              {/* §10.4: never silently truncate. Rendered always, including
                  when nothing was left out. */}
              <Text role="caption" tone="tertiary">
                {result.answer.omitted}
              </Text>

              {/*
                The model named something not in the record — an observation
                since deleted, or an id it invented. Both render as a gap in the
                sentence above; this says how many, so an oddly-reading answer
                has a stated cause rather than leaving the operator to wonder.
              */}
              <UnresolvedNote count={result.unresolvedReferences} />
            </Stack>
          )}

          {result.answer === null && result.omitted !== '' && (
            <Text role="caption" tone="tertiary">
              {result.omitted}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
