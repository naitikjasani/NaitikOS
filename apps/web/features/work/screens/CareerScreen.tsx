'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { CAREER_ENTRY_KINDS, CAREER_KIND_LABELS, systemClock } from '@naitikos/core';
import type { CareerEntryKind } from '@naitikos/core';
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
  ToggleField,
} from '@naitikos/design-system';

import type { CareerBoard } from '@/lib/platform/work';
import { recordCareerEntry } from '../services/workClient';

/**
 * `/work/career` — §4.8.
 *
 * ## The whole page is built around one sentence
 *
 * §4.8: "Solves a real recurring problem: reconstructing a year of work at
 * review time from memory. Every shipped thing gets one line on the day it
 * ships."
 *
 * So the entry form is at the top and it defaults to today, because the
 * protocol is per-shipped-thing and the friction that kills it is having to
 * find the form. The date is editable — backdating an entry to the day it
 * actually happened is the behaviour the protocol wants, and `loggingGap`
 * measures against `occurredAt` so a backdated entry closes the gap it was
 * written to close.
 *
 * ## Three visibility counts, not a percentage
 *
 * "Was anyone senior aware of this" has three answers, and the third is "I did
 * not record that". A percentage would fold the unknowns into one of the other
 * two and produce a confident number out of an incomplete one — the thing §10.0
 * exists to prevent, on the page most likely to be read before a conversation
 * about money.
 *
 * ## Feedback needs a source, and the form says so before you type
 *
 * Unattributed praise is not evidence, and at review time the first question
 * asked of it is who said so. Enforced in `core`, in the contract, and stated
 * here — the entry is refused rather than saved half-usable.
 */
