import type { ReactNode } from 'react';
import Link from 'next/link';
import { COMPLIANCE_THRESHOLD } from '@naitikos/core';
import { Badge, Card, CardBody, Divider, EmptyState, Icon, Inline, Stack, Text } from '@naitikos/design-system';

import type { PhysiquePlate, PhysiqueSeries, PhysiqueGallery } from '@/lib/platform/physique';

/**
 * `/body/composition/photos` — the physique progress gallery (§3.2, §4.6, §9.8).
 *
 * ## This page is a record of a series, not a wall of pictures
 *
 * §5.5 puts physique photography in the sensitive tier: "client-side envelope
 * encryption before upload. The storage provider holds ciphertext it cannot
 * read." A Server Component therefore *cannot* render these images, and no
 * amount of layout will change that — the bytes it can reach are ciphertext, the
 * key is wrapped with a passphrase-derived master key that never leaves the
 * device, and the browser flow that unwraps it is not built (see
 * `PhotoCaptureScreen`, which stores nothing for the same reason).
 *
 * The two dishonest ways to handle that are a grid of grey rectangles that
 * looks like a loading state forever, and an `<img>` pointed at a signed URL
 * that will render as a broken icon. Both make the operator think the system is
 * failing. So each photograph is rendered as a **plate**: its date, its capture
 * conditions, its compliance score, and an explicit locked marker saying the
 * pixels are on the device that took them. That is genuinely everything the
 * server knows, and the page says so once, at the top, rather than implying it
 * fourteen times.
 *
 * ## Why capture conditions are the loudest thing on the page
 *
 * §4.2 is the reason this module has a protocol at all:
 *
 *   "Photographs taken under inconsistent lighting, distance, angle, or time of
 *    day are not merely lower quality — they are *actively misleading*, because
 *    apparent change is dominated by capture variance rather than skin change."
 *
 * The same is true of a body. Twelve physique photos in date order *look* like
 * twelve observations of one thing; if four were shot under a ceiling light at
 * 22:00 they are two things, and the difference between the first and the last
 * is mostly the lamp. So every series carries its condition consistency above
 * its plates, and a series whose conditions vary is **not offered as a
 * comparison** — the page withholds the side-by-side rather than drawing it with
 * a caveat underneath, because a caveat under a picture loses to the picture.
 *
 * ## Missing is missing (§8.9(3))
 *
 * A protocol field nobody recorded reads "not recorded", never a default. A
 * field recorded differently from the rest of the series reads "differs" and is
 * marked. Those are different facts and the page never collapses them: an
 * unknown lighting condition is a gap in the record, a different one is a
 * different photograph.
 *
 * A Server Component. The one control — whether to include non-compliant plates
 * — is a link that changes a search parameter, so the filter is in the URL,
 * shareable, and survives a reload. It does not need to be a client boundary.
 */

export function PhysiqueGalleryScreen({ gallery }: { readonly gallery: PhysiqueGallery }): ReactNode {
  if (gallery.totalPhotos === 0) {
    return (
      <EmptyState
        icon="media.photo"
        title="No physique photographs yet"
        description="Nothing has been captured, and nothing is hidden — this is an empty table rather than a filtered view. Physique photography needs the encrypted upload path, which §5.5 requires before a body photo leaves the device and which is not built yet."
      />
    );
  }

  return (
    <Stack gap="5">
      <CaptureNotice gallery={gallery} />

      {gallery.series.map((series) => (
        <SeriesCard key={series.key} series={series} />
      ))}

      {gallery.undated.length > 0 && <UndatedCard plates={gallery.undated} />}

      <ComplianceFilter gallery={gallery} />
    </Stack>
  );
}

/**
 * Stated once, at the top, in the operator's terms.
 *
 * The operator is also the maintainer, and "why can I not see my photos" is a
 * question that must be answered on the page rather than in a document — the
 * alternative is discovering the answer by reading the source in month three.
 */
function CaptureNotice({ gallery }: { readonly gallery: PhysiqueGallery }): ReactNode {
  if (gallery.encryptedCount === 0) return null;

  return (
    <Card variant="flat">
      <CardBody>
        <Inline gap="3" align="start">
          <Icon name="status.locked" label={null} size="md" />
          <Stack gap="1">
            <Text role="body-sm">
              {gallery.encryptedCount === gallery.totalPhotos
                ? 'The images themselves are not shown here, and cannot be.'
                : `${String(gallery.encryptedCount)} of ${String(gallery.totalPhotos)} images are not shown here, and cannot be.`}
            </Text>
            <Text role="caption" tone="tertiary">
              Physique photographs are encrypted on the device before they are uploaded, so the server
              holds bytes it cannot read (§5.5). What it can tell you about each one is below: when it
              was taken, under what conditions, and whether those conditions match the rest of its
              series.
            </Text>
          </Stack>
        </Inline>
      </CardBody>
    </Card>
  );
}

