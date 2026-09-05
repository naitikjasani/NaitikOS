/**
 * `/api/money` — every Money write.
 *
 * ## Two permissions, split by blast radius
 *
 * §5.4 splits permissions by what a write can damage, and Money has both kinds
 * on one endpoint.
 *
 * `settings:write` — `account`, `budget`, `subscription`, `subscription_cancel`.
 * These change *what every future number is measured against*: an account's
 * `isLiability` flips a balance from an asset into a debt across the whole
 * net-worth history, and a budget is the denominator of every ratio on the
 * budgets page. The blast radius is the record, not the row.
 *
 * `observation:write` — `balance`, `transaction`, `transaction_import`,
 * `transaction_category`, `shopping_item`, `shopping_purchase`. These add to
 * the record or correct one row of it. A wrong transaction is a wrong
 * transaction; a wrong account definition is a wrong page.
 *
 * The kind is read off the body **before** the guard runs, the way
 * `/api/nutrition` does it. The body is read from a clone so `parseJson` can
 * still consume the original stream — a request body is read once.
 *
 * ## Amounts convert here and nowhere else
 *
 * The wire carries a **decimal string** in major units beside an ISO-4217 code;
 * storage is `bigint` minor units (§5.3). `parseAmount` is the only conversion
 * on the way in and it is allowed to fail — `'12.505'` in rupees is a typo, a
 * misread column, or a value in another currency, and every one of those is
 * better returned as a 400 than rounded into a total. Nothing here coerces and
 * nothing here defaults.
 *
 * On the way out, every response that carries money carries a **formatted
 * string**. Not politeness: `NextResponse.json` runs `JSON.stringify`, which
 * throws on a `bigint`, so returning a repository row unmapped would be a
 * runtime 500 on a write that had already succeeded.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { moneyWriteSchema } from '@naitikos/api';
import type { Result } from '@naitikos/shared';
import { ok } from '@naitikos/shared';
import type { DomainError, Money } from '@naitikos/core';
import {
  dayKeyInZone,
  formatAmount,
  isoFromMillis,
  notFoundError,
  parseAmount,
  systemClock,
  validateAccount,
  validateBudget,
} from '@naitikos/core';
import type { ImportedTransaction } from '@naitikos/db';
import { createMoneyRepository } from '@naitikos/db';

import {
  errorResponse,
  guard,
  internalErrorResponse,
  isGuardFailure,
  parseJson,
} from '@/lib/platform/context';

export const dynamic = 'force-dynamic';

/** The kinds that change what future numbers are measured against (§5.4). */
const SETTINGS_KINDS = new Set(['account', 'budget', 'subscription', 'subscription_cancel']);

/** A row with money on it, rendered for reading. Never a `bigint` on the wire. */
function moneyRow(row: {
  readonly id: string;
  readonly amountMinor: bigint;
  readonly currency: string;
}): { readonly id: string; readonly amount: string; readonly currency: string } {
  return {
    id: row.id,
    amount: formatAmount({ amountMinor: row.amountMinor, currency: row.currency }),
    currency: row.currency,
  };
}

/** The same, for a row whose price is optional. */
function optionalMoneyRow(row: {
  readonly id: string;
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
}): { readonly id: string; readonly amount: string | null; readonly currency: string | null } {
  return {
    id: row.id,
    amount:
      row.amountMinor === null || row.currency === null
        ? null
        : formatAmount({ amountMinor: row.amountMinor, currency: row.currency }),
    currency: row.currency,
  };
}

/**
 * An optional price: both halves, or neither.
 *
 * The contract already refuses half a monetary value and so does the `CHECK`
 * behind it, so an absent amount stays absent here rather than becoming a zero
 * — a price of zero is a claim that something was free.
 */
