'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  COMPLIANCE_THRESHOLD,
  DISTANCE_LABELS,
  LIGHTING_LABELS,
  type CaptureTimeBucket,
  type FlashState,
} from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Inline,
  Stack,
  Text,
  ToggleField,
  axisLabel,
  dayIndex,
} from '@naitikos/design-system';

import type { ComparisonPhoto, PhotoComparisonView, PhotoSeries } from '@/lib/platform/skin';

/**
 * `/body/skin/photos/compare` — §3.2's side-by-side, and the case against it.
 *
 * ## The failure this page exists to prevent
 *
 * §4.2 is unusually direct about it: photographs taken under inconsistent
 * conditions "are not merely lower quality — they are *actively misleading*,
 * because apparent change is dominated by capture variance rather than skin
 * change." §9.8 says what that costs: "a series where lighting varies more than
 * skin does is a series that will produce confident, wrong conclusions."
 *
 * The naive version of this screen — two photos, side by side, whichever two
 * you picked — is the machine for producing exactly that conclusion. A face
 * shot under a window next to the same face under a ceiling bulb reads as a
 * dramatic improvement, and the improvement is the window. Someone could stop a
 * treatment over it.
 *
 * So this screen is built to refuse that comparison, in four specific ways.
 *
 * **1. Cross-series pairing is impossible, not discouraged.** Region and pose
 * define a series (`seriesKey`), and the picker only ever offers photos from
 * one. There is no toggle for this, because there is no reading of a face-front
 * photo against a back-full photo that means anything.
 *
 * **2. Photos flagged at capture are hidden by default.** §9.8: "comparison
 * views default to compliant photos only, with non-compliant ones available
 * behind a toggle and clearly marked." Both halves are implemented — the toggle
 * exists, and every flagged photo carries its badge wherever it appears.
 *
 * **3. A pair whose capture conditions differ is not shown as a comparison
 * until the operator says so.** This is the one place the screen is stricter
 * than the capture flow, and deliberately. §14.2's Finding 9 makes protocol
 * checks "advisory and recorded, never blocking" — but that finding is about
 * *taking* a photo, where the alternative to a flagged photo is no photo at all.
 * Here the alternative to a mismatched pair is a different pair, or none, and
 * the cost of the wrong default runs the other way: an unremarked mismatch is a
 * false conclusion, whereas a remarked one is just an extra click. Nothing is
 * ever refused outright; the mismatch is named, and the pair is available after
 * an acknowledgement that stays on screen.
 *
 * **4. No similarity, change, or improvement figure. Anywhere.** See below.
 *
 * ## Why there is no score
 *
 * The tempting feature is a number: percent changed, lesion delta, a
 * perceptual-hash distance (the hash is already on the row). It is deliberately
 * absent.
 *
 * §10.0 forbids the *model* computing or asserting. Computing it deterministically
 * in TypeScript would satisfy the letter of that and defeat its purpose, because
 * the purpose is that every figure the operator reads is one the system can
 * stand behind. Given §4.2's own premise — apparent change is dominated by
 * capture variance — any figure derived from two photographs is mostly a
 * measurement of the light, wearing the authority of arithmetic. "Your skin is
 * 12% better" is an assertion this system is not entitled to make, and the fact
 * that a pure function produced it makes it more credible, not more true.
 *
 * §4.2's future-expansion note draws the line where it belongs: "automated
 * lesion counting on standardised photos (deterministic CV, computed locally,
 * never a generative model)". *Standardised* is doing the work in that sentence,
 * and the standard is what this page reports on rather than assumes.
 *
 * What the screen does show is what was recorded: each photo's capture protocol
 * block, and the compliance score the capture screen computed at the time
 * against that series' own baseline. Retrieved facts, not new claims. The
 * judgement about whether the skin changed stays with the person who has the
 * skin — which is the same shape as `/body/skin`'s flare view, where changes are
 * listed next to the flare and no cause is asserted.
 *
 * ## Why the images are not here
 *
 * §5.5 puts skin photos in the sensitive tier: client-side envelope encryption
 * before upload, and "the storage provider holds ciphertext it cannot read."
 * Neither can this server, and neither can this page without the master key,
 * which is derived from the passphrase via Argon2id, held in browser memory,
 * and never transmitted. That key flow is the same one `PhotoCaptureScreen`
 * defers, so today there is nothing to decrypt and no way to decrypt it.
 *
 * The honest rendering of that is a panel saying so, next to the metadata that
 * *is* readable. A broken `<img>`, or a silently blank frame, would let the
 * operator conclude the photo was lost.
 */
