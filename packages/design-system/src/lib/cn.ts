import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, resolving conflicts last-wins.
 *
 * The design system does not use Tailwind utilities for its own styling — it
 * uses CSS Modules over tokens, because §8.1 requires that "a component may
 * only reference tier 3" and a utility class references tier 1 directly.
 *
 * `cn` exists for the *seam*: a consumer passing `className` to override
 * spacing, and the `cva` variant maps below. `twMerge` is retained so that if
 * the app later adopts Tailwind for layout, a caller's `p-4` correctly replaces
 * a default rather than losing to specificity roulette.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
