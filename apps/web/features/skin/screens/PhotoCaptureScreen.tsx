'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  CAPTURE_DISTANCES,
  CAPTURE_LIGHTING,
  DISTANCE_LABELS,
  LIGHTING_LABELS,
  REGION_LABELS,
  TRACKED_REGIONS,
  evaluateProtocol,
  timeBucketFor,
  type CaptureCandidate,
  type CaptureDistance,
  type CaptureLighting,
  type ProtocolVerdict,
} from '@naitikos/core';
import { Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

import { GhostOverlay } from '../components/GhostOverlay';
import { ProtocolChecklist } from '../components/ProtocolChecklist';

/**
 * `/body/skin/photos` — standardised progress photography (§4.2, §9.8).
 *
 * ## What this screen is, and what it is honestly not
 *
 * It is the **capture protocol**: the ghost overlay, the region and pose
 * selection, the protocol block, the luminance measurement, and the scoring —
 * all of which run before anything is uploaded, and all of which are advisory.
 *
 * It is **not** the upload. `core/media/pipeline.ts` and the sensitive-tier
 * storage path have existed since week 2 and are wired end to end for
 * documents; wiring a *browser* capture through client-side encryption needs a
 * key-derivation flow (a passphrase, a wrapped master key, a place to keep it)
 * that §5.5 specifies and §12 puts in week 4 alongside two whole domains. What
 * ships here is the protocol; the encrypted upload is the next thing built, and
 * `docs/skin.md` says so rather than leaving it to be discovered.
 *
 * The ordering is deliberate and matches §14.4's fallback: "if week 4 slips,
 * skin *photography* defers to v0.2 while skin *state* ships. Deferring photos
 * is acceptable; deferring encryption is not." So nothing here writes a photo
 * anywhere — there is no half-encrypted path to retrofit.
 *
 * ## Luminance is measured here because it can only be measured here
 *
 * §5.5's pipeline encrypts second-to-last, and everything that needs to read
 * pixels happens before it. Median luminance is one of those things. It is
 * computed in a canvas from the captured frame, in the browser, before any
 * upload could occur — which is also the only place it *can* be computed, since
 * the server will never see the plaintext.
 */

/** The fixed reference region: the centre of the frame, a third of each side. */
const REFERENCE_BOX = { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 };

export function PhotoCaptureScreen({ localTime }: { readonly localTime: string }): ReactNode {
  const [region, setRegion] = useState<string>('face');
  const [distance, setDistance] = useState<CaptureDistance>('close');
  const [lighting, setLighting] = useState<CaptureLighting>('daylight_indirect');
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [luminance, setLuminance] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Revoke the object URL when it is replaced or the screen goes away. */
  useEffect(() => {
    return () => {
      if (captureUrl !== null) URL.revokeObjectURL(captureUrl);
    };
  }, [captureUrl]);

  const candidate: CaptureCandidate = useMemo(
    () => ({
      region,
      poseId: 'front',
      distance,
      lighting,
      timeBucket: timeBucketFor(localTime),
      /*
       * Flash is reported as off rather than read from EXIF.
       *
       * The browser file picker gives a `File`, and EXIF extraction is the
       * pipeline's job (`core/media/pipeline.ts`, stage 2 — deliberately before
       * compression, because a re-encode strips orientation). Until the upload
       * path is wired, claiming to know the flash state would be inventing a
       * fact, so this is what the capture screen *asked for*, not what the
       * camera did.
       */
      flash: 'off',
      medianLuminance: luminance,
      alignmentReferenceId: null,
    }),
    [region, distance, lighting, localTime, luminance],
  );

  /*
   * No series baseline yet, because nothing has been stored yet. The verdict is
   * therefore all-unknown and scores `null` — which is the correct answer for a
   * first photo and is exactly what the operator will see until uploads land.
   */
  const verdict: ProtocolVerdict = useMemo(() => evaluateProtocol(candidate, null, []), [candidate]);

  const onFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    if (file === undefined) return;

    if (captureUrl !== null) URL.revokeObjectURL(captureUrl);
    const url = URL.createObjectURL(file);
    setCaptureUrl(url);
    setLuminance(await medianLuminanceOf(url));
  };

  return (
    <Stack gap="5">
      <GhostOverlay
        referenceUrl={null}
        currentUrl={captureUrl}
        regionLabel={REGION_LABELS[region as keyof typeof REGION_LABELS] ?? region}
      />

      <Inline gap="2" wrap>
        {TRACKED_REGIONS.map((candidateRegion) => (
          <Button
            key={candidateRegion}
            size="sm"
            variant={candidateRegion === region ? 'primary' : 'secondary'}
            /* Selection is not colour-only (§8.13): the pressed state is in the
               accessibility tree, not just in the button's fill. */
            aria-pressed={candidateRegion === region}
            onClick={() => {
              setRegion(candidateRegion);
            }}
          >
            {REGION_LABELS[candidateRegion]}
          </Button>
        ))}
      </Inline>

      <Card variant="outlined">
        <CardBody>
          <Stack gap="3">
            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                Distance
              </Text>
              <Inline gap="2" wrap>
                {CAPTURE_DISTANCES.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === distance ? 'primary' : 'secondary'}
                    aria-pressed={option === distance}
                    onClick={() => {
                      setDistance(option);
                    }}
                  >
                    {DISTANCE_LABELS[option]}
                  </Button>
                ))}
              </Inline>
            </Stack>

            <Stack gap="2">
              <Text role="caption" tone="tertiary">
                Lighting
              </Text>
              <Inline gap="2" wrap>
                {CAPTURE_LIGHTING.filter((option) => option !== 'unknown').map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={option === lighting ? 'primary' : 'secondary'}
                    aria-pressed={option === lighting}
                    onClick={() => {
                      setLighting(option);
                    }}
                  >
                    {LIGHTING_LABELS[option]}
                  </Button>
                ))}
              </Inline>
            </Stack>
          </Stack>
        </CardBody>
      </Card>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        // `capture` opens the camera directly on a phone rather than the gallery.
        capture="environment"
        className="nos-visually-hidden"
        /*
         * Removed from the tab order and from the accessibility tree.
         *
         * The visible Button below is the control; leaving this input focusable
         * would put an unlabelled "Choose file" stop in the middle of the page
         * that does the same thing as the button after it.
         */
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          void onFile(event);
        }}
      />

      <Button
        variant="primary"
        size="lg"
        fullWidth
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        {captureUrl === null ? 'Take the photo' : 'Retake'}
      </Button>

      <Card variant="outlined">
        <CardBody>
          <ProtocolChecklist verdict={verdict} />
        </CardBody>
      </Card>

      {/*
        Stated on the screen, not only in a document. The operator is also the
        maintainer, and a capture screen that silently discarded the photo would
        be the worst possible thing to discover in month three.
      */}
      <Card variant="flat">
        <CardBody>
          <Text role="body-sm" tone="secondary">
            Nothing is stored yet. The encrypted upload path is the next thing built — §5.5 requires
            client-side encryption before a body photo leaves the device, and a half-wired version is
            worse than none.
          </Text>
        </CardBody>
      </Card>
    </Stack>
  );
}