function parseOptionalAmount(
  amount: string | null | undefined,
  currency: string | null | undefined,
): Result<Money | null, DomainError> {
  if (amount === undefined || amount === null) return ok(null);
  if (currency === undefined || currency === null) return ok(null);
  return parseAmount(amount, currency);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  const kind =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['kind'] : null;
  const permission = SETTINGS_KINDS.has(String(kind)) ? 'settings:write' : 'observation:write';

  const guarded = await guard(request, permission);
  if (isGuardFailure(guarded)) return guarded.response;
  const { traceId, platform } = guarded.context;

  const parsed = await parseJson(request, moneyWriteSchema, traceId);
  if ('response' in parsed) return parsed.response;

  const money = createMoneyRepository(platform.db);
  const nowIso = isoFromMillis(systemClock.nowMillis());

  try {
    switch (parsed.data.kind) {
      case 'account': {
        const input = parsed.data.account;
        /*
         * Validated in `core` as well as at the wire. The schema rejects a
         * shape; `validateAccount` rejects an account — a close before an open,
         * a currency that is not three letters. §5.0 puts that judgement below
         * the transport.
         */
        const validated = validateAccount({
          id: input.id,
          name: input.name,
          kind: input.kind,
          institution: input.institution ?? null,
          currency: input.currency,
          isLiability: input.isLiability,
          openedOn: input.openedOn ?? null,
          closedOn: input.closedOn ?? null,
          note: input.note ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const created = await money.createAccount(validated.value);
        if (!created.ok) return errorResponse(created.error, traceId);
        /* An account carries no amount, so it serialises as it stands. */
        return NextResponse.json({ account: created.value }, { status: 201 });
      }

      case 'balance': {
        const input = parsed.data.balance;
        const amount = parseAmount(input.amount, input.currency);
        if (!amount.ok) return errorResponse(amount.error, traceId);

        /*
         * The id is minted here because the contract has no field for one, and
         * that is safe precisely for this kind: `recordBalance` upserts on
         * `(account_id, as_of_day_key)`, so a replayed request corrects the same
         * reading rather than creating a second one. A fresh id cannot fork the
         * row.
         */
        const recorded = await money.recordBalance({
          id: crypto.randomUUID(),
          accountId: input.accountId,
          asOfDayKey: input.asOfDayKey,
          amountMinor: amount.value.amountMinor,
          currency: amount.value.currency,
        });
        if (!recorded.ok) return errorResponse(recorded.error, traceId);
        return NextResponse.json({ balance: moneyRow(recorded.value) }, { status: 201 });
      }

      case 'transaction': {
        const input = parsed.data.transaction;
        const amount = parseAmount(input.amount, input.currency);
        if (!amount.ok) return errorResponse(amount.error, traceId);

        const recorded = await money.recordTransaction({
          id: input.id,
          accountId: input.accountId ?? null,
          amountMinor: amount.value.amountMinor,
          currency: amount.value.currency,
          occurredAt: input.occurredAt,
          zone: input.zone,
          /* Both halves from one instant and one zone. A client that could send
           * the day key separately could send one that disagreed with the
           * timestamp, and a transaction filed on the wrong day is invisible to
           * every window this pillar is read through. */
          dayKey: dayKeyInZone(input.occurredAt, input.zone),
          rawDescription: input.rawDescription ?? null,
          merchant: input.merchant ?? null,
          category: input.category ?? null,
          subscriptionId: input.subscriptionId ?? null,
          note: input.note ?? null,
        });
        if (!recorded.ok) return errorResponse(recorded.error, traceId);
        return NextResponse.json({ transaction: moneyRow(recorded.value) }, { status: 201 });
      }

      case 'transaction_import': {
        const batch = parsed.data.batch;

        /*
         * Every row is parsed before any row is written. A batch that failed
         * halfway would leave the operator with a statement that is partly
         * imported and no way to tell which part — and re-importing is only
         * safe because the hashes make it a no-op, which a partial write with a
         * different failure point does not preserve.
         */
        const rows: ImportedTransaction[] = [];
        for (const row of batch.rows) {
          const amount = parseAmount(row.amount, row.currency);
          if (!amount.ok) return errorResponse(amount.error, traceId);

          rows.push({
            id: row.id,
            accountId: batch.accountId ?? null,
            amountMinor: amount.value.amountMinor,
            currency: amount.value.currency,
            occurredAt: row.occurredAt,
            zone: batch.zone,
            dayKey: dayKeyInZone(row.occurredAt, batch.zone),
            rawDescription: row.rawDescription ?? null,
            merchant: row.merchant ?? null,
            /* An imported category is a guess; only `transaction_category`
             * confirms one, which is what keeps a re-import from overwriting a
             * correction (P5). */
            category: row.category ?? null,
            importHash: row.importHash,
          });
        }

        const outcome = await money.importTransactions(rows, nowIso);
        if (!outcome.ok) return errorResponse(outcome.error, traceId);
        /*
         * Both counts, always. "412 imported" when 410 were already there is a
         * report nobody can use to tell whether the run did anything, and a
         * skip is the *normal* outcome for a re-imported statement rather than
         * an error — reporting it as one trains the operator to stop
         * re-importing, which is how a month goes missing.
         */
        return NextResponse.json({ imported: outcome.value }, { status: 201 });
      }

      case 'transaction_category': {
        const input = parsed.data.category;
        const updated = await money.setCategory(input.id, input.category, nowIso);
        if (!updated.ok) return errorResponse(updated.error, traceId);
        return NextResponse.json({ transaction: moneyRow(updated.value) });
      }

      case 'budget': {
        const input = parsed.data.budget;
        const amount = parseAmount(input.amount, input.currency);
        if (!amount.ok) return errorResponse(amount.error, traceId);

        /* `validateBudget` rejects a non-positive allowance, which the wire
         * cannot: `'0'` is a valid decimal string and not a valid budget. */
        const validated = validateBudget({
          id: input.id,
          category: input.category,
          period: input.period,
          amountMinor: amount.value.amountMinor,
          currency: amount.value.currency,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo ?? null,
          note: input.note ?? null,
        });
        if (!validated.ok) return errorResponse(validated.error, traceId);

        const saved = await money.saveBudget(validated.value);
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ budget: moneyRow(saved.value) }, { status: 201 });
      }

      case 'subscription': {
        const input = parsed.data.subscription;
        const amount = parseAmount(input.amount, input.currency);
        if (!amount.ok) return errorResponse(amount.error, traceId);

        const saved = await money.saveSubscription({
          id: input.id,
          name: input.name,
          amountMinor: amount.value.amountMinor,
          currency: amount.value.currency,
          cadence: input.cadence,
          category: input.category ?? null,
          accountId: input.accountId ?? null,
          startedOn: input.startedOn ?? null,
          nextDueOn: input.nextDueOn ?? null,
          /* Sent by the client, never stamped here. It records *attention*, and
           * a field the server touched on every write would answer nothing. */
          lastReviewedOn: input.lastReviewedOn ?? null,
          note: input.note ?? null,
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ subscription: moneyRow(saved.value) }, { status: 201 });
      }

      case 'subscription_cancel': {
        const input = parsed.data.cancel;
        /* The row is never deleted. A subscription paid for eighteen months and
         * then cancelled is the most interesting row this table holds. */
        const cancelled = await money.cancelSubscription(
          input.id,
          input.cancelledOn,
          input.cancellationNote ?? null,
          nowIso,
        );
        if (!cancelled.ok) return errorResponse(cancelled.error, traceId);
        return NextResponse.json({ subscription: moneyRow(cancelled.value) });
      }

      case 'subscription_review': {
        const input = parsed.data.review;
        /*
         * `observation:write`, not `settings:write`. Reviewing changes nothing
         * about what future numbers mean — it records that a person looked.
         * Putting it behind the wider permission would make the cheapest,
         * most-repeated act on this pillar the most guarded one.
         */
        const reviewed = await money.markSubscriptionReviewed(input.id, input.reviewedOn, nowIso);
        if (!reviewed.ok) return errorResponse(reviewed.error, traceId);
        return NextResponse.json({ subscription: moneyRow(reviewed.value) });
      }

      case 'shopping_item': {
        const input = parsed.data.item;
        const price = parseOptionalAmount(input.amount, input.currency);
        if (!price.ok) return errorResponse(price.error, traceId);

        const saved = await money.saveShoppingItem({
          id: input.id,
          name: input.name,
          status: input.status ?? 'wanted',
          category: input.category ?? null,
          quantity: input.quantity ?? null,
          amountMinor: price.value === null ? null : price.value.amountMinor,
          currency: price.value === null ? null : price.value.currency,
          linkedEntityType: input.linkedEntityType ?? null,
          linkedEntityId: input.linkedEntityId ?? null,
          note: input.note ?? null,
        });
        if (!saved.ok) return errorResponse(saved.error, traceId);
        return NextResponse.json({ item: optionalMoneyRow(saved.value) }, { status: 201 });
      }

      default: {
        const input = parsed.data.purchase;
        const price = parseOptionalAmount(input.amount, input.currency);
        if (!price.ok) return errorResponse(price.error, traceId);

        if (input.outcome === 'dropped') {
          /*
           * Dropping is an outcome, not a purchase, so it does not go through
           * `markPurchased` — that method stamps `purchased_at`, and an item
           * nobody bought carrying a purchase instant is a false record. The
           * existing row is read first because the save is an upsert that needs
           * the name it already has; without it the drop would blank the item.
           */
          const items = await money.shoppingItems();
          if (!items.ok) return errorResponse(items.error, traceId);

          const existing = items.value.find((item) => item.id === input.id);
          if (existing === undefined) {
            return errorResponse(notFoundError('shopping_item', input.id), traceId);
          }

          const dropped = await money.saveShoppingItem({
            id: existing.id,
            name: existing.name,
            status: 'dropped',
            category: existing.category,
            quantity: existing.quantity,
            amountMinor: price.value === null ? existing.amountMinor : price.value.amountMinor,
            currency: price.value === null ? existing.currency : price.value.currency,
            linkedEntityType: existing.linkedEntityType,
            linkedEntityId: existing.linkedEntityId,
            /* An honest blank beats an invented reason, so the note the item
             * already carried stands when none was given. */
            note: input.note ?? existing.note,
          });
          if (!dropped.ok) return errorResponse(dropped.error, traceId);
          return NextResponse.json({ item: optionalMoneyRow(dropped.value) });
        }

        const purchased = await money.markPurchased({
          id: input.id,
          /* Timed from the server's clock rather than the client's; the zone
           * travels on the request so the instant can be read back in the place
           * the purchase happened. */
          at: nowIso,
          transactionId: input.transactionId ?? null,
          amountMinor: price.value === null ? null : price.value.amountMinor,
          currency: price.value === null ? null : price.value.currency,
        });
        if (!purchased.ok) return errorResponse(purchased.error, traceId);
        return NextResponse.json({ item: optionalMoneyRow(purchased.value) });
      }
    }
  } catch (error: unknown) {
    platform.observability.logger.error('unhandled error in money.post', {
      traceId,
      component: 'money.post',
      identifiers: { name: error instanceof Error ? error.name : 'unknown' },
    });
    return internalErrorResponse(traceId);
  }
}
