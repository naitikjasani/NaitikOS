'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  LIFE_SPAN_KINDS,
  LIFE_SPAN_KIND_LABELS,
  MAX_SLOT,
  MIN_SLOT,
  TIMELINE_SCALES,
  TIMELINE_SCALE_LABELS,
  systemClock,
} from '@naitikos/core';
import type { LifeSpanKind, TimelineScale } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  Stack,
  Text,
  TextAreaField,
  TextField,
  seriesColorVar,
} from '@naitikos/design-system';

import type { LifeTimeline, PaletteSlot } from '@/lib/platform/life-timeline';
import { closeSpan, saveEvent, saveSpan } from '../services/lifeClient';

/**
 * `/timeline/life` — §10.8.
 *
 * ## Why this is a separate route from `/timeline`
 *
 * §3.2 writes the existing timeline as `/timeline?scale=day|week|month|year|life`,
 * which reads as one surface with a zoom control. It is not, and building it
 * that way would have produced one component with two unrelated halves.
 *
 * `/timeline` is the projection of the domain event log: every logged set,
 * every meal, every dose. It answers "what did I do". This page reads
 * `life_span` and `life_event` — three tables, a few dozen rows, all authored
 * by hand — and answers "what was happening in my life at the time". Different
 * tables, different questions, different write paths. The zoom control on this
 * page (`year` / `decade` / `life`) is the part of §3.2's `scale` that belongs
 * here.
 *
 * ## Nothing on this page is inferred
 *
 * §10.0 — the model never computes, discovers, or asserts — and the same limit
 * applies to the deterministic code. The record can say where the operator was
 * and what they logged; it cannot say a year was "the year I moved out".
 * Inferring a chapter boundary from a change in observation density would be
 * asserting a shape onto a life, so every bar and every marker here was typed
 * in by the person it belongs to.
 *
 * ## The empty state tells the truth about the timescale
 *
 * §10.8 is unusually frank: "Its value is entirely in the long run. At year one
 * it is a novelty; at year ten it is the only place a person can see their own
 * life as a shape." A page that dressed up three rows as an achievement would
 * be lying about what this is for, so the empty state says what it is waiting
 * for instead.
 *
 * "Nothing recorded at all" and "nothing in this window" get different words.
 * Conflating them would tell a five-year user their timeline is empty because
 * they happened to be looking at the last twelve months.
 *
 * ## Overlapping spans get their own lane
 *
 * A job and a relationship genuinely overlap, and drawing them on one line
 * would hide whichever was painted second. `layoutSpans` packs them greedily
 * into lanes in `core`; this file only positions what it is handed.
 *
 * ## An open span is drawn to today and labelled as open
 *
 * The bar reaches the right edge because that is where the operator still is,
 * but `endedAt` stays null in the record. Writing today's date into it every
 * night would make the most important span the one that is constantly being
 * rewritten, and would turn "still going" into a false precise ending.
 */
