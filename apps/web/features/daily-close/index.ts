/**
 * The Daily Close (§4.0) — the ritual the whole product is built around.
 *
 * §7.4: a feature exposes exactly what other parts of the app may use, and
 * nothing else. `app/` imports the screen; the shell imports the hook to know
 * whether today is closed. Everything else is internal.
 */

export { DailyCloseScreen } from './screens/DailyCloseScreen';
export type { DailyCloseScreenProps } from './screens/DailyCloseScreen';

export { useDailyClose } from './hooks/useDailyClose';
export type { UseDailyClose, DraftAnswers } from './hooks/useDailyClose';

export type { CloseSnapshot, SubmitAnswer } from './services/closeClient';
