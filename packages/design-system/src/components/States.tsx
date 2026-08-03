import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';
import { Button } from './Button';
import { Skeleton, Spinner } from './Display';
import { Stack } from '../primitives/Layout';
import { Text } from '../primitives/Text';

/**
 * Empty, loading, and error states.
 *
 * §8.8 raises empty states from an afterthought to a requirement:
 *
 *   "Every card supports an empty state; **an empty card is a designed state,
 *    not a blank rectangle.** Given that this system will legitimately have
 *    empty modules for long periods, empty states are a primary design surface
 *    rather than an afterthought — each one states what would appear here and
 *    offers the single action that would populate it."
 *
 * The prop types enforce the second half of that sentence: `description` is
 * required, and it is meant to say what *would* be here. "No data" is a
 * failing description; "Workouts you log will appear here" is a passing one.
 */

/* =========================================================================
 * EmptyState
 * ====================================================================== */

export type EmptyStateProps = {
  readonly icon?: IconName;
  readonly title: string;
  /**
   * Required. What would appear here, and why it is empty.
   *
   * §2.1 expects modules to sit empty for months at a time — this text is what
   * stops that reading as a broken screen.
   */
  readonly description: string;
  /**
   * The single action that would populate it. §8.8 says "the single action",
   * and the type says so too: one, not an array.
   */
  readonly action?: { readonly label: string; readonly onAction: () => void };
  readonly size?: 'sm' | 'md';
  readonly className?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'md',
  className,
}: EmptyStateProps): ReactNode {
  return (
    <div className={cn('nos-state', `nos-state--${size}`, className)}>
      <Stack gap="3" align="center">
        {icon !== undefined && (
          <div className="nos-state__icon" aria-hidden="true">
            <Icon name={icon} label={null} size="lg" />
          </div>
        )}
        <Text role="title-3" as="p" align="center">
          {title}
        </Text>
        <Text role="body-sm" tone="secondary" align="center">
          {description}
        </Text>
        {action !== undefined && (
          <Button variant="secondary" onClick={action.onAction}>
            {action.label}
          </Button>
        )}
      </Stack>
    </div>
  );
}

/* =========================================================================
 * ErrorState
 * ====================================================================== */

/**
 * A failure the user can see and act on.
 *
 * §5.12 sets the tone requirement, and it is unusual enough to restate:
 *
 *   "A specific rule for this product: never show a raw error for a *logging*
 *    action. The user just recorded something about their body; the correct
 *    response to a backend failure is 'saved locally, will sync' — which is
 *    true, because the outbox has it — not a red toast that makes them wonder
 *    whether their workout is gone."
 *
 * So this component is for a failure that genuinely blocks — a page that could
 * not load — not for a write that is queued. `traceId` is rendered because
 * §5.12 requires every error response to carry one, and the operator reading
 * it off the screen is how it reaches the log.
 */
export type ErrorStateProps = {
  readonly title?: string;
  readonly description?: string;
  /** Correlates with the server log (§5.13). */
  readonly traceId?: string;
  readonly onRetry?: () => void;
  readonly className?: string;
};

export function ErrorState({
  title = 'Something went wrong',
  description = 'The page could not be loaded. Nothing you entered has been lost.',
  traceId,
  onRetry,
  className,
}: ErrorStateProps): ReactNode {
  return (
    <div className={cn('nos-state', 'nos-state--md', className)} role="alert">
      <Stack gap="3" align="center">
        <div className="nos-state__icon nos-state__icon--caution" aria-hidden="true">
          {/*
            `caution`, not `critical`.
            §8.2 reserves critical for destructive actions and genuine data
            loss. A page that failed to load is recoverable, and colouring it
            the same as "you are about to delete five years of records" erodes
            the meaning of the stronger signal.
          */}
          <Icon name="status.warning" label={null} size="lg" />
        </div>
        <Text role="title-3" as="p" align="center">
          {title}
        </Text>
        <Text role="body-sm" tone="secondary" align="center">
          {description}
        </Text>
        {traceId !== undefined && (
          <Text role="mono" tone="tertiary" as="span">
            {traceId}
          </Text>
        )}
        {onRetry !== undefined && (
          <Button variant="secondary" iconStart="action.refresh" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Stack>
    </div>
  );
}

/* =========================================================================
 * LoadingState
 * ====================================================================== */

/**
 * A loading placeholder that holds layout.
 *
 * §8.6: "Skeletons do not shimmer; they hold layout." Preferring skeletons
 * over a spinner is not aesthetic — a skeleton reserves the space the content
 * will occupy, so nothing jumps when it arrives. A centred spinner guarantees
 * a layout shift on every load.
 *
 * The spinner variant exists for the case where the shape is genuinely unknown.
 */
export function LoadingState({
  variant = 'skeleton',
  rows = 3,
  label = 'Loading',
  className,
}: {
  readonly variant?: 'skeleton' | 'spinner';
  readonly rows?: number;
  readonly label?: string;
  readonly className?: string;
}): ReactNode {
  if (variant === 'spinner') {
    return (
      <div className={cn('nos-state', 'nos-state--sm', className)}>
        <Spinner label={label} size="lg" />
      </div>
    );
  }

  return (
    // One live region for the whole block, rather than per-skeleton
    // announcements. `polite` so it does not interrupt.
    <div className={cn('nos-loading', className)} role="status" aria-live="polite" aria-busy="true">
      <span className="nos-visually-hidden">{label}</span>
      <Stack gap="3">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton
            key={index}
            height="1rem"
            // The last row is short, which is what a paragraph actually looks
            // like. Equal-width bars read as a table, not as text.
            width={index === rows - 1 ? '60%' : '100%'}
          />
        ))}
      </Stack>
    </div>
  );
}