export function LifeTimelineScreen({
  timeline,
  scale,
}: {
  readonly timeline: LifeTimeline;
  readonly scale: TimelineScale;
}): ReactNode {
  const router = useRouter();
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState<'span' | 'event' | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const close = useMutation({
    mutationFn: async (input: { id: string; endedAt: string }) => {
      await closeSpan(input);
    },
    onSuccess: refresh,
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not close that span.');
    },
  });

  return (
    <Stack gap="6">
      <Inline gap="2" wrap>
        {TIMELINE_SCALES.map((option) => (
          <Button
            key={option}
            size="sm"
            variant={option === scale ? 'primary' : 'secondary'}
            aria-pressed={option === scale}
            onClick={() => {
              router.push(`/timeline/life?scale=${option}`);
            }}
          >
            {TIMELINE_SCALE_LABELS[option]}
          </Button>
        ))}
      </Inline>

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {timeline.bounds === null ? (
        <EmptyState
          title={timeline.hasNothing ? 'Nothing on the timeline yet' : 'Nothing in this window'}
          description={
            timeline.hasNothing
              ? 'Eras and chapters are written by hand — the record can say what you did, not what it meant. This page is worth almost nothing in year one and is the only place to see a life as a shape by year ten.'
              : 'There are entries, but none inside this range. Try a wider scale.'
          }
        />
      ) : (
        <Stack gap="3">
          <Text role="caption" tone="tertiary">
            {timeline.bounds.fromDayKey} to {timeline.bounds.toDayKey} ·{' '}
            {String(timeline.bounds.years)} {timeline.bounds.years === 1 ? 'year' : 'years'}
          </Text>

          <Card variant="outlined">
            <CardBody>
              <Stack gap="3">
                {timeline.lanes.map((lane) => (
                  <div key={lane.lane} className="nos-life-lane">
                    {lane.spans.map((span) => (
                      <div
                        key={span.id}
                        className="nos-life-span"
                        title={`${span.title}${span.open ? ' — still going' : ''}`}
                        style={
                          {
                            /*
                             * The slot maps to a colour through the design
                             * system's own `seriesColorVar`, not a hex literal.
                             * §8.9 keeps chart colour behind a token so a theme
                             * change repaints everything at once and no span can
                             * be given a value that fails contrast in one theme.
                             */
                            '--life-span-colour': seriesColorVar(span.slot),
                            left: `${String(span.from * 100)}%`,
                            width: `${String(Math.max(0.5, (span.to - span.from) * 100))}%`,
                          } as CSSProperties
                        }
                      >
                        <span className="nos-life-span__label">{span.title}</span>
                      </div>
                    ))}
                  </div>
                ))}

                {timeline.events.length > 0 && (
                  <div className="nos-life-lane nos-life-lane--events">
                    {timeline.events.map((event) => (
                      <div
                        key={event.id}
                        className="nos-life-event"
                        title={`${event.title} · ${event.occurredAt.slice(0, 10)}`}
                        style={{ left: `${String(event.at * 100)}%` }}
                      />
                    ))}
                  </div>
                )}
              </Stack>
            </CardBody>
          </Card>
        </Stack>
      )}

      <Inline gap="2">
        <Button
          variant="secondary"
          onClick={() => {
            setAdding(adding === 'span' ? null : 'span');
          }}
        >
          {adding === 'span' ? 'Cancel' : 'Add an era or chapter'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setAdding(adding === 'event' ? null : 'event');
          }}
        >
          {adding === 'event' ? 'Cancel' : 'Add an event'}
        </Button>
      </Inline>

      {adding === 'span' && (
        <SpanForm
          timeline={timeline}
          onSaved={() => {
            setAdding(null);
            refresh();
          }}
          onProblem={setProblem}
        />
      )}
      {adding === 'event' && (
        <EventForm
          timeline={timeline}
          onSaved={() => {
            setAdding(null);
            refresh();
          }}
          onProblem={setProblem}
        />
      )}

      {timeline.spans.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Spans
          </Text>
          {timeline.spans.map((span) => (
            <Card key={span.id} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {span.title}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {span.startedAt.slice(0, 10)} —{' '}
                      {span.endedAt === null ? 'still going' : span.endedAt.slice(0, 10)}
                    </Text>
                    {span.description !== null && (
                      <Text role="caption" tone="tertiary">
                        {span.description}
                      </Text>
                    )}
                  </Stack>
                  <Inline gap="2" align="center">
                    <Badge tone={span.kind === 'era' ? 'accent' : 'neutral'}>
                      {LIFE_SPAN_KIND_LABELS[span.kind]}
                    </Badge>
                    {span.endedAt === null && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={close.isPending}
                        onClick={() => {
                          close.mutate({
                            id: span.id,
                            /* Noon, like every day-anchored instant here: midnight
                             * sits on a boundary a DST rule can push into the
                             * previous day. */
                            endedAt: `${todayDayKey()}T12:00:00.000Z`,
                          });
                        }}
                      >
                        Ended today
                      </Button>
                    )}
                  </Inline>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** Today, as a day key. The form is day-granular; the zone is the profile's. */
function todayDayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(systemClock.nowMillis());
}

const SLOTS: readonly PaletteSlot[] = [1, 2, 3, 4, 5, 6, 7, 8];

function SpanForm({
  timeline,
  onSaved,
  onProblem,
}: {
  readonly timeline: LifeTimeline;
  readonly onSaved: () => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const [kind, setKind] = useState<LifeSpanKind>('chapter');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startedDay, setStartedDay] = useState(todayDayKey());
  const [endedDay, setEndedDay] = useState('');
  const [slot, setSlot] = useState<PaletteSlot>(1);
  const [parentId, setParentId] = useState<string | null>(null);

  const eras = timeline.spans.filter((span) => span.kind === 'era');

  const save = useMutation({
    mutationFn: async () => {
      await saveSpan({
        id: uuidV7(systemClock.nowMillis()),
        kind,
        title: title.trim(),
        description: description.trim() === '' ? null : description.trim(),
        startedAt: `${startedDay}T12:00:00.000Z`,
        /* Left null unless an ending was actually given. A span with no end is
         * still running, and today's date is not a substitute for that fact. */
        endedAt: endedDay === '' ? null : `${endedDay}T12:00:00.000Z`,
        parentId: kind === 'chapter' ? parentId : null,
        slot,
      });
    },
    onSuccess: onSaved,
    onError: (error: unknown) => {
      onProblem(error instanceof Error ? error.message : 'Could not save that span.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Inline gap="2" wrap>
            {LIFE_SPAN_KINDS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === kind ? 'primary' : 'secondary'}
                aria-pressed={option === kind}
                onClick={() => {
                  setKind(option);
                }}
              >
                {LIFE_SPAN_KIND_LABELS[option]}
              </Button>
            ))}
          </Inline>
          <Text role="caption" tone="tertiary">
            An era is a phase of life. A chapter is a job, a move, a relationship — and may sit inside one.
          </Text>

          <TextField
            label="Title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <TextAreaField
            label="What it was"
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <Inline gap="3" wrap>
            <DateField label="Started" value={startedDay} onValueChange={setStartedDay} />
            <DateField
              label="Ended"
              hint="Leave blank while it is still going."
              value={endedDay}
              onValueChange={setEndedDay}
            />
          </Inline>

          {kind === 'chapter' && eras.length > 0 && (
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Inside which era
              </Text>
              <Inline gap="2" wrap>
                {eras.map((era) => (
                  <Button
                    key={era.id}
                    size="sm"
                    variant={era.id === parentId ? 'primary' : 'secondary'}
                    aria-pressed={era.id === parentId}
                    onClick={() => {
                      setParentId(era.id === parentId ? null : era.id);
                    }}
                  >
                    {era.title}
                  </Button>
                ))}
              </Inline>
            </Stack>
          )}

          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              Colour
            </Text>
            <Inline gap="2" wrap>
              {SLOTS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="nos-life-swatch"
                  aria-label={`Colour ${String(option)}`}
                  aria-pressed={option === slot}
                  style={{ background: seriesColorVar(option) }}
                  onClick={() => {
                    setSlot(option);
                  }}
                />
              ))}
            </Inline>
            <Text role="caption" tone="tertiary">
              A palette slot between {String(MIN_SLOT)} and {String(MAX_SLOT)}, not a colour — the theme
              decides what it looks like.
            </Text>
          </Stack>

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={title.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
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

const SIGNIFICANCES = [1, 2, 3, 4, 5] as const;

function EventForm({
  timeline,
  onSaved,
  onProblem,
}: {
  readonly timeline: LifeTimeline;
  readonly onSaved: () => void;
  readonly onProblem: (message: string) => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [occurredDay, setOccurredDay] = useState(todayDayKey());
  const [significance, setSignificance] = useState<number | null>(null);
  const [spanId, setSpanId] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      await saveEvent({
        id: uuidV7(systemClock.nowMillis()),
        title: title.trim(),
        description: description.trim() === '' ? null : description.trim(),
        occurredAt: `${occurredDay}T12:00:00.000Z`,
        spanId,
        significance,
      });
    },
    onSuccess: onSaved,
    onError: (error: unknown) => {
      onProblem(error instanceof Error ? error.message : 'Could not save that event.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="What happened"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <TextAreaField
            label="Detail"
            rows={2}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
          <DateField label="When" value={occurredDay} onValueChange={setOccurredDay} />

          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              How large it looms
            </Text>
            <Inline gap="2" wrap>
              {SIGNIFICANCES.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={value === significance ? 'primary' : 'secondary'}
                  aria-pressed={value === significance}
                  onClick={() => {
                    setSignificance(value === significance ? null : value);
                  }}
                >
                  {String(value)}
                </Button>
              ))}
            </Inline>
            {/* Optional, and the operator's judgement alone. Nothing computes
                significance — a 1-to-5 scale here is a feeling, not a measure. */}
            <Text role="caption" tone="tertiary">
              Optional. Yours to decide — nothing here works it out for you.
            </Text>
          </Stack>

          {timeline.spans.length > 0 && (
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                During
              </Text>
              <Inline gap="2" wrap>
                {timeline.spans.map((span) => (
                  <Button
                    key={span.id}
                    size="sm"
                    variant={span.id === spanId ? 'primary' : 'secondary'}
                    aria-pressed={span.id === spanId}
                    onClick={() => {
                      setSpanId(span.id === spanId ? null : span.id);
                    }}
                  >
                    {span.title}
                  </Button>
                ))}
              </Inline>
            </Stack>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={title.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
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
