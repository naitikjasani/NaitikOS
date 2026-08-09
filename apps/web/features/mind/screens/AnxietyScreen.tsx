'use client';

import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidV7 } from '@naitikos/shared';
import { episodeDurationMinutes, shiftDayKey, summariseEpisodes, systemClock } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  Inline,
  LoadingState,
  ScaleField,
  Stack,
  Text,
  TextAreaField,
  TextField,
} from '@naitikos/design-system';

import { fetchMindOverview, logEpisode } from '../services/mindClient';

/**
 * `/mind/anxiety` — episodes and what the operator named as triggers.
 *
 * ## The form has one required field, and it is a timestamp
 *
 * Everything else — intensity, trigger, what they did, whether it helped — is
 * optional, and the submit button works with none of it filled in. §4.0's
 * argument applies with more force here than anywhere: "a system that only
 * accepts complete records trains the user to log nothing on a bad day, and bad
 * days are the clinically interesting ones." The worst episodes are the ones
 * least likely to be accompanied by the patience for a form.
 *
 * So the primary action is **"It's happening"** — one tap, one row, nothing
 * else asked for. The detail fields are below it and can be filled in later, or
 * never.
 *
 * ## The trigger field offers nothing
 *
 * A free text input with no autocomplete, no chips, no suggestions. §4.7 forbids
 * the system from making causal claims about mental state, and a picker of
 * common triggers is a menu of explanations — the operator would choose from
 * *our* list rather than describing theirs, and the record would slowly become
 * a record of the list.
 *
 * The tally below *does* group what they have typed, because that is their own
 * vocabulary counted back to them. It is labelled "what you named", never
 * "your triggers".
 */

const WINDOW_DAYS = 90;

export function AnxietyScreen({
  dayKey,
  zone,
  nowIso,
}: {
  readonly dayKey: string;
  readonly zone: string;
  readonly nowIso: string;
}): ReactNode {
  const queryClient = useQueryClient();
  const fromDayKey = shiftDayKey(dayKey, -(WINDOW_DAYS - 1)) ?? dayKey;

  const [intensity, setIntensity] = useState<number | null>(null);
  const [trigger, setTrigger] = useState('');
  const [coping, setCoping] = useState('');
  const [note, setNote] = useState('');

  const overview = useQuery({
    queryKey: ['mind', 'overview', fromDayKey, dayKey, zone],
    queryFn: () => fetchMindOverview(fromDayKey, dayKey, zone),
  });

  const log = useMutation({
    mutationFn: async () => {
      await logEpisode({
        id: uuidV7(systemClock.nowMillis()),
        startedAt: nowIso,
        zone,
        intensity,
        trigger: trigger.trim() === '' ? null : trigger.trim(),
        copingResponse: coping.trim() === '' ? null : coping.trim(),
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: async () => {
      setIntensity(null);
      setTrigger('');
      setCoping('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['mind', 'overview'] });
    },
  });

  const episodes = overview.data?.episodes ?? [];
  const summary = summariseEpisodes(episodes);

  return (
    <Stack gap="5">
      <Card variant="raised">
        <CardBody>
          <Stack gap="4">
            {/*
              The whole feature in one tap. Everything below is optional and the
              button does not wait for it.
            */}
            <Button
              variant="primary"
              size="lg"
              fullWidth
              onClick={() => {
                log.mutate();
              }}
              disabled={log.isPending}
            >
              It’s happening — record it
            </Button>

            <Text role="caption" tone="tertiary">
              Recorded straight away. Everything below is optional, now or later.
            </Text>

            <ScaleField
              label="Intensity"
              value={intensity}
              onValueChange={setIntensity}
              minLabel="Mild"
              maxLabel="Severe"
            />

            <TextField
              label="What set it off, if you know"
              value={trigger}
              onChange={(event) => {
                setTrigger(event.target.value);
              }}
              hint="Your words. Nothing is suggested here on purpose."
            />

            <TextField
              label="What you did"
              value={coping}
              onChange={(event) => {
                setCoping(event.target.value);
              }}
            />

            <TextAreaField
              label="Anything else"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
              rows={3}
            />
          </Stack>
        </CardBody>
      </Card>

      {overview.isLoading ? (
        <LoadingState label="Loading episodes" />
      ) : (
        <>
          <Card variant="outlined">
            <CardBody>
              <Stack gap="2">
                <Text role="title-3" as="h2">
                  Last {String(WINDOW_DAYS)} days
                </Text>
                <Text role="body-sm" tone="secondary">
                  {String(summary.count)} recorded.
                  {summary.meanClosedMinutes === null
                    ? ' None has an end time yet, so there is no duration to report.'
                    : ` The ${String(summary.closedCount)} with an end time averaged ${String(Math.round(summary.meanClosedMinutes))} minutes.`}
                </Text>

                {summary.namedTriggers.length > 0 && (
                  <Stack gap="1">
                    <Text role="caption" tone="tertiary">
                      What you named
                    </Text>
                    <Inline gap="2" wrap>
                      {summary.namedTriggers.slice(0, 8).map((item) => (
                        <Badge key={item.trigger} tone="neutral">
                          {item.trigger} · {String(item.count)}
                        </Badge>
                      ))}
                    </Inline>
                  </Stack>
                )}
              </Stack>
            </CardBody>
          </Card>

          {episodes.map((episode) => {
            const minutes = episodeDurationMinutes(episode);
            return (
              <Card key={episode.id} variant="outlined">
                <CardBody>
                  <Stack gap="1">
                    <Inline justify="between" align="center">
                      <Text role="body-sm" as="span">
                        {episode.startedAt.slice(0, 10)}
                      </Text>
                      <Text role="mono" as="span">
                        {episode.intensity === null ? '—' : `${String(episode.intensity)} / 5`}
                        {/* Open episodes say so rather than showing a zero. */}
                        {minutes === null ? ' · open' : ` · ${String(minutes)} min`}
                      </Text>
                    </Inline>
                    {episode.trigger !== null && (
                      <Text role="body-sm" tone="secondary">
                        {episode.trigger}
                      </Text>
                    )}
                    {episode.copingResponse !== null && (
                      <Text role="caption" tone="tertiary">
                        Did: {episode.copingResponse}
                      </Text>
                    )}
                  </Stack>
                </CardBody>
              </Card>
            );
          })}
        </>
      )}
    </Stack>
  );
}