export function PhotoCompareScreen({ view }: { readonly view: PhotoComparisonView }): ReactNode {
  const [seriesKeyChoice, setSeriesKeyChoice] = useState<string | null>(view.series[0]?.key ?? null);
  const [includeFlagged, setIncludeFlagged] = useState(false);
  /* Reset by the pair, not by a button: acknowledging one mismatch must not
     silently carry over to the next pair the operator picks. */
  const [acknowledged, setAcknowledged] = useState<string | null>(null);

  const series = view.series.find((candidate) => candidate.key === seriesKeyChoice) ?? null;

  const available = useMemo(
    () => (series === null ? [] : photosFor(series, includeFlagged)),
    [series, includeFlagged],
  );

  /* Held as ids rather than photos, so a change to the series or the flagged
     toggle cannot leave a selection pointing at something no longer offered. */
  const [leftId, setLeftId] = useState<string | null>(null);
  const [rightId, setRightId] = useState<string | null>(null);

  /* Unselected defaults to oldest against newest, because that is the
     comparison the operator came for. If those two turn out to be a mismatched
     pair, landing on the refusal is the correct first thing to see. */
  const chosenA = available.find((photo) => photo.mediaObjectId === leftId) ?? available[0] ?? null;
  const chosenB =
    available.find((photo) => photo.mediaObjectId === rightId) ?? available.at(-1) ?? null;

  if (view.series.length === 0) return <NothingStored view={view} />;

  /* Ordered by capture time regardless of which list they were picked from, so
     the "Earlier" and "Later" labels cannot lie. A comparison view that reads
     backwards would invert the direction of every apparent change on it. */
  const flip = chosenA !== null && chosenB !== null && chosenB.capturedAt < chosenA.capturedAt;
  const left = flip ? chosenB : chosenA;
  const right = flip ? chosenA : chosenB;

  const isSamePhoto = left !== null && right !== null && left.mediaObjectId === right.mediaObjectId;
  const differences = left === null || right === null ? [] : conditionDifferences(left, right);
  const pairKey = left === null || right === null ? '' : `${left.mediaObjectId}:${right.mediaObjectId}`;
  const withheld = differences.length > 0 && acknowledged !== pairKey;

  return (
    <Stack gap="5">
      <Text role="body-sm" tone="secondary">
        Two photos from one series, and everything recorded about how each was taken. There is no
        change score here and there will not be one — see the note at the bottom.
      </Text>

      {view.series.length > 1 && (
        <Stack gap="2">
          <Text role="caption" tone="tertiary">
            Series
          </Text>
          <Inline gap="2" wrap>
            {view.series.map((candidate) => (
              <Button
                key={candidate.key}
                size="sm"
                variant={candidate.key === seriesKeyChoice ? 'primary' : 'secondary'}
                aria-pressed={candidate.key === seriesKeyChoice}
                onClick={() => {
                  setSeriesKeyChoice(candidate.key);
                  setLeftId(null);
                  setRightId(null);
                  setAcknowledged(null);
                }}
              >
                {seriesLabel(candidate)}
              </Button>
            ))}
          </Inline>
        </Stack>
      )}

      {series !== null && series.flagged.length > 0 && (
        <Card variant="outlined">
          <CardBody>
            <Stack gap="2">
              <ToggleField
                label="Include photos flagged at capture"
                checked={includeFlagged}
                onCheckedChange={(next) => {
                  setIncludeFlagged(next);
                  setAcknowledged(null);
                }}
              />
              <Text role="caption" tone="tertiary">
                {`${String(series.flagged.length)} of ${String(series.eligible.length + series.flagged.length)} photos in this series scored below ${String(Math.round(COMPLIANCE_THRESHOLD * 100))}% against their own baseline. They are stored and they are yours; they are hidden here because a photo that broke the protocol is the one most likely to show a change that is not there.`}
              </Text>
            </Stack>
          </CardBody>
        </Card>
      )}

      {available.length < 2 ?
        <EmptyState
          title="Not enough photos in this series yet"
          description="A comparison needs two photos taken the same way. One is a reference; the second is the first thing worth looking at."
        />
      : <Stack gap="4">
          <PhotoPicker
            heading="First photo"
            photos={available}
            selectedId={chosenA?.mediaObjectId ?? null}
            onSelect={(id) => {
              setLeftId(id);
              setAcknowledged(null);
            }}
          />
          <PhotoPicker
            heading="Second photo"
            photos={available}
            selectedId={chosenB?.mediaObjectId ?? null}
            onSelect={(id) => {
              setRightId(id);
              setAcknowledged(null);
            }}
          />

          {isSamePhoto && (
            <Text role="body-sm" tone="secondary">
              Both sides are the same photo. Pick a second one above.
            </Text>
          )}

          {left !== null && right !== null && !isSamePhoto && (
            <Stack gap="4">
              <Elapsed left={left} right={right} />

              {differences.length > 0 && (
                <MismatchNotice
                  differences={differences}
                  withheld={withheld}
                  onAcknowledge={() => {
                    setAcknowledged(pairKey);
                  }}
                />
              )}

              {withheld ?
                /* The pair is not rendered. The differences above are the whole
                   content of this state, and that is the point. */
                null
              : <Stack gap="3">
                  <PhotoPanel photo={left} heading="Earlier" mismatched={differences.length > 0} />
                  <PhotoPanel photo={right} heading="Later" mismatched={differences.length > 0} />
                </Stack>
              }
            </Stack>
          )}
        </Stack>
      }

      <Provenance view={view} />
    </Stack>
  );
}

