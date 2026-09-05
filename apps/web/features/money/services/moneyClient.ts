'use client';

/**
 * The Money feature's client service (§7.3).
 *
 * ## Amounts are strings in both directions, and that is not a stylistic choice
 *
 * Every amount sent from here is a **decimal string** (`'1250.00'`) beside an
 * ISO-4217 code, and every amount that comes back is a **display string**
 * (`'₹1,250.00'`). Neither is a `number` and neither is a `bigint`.
 *
 * Storage is `bigint` minor units (§5.3), and `bigint` is not JSON-serialisable
 * — `JSON.stringify({ n: 1n })` throws. So `parseAmount` converts on the way in
 * at `/api/money` and `formatAmount` converts on the way out, and this module
 * never sees a minor-unit value at all. A wire type here that carried a raw
 * amount would fail at runtime, in the browser, as an opaque serialisation
 * complaint rather than as a type error — which is why the wire types below
 * spell the strings out instead of reusing the `core` types.
 *
 * **Writes only.** Every Money surface is server-rendered and re-read through
 * `router.refresh()` after a write, so nothing here fetches. A balance sheet is
 * opened deliberately rather than watched, and polling one would add exactly
 * the background request §1.4's counter-metric exists to discourage.
 *
 * **Nothing here queues through the outbox.** A recategorisation, a
 * cancellation and a mark-purchased are all *state transitions* on existing
 * rows, and the outbox replays in queue order rather than causal order — the
 * same argument `workClient.ts` records. The import is not queued either, for a
 * simpler reason: it is a 5,000-row batch initiated from a file the operator is
 * looking at, and a queued one that replayed a week later against a statement
 * they had already re-imported is a confusion with no upside.
 */

import type { AccountKind } from '@naitikos/core';

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function post<T>(body: unknown): Promise<T> {
  const response = await fetch('/api/money', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { readonly message?: string } | null;
    throw new HttpError(response.status, detail?.message ?? `Request failed (${String(response.status)}).`);
  }
  return (await response.json()) as T;
}

/** What the server sends back for a row that carries money. Display, not arithmetic. */
export type WireMoneyRow = {
  readonly id: string;
  /** Already formatted — `'₹1,250.00'`. Not parseable, and not meant to be. */
  readonly amount: string;
  readonly currency: string;
};

export type SpendCategoryValue = string;

/* -------------------------------------------------------------------------
 * Accounts and balances
 * ---------------------------------------------------------------------- */

export type AccountDraft = {
  readonly id: string;
  readonly name: string;
  readonly kind: AccountKind;
  readonly institution: string | null;
  readonly currency: string;
  readonly isLiability: boolean;
  readonly openedOn: string | null;
  readonly note: string | null;
};

export async function saveAccount(draft: AccountDraft): Promise<{ readonly account: { readonly id: string } }> {
  return post({ kind: 'account', account: draft });
}

export type BalanceDraft = {
  readonly accountId: string;
  readonly asOfDayKey: string;
  /** A decimal string in major units. `'1250.00'`, never `1250`. */
  readonly amount: string;
  readonly currency: string;
};

export async function recordBalance(draft: BalanceDraft): Promise<{ readonly balance: WireMoneyRow }> {
  return post({ kind: 'balance', balance: draft });
}

/* -------------------------------------------------------------------------
 * Transactions
 * ---------------------------------------------------------------------- */

export type TransactionDraft = {
  readonly id: string;
  readonly accountId: string | null;
  /** Negative is money leaving. One convention, stated once (§4.9). */
  readonly amount: string;
  readonly currency: string;
  readonly occurredAt: string;
  readonly zone: string;
  readonly rawDescription: string | null;
  readonly merchant: string | null;
  readonly category: SpendCategoryValue | null;
  readonly note: string | null;
};

export async function recordTransaction(
  draft: TransactionDraft,
): Promise<{ readonly transaction: WireMoneyRow }> {
  return post({ kind: 'transaction', transaction: draft });
}

