'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, CardBody, Divider, Inline, Spinner, Stack, Text, TextAreaField } from '@naitikos/design-system';

import type { AskResult } from '@/lib/platform/ask';
import type { RenderedParagraph } from '@/lib/platform/references';
import { askQuestion } from '../services/askClient';

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
 * §3.2 lists `/ask/:threadId` for "a saved line of enquiry". That needs a table
 * and it is not built; a single-turn surface is the honest version of this
 * screen until it is, rather than a fake thread that forgets.
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
                  <Paragraph key={index} paragraph={paragraph} />
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

              {result.unresolvedReferences > 0 && (
                /*
                 * The model named something that is not in the record — an
                 * observation since deleted, or an id it invented. Both render
                 * as a gap in the sentence above; this says how many, so an
                 * oddly-reading answer has a stated cause rather than leaving
                 * the operator to wonder.
                 */
                <Text role="caption" tone="tertiary">
                  {result.unresolvedReferences === 1 ?
                    'One figure could not be found in your record and is shown as a gap.'
                  : `${String(result.unresolvedReferences)} figures could not be found in your record and are shown as gaps.`
                  }
                </Text>
              )}
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

/**
 * One answered paragraph, with its figures marked as coming from the record.
 *
 * §10.10's guarantee — "the model is never the source of a figure the user
 * reads" — is invisible if a resolved number looks exactly like a written one.
 * The `<mark>` is not decoration: it is the interface saying *this came from
 * your data* about the one part of the sentence where that matters.
 *
 * An unresolved reference renders as an explicit gap. The model named an
 * observation that is not there — deleted, or invented — and the honest output
 * is a hole in the sentence. Substituting nothing would leave "has been below
 * on most days", which reads as complete and is missing its subject.
 */
function Paragraph({ paragraph }: { readonly paragraph: RenderedParagraph }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="body" as="p">
        {paragraph.rendered.segments.map((segment, index) => {
          if (segment.kind === 'text') return <span key={index}>{segment.text}</span>;
          if (segment.kind === 'value') {
            return (
              <mark key={index} className="nos-ask__figure" title="Read from your record">
                {segment.text}
              </mark>
            );
          }
          return (
            <span key={index} className="nos-ask__gap" title="This reference could not be resolved">
              &mdash;
            </span>
          );
        })}
      </Text>

      {paragraph.hasSuperseded && (
        <Text role="caption" tone="tertiary">
          {/*
            §9.1 makes a correction a supersession rather than an edit, so this
            answer still shows the figure it was written about. Rendering the
            correction in its place would make a saved answer say something the
            model never said.
          */}
          A figure here has been corrected since this was written. The value shown is the one the answer was
          about.
        </Text>
      )}
    </Stack>
  );
}
