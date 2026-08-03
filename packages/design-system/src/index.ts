/**
 * @naitikos/design-system
 *
 * Domain-agnostic UI. §6.2: "it renders values; it does not know what a
 * medication is." The boundary lint rule enforces that — this package may
 * import `@naitikos/shared` and nothing else internal.
 *
 * Consumers import `@naitikos/design-system/tokens.css` and
 * `@naitikos/design-system/styles.css` once, at the root.
 */

export { cn } from './lib/cn';

/* Primitives */
export * from './primitives/Layout';
export * from './primitives/Text';

/* Icons */
export { Icon } from './icons/Icon';
export type { IconProps } from './icons/Icon';
export { ICON_REGISTRY, ICON_NAMES, ICON_SIZES } from './icons/registry';
export type { IconName, IconSize } from './icons/registry';

/* Components */
export * from './components/Button';
export * from './components/Card';
export * from './components/Display';
export * from './components/Field';
export * from './components/Navigation';
export * from './components/Overlay';
export * from './components/States';
export * from './components/Toast';

/* Charts — architecture only; the plot layer is V2 (§8.9). */
export * from './charts/types';
export { ChartFrame } from './charts/ChartFrame';
export type { ChartFrameProps } from './charts/ChartFrame';
