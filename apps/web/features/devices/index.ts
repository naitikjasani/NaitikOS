/**
 * The Devices feature — §7.2's public surface.
 *
 * One screen, server-rendered from `lib/platform/devices.ts`. The import is a
 * client interaction because it reads a file in the browser; everything it
 * reports comes back from `/api/samples` rather than being computed here.
 */

export { DevicesScreen } from './screens/DevicesScreen';