export type ImportRow = {
  readonly id: string;
  readonly amount: string;
  readonly currency: string;
  readonly occurredAt: string;
  readonly rawDescription: string | null;
  readonly merchant: string | null;
  readonly category: SpendCategoryValue | null;
  /** Computed client-side over date + amount + description. See `TransactionsScreen`. */
  readonly importHash: string;
};

/**
 * The primary write path (§4.9's "import over entry, absolutely").
 *
 * The result is two counts rather than a success flag, because "412 rows, 9
 * new" is the only summary that tells the operator whether the run did what
 * they expected. A skip is the *normal* outcome for a re-imported statement,
 * not an error, and reporting it as one would train the operator to stop
 * re-importing — which is how a month goes missing.
 */
export async function importTransactions(batch: {
  readonly accountId: string | null;
  readonly zone: string;
  readonly rows: readonly ImportRow[];
}): Promise<{ readonly inserted: number; readonly skipped: number }> {
  return post({ kind: 'transaction_import', batch });
}

export async function setCategory(
  id: string,
  category: SpendCategoryValue,
): Promise<{ readonly transaction: WireMoneyRow }> {
  return post({ kind: 'transaction_category', category: { id, category } });
}

/* -------------------------------------------------------------------------
 * Budgets
 * ---------------------------------------------------------------------- */

export type BudgetDraft = {
  readonly id: string;
  readonly category: SpendCategoryValue;
  readonly period: 'weekly' | 'monthly' | 'quarterly' | 'annual';
  readonly amount: string;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly note: string | null;
};

export async function saveBudget(draft: BudgetDraft): Promise<{ readonly budget: WireMoneyRow }> {
  return post({ kind: 'budget', budget: draft });
}

/* -------------------------------------------------------------------------
 * Subscriptions
 * ---------------------------------------------------------------------- */

export type SubscriptionDraft = {
  readonly id: string;
  readonly name: string;
  readonly amount: string;
  readonly currency: string;
  readonly cadence: 'weekly' | 'monthly' | 'quarterly' | 'annual';
  readonly category: SpendCategoryValue | null;
  readonly accountId: string | null;
  readonly nextDueOn: string | null;
  readonly lastReviewedOn: string | null;
  readonly note: string | null;
};

export async function saveSubscription(
  draft: SubscriptionDraft,
): Promise<{ readonly subscription: WireMoneyRow }> {
  return post({ kind: 'subscription', subscription: draft });
}

/**
 * Record that a commitment was looked at and kept.
 *
 * The counterpart to `cancelSubscription`. Without it the review age only ever
 * grows, and §4.9's "what have I committed to and stopped noticing" becomes a
 * list of everything.
 */
export async function markSubscriptionReviewed(input: {
  readonly id: string;
  readonly reviewedOn: string;
}): Promise<{ readonly subscription: WireMoneyRow }> {
  return post({ kind: 'subscription_review', review: input });
}

export async function cancelSubscription(input: {
  readonly id: string;
  readonly cancelledOn: string;
  readonly cancellationNote: string | null;
}): Promise<{ readonly subscription: WireMoneyRow }> {
  return post({ kind: 'subscription_cancel', cancel: input });
}

/* -------------------------------------------------------------------------
 * Shopping
 * ---------------------------------------------------------------------- */

export type ShoppingDraft = {
  readonly id: string;
  readonly name: string;
  readonly category: SpendCategoryValue | null;
  readonly quantity: number | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly note: string | null;
};

export async function saveShoppingItem(
  draft: ShoppingDraft,
): Promise<{ readonly item: { readonly id: string } }> {
  return post({ kind: 'shopping_item', item: draft });
}

/**
 * Bought it, or decided not to.
 *
 * `dropped` travels the same path as `purchased` because it is an outcome
 * rather than a failure to reach one — the reason `abandoned` is a first-class
 * learning status. A list that can only be bought from accumulates things
 * nobody wants, and a list like that stops being opened.
 */
export async function markPurchased(input: {
  readonly id: string;
  readonly outcome: 'purchased' | 'dropped';
  readonly zone: string;
  readonly transactionId: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly note: string | null;
}): Promise<{ readonly item: { readonly id: string } }> {
  return post({ kind: 'shopping_purchase', purchase: input });
}
