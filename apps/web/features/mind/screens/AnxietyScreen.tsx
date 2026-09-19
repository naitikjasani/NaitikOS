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

import { CrisisCard } from '../components/CrisisCard';
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
 *
 * ## The crisis plan is shown here too, on exactly the same condition as `/mind`
 *
 * §10.10: "Detected crisis indicators route to exactly one behaviour: display
 * the user's own stored crisis plan." The service decides — `overview.crisis` is
 * non-null only when `core` has found the sustained run §4.7 describes — and
 * until now only the pillar overview rendered it. That is the wrong place for it
 * to be the *only* place. Somebody mid-episode is on this route, because this
 * route is where the "it's happening" button lives; requiring them to navigate
 * back up to `/mind` to reach what they wrote for themselves is a navigation
 * asked of the person least able to make it.
 *
 * It sits above the form rather than below the episode list, and there is no
 * disclosure around it. Nothing about the condition is explained: §4.7's card
 * shows the plan back and says nothing about which reading crossed which line.
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
  /*
   * Whether the last thing that happened here was a successful record.
   *
   * `log.isSuccess` stays true for the lifetime of the mutation, which would
   * leave "Recorded." on screen an hour later above an empty form — a true
   * statement about the past presented as a statement about now. Cleared on the
   * first keystroke of the next entry, for the same reason the journal clears
   * its own notice.
   */
  const [justRecorded, setJustRecorded] = useState(false);

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
      setJustRecorded(true);
      setIntensity(null);
      setTrigger('');
      setCoping('');
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['mind', 'overview'] });
    },
  });

  const episodes = overview.data?.episodes ?? [];
  const summary = summariseEpisodes(episodes);

  const crisis = overview.data?.crisis ?? null;

  return (
    <Stack gap="5">
      {/* First on the page when it is on the page at all. See the file header. */}
      {crisis !== null && <CrisisCard plan={crisis.plan} />}

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

            {/*
              What just happened, said out loud.

              The button clears the form and the list below re-fetches, which on
              a slow connection is several seconds of nothing. §4.0's argument
              for the one-tap record only holds if the tap is visibly a record —
              a person mid-episode who is not sure whether it went in will tap
              again, and two rows for one episode is a quietly corrupted count in
              the table a psychiatrist might one day read.

              `polite`, and the string is stable across renders, so it announces
              the transition rather than the typing (§8.13).
            */}
            <Text role="caption" tone="tertiary" aria-live="polite">
              {log.error !== null
                ? 'That did not record. Nothing was lost — the details below are still here.'
                : justRecorded
                  ? 'Recorded. Add the details below whenever you want to, or not at all.'
                  : 'Recorded straight away. Everything below is optional, now or later.'}
            </Text>

            <ScaleField
              label="Intensity"
              value={intensity}
              onValueChange={(next) => {
                setJustRecorded(false);
                setIntensity(next);
              }}
              minLabel="Mild"
              maxLabel="Severe"
            />

            <TextField
              label="What set it off, if you know"
              value={trigger}
              onChange={(event) => {
                setJustRecorded(false);
                setTrigger(event.target.value);
              }}
              hint="Your words. Nothing is suggested here on purpose."
            />

            <TextField
              label="What you did"
              value={coping}
              onChange={(event) => {
                setJustRecorded(false);
                setCoping(event.target.value);
              }}
            />

            <TextAreaField
              label="Anything else"
              value={note}
              onChange={(event) => {
                setJustRecorded(false);
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

          {/*
            A heading, because a bare run of cards after a summary card reads as
            more summary. The count is deliberately not repeated here — it is in
            the card above, and a second one invites the arithmetic §4.7 rules
            out. "Recorded", not "logged" and not "attacks": these are the rows
            the operator chose to write down, and nothing about the list is a
            claim that it is complete.
          */}
          {episodes.length > 0 && (
            <Text role="title-3" as="h2">
              Recorded episodes
            </Text>
          )}

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
