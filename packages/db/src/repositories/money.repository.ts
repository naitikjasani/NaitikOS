/**
 * Money, persisted — §4.9.
 *
 * ## Import is the normal path, so re-import is the normal case
 *
 * §4.9 is blunt about it: "Import over entry, absolutely (P1). Manual
 * transaction logging will not be sustained and should not be designed for."
 * A statement gets imported, then the same statement gets imported again next
 * month with a week of overlap, and the schema's partial unique index on
 * `import_hash` is what makes the overlap a no-op instead of a double count.
 *
 * `ON CONFLICT (import_hash) DO NOTHING` is not enough on its own: Postgres
 * refuses to infer a **partial** index without being handed its predicate, and
 * raises 42P10 — `there is no unique or exclusion constraint matching the ON
 * CONFLICT specification`. So the predicate repeats
 * `import_hash IS NOT NULL AND deleted_at IS NULL` verbatim, exactly as the
 * calendar and graph repositories had to.
 *
 * Note the spelling: Drizzle calls it `where` on `onConflictDoNothing` and
 * `targetWhere` on `onConflictDoUpdate`. The two conflict clauses do not agree,
 * which is why this block reads differently from the graph and calendar ones
 * even though it is doing the same thing.
 *
 * ## The re-import writes nothing at all, and that is the point
 *
 * `DO NOTHING` rather than `DO UPDATE`, because the row a re-import would
 * overwrite may have been corrected by hand since. `is_category_confirmed`
 * marks a human decision, and the schema says an import "can refine its own
 * guesses without overwriting a correction — the same rule the calendar import
 * follows for `is_travel` (P5)". Doing nothing honours that unconditionally:
 * there is no `SET` clause that could grow a field which reverts a correction
 * the next time someone adds a column.
 *
 * It also handles duplicates *within* one import batch, which `DO UPDATE`
 * cannot — Postgres rejects a command that would touch the same row twice.
 *
 * ## Amounts are `bigint` end to end
 *
 * The column is `bigint({ mode: 'bigint' })`, so a row arrives with a JS
 * `bigint` and leaves as one. Nothing here converts to `number`: §5.3's
 * argument against floats for a dosage applies with more force to a record
 * that will be totalled for twenty years, and the conversion is the only place
 * the guarantee could be lost.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type {
  AccountBalance,
  AccountInput,
  Budget,
  BudgetInput,
  BudgetPeriod,
  DomainError,
  FinancialAccount,
  MoneyTransaction,
  AccountKind,
  SpendCategory,
} from '@naitikos/core';
import { notFoundError, validationError } from '@naitikos/core';

import type { Database } from '../client';
import type { ShoppingStatus, SubscriptionCadence } from '../schema/enums';
import {
  accountBalance,
  budget,
  financialAccount,
  moneyTransaction,
  shoppingItem,
  subscription,
} from '../schema/money';

/* -------------------------------------------------------------------------
 * Row shapes that have no arithmetic in them
 *
 * A subscription and a shopping item are records rather than calculations —
 * `core` has nothing to say about either beyond what the columns already say,
 * so their types live with the repository that reads them, as `ReviewRow` does.
 * Accounts, balances, budgets and transactions do carry arithmetic, so their
 * types live in `core/domain/money` and are imported above.
 * ---------------------------------------------------------------------- */

export type Subscription = {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly cadence: SubscriptionCadence;
  readonly category: SpendCategory | null;
  readonly accountId: string | null;
  readonly startedOn: string | null;
  readonly cancelledOn: string | null;
  readonly cancellationNote: string | null;
  readonly nextDueOn: string | null;
  /** When the commitment was last looked at. §4.9's actual question. */
  readonly lastReviewedOn: string | null;
  readonly note: string | null;
};

export type SubscriptionInput = {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly cadence: SubscriptionCadence;
  readonly category?: SpendCategory | null;
  readonly accountId?: string | null;
  readonly startedOn?: string | null;
  readonly nextDueOn?: string | null;
  readonly lastReviewedOn?: string | null;
  readonly note?: string | null;
};

export type ShoppingItem = {
  readonly id: string;
  readonly name: string;
  readonly status: ShoppingStatus;
  readonly category: SpendCategory | null;
  readonly quantity: number | null;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly purchasedAt: string | null;
  readonly transactionId: string | null;
  readonly linkedEntityType: string | null;
  readonly linkedEntityId: string | null;
  readonly note: string | null;
};

