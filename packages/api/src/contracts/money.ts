/**
 * Money contracts — §4.9.
 *
 * ## Every amount is a decimal string on the wire and `bigint` minor units in storage
 *
 * This is the one sentence a later maintainer will get wrong, so it is the
 * first one here. §5.3 stores money as **integer minor units plus an ISO-4217
 * code** — `1250n` + `'INR'` is ₹12.50 — and `bigint` is not JSON-serialisable:
 * `JSON.stringify({ n: 1n })` throws. So every amount that crosses this
 * boundary, in either direction, is a **decimal string** (`'12.50'`) carried
 * beside a three-letter currency code, and it is converted at the boundary and
 * nowhere else: `parseAmount` on the way in, `formatAmount` on the way out.
 *
 * The string is not a convenience wrapper around a number. A JSON number would
 * be an IEEE-754 double, and §5.3 rules out floats for money for the reason
 * every finance system eventually learns in production. `-0.1` is a string here
 * because it is exact as a string and is not exact as a double.
 *
 * ## A contract never mixes currencies, because no exchange rate exists anywhere
 *
 * There is no rate table, no rate provider and no conversion function in this
 * system, deliberately (see `docs/money.md`). Consequently every amount here
 * carries its own currency and nothing in this file, in `core`, or in any
 * route sums two amounts in different currencies — `addAmounts` refuses. A
 * contract that accepted a mixed batch would be promising an addition the rest
 * of the system cannot perform.
 *
 * ## Import is the primary path, so the import kind takes a batch
 *
 * §4.9: "Import over entry, absolutely (P1). Manual transaction logging will
 * not be sustained and should not be designed for." So `transaction_import`
 * accepts up to 5,000 rows in one request, each carrying an `importHash` the
 * client computed over the fields the source actually guarantees. The server
 * dedupes on that hash against `money_transaction_import_unique`, which makes
 * re-importing last month's statement a no-op rather than a double count.
 * Re-import is the normal case, not the error case.
 *
 * `transaction` — a single hand-entered row — exists for the transaction the
 * statement will never carry, not as the path the operator is expected to live
 * in. It takes no `importHash`: there is no source to hash.
 *
 * ## Nothing here accepts a computed balance
 *
 * `balance` is an *observation* — a number read off an account on a day. The
 * schema comment on `account_balance` gives the argument; this is the wire
 * refusing the alternative. There is no kind that asks the server to roll
 * transactions forward into a balance, because a running total is wrong from
 * the first missing statement and stays wrong silently forever.
 */

import { z } from 'zod';

import { dayKeySchema, instantSchema, uuidSchema, zoneSchema } from './timeline';

/* =========================================================================
 * The two primitives every money field is built from
 * ====================================================================== */

/**
 * A decimal amount, as a string.
 *
 * Signed, because §4.9's convention is that **negative is money leaving**. The
 * fractional part is unbounded here rather than pinned to two digits: minor
 * units are per-currency (`MINOR_UNITS`), JPY has none and KWD has three, and a
 * regex that assumed two would silently reject a valid Kuwaiti amount. The
 * scale is checked against the currency by `parseAmount` in `core`, which is
 * the layer that knows.
 */
export const amountSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/u, 'Must be a decimal amount, as a string — not a number.');

/** An ISO-4217 code. Three uppercase letters, always present beside an amount. */
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/u, 'Must be an uppercase ISO-4217 currency code.');

export const accountKindSchema = z.enum([
  'current',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
  'wallet',
  'other',
]);

export const spendCategorySchema = z.enum([
  'groceries',
  'eating_out',
  'supplements',
  'skincare',
  'health',
  'fitness',
  'rent',
  'utilities',
  'transport',
  'subscriptions',
  'shopping',
  'travel',
  'education',
  'gifts',
  'fees',
  'income',
  'transfer',
  'other',
]);

export const budgetPeriodSchema = z.enum(['weekly', 'monthly', 'quarterly', 'annual']);

export const subscriptionCadenceSchema = z.enum(['weekly', 'monthly', 'quarterly', 'annual']);

export const shoppingStatusSchema = z.enum(['wanted', 'purchased', 'dropped']);

/* =========================================================================
 * Accounts and balances
 * ====================================================================== */

/**
 * An account.
 *
 * No account number, IBAN, sort code or card PAN — the schema comment explains
 * why, and the contract is where the refusal is enforceable. A field the wire
 * will not carry is a field that cannot arrive by accident.
 */
export const accountRequestSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    kind: accountKindSchema,
    institution: z.string().max(200).nullish(),
    currency: currencySchema,
    /**
     * Whether a positive balance is money owed rather than money held.
     *
     * Sent explicitly rather than derived from `kind` on the server, for the
     * reason the schema gives: a net worth that added a credit card balance
     * instead of subtracting it is wrong by twice the balance, and that
     * decision belongs somewhere a human states it once.
     */
    isLiability: z.boolean(),
    openedOn: dayKeySchema.nullish(),
    closedOn: dayKeySchema.nullish(),
    note: z.string().max(2000).nullish(),
  })
  .refine(
    (account) => {
      const opened = account.openedOn ?? null;
      const closed = account.closedOn ?? null;
      return opened === null || closed === null || opened <= closed;
    },
    { message: 'An account cannot close before it opened.', path: ['closedOn'] },
  );

