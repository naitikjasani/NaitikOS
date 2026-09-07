'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@naitikos/api';
import { AlertDialog, Badge, Button, Card, CardBody, Inline, Stack, Text } from '@naitikos/design-system';

/**
 * §5.2's manual trigger — "manually triggerable from `/settings/developer`".
 *
 * ## The only client component on this page, and only for this button
 *
 * Everything else on `/settings/developer` is a Server Component reading once.
 * A button that fires a fifteen-minute job needs three things a server render
 * cannot give it — a confirmation before it fires, a disabled state while it
 * runs, and the returned report — so the interactivity is isolated to this file
 * and the rest of the page stays out of the browser bundle.
 *
 * ## Why a `fetch` rather than a Server Action
 *
 * §5.2 permits exactly one entry point to the nightly run, and it already
 * exists: `POST /api/jobs/nightly`, which is what cron calls. A Server Action
 * would be a *second* way to start the job, with its own authorization site to
 * keep in step with the first — precisely the "second way in is a second thing
 * to secure" that §5.4 warns about. So this posts to the same endpoint cron
 * posts to, and inherits its guard chain unchanged.
 *
 * ## The CSRF header is not optional
 *
 * The endpoint's guard runs `verifyCsrf`, which checks `Origin` *and* a
 * double-submit token. The browser sends the first for free; the second has to
 * be read from the cookie and echoed, which is what {@link csrfToken} does. A
 * request without it is refused with 403 `csrf_token_missing` — the failure this
 * component would otherwise produce, and it would look like a server bug.
 *
 * ## What is not built here
 *
 * There is no step picker, though the endpoint accepts `only`. Two orderings in
 * `JOB_STEPS` are load-bearing — `resolve-predictions` before
 * `make-predictions`, `maintain-partitions` before `downsample-samples` — and a
 * control offering nine checkboxes invites running half a pipeline whose halves
 * depend on each other. The whole run is idempotent by §5.2's requirement, which
 * makes "run everything" the safe default and a picker a convenience with teeth.
 * A maintainer who genuinely needs one step has `curl` and the runbook.
 */

/** One step, as the endpoint reported it. Narrowed from JSON — see {@link parseSummary}. */
type RanStep = {
  readonly name: string;
  readonly status: string;
  readonly durationMs: number;
  readonly rowsAffected: number | null;
  readonly errorCode: string | null;
};

type RanSummary = {
  readonly runId: string;
  readonly status: string;
  readonly durationMs: number;
  readonly steps: readonly RanStep[];
};

/**
 * The trigger's state.
 *
 * A union rather than four booleans: `running` and `done` are mutually
 * exclusive, and a shape that can represent both at once is a shape where a
 * second click during a run is expressible.
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'confirming' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly summary: RanSummary }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Read the double-submit CSRF token from the cookie.
 *
 * Readable by script by design — the scheme requires it and the token is not a
 * credential; `CSRF_COOKIE_OPTIONS` in `packages/api` carries the full argument.
 * Duplicated from the auth client rather than imported, because that helper is
 * private to the auth feature and §7.4 R1 forbids reaching into it.
 */
function csrfToken(): string | null {
  if (typeof document === 'undefined') return null;

  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match === undefined ? null : decodeURIComponent(match.slice(CSRF_COOKIE_NAME.length + 1));
}

/**
 * Narrow the response body.
 *
 * The endpoint returns `JobRunSummary`, and this could import that type and
 * cast. It does not: the value has crossed a network boundary, where a
 * deployment skew or an intercepting proxy can hand back something else with a
 * 200, and a cast would turn that into `undefined.map` inside a render. Parsing
 * costs twenty lines and converts the failure into a sentence.
 */
function parseSummary(value: unknown): RanSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const body: Record<string, unknown> = { ...value };

  const runId = body['runId'];
  const status = body['status'];
  const durationMs = body['durationMs'];
  const steps = body['steps'];
  if (typeof runId !== 'string' || typeof status !== 'string' || !Array.isArray(steps)) return null;

  return {
    runId,
    status,
    durationMs: typeof durationMs === 'number' ? durationMs : 0,
    steps: steps.flatMap((entry: unknown): readonly RanStep[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const step: Record<string, unknown> = { ...entry };
      const name = step['name'];
      const stepStatus = step['status'];
      if (typeof name !== 'string' || typeof stepStatus !== 'string') return [];

      const stepDuration = step['durationMs'];
      const rows = step['rowsAffected'];
      const code = step['errorCode'];
      return [
        {
          name,
          status: stepStatus,
          durationMs: typeof stepDuration === 'number' ? stepDuration : 0,
          rowsAffected: typeof rows === 'number' ? rows : null,
          errorCode: typeof code === 'string' ? code : null,
        },
      ];
    }),
  };
}

