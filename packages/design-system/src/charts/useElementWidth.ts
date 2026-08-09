'use client';

import { useEffect, useState, type RefObject } from 'react';

/**
 * The measured width of an element, for charts that render in real pixels.
 *
 * ## Why not a `viewBox` and a percentage width
 *
 * The usual trick — draw into a fixed coordinate system and let SVG scale it —
 * scales the *text and the strokes* with it. A 1px axis on a 720-unit viewBox
 * shown at 340px becomes 0.47px and disappears on a non-retina screen; a 10px
 * tick label becomes 4.7px and is unreadable. §8.9(7) makes 360px the design
 * target rather than a degraded case, so the plot is drawn at the size it will
 * actually occupy and the type stays the size the type system says.
 *
 * ## The server-render default
 *
 * `INITIAL_WIDTH` is what the first paint uses, before measurement. It is
 * deliberately the narrow case: a chart that renders wide and then snaps narrow
 * is a visible reflow, while one that renders narrow and then widens is not.
 * Charts are also secondary content — the data table beneath them (§8.9(6)) is
 * plain HTML, present in the server-rendered markup, and readable with no
 * JavaScript at all.
 */
export const INITIAL_WIDTH = 320;

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(INITIAL_WIDTH);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const measure = (): void => {
      // `Math.round` because a fractional width produces fractional tick
      // positions, and those render on half-pixels as a blurred grey line.
      setWidth(Math.round(element.getBoundingClientRect().width));
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      // Ancient or headless. One measurement is better than none, and the
      // chart simply will not reflow on rotation.
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return width;
}