/** A balance reading. One per account per day; a second replaces the first. */
export const balanceRequestSchema = z.object({
  accountId: uuidSchema,
  /** The day the balance was *read*, which is not necessarily today. */
  asOfDayKey: dayKeySchema,
  amount: amountSchema,
  currency: currencySchema,
});

/* =========================================================================
 * Transactions
 * ====================================================================== */

/** A hand-entered transaction. Negative is money leaving. */
export const transactionRequestSchema = z.object({
  id: uuidSchema,
  accountId: uuidSchema.nullish(),
  amount: amountSchema,
  currency: currencySchema,
  occurredAt: instantSchema,
  /** The zone it happened in. The server derives `dayKey` from the pair. */
  zone: zoneSchema,
  rawDescription: z.string().max(500).nullish(),
  merchant: z.string().max(200).nullish(),
  category: spendCategorySchema.nullish(),
  subscriptionId: uuidSchema.nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * One row of an import batch.
 *
 * `importHash` is required and every other identifying field is optional,
 * which is the right way round: the hash is the row's identity for
 * deduplication purposes and the description is only evidence. The client
 * computes the hash over what the *source* guarantees — a statement re-exported
 * next month may re-order its columns or re-pad its whitespace, and a hash over
 * the whole raw line would make every one of those a new transaction.
 */
export const transactionImportRowSchema = z.object({
  id: uuidSchema,
  amount: amountSchema,
  currency: currencySchema,
  occurredAt: instantSchema,
  rawDescription: z.string().max(500).nullish(),
  merchant: z.string().max(200).nullish(),
  category: spendCategorySchema.nullish(),
  importHash: z.string().min(8).max(200),
});

/**
 * A batch import.
 *
 * Capped at 5,000 rows — several years of one account's statements, and small
 * enough that one request is one transaction rather than a job. A single
 * `accountId` and a single `zone` for the batch, because a statement comes from
 * one account and was read in one place; per-row overrides would invite a batch
 * that half-belongs to two accounts.
 */
export const transactionImportRequestSchema = z.object({
  accountId: uuidSchema.nullish(),
  zone: zoneSchema,
  rows: z.array(transactionImportRowSchema).min(1).max(5000),
});

/**
 * A recategorisation, always by hand.
 *
 * The server sets `isCategoryConfirmed` from this path and only from this
 * path, so a later re-import can refine its own guesses without overwriting a
 * human decision — the rule the calendar import already follows for
 * `is_travel` (P5).
 */
export const transactionCategoryRequestSchema = z.object({
  id: uuidSchema,
  category: spendCategorySchema,
});

/* =========================================================================
 * Budgets
 * ====================================================================== */

/**
 * A budget: a category, a period, a number, and a window it applies to.
 *
 * It carries no `spent` field and never will. What was spent is summed from
 * transactions on every read (§9.3(4)); a stored total would drift the first
 * time a transaction was recategorised, and would drift silently.
 */
export const budgetRequestSchema = z
  .object({
    id: uuidSchema,
    category: spendCategorySchema,
    period: budgetPeriodSchema,
    amount: amountSchema,
    currency: currencySchema,
    effectiveFrom: dayKeySchema,
    effectiveTo: dayKeySchema.nullish(),
    note: z.string().max(2000).nullish(),
  })
  .refine(
    (budget) => {
      const to = budget.effectiveTo ?? null;
      return to === null || budget.effectiveFrom <= to;
    },
    { message: 'A budget cannot end before it starts.', path: ['effectiveTo'] },
  );

/* =========================================================================
 * Subscriptions
 * ====================================================================== */

/**
 * A recurring commitment.
 *
 * `lastReviewedOn` is on the write path rather than being stamped by the server
 * on every save, because it records *attention*, not modification. §3.2 calls
 * these "recurring commitments" and the question they answer is what has been
 * committed to and stopped being noticed; a field the server touched on every
 * write would answer nothing.
 */
export const subscriptionRequestSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(200),
  amount: amountSchema,
  currency: currencySchema,
  cadence: subscriptionCadenceSchema,
  category: spendCategorySchema.nullish(),
  accountId: uuidSchema.nullish(),
  startedOn: dayKeySchema.nullish(),
  nextDueOn: dayKeySchema.nullish(),
  lastReviewedOn: dayKeySchema.nullish(),
  note: z.string().max(2000).nullish(),
});

/**
 * A cancellation.
 *
 * The row is never deleted. A subscription paid for eighteen months and then
 * cancelled is the most interesting kind of row this table holds, and deleting
 * it would erase the eighteen months along with the commitment.
 */