/* -------------------------------------------------------------------------
 * The refusal
 * ---------------------------------------------------------------------- */

type Difference = {
  readonly label: string;
  readonly earlier: string;
  readonly later: string;
};

/**
 * The capture conditions on which the two photos disagree.
 *
 * Equality over four recorded fields — not a score, and not weighted. A
 * weighting would be a claim about how much each condition distorts an
 * appearance, and the honest answer is that it depends on the skin, the region
 * and the light in ways this system has no evidence about.
 *
 * Brightness is excluded on purpose. §14.2's Finding 9 predicts the luminance
 * check will produce false warnings, and a false warning here would train the
 * operator to click through the real ones — the exact decay the finding warns
 * about, relocated to the surface where the stakes are highest. The luminance
 * figure is still shown on each panel; it just does not withhold a pair.
 */
function conditionDifferences(left: ComparisonPhoto, right: ComparisonPhoto): readonly Difference[] {
  const differences: Difference[] = [];

  const add = (label: string, earlier: string | null, later: string | null): void => {
    /* An unrecorded condition is not a mismatch. It is an unknown, and calling
       it a difference would flag every photo taken before the protocol block
       was populated — §8.9's rule that absence is not evidence. */
    if (earlier === null || later === null || earlier === later) return;
    differences.push({ label, earlier, later });
  };

  add(
    'Distance',
    left.distance === null ? null : DISTANCE_LABELS[left.distance],
    right.distance === null ? null : DISTANCE_LABELS[right.distance],
  );
  add(
    'Lighting',
    left.lighting === null ? null : LIGHTING_LABELS[left.lighting],
    right.lighting === null ? null : LIGHTING_LABELS[right.lighting],
  );
  add(
    'Time of day',
    left.timeBucket === null ? null : TIME_BUCKET_LABELS[left.timeBucket],
    right.timeBucket === null ? null : TIME_BUCKET_LABELS[right.timeBucket],
  );
  add(
    'Flash',
    left.flash === null ? null : FLASH_LABELS[left.flash],
    right.flash === null ? null : FLASH_LABELS[right.flash],
  );

  return differences;
}

function MismatchNotice({
  differences,
  withheld,
  onAcknowledge,
}: {
  readonly differences: readonly Difference[];
  readonly withheld: boolean;
  readonly onAcknowledge: () => void;
}): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" justify="between" align="baseline">
            <Text role="title-3" as="h2">
              These two were not taken the same way
            </Text>
            <Badge tone="caution">Not like-for-like</Badge>
          </Inline>

          <Text role="body-sm" tone="secondary">
            {withheld ?
              'Held back rather than shown side by side. Whatever difference you would see between them is partly, and possibly mostly, the difference below.'
            : 'Shown at your request. Whatever difference you see between them is partly, and possibly mostly, the difference below.'}
          </Text>

          <ul className="nos-protocol">
            {differences.map((difference) => (
              <li className="nos-protocol__item" key={difference.label}>
                <span className="nos-protocol__dot nos-protocol__dot--advisory" aria-hidden="true" />
                <Stack gap="0">
                  <Text role="body-sm" as="span">
                    {/* Named in the text, not carried by the dot's colour (§8.13). */}
                    {`${difference.label} — differs`}
                  </Text>
                  <Text role="caption" tone="tertiary">
                    {`Earlier: ${difference.earlier}. Later: ${difference.later}.`}
                  </Text>
                </Stack>
              </li>
            ))}
          </ul>

          {withheld && (
            <Stack gap="2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  onAcknowledge();
                }}
              >
                Show them anyway
              </Button>
              <Text role="caption" tone="tertiary">
                Nothing is being kept from you. Picking a closer-matched pair from the lists above is
                usually the better move, and if there is not one, that is itself the finding.
              </Text>
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * The panels
 * ---------------------------------------------------------------------- */

