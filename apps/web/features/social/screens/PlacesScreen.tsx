'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import {
  PLACE_KINDS,
  PLACE_LABELS,
  TRIP_PURPOSES,
  TRIP_PURPOSE_LABELS,
  nightsAway,
  systemClock,
} from '@naitikos/core';
import type { PlaceKind, TripPurpose, Visit } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  DateField,
  EmptyState,
  Inline,
  SegmentedControl,
  Stack,
  TextField,
  Text,
} from '@naitikos/design-system';

import type { PlacesBoard } from '@/lib/platform/social';
import { savePlace, saveTrip, saveVisit } from '../services/socialClient';

/**
 * `/life/places` — §3.2's "Places & travel".
 *
 * ## This page exists to explain other pages
 *
 * Not as a travel diary. §10.6's detectors watch for changes in series, and a
 * fortnight abroad moves sleep midpoint, weight, skin state and training volume
 * at once for reasons that have nothing to do with anything being measured.
 * §5.3 already insists a workout at 7am during travel is a materially different
 * fact; a visit is that fact at the scale of a fortnight.
 *
 * So the number at the top is **days away in the last month**. That is the
 * figure another page needs to know before it reports a disruption as a
 * finding, and it is the reason to open this one.
 *
 * ## Overlaps are shown, not prevented
 *
 * A person is in one place at a time, so two visits claiming the same day are a
 * mistake — nearly always a departure date left blank. Refusing the write would
 * make the fix impossible from the page showing the problem, so the write is
 * accepted and the conflict is listed. P5: the operator is always right, and
 * always able to correct the record.
 *
 * An open-ended visit does *not* count as an overlap with a later one. Home is
 * where you are when you are not somewhere else, and nobody types a departure
 * date for their own house before a weekend away.
 */