export type ShoppingItemInput = {
  readonly id: string;
  readonly name: string;
  readonly status?: ShoppingStatus;
  readonly category?: SpendCategory | null;
  readonly quantity?: number | null;
  readonly amountMinor?: bigint | null;
  readonly currency?: string | null;
  readonly linkedEntityType?: string | null;
  readonly linkedEntityId?: string | null;
  readonly note?: string | null;
};

/** A balance reading. One per account per day; a second is a correction. */
export type BalanceInput = {
  readonly id: string;
  readonly accountId: string;
  readonly asOfDayKey: string;
  readonly amountMinor: bigint;
  readonly currency: string;
};

/** A transaction entered by hand. No source, so no hash to deduplicate on. */
export type TransactionInput = {
  readonly id: string;
  readonly accountId?: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredAt: string;
  readonly zone?: string | null;
  readonly dayKey: string;
  readonly rawDescription?: string | null;
  readonly merchant?: string | null;
  readonly category?: SpendCategory | null;
  readonly subscriptionId?: string | null;
  readonly note?: string | null;
};

/**
 * A transaction from a statement.
 *
 * `importHash` is required rather than optional: the hash is what makes the
 * re-import safe, and a row without one is a hand entry that belongs in
 * {@link MoneyRepository.recordTransaction}.
 */
export type ImportedTransaction = TransactionInput & { readonly importHash: string };

/**
 * What an import did.
 *
 * Both numbers, always. An import that reports "412 transactions" when 410 of
 * them were already there is a report nobody can use to tell whether it worked.
 */
export type ImportOutcome = {
  readonly inserted: number;
  readonly skipped: number;
};

export type MarkPurchasedInput = {
  readonly id: string;
  readonly at: string;
  readonly transactionId?: string | null;
  readonly amountMinor?: bigint | null;
  readonly currency?: string | null;
};

/* -------------------------------------------------------------------------
 * Row mapping
 * ---------------------------------------------------------------------- */

function toAccount(row: typeof financialAccount.$inferSelect): FinancialAccount {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as AccountKind,
    institution: row.institution,
    currency: row.currency,
    isLiability: row.isLiability,
    openedOn: row.openedOn,
    closedOn: row.closedOn,
    note: row.note,
  };
}

function toBalance(row: typeof accountBalance.$inferSelect): AccountBalance {
  return {
    id: row.id,
    accountId: row.accountId,
    asOfDayKey: row.asOfDayKey,
    amountMinor: row.amountMinor,
    currency: row.currency,
  };
}

function toTransaction(row: typeof moneyTransaction.$inferSelect): MoneyTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    occurredAt: row.occurredAt,
    zone: row.zone,
    dayKey: row.dayKey,
    rawDescription: row.rawDescription,
    merchant: row.merchant,
    category: row.category as SpendCategory | null,
    isCategoryConfirmed: row.isCategoryConfirmed,
    subscriptionId: row.subscriptionId,
    importHash: row.importHash,
    importedAt: row.importedAt,
    note: row.note,
  };
}

function toBudget(row: typeof budget.$inferSelect): Budget {
  return {
    id: row.id,
    category: row.category as SpendCategory,
    period: row.period as BudgetPeriod,
    amountMinor: row.amountMinor,
    currency: row.currency,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    note: row.note,
  };
}

function toSubscription(row: typeof subscription.$inferSelect): Subscription {
  return {
    id: row.id,
    name: row.name,
    amountMinor: row.amountMinor,
    currency: row.currency,
    cadence: row.cadence as SubscriptionCadence,
    category: row.category as SpendCategory | null,
    accountId: row.accountId,
    startedOn: row.startedOn,
    cancelledOn: row.cancelledOn,
    cancellationNote: row.cancellationNote,
    nextDueOn: row.nextDueOn,
    lastReviewedOn: row.lastReviewedOn,
    note: row.note,
  };
}

function toShoppingItem(row: typeof shoppingItem.$inferSelect): ShoppingItem {
  return {
    id: row.id,
    name: row.name,
    status: row.status as ShoppingStatus,
    category: row.category as SpendCategory | null,
    quantity: row.quantity,
    amountMinor: row.amountMinor,
    currency: row.currency,
    purchasedAt: row.purchasedAt,
    transactionId: row.transactionId,
    linkedEntityType: row.linkedEntityType,
    linkedEntityId: row.linkedEntityId,
    note: row.note,
  };
}

