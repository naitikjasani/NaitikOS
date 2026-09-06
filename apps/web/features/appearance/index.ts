/**
 * Appearance — §7.2's public surface for §2.3's aggregate lens.
 *
 * One Server Component and no client code, because the lens owns no state: it
 * composes what Skin and Composition already compute, and everything
 * interactive lives on those pages.
 */

export { AppearanceScreen } from './screens/AppearanceScreen';
