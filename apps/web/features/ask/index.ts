/**
 * The Ask feature — §4.13's conversational lens.
 *
 * Client-rendered, unusually for this codebase: the question is not known at
 * request time and the answer costs a model call, so there is nothing to
 * server-render. Every other read surface here is server-rendered precisely
 * because it has data to show before the operator does anything.
 */

export { AskScreen } from './screens/AskScreen';