export type MoneyRepository = {
  accounts(): Promise<Result<readonly FinancialAccount[], DomainError>>;
  createAccount(input: AccountInput): Promise<Result<FinancialAccount, DomainError>>;

  /** Every reading for these accounts at or before a day, newest first. */
  balancesFor(
    accountIds: readonly string[],
    onOrBeforeDayKey: string,
  ): Promise<Result<readonly AccountBalance[], DomainError>>;
  /** Upserts on `(account_id, as_of_day_key)`. A second reading is a correction. */
  recordBalance(input: BalanceInput): Promise<Result<AccountBalance, DomainError>>;

  transactionsBetween(
    fromDayKey: string,
    toDayKey: string,
  ): Promise<Result<readonly MoneyTransaction[], DomainError>>;
  /** Deduplicates on `import_hash`. Never overwrites a confirmed category. */
  importTransactions(
    rows: readonly ImportedTransaction[],
    at: string,
  ): Promise<Result<ImportOutcome, DomainError>>;
  recordTransaction(input: TransactionInput): Promise<Result<MoneyTransaction, DomainError>>;
  /** Confirms a category. A human decision, and marked as one. */
  setCategory(
    id: string,
    category: SpendCategory,
    at: string,
  ): Promise<Result<MoneyTransaction, DomainError>>;

  budgets(): Promise<Result<readonly Budget[], DomainError>>;
  saveBudget(input: BudgetInput): Promise<Result<Budget, DomainError>>;

  subscriptions(): Promise<Result<readonly Subscription[], DomainError>>;
  saveSubscription(input: SubscriptionInput): Promise<Result<Subscription, DomainError>>;
  cancelSubscription(
    id: string,
    on: string,
    note: string | null,
    at: string,
  ): Promise<Result<Subscription, DomainError>>;
  /**
   * Record that a commitment was looked at and kept.
   *
   * §3.2 calls these "recurring commitments" and §4.9's question is what the
   * operator has committed to and stopped noticing. Without this, the review
   * age only ever grows and the "nobody has looked at this" list becomes every
   * subscription — at which point it stops being read, and the one measure
   * this table exists for is dead.
   */
  markSubscriptionReviewed(id: string, on: string, at: string): Promise<Result<Subscription, DomainError>>;

  shoppingItems(): Promise<Result<readonly ShoppingItem[], DomainError>>;
  saveShoppingItem(input: ShoppingItemInput): Promise<Result<ShoppingItem, DomainError>>;
  markPurchased(input: MarkPurchasedInput): Promise<Result<ShoppingItem, DomainError>>;
};

