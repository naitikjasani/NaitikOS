import type { CSSProperties, ElementType, ReactNode } from 'react';

import { cn } from '../lib/cn';

/**
 * Typography — §8.3.
 *
 * The scale is "mapped to semantic roles rather than sizes", and this component
 * is what makes that stick: a caller asks for `title-2`, never for 20px. When
 * the scale is retuned in year four, every screen follows.
 *
 * ## Tabular figures
 *
 * The `metric-*` roles apply `font-variant-numeric: tabular-nums`
 * automatically. §8.3: "Non-tabular figures make columns of numbers jitter,
 * which reads as instability in a data-dense product." Getting this wrong is
 * invisible in a mockup and obvious in a five-year weight chart.
 */

export const TEXT_ROLES = [
  'display',
  'title-1',
  'title-2',
  'title-3',
  'body',
  'body-sm',
  'caption',
  'metric-l',
  'metric-m',
  'mono',
] as const;

export type TextRole = (typeof TEXT_ROLES)[number];

/** Semantic colour roles a caller may choose. Deliberately short. */
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'accent' | 'critical' | 'inherit';

const TONE_VAR: Record<TextTone, string | undefined> = {
  primary: 'var(--color-text-primary)',
  secondary: 'var(--color-text-secondary)',
  tertiary: 'var(--color-text-tertiary)',
  accent: 'var(--color-accent)',
  /**
   * Errors and destructive labels only.
   *
   * §8.2: `--color-critical` is "Never a health metric. Ever." A mood of 2 is
   * not red. This tone exists for "Delete permanently", not for data.
   */
  critical: 'var(--color-critical)',
  inherit: undefined,
};

/** Roles that render numerals in fixed-width columns. */
const TABULAR_ROLES = new Set<TextRole>(['metric-l', 'metric-m', 'mono']);

/** The element each role maps to when the caller does not say. */
const DEFAULT_ELEMENT: Record<TextRole, ElementType> = {
  display: 'p',
  'title-1': 'h1',
  'title-2': 'h2',
  'title-3': 'h3',
  body: 'p',
  'body-sm': 'p',
  caption: 'span',
  'metric-l': 'p',
  'metric-m': 'p',
  mono: 'code',
};

export type TextProps = {
  readonly children?: ReactNode;
  readonly role?: TextRole;
  readonly tone?: TextTone;
  /**
   * Override the element.
   *
   * Necessary because heading *level* is a document-structure decision and
   * heading *size* is a visual one, and conflating them produces either a
   * broken outline or the wrong type scale. A `title-1` inside a card is
   * usually an `h2`.
   */
  readonly as?: ElementType;
  /** Long-form serif (§8.3) — journal entries and reviews. */
  readonly serif?: boolean;
  readonly align?: 'start' | 'center' | 'end';
  /** Clamp to N lines with an ellipsis. */
  readonly lines?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly id?: string;
};

export function Text({
  children,
  role = 'body',
  tone = 'primary',
  as,
  serif = false,
  align,
  lines,
  className,
  style,
  id,
}: TextProps): ReactNode {
  const Component = as ?? DEFAULT_ELEMENT[role];

  const clamp: CSSProperties =
    lines === undefined
      ? {}
      : {
          display: '-webkit-box',
          WebkitLineClamp: lines,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        };

  return (
    <Component
      id={id}
      className={cn('nos-text', `nos-text--${role}`, serif && 'nos-text--serif', className)}
      style={{
        color: TONE_VAR[tone],
        textAlign: align,
        fontVariantNumeric: TABULAR_ROLES.has(role) ? 'tabular-nums' : undefined,
        ...clamp,
        ...style,
      }}
    >
      {children}
    </Component>
  );
}

/**
 * Content visible only to screen readers.
 *
 * §8.13 requires labels that carry meaning without being visual. Kept as a
 * component rather than a utility class so it cannot be accidentally styled
 * away — the clip rectangle is the part people get wrong.
 */
export function VisuallyHidden({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="nos-visually-hidden">{children}</span>;
}
