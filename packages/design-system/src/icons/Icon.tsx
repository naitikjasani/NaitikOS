import type { ReactNode, SVGProps } from 'react';

import { ICON_REGISTRY, ICON_SIZES, type IconName, type IconSize } from './registry';

/**
 * The only way to render an icon.
 *
 * §8.5: "Icons never appear without a text label or an `aria-label`, and never
 * as the sole carrier of meaning."
 *
 * That rule is enforced by the prop types rather than documented: `label` is
 * required, and passing `null` is the explicit way to say "this icon is
 * decorative because adjacent text already carries the meaning". There is no
 * way to render an unlabelled icon by forgetting something — you have to state
 * the intent.
 */
export type IconProps = {
  readonly name: IconName;
  /**
   * Accessible label, or `null` when the icon is decorative.
   *
   * `null` sets `aria-hidden` and removes it from the accessibility tree. Use
   * it when a visible text label sits beside the icon — announcing "pencil
   * Edit" is worse than announcing "Edit".
   */
  readonly label: string | null;
  readonly size?: IconSize | undefined;
  readonly className?: string | undefined;
  /**
   * Stroke colour. Defaults to `currentColor`, which is almost always right:
   * an icon should inherit the colour of the text it sits with, so it stays
   * correct across themes and states without being told about either.
   */
  readonly color?: string | undefined;
} & Omit<SVGProps<SVGSVGElement>, 'ref' | 'color' | 'name'>;

export function Icon({
  name,
  label,
  size = 'md',
  className,
  color = 'currentColor',
  ...rest
}: IconProps): ReactNode {
  const Glyph = ICON_REGISTRY[name];
  const pixels = ICON_SIZES[size];

  return (
    <Glyph
      width={pixels}
      height={pixels}
      color={color}
      // Lucide's default is 2 at 24px. Scaling it keeps optical weight even
      // across sizes — a 2px stroke on a 16px glyph reads noticeably heavier.
      strokeWidth={size === 'sm' ? 2.25 : 2}
      className={className}
      aria-hidden={label === null ? true : undefined}
      aria-label={label ?? undefined}
      role={label === null ? undefined : 'img'}
      // The glyph never shrinks in a flex row. An icon squashed to 14px beside
      // a long label is a rendering bug that looks like a design decision.
      style={{ flexShrink: 0 }}
      {...rest}
    />
  );
}
