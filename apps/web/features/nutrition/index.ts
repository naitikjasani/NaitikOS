/**
 * The Nutrition feature — §4.3's public surface.
 *
 * Everything except the meal write is server-rendered through
 * `lib/platform/nutrition.ts`. The meal write is the one exception and the
 * reason the module exists: it queues through §5.7's outbox, resolves before
 * the network, and is measured against §2.2's ten-second gate.
 */

export { MealLogScreen } from './screens/MealLogScreen';
export { NutritionOverviewScreen } from './screens/NutritionOverviewScreen';
export { FoodLibraryScreen } from './screens/FoodLibraryScreen';
export { FoodDetailScreen } from './screens/FoodDetailScreen';
export { MealTemplatesScreen } from './screens/MealTemplatesScreen';
export { TargetsScreen } from './screens/TargetsScreen';
export { TrendsScreen } from './screens/TrendsScreen';