/**
 * Recording that a commitment was looked at and kept.
 *
 * Only a day key. There is nothing else to say — the value is the date, and a
 * field asking *why* it was kept would be a field nobody fills in on the one
 * screen whose whole point is being cheap to revisit.
 */
export const subscriptionReviewRequestSchema = z.object({
  id: uuidSchema,
  reviewedOn: dayKeySchema,
});

export const subscriptionCancelRequestSchema = z.object({
  id: uuidSchema,
  cancelledOn: dayKeySchema,
  /** Asked for, never required. An honest blank beats an invented reason. */
  cancellationNote: z.string().max(1000).nullish(),
});

/* =========================================================================
 * Shopping
 * ====================================================================== */

/**
 * A thing to buy.
 *
 * The amount pair is optional — most things go on a list before anyone checks
 * the price — but it is all-or-nothing. Half a monetary value is not a smaller
 * fact, it is an unreadable one, and the schema has a `CHECK` saying so.
 */
export const shoppingItemRequestSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(200),
    status: shoppingStatusSchema.nullish(),
    category: spendCategorySchema.nullish(),
    quantity: z.number().int().min(1).max(10000).nullish(),
    amount: amountSchema.nullish(),
    currency: currencySchema.nullish(),
    linkedEntityType: z.string().max(60).nullish(),
    linkedEntityId: uuidSchema.nullish(),
    note: z.string().max(2000).nullish(),
  })
  .refine((item) => ((item.amount ?? null) === null) === ((item.currency ?? null) === null), {
    message: 'An amount needs a currency, and a currency needs an amount.',
    path: ['currency'],
  })
  .refine(
    (item) =>
      ((item.linkedEntityType ?? null) === null) === ((item.linkedEntityId ?? null) === null),
    { message: 'A linked entity needs both a type and an id, or neither.', path: ['linkedEntityId'] },
  );

/**
 * Buying the thing, or deciding not to.
 *
 * `dropped` is here alongside `purchased` because it is a first-class outcome,
 * for the reason `abandoned` is one on a learning item: a list that can only be
 * bought from accumulates things nobody wants any more, and a list like that
 * stops being opened.
 */
export const shoppingPurchaseRequestSchema = z
  .object({
    id: uuidSchema,
    outcome: z.enum(['purchased', 'dropped']),
    /** The zone the purchase happened in; the server times it from its clock. */
    zone: zoneSchema,
    /** The transaction it turned out to be, when it is identified. */
    transactionId: uuidSchema.nullish(),
    /** What it actually cost, which is often not what was expected. */
    amount: amountSchema.nullish(),
    currency: currencySchema.nullish(),
    note: z.string().max(2000).nullish(),
  })
  .refine((purchase) => ((purchase.amount ?? null) === null) === ((purchase.currency ?? null) === null), {
    message: 'An amount needs a currency, and a currency needs an amount.',
    path: ['currency'],
  });

/* =========================================================================
 * The union
 * ====================================================================== */

export const moneyWriteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), account: accountRequestSchema }),
  z.object({ kind: z.literal('balance'), balance: balanceRequestSchema }),
  z.object({ kind: z.literal('transaction'), transaction: transactionRequestSchema }),
  z.object({ kind: z.literal('transaction_import'), batch: transactionImportRequestSchema }),
  z.object({ kind: z.literal('transaction_category'), category: transactionCategoryRequestSchema }),
  z.object({ kind: z.literal('budget'), budget: budgetRequestSchema }),
  z.object({ kind: z.literal('subscription'), subscription: subscriptionRequestSchema }),
  z.object({ kind: z.literal('subscription_cancel'), cancel: subscriptionCancelRequestSchema }),
  z.object({ kind: z.literal('subscription_review'), review: subscriptionReviewRequestSchema }),
  z.object({ kind: z.literal('shopping_item'), item: shoppingItemRequestSchema }),
  z.object({ kind: z.literal('shopping_purchase'), purchase: shoppingPurchaseRequestSchema }),
]);

export type MoneyWriteRequest = z.infer<typeof moneyWriteSchema>;
export type AccountRequest = z.infer<typeof accountRequestSchema>;
export type BalanceRequest = z.infer<typeof balanceRequestSchema>;
export type TransactionRequest = z.infer<typeof transactionRequestSchema>;
export type TransactionImportRow = z.infer<typeof transactionImportRowSchema>;
export type TransactionImportRequest = z.infer<typeof transactionImportRequestSchema>;
export type BudgetRequest = z.infer<typeof budgetRequestSchema>;
export type SubscriptionRequest = z.infer<typeof subscriptionRequestSchema>;
export type ShoppingItemRequest = z.infer<typeof shoppingItemRequestSchema>;
export type ShoppingPurchaseRequest = z.infer<typeof shoppingPurchaseRequestSchema>;
