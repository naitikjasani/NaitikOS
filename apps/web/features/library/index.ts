/**
 * The Library feature — §7.2's public surface.
 *
 * A read surface over registries that already exist. Nothing in this feature
 * writes: exercises, foods, products, protocols and metrics are all authored by
 * the module that owns them, and §2.1's "no manual database intervention" is
 * satisfied by the register editors those modules already ship. A second editor
 * here would be a second source of truth for the same row (§9.3(4)).
 *
 * Four of the six screens are plain Server Components. Reference pages are
 * opened deliberately and rarely, and rendering the whole registry keeps the
 * browser's own find working — which is better than a filter box on a page
 * whose entire job is being looked things up in. The two exceptions are
 * exercises and foods, the only registries the operator adds to incidentally.
 */

export { LibraryOverviewScreen } from './screens/LibraryOverviewScreen';
export { ExerciseLibraryScreen } from './screens/ExerciseLibraryScreen';
export { FoodLibraryScreen } from './screens/FoodLibraryScreen';
export { ProductLibraryScreen } from './screens/ProductLibraryScreen';
export { ProtocolLibraryScreen } from './screens/ProtocolLibraryScreen';
export { MetricRegistryScreen } from './screens/MetricRegistryScreen';
export { TagVocabularyScreen } from './screens/TagVocabularyScreen';
