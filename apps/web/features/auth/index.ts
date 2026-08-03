/**
 * ★ The public API of the auth feature (§7.4 R1).
 *
 * This is the only legal import path. `@/features/auth/services/authClient` is
 * not importable from outside and fails lint — without that, the boundary is
 * decorative.
 */

export { SignInScreen } from './screens/SignInScreen';
export { SessionProvider } from './components/SessionProvider';
export { useSession } from './hooks/useSession';
export type { ClientSession, SessionContextValue } from './hooks/useSession';
export { signOut, stepUp } from './services/authClient';
export type { AuthClientError } from './services/authClient';
