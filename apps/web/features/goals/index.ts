/**
 * The Goals feature — §7.2's public surface.
 *
 * Reads are all server-rendered through `lib/platform/goals.ts`; these screens
 * take their data as props. §4.10 makes progress a derivation over other
 * modules' observations, so there is no goal data to fetch client-side — only
 * a definition to write.
 */

export { GoalsScreen } from './screens/GoalsScreen';
export { GoalDetailScreen } from './screens/GoalDetailScreen';
export { GoalReviewScreen } from './screens/GoalReviewScreen';
