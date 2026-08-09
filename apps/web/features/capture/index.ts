/**
 * Quick capture and sync visibility (§3.3(4), §5.7).
 *
 * §7.4: a feature exposes what other parts of the app may use, and nothing
 * else. The shell mounts both components; nothing imports the outbox through
 * here, because the outbox is infrastructure and lives in `lib/offline`.
 */

export { QuickCapture, QUICK_CAPTURE_CHORDS } from './components/QuickCapture';
export type { QuickCaptureProps } from './components/QuickCapture';

export { SyncBanner } from './components/SyncBanner';

export { useOutbox } from './hooks/useOutboxHealth';
export type { UseOutbox } from './hooks/useOutboxHealth';
