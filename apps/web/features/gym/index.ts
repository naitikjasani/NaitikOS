/**
 * The gym feature — §7.2's public surface.
 *
 * §7.4's rule: "a feature's `index.ts` is its only public surface. Reaching into
 * `features/gym/components/…` from outside is a lint error, because the day one
 * feature depends on another's internals is the day the boundary stops meaning
 * anything."
 */

export { SessionLoggerScreen } from './screens/SessionLoggerScreen';
export type { SessionLoggerScreenProps } from './screens/SessionLoggerScreen';

export { SessionHistoryScreen } from './screens/SessionHistoryScreen';
export { ExerciseLibraryScreen } from './screens/ExerciseLibraryScreen';
export { ExerciseDetailScreen } from './screens/ExerciseDetailScreen';
export { VolumeScreen } from './screens/VolumeScreen';
export { ProgramCard } from './components/ProgramCard';

export { useRestTimer, DEFAULT_REST_SECONDS } from './hooks/useRestTimer';
export type { RestTimer as RestTimerState } from './hooks/useRestTimer';

/* Program definition (§4.1). Server-rendered; the forms are the only client
 * state, and a plan is written once a mesocycle rather than watched. */
export { ProgramsScreen } from './screens/ProgramsScreen';
export { ProgramDetailScreen } from './screens/ProgramDetailScreen';
