/**
 * Money — §4.9, the V3 Q2 pillar.
 *
 * §4.9 is unusually candid about where this module sits:
 *
 *   "Last in priority: excellent third-party tools exist, and the cross-domain
 *    linkage is thinner than the others. Where it does link, it links well —
 *    supplement and skincare spend against outcomes, food spend against
 *    nutrition quality, and the correlation between financial stress and
 *    anxiety episodes, which is worth knowing."
 *
 * §13's finding 12 sharpens it further: "A dedicated finance app will beat the
 * Money pillar... NaitikOS should own the domains where *integration* is the
 * value, and it should not compete on features in domains where it cannot win."
 *
 * Both sentences are design constraints. This schema is built for the joins
 * §4.9 names and for nothing else. There is no double-entry ledger, no
 * reconciliation workflow, no investment cost-basis tracking, no tax lot, no
 * split-transaction model. Each of those is a real feature of a real finance
 * product, and each would be a fight this system has already decided not to
 * have.
 *
 * ## Import over entry, structurally
 *
 * §4.9: "Import over entry, absolutely (P1). Manual transaction logging will
 * not be sustained and should not be designed for."
 *
 * So `money_transaction` carries `import_hash` and a partial unique index on
 * it. Re-importing the same statement is the normal case rather than the
 * exception, and a schema that made deduplication the application's problem
 * would be a schema that eventually double-counts a month of spending.
 *
 * ## Every amount is integer minor units plus a currency
 *
 * §5.3: "Integer minor units plus an ISO-4217 code — never a float." 1250 +
 * 'INR' is ₹12.50. The `money()` helper in `columns.ts` is the only way an
 * amount is declared here, so no table can quietly deviate — and a bare number
 * with no currency is not a monetary value, which matters over a record that
 * will outlive at least one relocation.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { accountKind, budgetPeriod, shoppingStatus, spendCategory, subscriptionCadence } from './enums';
import { entityColumns, ianaZone, instant, money, primaryKey, reference, rowTimestamps } from './columns';

/* =========================================================================
 * Accounts and balances
 * ====================================================================== */

/**
 * An account. Named, not numbered.
 *
 * There is deliberately **no account number, IBAN, sort code or card PAN**.
 * §5.5 tiers storage by sensitivity and none of those identifiers earns its
 * risk here: the questions this pillar answers — where does it go, is it
 * aligned with what I want — need to tell accounts apart, not to address
 * payments to them. `institution` and `name` do that, and a record that cannot
 * be used to move money is a record whose loss is survivable.
 */
export const financialAccount = pgTable(
  'financial_account',
  {
    ...entityColumns,

    name: text().notNull(),
    kind: accountKind().notNull(),
    institution: text(),

    /** ISO-4217. The account's native currency; a transaction may differ. */
    currency: text().notNull(),

    /**
     * Whether a positive balance is money owed rather than money held.
     *
     * Stored rather than derived from `kind`, because the sign convention is
     * the single easiest thing to get wrong in a net-worth figure and deriving
     * it puts that decision in whichever caller happens to be summing. A credit
     * card with ₹40,000 on it is −₹40,000 of net worth, and a net worth that
     * silently added it instead would be wrong by twice the balance.
     */
    isLiability: boolean().notNull().default(false),

    openedOn: date(),
    closedOn: date(),
    note: text(),
  },
  (t) => [
    index('financial_account_kind_idx').on(t.kind).where(sql`${t.deletedAt} IS NULL`),
    check('financial_account_dates_ordered', sql`${t.closedOn} IS NULL OR ${t.openedOn} IS NULL OR ${t.openedOn} <= ${t.closedOn}`),
  ],
);

/**
 * A balance, as at a moment.
 *
 * §3.2 asks for "net worth over time", and that is this table's whole purpose.
 * Balances are **observed, never computed from transactions.** A running total
 * derived from an import would be wrong from the first missing statement and
 * would stay wrong forever, silently; a balance the operator or an import read
 * off the account is a fact with a date on it.
 *
 * That is the same reasoning §4.10 gives for goals owning no progress, applied
 * to money: two sources of truth guarantee drift.
 */
