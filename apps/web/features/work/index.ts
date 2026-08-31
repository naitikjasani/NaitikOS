/**
 * The Work feature — §7.2's public surface.
 *
 * Reads are server-rendered through `lib/platform/work.ts`; these screens take
 * their data as props. §4.8's value is in cross-domain joins rather than in
 * live state, so there is nothing here worth polling for.
 */

export { WorkOverviewScreen } from './screens/WorkOverviewScreen';
export { TaskBoardScreen } from './screens/TaskBoardScreen';
export { ProjectsScreen } from './screens/ProjectsScreen';
export { CareerScreen } from './screens/CareerScreen';
export { LearningScreen } from './screens/LearningScreen';
export { LearningNotesScreen } from './screens/LearningNotesScreen';
export { CalendarScreen } from './screens/CalendarScreen';
export { FocusScreen } from './screens/FocusScreen';