export function PlacesScreen({ board }: { readonly board: PlacesBoard }): ReactNode {
  const router = useRouter();
  const [panel, setPanel] = useState<'none' | 'place' | 'trip' | 'visit'>('none');
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
    setPanel('none');
  };

  const onError = (error: unknown): void => {
    setProblem(error instanceof Error ? error.message : 'That did not save.');
  };

  const byId = new Map(board.places.map((place) => [place.id, place]));
  /* `?? null` because a visit can point at a soft-deleted place — the FK is
   * still satisfied, and `byId` only holds live rows. Rendering "Whereabouts"
   * is the right answer there; inventing a name is not. */
  const current = board.currentVisit === null ? null : (byId.get(board.currentVisit.placeId) ?? null);

  return (
    <Stack gap="5">
      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="2">
            <Inline gap="3" justify="between" align="baseline">
              <Text role="title-3" as="h2">
                {current === null ? 'Whereabouts' : current.name}
              </Text>
              <Badge tone="neutral">
                {String(board.travelDayKeys.length)} of {String(board.windowDays)} days away
              </Badge>
            </Inline>
            <Text role="caption" tone="tertiary">
              {current === null ?
                'No visit covers today, so this system does not know where you are. A day with no record is not counted as travel either way.'
              : `Since ${board.currentVisit?.arrivedOn ?? ''}. Days away are what other pages consult before calling a disrupted fortnight a finding.`
              }
            </Text>
          </Stack>
        </CardBody>
      </Card>

      {board.overlaps.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Two places at once
              </Text>
              {board.overlaps.map((overlap) => (
                <Text key={`${overlap.earlier.id}-${overlap.later.id}`} role="body-sm" tone="critical">
                  {byId.get(overlap.earlier.placeId)?.name ?? 'Somewhere'} (
                  {overlap.earlier.arrivedOn}–{overlap.earlier.departedOn ?? 'open'}) overlaps{' '}
                  {byId.get(overlap.later.placeId)?.name ?? 'somewhere'} ({overlap.later.arrivedOn}–
                  {overlap.later.departedOn ?? 'open'}).
                </Text>
              ))}
              <Text role="caption" tone="tertiary">
                Usually a departure date that was never filled in. Edit either visit below; nothing has been
                refused or discarded.
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Inline gap="2" align="center" justify="between">
              <Text role="title-3" as="h2">
                Record
              </Text>
              <Inline gap="2">
                <Button size="sm" variant="ghost" onClick={() => { setPanel(panel === 'place' ? 'none' : 'place'); }}>
                  Place
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setPanel(panel === 'trip' ? 'none' : 'trip'); }}>
                  Trip
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={board.places.length === 0}
                  onClick={() => { setPanel(panel === 'visit' ? 'none' : 'visit'); }}
                >
                  Visit
                </Button>
              </Inline>
            </Inline>

            {panel === 'place' && <PlaceForm onDone={refresh} onError={onError} />}
            {panel === 'trip' && <TripForm onDone={refresh} onError={onError} />}
            {panel === 'visit' && <VisitForm board={board} onDone={refresh} onError={onError} />}

            {board.places.length === 0 && panel === 'none' && (
              <Text role="caption" tone="tertiary">
                Add a place first — a visit needs somewhere to point at. Mark the one you live in as Home;
                that is what tells the days-away count which days are not travel.
              </Text>
            )}
          </Stack>
        </CardBody>
      </Card>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Text role="title-3" as="h2">
              Visits
            </Text>

            {board.visits.length === 0 ?
              <EmptyState
                title="No visits recorded"
                description="A visit is where you were between two dates. It is what lets a fortnight of odd sleep read as a trip rather than as a finding."
              />
            : <Stack gap="2">
                {board.visits.map((visit) => (
                  <VisitRow key={visit.id} visit={visit} placeName={byId.get(visit.placeId)?.name ?? 'Unknown'} />
                ))}
              </Stack>
            }
          </Stack>
        </CardBody>
      </Card>

      {board.trips.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <Text role="title-3" as="h2">
                Trips
              </Text>
              {board.trips.map((trip) => (
                <Inline key={trip.id} gap="3" justify="between" align="baseline">
                  <Stack gap="0">
                    <Text role="body">{trip.title}</Text>
                    <Text role="caption" tone="tertiary">
                      {TRIP_PURPOSE_LABELS[trip.purpose]} · {trip.startedOn}
                      {trip.endedOn === null ? ' — ongoing' : ` to ${trip.endedOn}`}
                    </Text>
                  </Stack>
                </Inline>
              ))}
            </Stack>
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

function VisitRow({ visit, placeName }: { readonly visit: Visit; readonly placeName: string }): ReactNode {
  const nights = nightsAway(visit);

  return (
    <Inline gap="3" justify="between" align="baseline">
      <Stack gap="0">
        <Text role="body">{placeName}</Text>
        <Text role="caption" tone="tertiary">
          {visit.arrivedOn}
          {visit.departedOn === null ? ' — still there' : ` to ${visit.departedOn}`}
        </Text>
      </Stack>
      <Text role="body-sm" tone="secondary">
        {nights === null ? 'open' : nights === 0 ? 'day trip' : `${String(nights)} nights`}
      </Text>
    </Inline>
  );
}

function PlaceForm({
  onDone,
  onError,
}: {
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PlaceKind>('city');
  const [countryCode, setCountryCode] = useState('');
  const [zone, setZone] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await savePlace({
        id: uuidV7(systemClock.nowMillis()),
        name,
        kind,
        countryCode: countryCode.trim() === '' ? null : countryCode.trim(),
        zone: zone.trim() === '' ? null : zone.trim(),
        latitude: null,
        longitude: null,
        notes: null,
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <TextField label="Name" value={name} onChange={(event) => { setName(event.target.value); }} />
      <SegmentedControl<PlaceKind>
        label="Kind"
        value={kind}
        onValueChange={setKind}
        size="sm"
        options={PLACE_KINDS.map((value) => ({ value, label: PLACE_LABELS[value] }))}
      />
      <TextField
        label="Country"
        hint="Two letters, like IN or GB. Optional."
        value={countryCode}
        onChange={(event) => { setCountryCode(event.target.value); }}
      />
      <TextField
        label="Time zone"
        hint="Optional, but it is what lets a visit explain a run of foreign timestamps. Written as Europe/London."
        value={zone}
        onChange={(event) => { setZone(event.target.value); }}
      />
      <Inline gap="2">
        <Button size="sm" disabled={name.trim() === '' || save.isPending} onClick={() => { save.mutate(); }}>
          Save place
        </Button>
      </Inline>
    </Stack>
  );
}

function TripForm({
  onDone,
  onError,
}: {
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState<TripPurpose>('leisure');
  const [startedOn, setStartedOn] = useState('');
  const [endedOn, setEndedOn] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await saveTrip({
        id: uuidV7(systemClock.nowMillis()),
        title,
        purpose,
        startedOn,
        endedOn: endedOn === '' ? null : endedOn,
        notes: null,
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <TextField label="Name" value={title} onChange={(event) => { setTitle(event.target.value); }} />
      <SegmentedControl<TripPurpose>
        label="Purpose"
        value={purpose}
        onValueChange={setPurpose}
        size="sm"
        options={TRIP_PURPOSES.map((value) => ({ value, label: TRIP_PURPOSE_LABELS[value] }))}
      />
      <DateField label="From" value={startedOn} onValueChange={setStartedOn} />
      <DateField label="To" hint="Leave empty while it is happening." value={endedOn} onValueChange={setEndedOn} />
      <Inline gap="2">
        <Button
          size="sm"
          disabled={title.trim() === '' || startedOn === '' || save.isPending}
          onClick={() => { save.mutate(); }}
        >
          Save trip
        </Button>
      </Inline>
    </Stack>
  );
}

function VisitForm({
  board,
  onDone,
  onError,
}: {
  readonly board: PlacesBoard;
  readonly onDone: () => void;
  readonly onError: (error: unknown) => void;
}): ReactNode {
  const first = board.places[0];
  const [placeId, setPlaceId] = useState(first?.id ?? '');
  const [tripId, setTripId] = useState('');
  const [arrivedOn, setArrivedOn] = useState(board.todayDayKey);
  const [departedOn, setDepartedOn] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      await saveVisit({
        id: uuidV7(systemClock.nowMillis()),
        placeId,
        tripId: tripId === '' ? null : tripId,
        arrivedOn,
        departedOn: departedOn === '' ? null : departedOn,
        notes: null,
      });
    },
    onSuccess: onDone,
    onError,
  });

  return (
    <Stack gap="3">
      <SegmentedControl<string>
        label="Where"
        value={placeId}
        onValueChange={setPlaceId}
        size="sm"
        options={board.places.map((place) => ({ value: place.id, label: place.name }))}
      />
      {board.trips.length > 0 && (
        <SegmentedControl<string>
          label="Part of"
          value={tripId}
          onValueChange={setTripId}
          size="sm"
          options={[{ value: '', label: 'No trip' }, ...board.trips.map((trip) => ({ value: trip.id, label: trip.title }))]}
        />
      )}
      <DateField label="Arrived" value={arrivedOn} onValueChange={setArrivedOn} />
      <DateField
        label="Departed"
        hint="Leave empty while you are there. An open visit closes itself when the next one starts."
        value={departedOn}
        onValueChange={setDepartedOn}
      />
      <Inline gap="2">
        <Button size="sm" disabled={placeId === '' || arrivedOn === '' || save.isPending} onClick={() => { save.mutate(); }}>
          Save visit
        </Button>
      </Inline>
    </Stack>
  );
}