export const accountBalance = pgTable(
  'account_balance',
  {
    id: primaryKey(),
    ...rowTimestamps,

    accountId: reference()
      .notNull()
      .references(() => financialAccount.id),

    /** The day the balance was read. One reading per account per day. */
    asOfDayKey: text().notNull(),

    /*
     * Required, both halves. A balance row with no amount is not a reading, and
     * an amount with no currency is not a monetary value at all — `columns.ts`
     * says so and this is where that sentence becomes enforceable.
     */
    amountMinor: money().amountMinor.notNull(),
    currency: money().currency.notNull(),
  },
  (t) => [
    uniqueIndex('account_balance_day_unique').on(t.accountId, t.asOfDayKey),
    index('account_balance_day_idx').on(t.asOfDayKey.desc()),
  ],
);

/* =========================================================================
 * Transactions
 * ====================================================================== */

/**
 * A transaction.
 *
 * Named `money_transaction` rather than `transaction`: the bare word is a
 * Postgres keyword and also the name of Drizzle's own `db.transaction()` API,
 * and a table export colliding with the transaction helper is a confusion that
 * would be discovered at the worst possible moment.
 *
 * Sign convention: **negative is money leaving.** One convention, stated once,
 * because the alternative is every query deciding for itself and one of them
 * getting it backwards.
 */
