'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { uuidV7 } from '@naitikos/shared';
import { formatDay, parseTooth, systemClock, toothLabel } from '@naitikos/core';
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
  TextField,
} from '@naitikos/design-system';

import type { TeethOverview } from '@/lib/platform/teeth';
import { recordProcedure } from '../services/teethClient';

/**
 * `/body/teeth/procedures` — §4.5's per-tooth history.
 *
 * ## Grouped by tooth, not by date
 *
 * The question §4.5 exists to answer is *"what has been done to my teeth"*, and
 * a flat chronology does not answer it. A tooth with three procedures over
 * eight years is precisely the record "no dental practice will reliably retain
 * across relocations, insurers, or practitioner changes".
 *
 * ## The tooth number is validated but never corrected
 *
 * A notation this system cannot read is stored and displayed exactly as
 * written, and simply gets no place on the chart. That is visibly different
 * from being placed on the wrong one, and the form says which reading it made
 * as you type — so a mistyped `63` announcing itself as a primary canine is
 * caught before it is saved rather than after.
 */
export function ProceduresScreen({
  overview,
  zone,
}: {
  readonly overview: TeethOverview;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [tooth, setTooth] = useState('');
  const [performedBy, setPerformedBy] = useState('');
  const [day, setDay] = useState('');
  const [cost, setCost] = useState('');
  const [currency, setCurrency] = useState('INR');

  const save = useMutation({
    mutationFn: async () => {
      await recordProcedure({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        toothNotation: tooth.trim() === '' ? null : tooth.trim(),
        performedBy: performedBy.trim() === '' ? null : performedBy.trim(),
        location: null,
        /* Noon: a procedure date is a day, and midnight sits on a boundary a
           DST rule can push into the previous one. */
        performedAt: `${day}T12:00:00.000Z`,
        zone,
        outcome: null,
        complications: null,
        costMinor: cost.trim() === '' ? null : Math.round(Number(cost) * 100),
        currency: cost.trim() === '' ? null : currency.trim().toUpperCase(),
      });
    },
    onSuccess: () => {
      setAdding(false);
      setName('');
      setTooth('');
      setPerformedBy('');
      setDay('');
      setCost('');
      router.refresh();
    },
  });

  const reading = tooth.trim() === '' ? null : parseTooth(tooth);
  const usable = name.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/u.test(day);

  const grouped = [...overview.byTooth.entries()]
    .filter(([key]) => key !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  const unattached = overview.byTooth.get('') ?? [];

  return (
    <Stack gap="6">
      {adding ? (
        <Card variant="raised">
          <CardBody>
            <Stack gap="4">
              <Text role="title-3" as="h2">
                Record a procedure
              </Text>
              <TextField
                label="What was done"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                placeholder="Root canal"
              />
              <TextField
                label="Tooth (optional)"
                value={tooth}
                inputMode="numeric"
                onChange={(event) => {
                  setTooth(event.target.value);
                }}
                placeholder="36"
                hint={
                  reading === null
                    ? 'FDI notation — 36 is the lower-left first molar. Leave blank for work that is not on one tooth.'
                    : `Reads as: ${reading.label}.`
                }
              />
              <DateField label="When" value={day} onValueChange={setDay} />
              <TextField
                label="Who did it (optional)"
                value={performedBy}
                onChange={(event) => {
                  setPerformedBy(event.target.value);
                }}
              />
              <Inline gap="2">
                <TextField
                  label="Cost (optional)"
                  value={cost}
                  inputMode="decimal"
                  onChange={(event) => {
                    setCost(event.target.value);
                  }}
                />
                <TextField
                  label="Currency"
                  value={currency}
                  onChange={(event) => {
                    setCurrency(event.target.value);
                  }}
                />
              </Inline>
              <Inline gap="2" justify="between" align="center">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setAdding(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!usable || save.isPending}
                  onClick={() => {
                    save.mutate();
                  }}
                >
                  Record it
                </Button>
              </Inline>
            </Stack>
          </CardBody>
        </Card>
      ) : (
        <Inline justify="end">
          <Button
            variant="secondary"
            onClick={() => {
              setAdding(true);
            }}
          >
            Record a procedure
          </Button>
        </Inline>
      )}

      {overview.procedures.length === 0 ? (
        <EmptyState
          icon="domain.clinical"
          title="No procedures recorded"
          description="Fillings, root canals, extractions and cleanings, per tooth, kept for as long as the record lasts."
        />
      ) : (
        <>
          {grouped.map(([notation, procedures]) => (
            <Stack gap="2" key={notation}>
              <Inline gap="2" align="center">
                <Text role="title-3" as="h2">
                  Tooth {notation}
                </Text>
                <Text role="caption" tone="tertiary">
                  {toothLabel(notation)}
                </Text>
              </Inline>
              {procedures.map((procedure) => (
                <Card key={procedure.id} variant="outlined">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Stack gap="1">
                        <Text role="body" as="span">
                          {procedure.name}
                        </Text>
                        <Text role="caption" tone="tertiary">
                          {procedure.performedAt === null ? 'Date not recorded' : formatDay(procedure.performedAt)}
                          {procedure.performedBy === null ? '' : ` · ${procedure.performedBy}`}
                        </Text>
                      </Stack>
                      {procedure.costMinor !== null && procedure.currency !== null && (
                        <Badge tone="neutral">
                          {procedure.currency} {(procedure.costMinor / 100).toFixed(2)}
                        </Badge>
                      )}
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          ))}

          {unattached.length > 0 && (
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Not on one tooth
              </Text>
              {unattached.map((procedure) => (
                <Card key={procedure.id} variant="flat">
                  <CardBody>
                    <Inline justify="between" align="center" wrap>
                      <Text role="body-sm" as="span">
                        {procedure.name}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {procedure.performedAt === null ? '' : formatDay(procedure.performedAt)}
                      </Text>
                    </Inline>
                  </CardBody>
                </Card>
              ))}
            </Stack>
          )}
        </>
      )}

      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/body/teeth">
          Back to Teeth
        </Link>
      </Text>
    </Stack>
  );
}
