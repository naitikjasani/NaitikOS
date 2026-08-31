/**
 * The Insights feature — §3.2's V2 inbox, and §10.6's surface.
 *
 * The inbox is server-rendered: an insight changes once a night at most, and a
 * client-side poll would add exactly the background request §1.4's
 * counter-metric exists to discourage.
 */

export { InsightInboxScreen } from './screens/InsightInboxScreen';
export { InsightDetailScreen } from './screens/InsightDetailScreen';
export { InsightArchiveScreen } from './screens/InsightArchiveScreen';
