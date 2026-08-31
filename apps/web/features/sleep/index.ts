/**
 * The Sleep feature — §7.2's public surface.
 *
 * Reads are server-rendered through `lib/platform/sleep.ts`; the screen takes
 * its board as a prop. §4.6's value is in what other domains can be laid next
 * to this data, not in live state, so there is nothing here worth polling for.
 */

export { SleepScreen } from './screens/SleepScreen';