export const moneyTransaction = pgTable(
  'money_transaction',
  {
    ...entityColumns,

    accountId: reference().references(() => financialAccount.id),

    /** Negative for spending, positive for income. §5.3's minor units. */
    amountMinor: money().amountMinor.notNull(),
    currency: money().currency.notNull(),

    occurredAt: instant().notNull(),
    zone: ianaZone(),
    /** The zoned local day, for the per-day joins every other pillar uses. */
    dayKey: text().notNull(),

    /** As printed on the statement. Not cleaned up — the raw string is evidence. */
    rawDescription: text(),
    /** The operator's own name for it, when the raw string is unreadable. */
    merchant: text(),

    category: spendCategory(),
    /**
     * Whether the category was set by hand.
     *
     * An imported guess and a human decision must stay distinguishable, so a
     * re-import can refine its own guesses without overwriting a correction —
     * the same rule the calendar import follows for `is_travel` (P5).
     */
    isCategoryConfirmed: boolean().notNull().default(false),

    subscriptionId: reference(),

    /**
     * Deduplication key for re-import.
     *
     * §4.9 makes import the normal path, which makes re-import the normal case.
     * The hash is computed by the importer over the fields the source actually
     * guarantees; the partial unique index makes a repeat a no-op rather than a
     * double count. Nullable because a hand-entered transaction has no source
     * to hash.
     */
    importHash: text(),
    importedAt: instant(),

    note: text(),
  },
  (t) => [
    index('money_transaction_day_idx').on(t.dayKey.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('money_transaction_category_idx').on(t.category, t.dayKey.desc()).where(sql`${t.deletedAt} IS NULL`),
    index('money_transaction_account_idx').on(t.accountId).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('money_transaction_import_unique')
      .on(t.importHash)
      .where(sql`${t.importHash} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/* =========================================================================
 * Budgets
 * ====================================================================== */

/**
 * A budget: a category, a period, and a number.
 *
 * It owns no spending, exactly as a goal owns no progress (§9.3(4)). What was
 * actually spent is summed from `money_transaction` on read, every time. A
 * stored `spent` column would be a cache that drifts the first time a
 * transaction is recategorised.
 */
export const budget = pgTable(
  'budget',
  {
    ...entityColumns,

    category: spendCategory().notNull(),
    period: budgetPeriod().notNull(),
    amountMinor: money().amountMinor.notNull(),
    currency: money().currency.notNull(),

    effectiveFrom: date().notNull(),
    effectiveTo: date(),
    note: text(),
  },
  (t) => [
    /* One live budget per category per period. A second is a contradiction
     * rather than an addition, and summing two would be nobody's intent. */
    uniqueIndex('budget_category_unique')
      .on(t.category, t.period, t.effectiveFrom)
      .where(sql`${t.deletedAt} IS NULL`),
    check('budget_dates_ordered', sql`${t.effectiveTo} IS NULL OR ${t.effectiveFrom} <= ${t.effectiveTo}`),
  ],
);

/* =========================================================================
 * Subscriptions
 * ====================================================================== */

/**
 * A recurring commitment.
 *
 * §3.2 calls these "recurring commitments", which is the more honest word: the
 * question this answers is not "what do I pay for" but "what have I committed
 * to that I have stopped noticing". So `lastReviewedOn` exists — a subscription
 * nobody has looked at in two years is the one worth surfacing, and that is a
 * fact about attention rather than about money.
 */
export const subscription = pgTable(
  'subscription',
  {
    ...entityColumns,

    name: text().notNull(),
    amountMinor: money().amountMinor.notNull(),
    currency: money().currency.notNull(),
    cadence: subscriptionCadence().notNull(),
    category: spendCategory(),

    accountId: reference().references(() => financialAccount.id),

    startedOn: date(),
    /** Set when it was cancelled. A cancelled row is history, never removed. */
    cancelledOn: date(),
    cancellationNote: text(),

    nextDueOn: date(),
    lastReviewedOn: date(),

    note: text(),
  },
  (t) => [
    index('subscription_active_idx').on(t.nextDueOn).where(sql`${t.cancelledOn} IS NULL AND ${t.deletedAt} IS NULL`),
    check('subscription_dates_ordered', sql`${t.cancelledOn} IS NULL OR ${t.startedOn} IS NULL OR ${t.startedOn} <= ${t.cancelledOn}`),
  ],
);

/* =========================================================================
 * Shopping
 * ====================================================================== */

/**
 * A thing to buy, and — once bought — what it cost.
 *
 * §3.2 puts "shopping list & purchase history" on one route, and they are one
 * table rather than two because they are one object at two moments. Splitting
 * them would mean copying an item across on purchase and then keeping two
 * spellings of the same thing in step for twenty years.
 *
 * The link to `money_transaction` is what makes this more than a notepad: it is
 * how "supplement and skincare spend against outcomes" (§4.9) becomes
 * answerable at the level of an individual product rather than a category.
 */
export const shoppingItem = pgTable(
  'shopping_item',
  {
    ...entityColumns,

    name: text().notNull(),
    status: shoppingStatus().notNull().default('wanted'),
    category: spendCategory(),

    quantity: integer(),

    /**
     * What it was expected to cost, when that was known before buying.
     *
     * Genuinely optional — most things go on a list before anyone checks the
     * price — but the pair is enforced below. Half a monetary value is not a
     * smaller fact, it is an unreadable one.
     */
    ...money(),

    purchasedAt: instant(),
    /** The purchase, once it is identified in the record. */
    transactionId: reference().references(() => moneyTransaction.id),

    /**
     * The product this restocks, when it is one the system already tracks.
     * Polymorphic like §9.3(3): a skincare product, a supplement, a food.
     */
    linkedEntityType: text(),
    linkedEntityId: reference(),

    note: text(),
  },
  (t) => [
    index('shopping_item_status_idx').on(t.status).where(sql`${t.deletedAt} IS NULL`),
    index('shopping_item_linked_idx').on(t.linkedEntityType, t.linkedEntityId),
    check(
      'shopping_item_purchase_together',
      sql`${t.status} <> 'purchased' OR ${t.purchasedAt} IS NOT NULL`,
    ),
    check(
      'shopping_item_amount_paired',
      sql`(${t.amountMinor} IS NULL) = (${t.currency} IS NULL)`,
    ),
  ],
);