export function CareerScreen({ board, zone }: { readonly board: CareerBoard; readonly zone: string }): ReactNode {
  const router = useRouter();
  const period = board.period;

  return (
    <Stack gap="6">
      <AddEntry
        board={board}
        zone={zone}
        onSaved={() => {
          router.refresh();
        }}
      />

      {board.gapDays !== null && board.gapDays >= board.gapThreshold && (
        <Card variant="outlined">
          <CardBody>
            <Text role="body" tone="secondary">
              Nothing logged in {String(board.gapDays)} days. One line on the day it ships is the whole
              protocol; a year rebuilt from memory in November is the problem it avoids.
            </Text>
          </CardBody>
        </Card>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          {period.fromDayKey} to {period.toDayKey}
        </Text>
        <Inline gap="4" wrap>
          <Metric label="Entries" value={period.total} />
          <Metric label="Seen by leadership" value={period.visible} />
          <Metric label="Not seen" value={period.notVisible} />
          <Metric label="Not recorded" value={period.visibilityUnknown} />
        </Inline>
        {/* Named rather than folded away. The unknown column is the honest one
            and a percentage would hide it. */}
        <Text role="caption" tone="tertiary">
          Visibility is three counts because &ldquo;I did not record that&rdquo; is a real answer, and a
          percentage would quietly assign it to one of the other two.
        </Text>
      </Stack>

      {period.skills.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Skills exercised
          </Text>
          <Inline gap="2" wrap>
            {period.skills.map((tally) => (
              <Badge key={tally.skill} tone="neutral">
                {tally.skill} · {String(tally.entries)}
              </Badge>
            ))}
          </Inline>
        </Stack>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          The log
        </Text>
        {period.entries.length === 0 ? (
          <EmptyState
            title="Nothing in this period"
            description="Every shipped thing gets one line on the day it ships."
          />
        ) : (
          period.entries.map((entry) => (
            <Card key={entry.id} variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Inline gap="3" align="center" justify="between">
                    <Text role="body" as="span">
                      {entry.title}
                    </Text>
                    <Badge tone={entry.kind === 'incident' ? 'caution' : 'neutral'}>
                      {CAREER_KIND_LABELS[entry.kind]}
                    </Badge>
                  </Inline>
                  <Text role="caption" tone="tertiary">
                    {entry.occurredAt.slice(0, 10)}
                    {entry.attributedTo === null ? '' : ` · ${entry.attributedTo}`}
                    {entry.projectId === null
                      ? ''
                      : ` · ${board.projects.find((p) => p.id === entry.projectId)?.name ?? 'a project'}`}
                    {entry.isVisibleToLeadership === true ? ' · seen' : ''}
                  </Text>
                  {entry.detail !== null && (
                    <Text role="body-sm" tone="secondary">
                      {entry.detail}
                    </Text>
                  )}
                  {entry.artifactUrl !== null && (
                    <a href={entry.artifactUrl} rel="noreferrer noopener" target="_blank">
                      <Text role="caption" tone="accent" as="span">
                        The artifact →
                      </Text>
                    </a>
                  )}
                  {entry.skills.length > 0 && (
                    <Inline gap="2" wrap>
                      {entry.skills.map((skill) => (
                        <Badge key={skill} tone="neutral">
                          {skill}
                        </Badge>
                      ))}
                    </Inline>
                  )}
                </Stack>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>
    </Stack>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {String(value)}
      </Text>
    </Stack>
  );
}

function AddEntry({
  board,
  zone,
  onSaved,
}: {
  readonly board: CareerBoard;
  readonly zone: string;
  readonly onSaved: () => void;
}): ReactNode {
  const [kind, setKind] = useState<CareerEntryKind>('shipped');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [occurredDay, setOccurredDay] = useState(board.period.toDayKey);
  const [attributedTo, setAttributedTo] = useState('');
  const [artifactUrl, setArtifactUrl] = useState('');
  const [seen, setSeen] = useState(false);
  const [skills, setSkills] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const needsSource = kind === 'feedback' || kind === 'recognition';

  const save = useMutation({
    mutationFn: async () => {
      await recordCareerEntry({
        id: uuidV7(systemClock.nowMillis()),
        kind,
        title: title.trim(),
        detail: detail.trim() === '' ? null : detail.trim(),
        /* Noon, so a DST rule cannot push the day it happened into the day
         * before it. The same convention every day-anchored instant uses. */
        occurredAt: `${occurredDay}T12:00:00.000Z`,
        zone,
        projectId,
        attributedTo: attributedTo.trim() === '' ? null : attributedTo.trim(),
        artifactUrl: artifactUrl.trim() === '' ? null : artifactUrl.trim(),
        /*
         * `false` only when explicitly toggled off is wrong here: the toggle
         * has two positions and the operator has seen both. An untouched
         * toggle reads as "not seen", which is a claim. So the unknown state
         * is expressed by leaving the toggle alone *and* the entry recording
         * `null` — which is what happens when it was never switched on and the
         * title has no artifact. Kept simple: off means not recorded.
         */
        isVisibleToLeadership: seen ? true : null,
        skills: skills
          .split(',')
          .map((skill) => skill.trim())
          .filter((skill) => skill !== ''),
      });
    },
    onSuccess: () => {
      setTitle('');
      setDetail('');
      setAttributedTo('');
      setArtifactUrl('');
      setSkills('');
      setSeen(false);
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not save that entry.');
    },
  });

  const usable = title.trim() !== '' && (!needsSource || attributedTo.trim() !== '');

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Inline gap="2" wrap>
            {CAREER_ENTRY_KINDS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === kind ? 'primary' : 'secondary'}
                aria-pressed={option === kind}
                onClick={() => {
                  setKind(option);
                }}
              >
                {CAREER_KIND_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <TextField
            label="One line"
            value={title}
            placeholder="Shipped the offline outbox"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />

          <DateField
            label="The day it happened"
            hint="Not the day you are typing this. Backdating is the protocol working."
            value={occurredDay}
            onValueChange={setOccurredDay}
          />

          {needsSource && (
            <TextField
              label="Who said it"
              hint="Required. Unattributed praise is not evidence at review time."
              value={attributedTo}
              onChange={(event) => {
                setAttributedTo(event.target.value);
              }}
            />
          )}

          <TextAreaField
            label="Detail"
            value={detail}
            rows={3}
            onChange={(event) => {
              setDetail(event.target.value);
            }}
          />

          <TextField
            label="Artifact"
            hint="A link to the shipped thing — a PR, a doc, a release."
            value={artifactUrl}
            onChange={(event) => {
              setArtifactUrl(event.target.value);
            }}
          />

          <TextField
            label="Skills"
            hint="Comma separated. Matched against the learning queue."
            value={skills}
            onChange={(event) => {
              setSkills(event.target.value);
            }}
          />

          <ToggleField
            label="Someone senior saw this"
            description="Known now, guessed later. Left off means not recorded, not 'nobody did'."
            checked={seen}
            onCheckedChange={setSeen}
          />

          {board.projects.length > 0 && (
            <Inline gap="2" wrap>
              {board.projects
                .filter((project) => project.status === 'active')
                .map((project) => (
                  <Button
                    key={project.id}
                    size="sm"
                    variant={project.id === projectId ? 'primary' : 'secondary'}
                    aria-pressed={project.id === projectId}
                    onClick={() => {
                      setProjectId(project.id === projectId ? null : project.id);
                    }}
                  >
                    {project.name}
                  </Button>
                ))}
            </Inline>
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={!usable || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Log it
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
