'use client';

/**
 * Client telemetry — the four things §12's V1 phase names.
 *
 * > "Instrument: capture latency, Daily Close completion, drop-off points, sync
 * > failures."
 *
 * Two of those were unmeasured before this file existed. `capture.latency` was
 * in the metric registry and in `METRIC_NAMES` and **nothing wrote it** — the
 * §1.4 health metric with an explicit p50 budget had no source. So did
 * `route.transition`, which the counter-metric depends on.
 *
 * ## Batched, because measuring must not cost what it measures
 *
 * A request per route transition would make §1.4's "time in app" rise *because*
 * it is being measured, which is the funniest available way to fail this phase
 * and a real one. Events accumulate in memory and flush on a timer, on page
 * hide, and when the buffer fills.
 *
 * `sendBeacon` on hide, `fetch` otherwise. A `fetch` in a `visibilitychange`
 * handler is cancelled when the tab goes away, which loses precisely the events
 * at the end of a session — the ones that carry the session's length.
 *
 * ## Never a populated path
 *
 * {@link routePattern} replaces every id segment with `:id` before anything is
 * queued. §5.11 forbids payloads, and a URL with an entity id in it is a payload
 * wearing a route's clothes; the contract rejects it server-side as well.
 */

import type { TelemetryEvent, TelemetryName } from '@naitikos/api';

/** Flush cadence. Long enough to batch a burst of navigation, short enough to survive a crash. */
const FLUSH_INTERVAL_MS = 15_000;

/** The contract's cap. Flushing early is cheaper than being rejected. */
const MAX_BATCH = 50;

let buffer: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

/* -------------------------------------------------------------------------
 * Route patterns
 * ---------------------------------------------------------------------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * `/mind/journal/018f…` → `/mind/journal/:id`.
 *
 * Day keys are collapsed too. `/timeline/2026-09-14` is not an identifier in the
 * database sense, but it is still a fact about the operator's life — which day
 * they went back and looked at — and a telemetry table has no business holding
 * it.
 */
export function routePattern(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => {
      if (UUID.test(segment)) return ':id';
      if (DAY_KEY.test(segment)) return ':day';
      return segment;
    })
    .join('/');
}

function deviceClass(): TelemetryEvent['deviceClass'] {
  if (typeof window === 'undefined') return undefined;
  const width = window.innerWidth;
  if (width < 640) return 'phone';
  return width < 1024 ? 'tablet' : 'desktop';
}

/* -------------------------------------------------------------------------
 * The buffer
 * ---------------------------------------------------------------------- */

function bindListeners(): void {
  if (listenersBound || typeof document === 'undefined') return;
  listenersBound = true;

  /*
   * `visibilitychange` rather than `beforeunload`.
   *
   * Mobile Safari frequently never fires `beforeunload` — the tab is frozen
   * rather than unloaded — and losing the end of every session on the operator's
   * primary device would make the counter-metric systematically short.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush({ beacon: true });
  });
}

export function record(name: TelemetryName, value?: number, route?: string): void {
  if (typeof window === 'undefined') return;
  bindListeners();

  const device = deviceClass();
  buffer.push({
    name,
    ...(value === undefined ? {} : { value: Math.round(value) }),
    ...(route === undefined ? {} : { route: routePattern(route) }),
    ...(device === undefined ? {} : { deviceClass: device }),
  });

  if (buffer.length >= MAX_BATCH) {
    flush();
    return;
  }
  if (timer === null) {
    timer = setTimeout(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
  }
}

export function flush(options: { readonly beacon?: boolean } = {}): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (buffer.length === 0) return;

  const batch = { events: buffer.slice(0, MAX_BATCH), zone: timeZone() };
  buffer = buffer.slice(MAX_BATCH);

  const body = JSON.stringify(batch);

  if (options.beacon === true && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
    return;
  }

  /*
   * Failures are swallowed on purpose. Telemetry that surfaces an error is
   * telemetry that interrupts the thing it is measuring, and the metrics are
   * medians over thirty days — a dropped batch is noise, not a defect.
   */
  void fetch('/api/telemetry', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------
 * Capture latency — §1.4's health metric
 * ---------------------------------------------------------------------- */

/**
 * "Cold start → logged observation persisted, p50." (§1.4)
 *
 * **Cold start**, not "when the form was submitted". The measurement starts at
 * `performance.timeOrigin` — the navigation that brought the app up — because
 * the budget is about how long it takes to *get a fact recorded*, and the four
 * seconds spent waiting for the app to paint are four seconds of that.
 *
 * Measuring from the submit button would report a system that boots in eight
 * seconds and writes in two hundred milliseconds as comfortably inside a five
 * second budget, which is the opposite of what §1.4 is protecting.
 *
 * Recorded **once per page load**. The second capture in a session is not a
 * cold start, and including it would drag the median towards the warm case and
 * hide exactly the regression the metric exists to catch.
 */
let coldCaptureRecorded = false;

export function recordCaptureLatency(route: string): void {
  if (typeof window === 'undefined' || coldCaptureRecorded) return;
  coldCaptureRecorded = true;

  const elapsed = performance.now();
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  record('capture.latency', elapsed, route);
}

/** Reset between tests, and after a soft navigation that reloads the document. */
export function resetCaptureLatency(): void {
  coldCaptureRecorded = false;
}
