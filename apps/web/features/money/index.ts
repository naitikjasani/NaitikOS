/**
 * The Money feature — §7.2's public surface.
 *
 * Reads are server-rendered through `lib/platform/money.ts` and these screens
 * take their data as props. Every amount arrives already formatted, because a
 * `bigint` cannot cross the Server-to-Client-Component boundary (§8 of
 * `docs/money.md`); the loaders own that conversion and the screens do no
 * money arithmetic at all.
 *
 * §4.9 makes this pillar's value cross-domain rather than live, so there is
 * nothing here worth polling for.
 */

export { MoneyOverviewScreen } from './screens/MoneyOverviewScreen';
export { AccountsScreen } from './screens/AccountsScreen';
export { TransactionsScreen } from './screens/TransactionsScreen';
export { BudgetsScreen } from './screens/BudgetsScreen';
export { SubscriptionsScreen } from './screens/SubscriptionsScreen';
export { ShoppingScreen } from './screens/ShoppingScreen';
export { NetWorthScreen } from './screens/NetWorthScreen';