export function NightlyRunTrigger(): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const router = useRouter();

  async function run(): Promise<void> {
    setPhase({ kind: 'running' });

    const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
    const token = csrfToken();
    if (token !== null) headers.set(CSRF_HEADER_NAME, token);

    try {
      const response = await fetch('/api/jobs/nightly', {
        method: 'POST',
        headers,
        /* Cookies are the session. Without this the request looks signed out. */
        credentials: 'same-origin',
        cache: 'no-store',
        /*
         * `{}` rather than no body at all: the handler parses the body before
         * anything else and refuses a request whose body is not JSON. An empty
         * object satisfies `runJobSchema`, whose only field is optional, and
         * means the full sequence.
         */
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        setPhase({
          kind: 'failed',
          /*
           * The status code, not the response body. The handler's error bodies
           * carry a trace id for the log and nothing a browser should render,
           * and 403 versus 429 versus 500 is the whole of what a maintainer
           * needs to know which of the guard chain refused.
           */
          message: `The endpoint refused the request (HTTP ${String(response.status)}). The server log has the trace id.`,
        });
        return;
      }

      const summary = parseSummary(await response.json());
      if (summary === null) {
        setPhase({ kind: 'failed', message: 'The run reported back in a shape this page cannot read.' });
        return;
      }

      setPhase({ kind: 'done', summary });
      /*
       * Re-render the server components above. The run has just written a
       * `job_run` row, pruned rows and possibly written predictions, so
       * everything else on this page is now stale — and a dashboard that
       * contradicts the report immediately below it is worse than one that
       * shows nothing.
       */
      router.refresh();
    } catch {
      /* A network failure, not a refusal. The job may well be running. */
      setPhase({
        kind: 'failed',
        message:
          'The request did not complete. The run may still be in progress — reload before starting another.',
      });
    }
  }

  const running = phase.kind === 'running';

  return (
    <Card variant="outlined">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Run it now
          </Text>

          <Text role="body-sm" tone="secondary">
            Cron fires this at 03:00 in the profile zone. Pressing the button runs the same sequence
            through the same endpoint, flagged <code>is_manual</code> so it cannot satisfy the alert that
            watches for the cron having stopped (§5.16).
          </Text>

          <Inline gap="3" align="center">
            <Button
              variant="primary"
              isLoading={running}
              disabled={running}
              onClick={() => {
                setPhase({ kind: 'confirming' });
              }}
            >
              {running ? 'Running' : 'Run the nightly job'}
            </Button>

            <ConfirmDialog
              open={phase.kind === 'confirming'}
              onOpenChange={(next) => {
                /*
                 * Dismissal — Escape, the overlay, or Cancel — returns to idle.
                 *
                 * **The functional update is load-bearing.** Confirming also
                 * closes the dialog, so this fires in the same event as
                 * `onConfirm`, one tick after `run()` has already set `running`.
                 * A plain `setPhase({ kind: 'idle' })` guarded on the captured
                 * `phase` would see the stale `confirming` and reset a run that
                 * had just started — leaving the button enabled and inviting a
                 * second one. Reading the current value instead means the reset
                 * only applies when nothing has moved on from `confirming`.
                 */
                if (!next) {
                  setPhase((current) => (current.kind === 'confirming' ? { kind: 'idle' } : current));
                }
              }}
              onConfirm={() => {
                /* Deliberately not awaited: the dialog primitive closes on this
                 * handler returning, and holding it open for fifteen minutes
                 * would hide the progress state behind an overlay. Failures are
                 * captured into `phase` inside `run`, which cannot reject. */
                void run();
              }}
            />

            {running && (
              <Text role="body-sm" tone="secondary">
                Up to fifteen minutes. Leaving this page does not stop the run.
              </Text>
            )}
          </Inline>

          {phase.kind === 'failed' && (
            <Text role="body-sm" tone="critical">
              {phase.message}
            </Text>
          )}

          {phase.kind === 'done' && (
            <Stack gap="2">
              <Inline gap="2" align="center">
                <Badge tone={phase.summary.status === 'succeeded' ? 'accent' : 'critical'}>
                  {phase.summary.status}
                </Badge>
                <Text role="body-sm" tone="secondary">
                  {phase.summary.steps.length === 1 ?
                    '1 step'
                  : `${String(phase.summary.steps.length)} steps`}{' '}
                  in {String(Math.round(phase.summary.durationMs / 100) / 10)} s
                </Text>
              </Inline>

              {phase.summary.steps.map((step) => (
                <Inline key={step.name} gap="2" align="baseline" justify="between">
                  <Text role="body-sm">{step.name}</Text>
                  <Text role="caption" tone={step.status === 'failed' ? 'critical' : 'tertiary'}>
                    {step.status}
                    {step.errorCode === null ? '' : ` · ${step.errorCode}`}
                    {/* Absent is not zero — a step that reported no row count
                        did not report having touched nothing. */}
                    {step.rowsAffected === null ? '' : ` · ${String(step.rowsAffected)} rows`}
                  </Text>
                </Inline>
              ))}

              <Text role="caption" tone="tertiary">
                This is the report the run returned. The tables above have been reloaded from the
                database.
              </Text>
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------------------
 * The confirmation
 *
 * §8.12 is blunt that a confirm dialog is the *second* line of defence and that
 * undo is the first. There is no undo for a job run and there should not be one:
 * §5.2 requires the run to be idempotent and safe to re-run, which is a stronger
 * property than reversibility — running it twice is indistinguishable from
 * running it once.
 *
 * The dialog is still here, because the run is not free. It deletes idempotency
 * records and telemetry rows that are past their retention, collapses device
 * samples, and writes tonight's predictions. None of that is recoverable, all of
 * it was going to happen at 03:00 anyway, and the description says so rather
 * than asking "are you sure?" about an effect it declines to name.
 * ---------------------------------------------------------------------- */
function ConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  return (
    <AlertDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Run the nightly job now?"
      description="It prunes expired idempotency records and telemetry past ninety days, collapses old device samples, and writes tonight's predictions. Those deletions are permanent — they were due at 03:00 regardless. The run is idempotent, so doing it twice changes nothing further."
      confirmLabel="Run it"
      cancelLabel="Not now"
      onConfirm={onConfirm}
    />
  );
}
