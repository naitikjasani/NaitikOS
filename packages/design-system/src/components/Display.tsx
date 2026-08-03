'use client';

import * as AvatarPrimitive from '@radix-ui/react-avatar';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/registry';
import { Text } from '../primitives/Text';

/* =========================================================================
 * Badge
 * ====================================================================== */

/**
 * A small status or category label.
 *
 * ## The tone list is deliberately short
 *
 * §8.2 forbids colour-as-judgement on health data: "A mood of 2 is not red. A
 * missed medication dose is not red." So there is no `success`/`danger` pair
 * here that a feature could reach for to colour a reading.
 *
 * `caution` and `critical` exist for *system* states — §8.2's stated
 * exception, "sync failure and data loss risk… because those are system states
 * requiring user action, not statements about the user."
 */
export type BadgeTone = 'neutral' | 'accent' | 'positive' | 'caution' | 'critical';

export type BadgeProps = {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly icon?: IconName;
  readonly className?: string;
};

export function Badge({ children, tone = 'neutral', icon, className }: BadgeProps): ReactNode {
  return (
    <span className={cn('nos-badge', `nos-badge--${tone}`, className)}>
      {/* §8.13: "No information conveyed by colour alone; every colour-coded
          state carries a shape, icon, or label." The text is always present,
          so the badge survives greyscale printing and colour blindness. */}
      {icon !== undefined && <Icon name={icon} label={null} size="sm" />}
      {children}
    </span>
  );
}

/* =========================================================================
 * Avatar
 * ====================================================================== */

export type AvatarProps = {
  /** Used for initials and as the accessible name. */
  readonly name: string;
  readonly src?: string;
  readonly size?: 'sm' | 'md' | 'lg';
  readonly className?: string;
};

/** First letter of the first two words. `Naitik Jasani` → `NJ`. */
function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function Avatar({ name, src, size = 'md', className }: AvatarProps): ReactNode {
  return (
    <AvatarPrimitive.Root className={cn('nos-avatar', `nos-avatar--${size}`, className)}>
      {src !== undefined && (
        <AvatarPrimitive.Image className="nos-avatar__image" src={src} alt={name} />
      )}
      {/* Radix renders the fallback only after the image fails or while it
          loads, so there is no flash of initials over a cached image. */}
      <AvatarPrimitive.Fallback className="nos-avatar__fallback" delayMs={src === undefined ? 0 : 400}>
        <span aria-hidden="true">{initialsOf(name)}</span>
        <span className="nos-visually-hidden">{name}</span>
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

/* =========================================================================
 * Progress
 * ====================================================================== */

export type ProgressProps = {
  /** 0–100. `null` renders the indeterminate state. */
  readonly value: number | null;
  /** Required. A bare bar announces nothing. */
  readonly label: string;
  /** Show the numeric value beside the label. */
  readonly showValue?: boolean;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
};

export function Progress({
  value,
  label,
  showValue = false,
  size = 'md',
  className,
}: ProgressProps): ReactNode {
  const clamped = value === null ? null : Math.max(0, Math.min(100, value));

  return (
    <div className={cn('nos-progress', className)}>
      <div className="nos-progress__labels">
        <Text role="caption" tone="secondary">
          {label}
        </Text>
        {showValue && clamped !== null && (
          <Text role="caption" tone="secondary">
            {/* Tabular, so a bar animating from 9% to 10% does not shift the
                text beside it (§8.3). */}
            {Math.round(clamped)}%
          </Text>
        )}
      </div>
      <ProgressPrimitive.Root
        className={cn('nos-progress__track', `nos-progress__track--${size}`)}
        value={clamped}
        aria-label={label}
      >
        <ProgressPrimitive.Indicator
          className="nos-progress__indicator"
          style={{
            // Radix expects a transform-based indicator; translating avoids a
            // width animation, which is the cheaper repaint.
            transform: `translateX(-${String(100 - (clamped ?? 0))}%)`,
          }}
        />
      </ProgressPrimitive.Root>
    </div>
  );
}

/* =========================================================================
 * Skeleton and Spinner
 * ====================================================================== */

/**
 * A layout-holding placeholder.
 *
 * §8.6: "**Skeletons do not shimmer; they hold layout.**" A shimmering
 * gradient is motion that carries no information and draws the eye to the one
 * thing that is not yet readable. This renders a static block at the token
 * surface colour.
 */
export function Skeleton({
  width,
  height = '1rem',
  radius = 'sm',
  className,
}: {
  readonly width?: string;
  readonly height?: string;
  readonly radius?: 'sm' | 'md' | 'full';
  readonly className?: string;
}): ReactNode {
  return (
    <div
      className={cn('nos-skeleton', className)}
      style={{ width: width ?? '100%', height, borderRadius: `var(--radius-${radius})` }}
      // Hidden from assistive tech: a live region announcing "loading" for
      // every placeholder block is noise. The container owns the announcement.
      aria-hidden="true"
    />
  );
}

/**
 * An indeterminate activity indicator.
 *
 * The one place motion is unconditional — but §8.6's reduced-motion rule still
 * applies, and under it the CSS drops the rotation and holds a static glyph.
 */
export function Spinner({
  label = 'Loading',
  size = 'md',
}: {
  readonly label?: string;
  readonly size?: 'sm' | 'md' | 'lg';
}): ReactNode {
  return (
    <span className="nos-spinner" role="status">
      <Icon name="status.loading" label={null} size={size} className="nos-spin" />
      <span className="nos-visually-hidden">{label}</span>
    </span>
  );
}