export function createMoneyRepository(db: Database): MoneyRepository {
  return {
    async accounts() {
      const rows = await db
        .select()
        .from(financialAccount)
        .where(isNull(financialAccount.deletedAt))
        .orderBy(asc(financialAccount.name));
      return ok(rows.map(toAccount));
    },

    async createAccount(input) {
      const rows = await db
        .insert(financialAccount)
        .values({
          id: input.id,
          name: input.name,
          kind: input.kind,
          institution: input.institution ?? null,
          currency: input.currency.trim().toUpperCase(),
          isLiability: input.isLiability ?? false,
          openedOn: input.openedOn ?? null,
          closedOn: input.closedOn ?? null,
          note: input.note ?? null,
        })
        /* §5.7: a replayed write arrives with the same client-minted UUIDv7. */
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toAccount(row));

      const existing = await db
        .select()
        .from(financialAccount)
        .where(eq(financialAccount.id, input.id))
        .limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('financial_account', input.id) }
        : ok(toAccount(replayed));
    },

    async balancesFor(accountIds, onOrBeforeDayKey) {
      /* An empty `IN ()` is not valid SQL, and asking for nothing has an
       * answer that needs no round trip. */
      if (accountIds.length === 0) return ok([]);

      const rows = await db
        .select()
        .from(accountBalance)
        .where(
          and(
            inArray(accountBalance.accountId, [...accountIds]),
            lte(accountBalance.asOfDayKey, onOrBeforeDayKey),
          ),
        )
        .orderBy(asc(accountBalance.accountId), desc(accountBalance.asOfDayKey));
      return ok(rows.map(toBalance));
    },

    async recordBalance(input) {
      const rows = await db
        .insert(accountBalance)
        .values({
          id: input.id,
          accountId: input.accountId,
          asOfDayKey: input.asOfDayKey,
          amountMinor: input.amountMinor,
          currency: input.currency.trim().toUpperCase(),
        })
        /*
         * `account_balance_day_unique` is a *total* unique index rather than a
         * partial one, so it is inferable from its columns alone and needs no
         * `targetWhere` — unlike the import index below. Re-reading a balance
         * for a day the operator already recorded is a correction of that
         * reading, not a second one.
         */
        .onConflictDoUpdate({
          target: [accountBalance.accountId, accountBalance.asOfDayKey],
          set: {
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('account_balance', input.id) }
        : ok(toBalance(row));
    },

    async transactionsBetween(fromDayKey, toDayKey) {
      const rows = await db
        .select()
        .from(moneyTransaction)
        .where(
          and(
            isNull(moneyTransaction.deletedAt),
            gte(moneyTransaction.dayKey, fromDayKey),
            lte(moneyTransaction.dayKey, toDayKey),
          ),
        )
        .orderBy(desc(moneyTransaction.dayKey), desc(moneyTransaction.occurredAt));
      return ok(rows.map(toTransaction));
    },

    async importTransactions(rows, at) {
      if (rows.length === 0) return ok({ inserted: 0, skipped: 0 });

      const unhashed = rows.find((row) => row.importHash.trim() === '');
      if (unhashed !== undefined) {
        return {
          ok: false,
          error: validationError(
            'import_hash_missing',
            'An imported transaction needs an import hash; deduplication depends on it.',
          ),
        };
      }

      const inserted = await db
        .insert(moneyTransaction)
        .values(
          rows.map((row) => ({
            id: row.id,
            accountId: row.accountId ?? null,
            amountMinor: row.amountMinor,
            currency: row.currency.trim().toUpperCase(),
            occurredAt: row.occurredAt,
            zone: row.zone ?? null,
            dayKey: row.dayKey,
            rawDescription: row.rawDescription ?? null,
            merchant: row.merchant ?? null,
            category: row.category ?? null,
            /* An imported category is a guess. Only `setCategory` confirms. */
            isCategoryConfirmed: false,
            subscriptionId: row.subscriptionId ?? null,
            importHash: row.importHash,
            importedAt: at,
            note: row.note ?? null,
          })),
        )
        .onConflictDoNothing({
          /*
           * The predicate is repeated because `money_transaction_import_unique`
           * is partial. Without it Postgres raises 42P10 and the import fails
           * outright — the same wall the calendar and graph repositories hit.
           *
           * The key is `where`, not `targetWhere`. Drizzle spells the arbiter
           * predicate differently on the two conflict clauses: `onConflictDoUpdate`
           * takes `targetWhere` (and `setWhere`), `onConflictDoNothing` takes
           * `where`. That is why `graph.repository.ts` and `learning.repository.ts`
           * — both DO UPDATE — read differently from this one. Writing
           * `targetWhere` here typechecks as an excess property in some
           * positions, is silently dropped in the emitted SQL, and produces a
           * bare `ON CONFLICT ("import_hash") DO NOTHING` that Postgres cannot
           * match against a partial index. Every import then throws 42P10 —
           * the precise failure this block exists to prevent.
           */
          target: moneyTransaction.importHash,
          where: sql`${moneyTransaction.importHash} IS NOT NULL AND ${moneyTransaction.deletedAt} IS NULL`,
        })
        .returning({ id: moneyTransaction.id });

      /* `DO NOTHING` returns only what it actually wrote, so the difference is
       * exactly what was already there. No second query, and no arithmetic
       * that could disagree with the write. */
      return ok({ inserted: inserted.length, skipped: rows.length - inserted.length });
    },

    async recordTransaction(input) {
      const rows = await db
        .insert(moneyTransaction)
        .values({
          id: input.id,
          accountId: input.accountId ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency.trim().toUpperCase(),
          occurredAt: input.occurredAt,
          zone: input.zone ?? null,
          dayKey: input.dayKey,
          rawDescription: input.rawDescription ?? null,
          merchant: input.merchant ?? null,
          category: input.category ?? null,
          /*
           * A hand-entered category is a human decision from the first moment,
           * so it is confirmed on the way in. A later import must not be able
           * to overwrite it, and `is_category_confirmed` is what says so.
           */
          isCategoryConfirmed: input.category !== undefined && input.category !== null,
          subscriptionId: input.subscriptionId ?? null,
          /* No hash: there is no source to deduplicate against. */
          importHash: null,
          note: input.note ?? null,
        })
        .onConflictDoNothing()
        .returning();

      const row = rows[0];
      if (row !== undefined) return ok(toTransaction(row));

      const existing = await db
        .select()
        .from(moneyTransaction)
        .where(eq(moneyTransaction.id, input.id))
        .limit(1);
      const replayed = existing[0];
      return replayed === undefined
        ? { ok: false, error: notFoundError('money_transaction', input.id) }
        : ok(toTransaction(replayed));
    },

    async setCategory(id, category, at) {
      const rows = await db
        .update(moneyTransaction)
        .set({
          category,
          /* Confirmed, because a person chose it. This is the flag the import
           * reads to know it must leave the row alone. */
          isCategoryConfirmed: true,
          updatedAt: at,
        })
        .where(and(eq(moneyTransaction.id, id), isNull(moneyTransaction.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('money_transaction', id) }
        : ok(toTransaction(row));
    },

    async budgets() {
      const rows = await db
        .select()
        .from(budget)
        .where(isNull(budget.deletedAt))
        .orderBy(asc(budget.category), desc(budget.effectiveFrom));
      return ok(rows.map(toBudget));
    },

    async saveBudget(input) {
      const rows = await db
        .insert(budget)
        .values({
          id: input.id,
          category: input.category,
          period: input.period,
          amountMinor: input.amountMinor,
          currency: input.currency.trim().toUpperCase(),
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          note: input.note ?? null,
        })
        /* Keyed on the id, so editing an allowance is the same call as setting
         * one. The natural key stays the database's business — two live
         * budgets for one category and period is a contradiction the unique
         * index rejects rather than something this method silently merges. */
        .onConflictDoUpdate({
          target: budget.id,
          set: {
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            period: sql`excluded.period`,
            effectiveTo: sql`excluded.effective_to`,
            note: sql`excluded.note`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('budget', input.id) }
        : ok(toBudget(row));
    },

    async subscriptions() {
      /* Cancelled subscriptions are included. The schema keeps them because
       * "a cancelled row is history, never removed", and §4.9's question —
       * what have I committed to and stopped noticing — is answered partly by
       * what was let go and when. */
      const rows = await db
        .select()
        .from(subscription)
        .where(isNull(subscription.deletedAt))
        .orderBy(asc(subscription.cancelledOn), asc(subscription.nextDueOn), asc(subscription.name));
      return ok(rows.map(toSubscription));
    },

    async saveSubscription(input) {
      const rows = await db
        .insert(subscription)
        .values({
          id: input.id,
          name: input.name,
          amountMinor: input.amountMinor,
          currency: input.currency.trim().toUpperCase(),
          cadence: input.cadence,
          category: input.category ?? null,
          accountId: input.accountId ?? null,
          startedOn: input.startedOn ?? null,
          nextDueOn: input.nextDueOn ?? null,
          lastReviewedOn: input.lastReviewedOn ?? null,
          note: input.note ?? null,
        })
        .onConflictDoUpdate({
          target: subscription.id,
          set: {
            name: sql`excluded.name`,
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            cadence: sql`excluded.cadence`,
            category: sql`excluded.category`,
            accountId: sql`excluded.account_id`,
            startedOn: sql`excluded.started_on`,
            nextDueOn: sql`excluded.next_due_on`,
            lastReviewedOn: sql`excluded.last_reviewed_on`,
            note: sql`excluded.note`,
            /* `cancelled_on` is deliberately absent. A save is an edit to a
             * commitment, not a resurrection of one — undoing a cancellation
             * is a decision that deserves its own call. */
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('subscription', input.id) }
        : ok(toSubscription(row));
    },

    async cancelSubscription(id, on, note, at) {
      const rows = await db
        .update(subscription)
        .set({
          cancelledOn: on,
          cancellationNote: note,
          /* Cancelling is the most attentive act available here, so it counts
           * as a review. Leaving `last_reviewed_on` stale would keep a settled
           * commitment on the "nobody has looked at this" list forever. */
          lastReviewedOn: on,
          updatedAt: at,
        })
        .where(and(eq(subscription.id, id), isNull(subscription.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('subscription', id) }
        : ok(toSubscription(row));
    },

    async markSubscriptionReviewed(id, on, at) {
      const rows = await db
        .update(subscription)
        .set({ lastReviewedOn: on, updatedAt: at })
        /* A cancelled commitment is not reviewable — there is nothing left to
         * decide about it, and letting it be "reviewed" would put settled rows
         * back into the rotation. */
        .where(and(eq(subscription.id, id), isNull(subscription.cancelledOn), isNull(subscription.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('subscription', id) }
        : ok(toSubscription(row));
    },

    async shoppingItems() {
      const rows = await db
        .select()
        .from(shoppingItem)
        .where(isNull(shoppingItem.deletedAt))
        .orderBy(asc(shoppingItem.status), desc(shoppingItem.createdAt));
      return ok(rows.map(toShoppingItem));
    },

    async saveShoppingItem(input) {
      const amount = input.amountMinor ?? null;
      const currency = input.currency ?? null;
      /* `shopping_item_amount_paired` rejects half a monetary value, and the
       * CHECK is the guarantee. This is here so the caller gets a field name
       * rather than a constraint name. */
      if ((amount === null) !== (currency === null)) {
        return {
          ok: false,
          error: validationError(
            'shopping_item_amount_unpaired',
            'An expected price needs both an amount and a currency, or neither.',
          ),
        };
      }

      const rows = await db
        .insert(shoppingItem)
        .values({
          id: input.id,
          name: input.name,
          status: input.status ?? 'wanted',
          category: input.category ?? null,
          quantity: input.quantity ?? null,
          amountMinor: amount,
          currency: currency === null ? null : currency.trim().toUpperCase(),
          linkedEntityType: input.linkedEntityType ?? null,
          linkedEntityId: input.linkedEntityId ?? null,
          note: input.note ?? null,
        })
        .onConflictDoUpdate({
          target: shoppingItem.id,
          set: {
            name: sql`excluded.name`,
            status: sql`excluded.status`,
            category: sql`excluded.category`,
            quantity: sql`excluded.quantity`,
            amountMinor: sql`excluded.amount_minor`,
            currency: sql`excluded.currency`,
            linkedEntityType: sql`excluded.linked_entity_type`,
            linkedEntityId: sql`excluded.linked_entity_id`,
            note: sql`excluded.note`,
            updatedAt: sql`now()`,
          },
        })
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('shopping_item', input.id) }
        : ok(toShoppingItem(row));
    },

    async markPurchased(input) {
      const amount = input.amountMinor ?? null;
      const currency = input.currency ?? null;
      if ((amount === null) !== (currency === null)) {
        return {
          ok: false,
          error: validationError(
            'shopping_item_amount_unpaired',
            'A purchase price needs both an amount and a currency, or neither.',
          ),
        };
      }

      /*
       * Both halves are written only when both were supplied, so recording the
       * transaction later does not erase a price the item already carried —
       * and so the CHECK's pairing can never be broken from here.
       */
      const price =
        amount === null || currency === null
          ? {}
          : { amountMinor: amount, currency: currency.trim().toUpperCase() };

      const rows = await db
        .update(shoppingItem)
        .set({
          status: 'purchased',
          /*
           * The instant travels with the status, always.
           * `shopping_item_purchase_together` rejects a purchased item with no
           * `purchased_at`, and an item that is bought but undated is invisible
           * to every question the purchase history exists to answer.
           */
          purchasedAt: input.at,
          /* Likewise left alone when absent: a second call that only fills in
           * the price must not unlink the transaction found by the first. */
          ...(input.transactionId === undefined || input.transactionId === null
            ? {}
            : { transactionId: input.transactionId }),
          ...price,
          updatedAt: input.at,
        })
        .where(and(eq(shoppingItem.id, input.id), isNull(shoppingItem.deletedAt)))
        .returning();

      const row = rows[0];
      return row === undefined
        ? { ok: false, error: notFoundError('shopping_item', input.id) }
        : ok(toShoppingItem(row));
    },
  };
}