function PhotoPanel({
  photo,
  heading,
  mismatched,
}: {
  readonly photo: ComparisonPhoto;
  readonly heading: string;
  readonly mismatched: boolean;
}): ReactNode {
  const index = dayIndex(photo.dayKey);
  const score = photo.complianceScore === null ? null : Math.round(photo.complianceScore * 100);

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Inline gap="3" justify="between" align="baseline" wrap>
            <Text role="title-3" as="h3">
              {`${heading} — ${index === null ? photo.dayKey : axisLabel(index, true)}`}
            </Text>
            <Inline gap="2" wrap>
              {mismatched && <Badge tone="caution">Different conditions</Badge>}
              {score === null ?
                <Badge tone="neutral">Series reference</Badge>
              : <Badge tone={score >= COMPLIANCE_THRESHOLD * 100 ? 'accent' : 'caution'}>
                  {`${String(score)}% consistent at capture`}
                </Badge>
              }
            </Inline>
          </Inline>

          {photo.isEncrypted && (
            /* Not a placeholder for a picture that failed to load. The bytes
               exist and are intact; this server is structurally unable to read
               them, and that is the design (§5.5). */
            <Card variant="flat">
              <CardBody>
                <Text role="body-sm" tone="secondary">
                  Encrypted on the device that took it. The server holds ciphertext and no key, so
                  the image cannot be shown here — it needs the passphrase-derived key, which never
                  leaves the browser. The record below is what is readable without it.
                </Text>
              </CardBody>
            </Card>
          )}

          <dl className="nos-protocol">
            <Detail
              label="Distance"
              value={photo.distance === null ? null : DISTANCE_LABELS[photo.distance]}
            />
            <Detail
              label="Lighting"
              value={photo.lighting === null ? null : LIGHTING_LABELS[photo.lighting]}
            />
            <Detail
              label="Time of day"
              value={photo.timeBucket === null ? null : TIME_BUCKET_LABELS[photo.timeBucket]}
            />
            <Detail label="Flash" value={photo.flash === null ? null : FLASH_LABELS[photo.flash]} />
            <Detail
              label="Brightness"
              value={photo.medianLuminance === null ? null : String(Math.round(photo.medianLuminance))}
            />
          </dl>

          {photo.complianceNotes !== null && (
            <Text role="caption" tone="tertiary">
              {photo.complianceNotes}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string | null }): ReactNode {
  return (
    <div className="nos-protocol__item">
      <Text role="caption" tone="tertiary" as="dt">
        {label}
      </Text>
      <Text role="body-sm" as="dd">
        {/* "Not recorded" rather than a dash, because a dash reads as zero and
            this is the §8.9 distinction in its smallest form. */}
        {value ?? 'Not recorded'}
      </Text>
    </div>
  );
}

/**
 * Days between the two photos.
 *
 * The one figure on this page, and it is a fact about the *record* rather than
 * about the skin: integer subtraction of two civil day indices, both resolved
 * server-side in the zone each photo was captured in. It asserts nothing about
 * what happened in between, which is exactly why it is allowed to be here.
 */
function Elapsed({ left, right }: { readonly left: ComparisonPhoto; readonly right: ComparisonPhoto }): ReactNode {
  const from = dayIndex(left.dayKey);
  const to = dayIndex(right.dayKey);
  if (from === null || to === null) return null;

  const days = Math.abs(to - from);
  return (
    <Text role="body-sm" tone="secondary">
      {days === 0 ?
        'Both taken on the same day.'
      : `${String(days)} ${days === 1 ? 'day' : 'days'} apart.`}
    </Text>
  );
}

/* -------------------------------------------------------------------------
 * Pickers and empty states
 * ---------------------------------------------------------------------- */

function PhotoPicker({
  heading,
  photos,
  selectedId,
  onSelect,
}: {
  readonly heading: string;
  readonly photos: readonly ComparisonPhoto[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}): ReactNode {
  return (
    <Stack gap="2">
      <Text role="caption" tone="tertiary">
        {heading}
      </Text>
      <Inline gap="2" wrap>
        {photos.map((photo) => {
          const index = dayIndex(photo.dayKey);
          const flagged =
            photo.complianceScore !== null && photo.complianceScore < COMPLIANCE_THRESHOLD;
          return (
            <Button
              key={photo.mediaObjectId}
              size="sm"
              variant={photo.mediaObjectId === selectedId ? 'primary' : 'secondary'}
              aria-pressed={photo.mediaObjectId === selectedId}
              onClick={() => {
                onSelect(photo.mediaObjectId);
              }}
            >
              {/* The flag travels with the photo everywhere it is offered, not
                  only where it is opened — §9.8's "clearly marked". */}
              {`${index === null ? photo.dayKey : axisLabel(index, true)}${flagged ? ' · flagged' : ''}`}
            </Button>
          );
        })}
      </Inline>
    </Stack>
  );
}

function NothingStored({ view }: { readonly view: PhotoComparisonView }): ReactNode {
  return (
    <Stack gap="4">
      <EmptyState
        title="No photos to compare"
        description="Nothing has been stored yet. The capture protocol on the photos page runs, but the encrypted upload path is still to be built — §5.5 requires client-side encryption before a body photo leaves the device, and a half-wired version is worse than none."
      />
      <Text role="body-sm" tone="secondary">
        <Link className="nos-inline-link" href="/body/skin/photos">
          Take a photo
        </Link>
        {' — the first one becomes the alignment reference for everything after it, which is what '}
        makes this page worth having later.
      </Text>
      {view.undatedCount > 0 && <Undated count={view.undatedCount} />}
    </Stack>
  );
}

function Undated({ count }: { readonly count: number }): ReactNode {
  return (
    <Text role="caption" tone="tertiary">
      {`${String(count)} stored ${count === 1 ? 'photo has' : 'photos have'} no capture time, so ${count === 1 ? 'it cannot' : 'they cannot'} be placed in a series. Counted here rather than dropped: a series with silent gaps is worse than one with none (§9.8).`}
    </Text>
  );
}

/**
 * The standing note, at the bottom of every state of this page.
 *
 * Repeated rather than tucked into a help panel because the absence of a score
 * is the kind of thing a reader assumes is an oversight. Saying why, on the
 * page, is cheaper than being asked for the feature in month three.
 */
function Provenance({ view }: { readonly view: PhotoComparisonView }): ReactNode {
  return (
    <Card variant="flat">
      <CardBody>
        <Stack gap="2">
          <Text role="body-sm" tone="secondary">
            No change score, no similarity figure, no percentage improvement — not because it is
            hard, but because apparent change between two photographs is dominated by how they were
            taken (§4.2). A number derived from these two images would mostly be measuring the
            light, and it would read as if it were measuring the skin.
          </Text>
          <Text role="caption" tone="tertiary">
            Everything above was recorded at capture. The consistency percentages were computed then,
            against each series&rsquo; own baseline, and are shown here rather than recalculated.
          </Text>
          {view.undatedCount > 0 && <Undated count={view.undatedCount} />}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * Labels
 * ---------------------------------------------------------------------- */

/*
 * Local rather than in `core` alongside `LIGHTING_LABELS` and `DISTANCE_LABELS`.
 *
 * Those two exist in the domain because the capture screen offers them as
 * *choices* and the vocabulary has to be picked from. A time bucket is derived
 * by `timeBucketFor` and a flash state is read from EXIF; neither is ever
 * selected, so neither has needed a label until this screen. When a second
 * surface needs them, they move up — one caller is not a shared vocabulary.
 */
const TIME_BUCKET_LABELS: Readonly<Record<CaptureTimeBucket, string>> = Object.freeze({
  early_morning: 'Early morning',
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
});

const FLASH_LABELS: Readonly<Record<FlashState, string>> = Object.freeze({
  on: 'On',
  off: 'Off',
  auto_fired: 'Auto — fired',
  auto_not_fired: 'Auto — did not fire',
});

function seriesLabel(series: PhotoSeries): string {
  const count = series.eligible.length + series.flagged.length;
  const pose = series.poseId === null ? '' : ` · ${series.poseId}`;
  return `${series.regionLabel}${pose} (${String(count)})`;
}

/** Oldest first, with the flagged photos merged back into date order when asked for. */
function photosFor(series: PhotoSeries, includeFlagged: boolean): readonly ComparisonPhoto[] {
  if (!includeFlagged) return series.eligible;
  return [...series.eligible, ...series.flagged].sort((a, b) =>
    a.capturedAt < b.capturedAt ? -1
    : a.capturedAt > b.capturedAt ? 1
    : 0,
  );
}
