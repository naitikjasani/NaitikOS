/**
 * The mind feature — §7.2's public surface.
 *
 * §7.4: "a feature's `index.ts` is its only public surface." Nothing outside
 * this folder imports from `features/mind/components/…`, which is what stops
 * `CrisisCard` — the component with the most rules attached to it in the
 * system — from being reused somewhere those rules do not hold.
 */

export { MindOverviewScreen } from './screens/MindOverviewScreen';
export { AnxietyScreen } from './screens/AnxietyScreen';
export { JournalScreen } from './screens/JournalScreen';
export { JournalEntryScreen } from './screens/JournalEntryScreen';
export { PracticesScreen } from './screens/PracticesScreen';
export { MedicationScreen } from './screens/MedicationScreen';
