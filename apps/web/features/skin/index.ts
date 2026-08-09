/**
 * The skin feature — §7.2's public surface.
 *
 * The routine screen lives here even though the routine *engine* is generic
 * (§9.2). Skincare is its only consumer in the MVP, and a `features/routine/`
 * with one screen in it would be a folder created for a symmetry nobody needs
 * yet. When dental hygiene arrives, the screen moves and this export goes.
 */

export { SkinOverviewScreen } from './screens/SkinOverviewScreen';
export { SkinStateScreen } from './screens/SkinStateScreen';
export { RoutineScreen } from './screens/RoutineScreen';
export { ProductsScreen } from './screens/ProductsScreen';
export { PhotoCaptureScreen } from './screens/PhotoCaptureScreen';
