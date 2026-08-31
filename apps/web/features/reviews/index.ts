/**
 * The Reviews feature — §7.2's public surface.
 *
 * Reads are server-rendered through `lib/platform/reviews.ts`; these screens
 * take their data as props. A review is a document, not a live state, and there
 * is nothing here worth polling for.
 */

export { ReviewsScreen } from './screens/ReviewsScreen';
export { ReviewDetailScreen } from './screens/ReviewDetailScreen';