/**
 * Median luminance of the fixed reference region (§4.2).
 *
 * Median rather than mean, for the reason `protocol.ts` gives: one bright
 * specular highlight drags a mean far enough to make every subsequent photo
 * look inconsistent — the false-warning failure Finding 9 describes, arriving
 * through the statistic instead of the threshold.
 *
 * Downsampled to a fixed 64px box before sampling, so the cost does not depend
 * on the camera's resolution and the figure is comparable between a phone and a
 * laptop.
 */
async function medianLuminanceOf(url: string): Promise<number | null> {
  if (typeof document === 'undefined') return null;

  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => {
      resolve(true);
    };
    image.onerror = () => {
      resolve(false);
    };
  });
  image.src = url;
  if (!(await loaded)) return null;

  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) return null;

  context.drawImage(
    image,
    image.naturalWidth * REFERENCE_BOX.x,
    image.naturalHeight * REFERENCE_BOX.y,
    image.naturalWidth * REFERENCE_BOX.width,
    image.naturalHeight * REFERENCE_BOX.height,
    0,
    0,
    size,
    size,
  );

  const { data } = context.getImageData(0, 0, size, size);
  const values: number[] = [];
  for (let index = 0; index < data.length; index += 4) {
    // Rec. 601 luma. Perceptual weighting matters here: an equal-weight average
    // reads a green cast as brighter than it looks.
    values.push(0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0));
  }

  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) return values[middle] ?? null;
  const lower = values[middle - 1];
  const upper = values[middle];
  return lower === undefined || upper === undefined ? null : (lower + upper) / 2;
}
