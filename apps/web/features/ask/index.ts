/**
 * The Ask feature — §4.13's conversational lens, and §3.2's saved lines of
 * enquiry.
 *
 * `AskScreen` is client-rendered, unusually for this codebase: the question is
 * not known at request time and the answer costs a model call, so there is
 * nothing to server-render. The thread surfaces are the opposite — a saved
 * enquiry has its answers already, and they are re-resolved against the log on
 * the server every time the page opens (§9.1's supersession).
 */

export { AskScreen } from './screens/AskScreen';
export { ThreadListScreen } from './screens/ThreadListScreen';
export { ThreadScreen } from './screens/ThreadScreen';
export { AnsweredParagraph, UnresolvedNote } from './components/AnsweredParagraph';