function SeriesCard({ series }: { readonly series: PhysiqueSeries }): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="4">
          <Inline gap="3" justify="between" align="baseline" wrap>
            <Text role="title-3" as="h2">
              {series.label}
            </Text>
            <Text role="caption" tone="tertiary">
              {describeSpan(series)}
            </Text>
          </Inline>

          <ConsistencySummary series={series} />

          <Divider />

          <Stack gap="3">
            {series.plates.map((plate) => (
              <PlateRow key={plate.mediaObjectId} plate={plate} />
            ))}
          </Stack>

          {series.hiddenCount > 0 && (
            <Text role="caption" tone="tertiary">
              {series.hiddenCount === 1
                ? 'One further plate in this series scored below the protocol threshold and is hidden.'
                : `${String(series.hiddenCount)} further plates in this series scored below the protocol threshold and are hidden.`}{' '}
              They are stored, not discarded — a photo is never refused.
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * The verdict on whether this series is a comparison at all.
 *
 * The comparability sentence comes *before* the plates rather than after them,
 * because a reader who has already scrolled the dates has already drawn the
 * comparison the page is trying to qualify.
 */
function ConsistencySummary({ series }: { readonly series: PhysiqueSeries }): ReactNode {
  const varying = series.consistency.filter((entry) => !entry.isConsistent);

  return (
    <Stack gap="2">
      {/* The state is in the words, not only in the tone (§8.13). */}
      <Inline gap="2" wrap>
        {series.consistency.map((entry) => (
          <Badge key={entry.field} tone={entry.isConsistent ? 'accent' : 'caution'}>
            {entry.label} — {entry.isConsistent ? 'consistent' : 'varies'}
          </Badge>
        ))}
      </Inline>

      {varying.map((entry) => (
        <Text key={entry.field} role="caption" tone="tertiary">
          {entry.label}:{' '}
          {entry.values.length === 0
            ? 'never recorded'
            : entry.values.map((value) => `${value.value} (${String(value.count)})`).join(', ')}
          {entry.missingCount > 0 && `${entry.values.length === 0 ? '' : ', '}not recorded (${String(entry.missingCount)})`}
        </Text>
      ))}

      <Text role="body-sm" tone={series.isComparable ? 'secondary' : 'primary'}>
        {series.isComparable
          ? 'Every plate in this series was shot under the same conditions, so the difference between the first and the last is a difference in the body.'
          : series.plates.length < 2
            ? 'One plate. A series begins at two, and there is nothing to compare yet.'
            : 'These plates are not offered side by side. Their capture conditions differ, so apparent change between them would be dominated by the conditions rather than by the body (§4.2).'}
      </Text>
    </Stack>
  );
}

function PlateRow({ plate }: { readonly plate: PhysiquePlate }): ReactNode {
  const percent = plate.complianceScore === null ? null : Math.round(plate.complianceScore * 100);

  /* Wraps, because §8.4 makes 360px the common case rather than the degraded one. */
  return (
    <Inline gap="3" align="start">
      <LockedThumbnail plate={plate} />

      <Stack gap="1">
        <Inline gap="2" align="baseline" wrap>
          <Text role="body" as="span">
            {plate.dayKey ?? 'Date not recorded'}
          </Text>
          {plate.daysSincePrevious !== null && (
            <Text role="caption" tone="tertiary" as="span">
              {plate.daysSincePrevious === 0
                ? 'same day as the previous plate'
                : `+${String(plate.daysSincePrevious)} days`}
            </Text>
          )}
          {percent === null ? (
            <Badge tone="neutral">Reference plate</Badge>
          ) : (
            <Badge tone={plate.isCompliant ? 'accent' : 'caution'}>{String(percent)}% consistent</Badge>
          )}
        </Inline>

        <Text role="caption" tone="tertiary">
          {plate.conditions
            .map((condition) =>
              condition.value === null
                ? `${condition.label}: not recorded`
                : `${condition.label}: ${condition.value}${condition.deviates ? ' (differs)' : ''}`,
            )
            .join(' · ')}
        </Text>

        {plate.complianceNotes !== null && (
          <Text role="caption" tone="tertiary">
            {plate.complianceNotes}
          </Text>
        )}
      </Stack>
    </Inline>
  );
}

/**
 * What stands in for the photograph.
 *
 * A lock and a sentence, not a grey rectangle. A placeholder that looks like an
 * image that has not loaded is a placeholder the operator will wait for.
 */
function LockedThumbnail({ plate }: { readonly plate: PhysiquePlate }): ReactNode {
  return (
    <Card variant="flat">
      <CardBody>
        <Stack gap="1" align="center">
          <Icon name={plate.isEncrypted ? 'status.locked' : 'media.photo'} label={null} size="md" />
          <Text role="caption" tone="tertiary" align="center">
            {plate.isEncrypted ? 'Encrypted' : 'Not rendered'}
          </Text>
          {plate.dimensions !== null && (
            <Text role="caption" tone="tertiary" align="center">
              {String(plate.dimensions.width)}×{String(plate.dimensions.height)}
            </Text>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * Photographs with no capture time.
 *
 * Shown rather than dropped, and shown apart rather than folded into a series
 * with a guessed date. A plate whose capture time was never recorded cannot be
 * placed in a chronology; substituting its upload time would place it
 * confidently in the wrong week, which is worse than leaving it here.
 */
function UndatedCard({ plates }: { readonly plates: readonly PhysiquePlate[] }): ReactNode {
  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Undated
          </Text>
          <Text role="caption" tone="tertiary">
            {plates.length === 1 ? 'One photograph has' : `${String(plates.length)} photographs have`} no
            capture time, so {plates.length === 1 ? 'it belongs' : 'they belong'} to no series and{' '}
            {plates.length === 1 ? 'is' : 'are'} in no comparison.
          </Text>
          <Stack gap="3">
            {plates.map((plate) => (
              <PlateRow key={plate.mediaObjectId} plate={plate} />
            ))}
          </Stack>
        </Stack>
      </CardBody>
    </Card>
  );
}

/**
 * §9.8's toggle: "non-compliant ones available behind a toggle and clearly marked."
 *
 * A link rather than a control, so the page stays a Server Component and the
 * filter lives in the URL. It is at the bottom because the default view is the
 * correct one and the exception should take a deliberate act to reach.
 */
function ComplianceFilter({ gallery }: { readonly gallery: PhysiqueGallery }): ReactNode {
  if (!gallery.includeNonCompliant && gallery.hiddenCount === 0) {
    return (
      <Text role="caption" tone="tertiary">
        Every stored plate is shown. None scored below {String(Math.round(COMPLIANCE_THRESHOLD * 100))}%
        protocol consistency.
      </Text>
    );
  }

  return (
    <Inline gap="2" align="baseline" wrap>
      <Link
        className="nos-inline-link"
        href={gallery.includeNonCompliant ? '/body/composition/photos' : '/body/composition/photos?include=all'}
      >
        <Text role="body-sm" as="span">
          {gallery.includeNonCompliant ? 'Hide non-compliant plates' : 'Show non-compliant plates'}
        </Text>
      </Link>
      <Text role="caption" tone="tertiary">
        {gallery.includeNonCompliant
          ? `Showing plates that scored below ${String(Math.round(COMPLIANCE_THRESHOLD * 100))}% protocol consistency. They are marked, and they are not a like-for-like comparison with the rest.`
          : `${String(gallery.hiddenCount)} hidden — below ${String(Math.round(COMPLIANCE_THRESHOLD * 100))}% protocol consistency, which §9.8 keeps out of comparison views by default.`}
      </Text>
    </Inline>
  );
}

/** The span and the cadence, or an honest statement that there is neither yet. */
function describeSpan(series: PhysiqueSeries): string {
  const count =
    series.plates.length === 1 ? '1 plate' : `${String(series.plates.length)} plates`;
  if (series.firstDayKey === null || series.lastDayKey === null) return count;
  if (series.firstDayKey === series.lastDayKey) return `${count} · ${series.firstDayKey}`;

  const cadence =
    series.medianIntervalDays === null
      ? ''
      : ` · typically ${String(Math.round(series.medianIntervalDays))} days apart`;
  return `${count} · ${series.firstDayKey} to ${series.lastDayKey}${cadence}`;
}
