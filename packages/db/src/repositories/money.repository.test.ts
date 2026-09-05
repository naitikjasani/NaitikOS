/**
 * Money — integration, against real Postgres.
 *
 * The core tests cover the arithmetic: the sign convention behind net worth,
 * the exclusion of transfers from a budget total, the currency mismatch that
 * has to be reported rather than converted. None of that needs a database.
 *
 * This covers what only Postgres can answer:
 *
 *   1. **Deduplication actually deduplicates.** §4.9 makes import the primary
 *      path, which makes re-import the normal case rather than an edge one, and
 *      the partial unique index on `import_hash` is the only thing standing
 *      between an overlapping statement and a double-counted month.
 *   2. **A re-import does not revert a correction.** `is_category_confirmed`
 *      marks a human decision and the import must leave it alone — the same
 *      rule the calendar import follows for `is_travel` (P5).
 *   3. **`bigint` survives the driver.** §5.3 forbids floats for money, and the
 *      round trip through the column is the one place that guarantee could be
 *      lost without anything erroring.
 *   4. **The CHECK and UNIQUE constraints reject what the repository would
 *      otherwise pass through.** A repository habit is not a guarantee.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidV7 } from '@naitikos/shared';

import { createDatabase } from '../client';
import { resetDomainTables } from '../testing/reset';
import { createMoneyRepository } from './money.repository';

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL === undefined ? undefined : createDatabase(DATABASE_URL);
const suite = db === undefined ? describe.skip : describe;

afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

const ZONE = 'Asia/Kolkata';
const EPOCH = 1_764_000_000_000;
let counter = 0;
const newId = (): string => uuidV7(EPOCH + (counter += 1));

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

suite('money repository (§4.9)', () => {
  /* `describe.skip` has established that `db` exists; TypeScript cannot see
   * through it, so it is narrowed once rather than at each call site. */
  if (db === undefined) throw new Error('no database');
  const database = db;
  const repo = createMoneyRepository(database);

  beforeEach(async () => {
    await resetDomainTables(database.$client);
  });

  /** An account to hang balances and transactions off. */
  async function anAccount(name = 'Current'): Promise<string> {
    const id = newId();
    await repo.createAccount({ id, name, kind: 'current', currency: 'INR' });
    return id;
  }

  /** A statement row, with everything the importer would have computed. */
  function aStatementRow(
    importHash: string,
    overrides: {
      readonly amountMinor?: bigint;
      readonly category?: 'groceries' | 'eating_out' | 'skincare' | 'shopping';
      readonly dayKey?: string;
    } = {},
  ) {
    const dayKey = overrides.dayKey ?? '2026-08-30';
    return {
      id: newId(),
      amountMinor: overrides.amountMinor ?? -125_000n,
      currency: 'INR',
      occurredAt: `${dayKey}T10:00:00.000Z`,
      zone: ZONE,
      dayKey,
      rawDescription: `UPI/${importHash}`,
      importHash,
      ...(overrides.category === undefined ? {} : { category: overrides.category }),
    };
  }

  describe('importing a statement', () => {
    it('inserts a row once and skips it on every later import', async () => {
      const row = aStatementRow('hash-groceries-aug-30');

      const first = unwrap(await repo.importTransactions([row], '2026-08-31T06:00:00.000Z'));
      expect(first).toEqual({ inserted: 1, skipped: 0 });

      /* The second import is the same statement fetched again with a week of
       * overlap — §4.9's normal case, not an error. A fresh id proves the
       * dedupe keys on the hash rather than on the primary key. */
      const second = unwrap(
        await repo.importTransactions(
          [{ ...row, id: newId() }],
          '2026-09-07T06:00:00.000Z',
        ),
      );
      expect(second).toEqual({ inserted: 0, skipped: 1 });

      expect(unwrap(await repo.transactionsBetween('2026-08-01', '2026-08-31'))).toHaveLength(1);
    });

    it('leaves a hand-confirmed category alone when the row arrives again', async () => {
      const row = aStatementRow('hash-misfiled-merchant', { category: 'shopping' });
      await repo.importTransactions([row], '2026-08-31T06:00:00.000Z');

      /* A person looked at it and decided it was skincare. From here on the
       * import's own guess is the less trustworthy of the two. */
      const corrected = unwrap(await repo.setCategory(row.id, 'skincare', '2026-09-01T09:00:00.000Z'));
      expect(corrected.isCategoryConfirmed).toBe(true);

      const again = unwrap(
        await repo.importTransactions(
          [{ ...row, id: newId(), category: 'groceries' as const }],
          '2026-09-07T06:00:00.000Z',
        ),
      );
      expect(again).toEqual({ inserted: 0, skipped: 1 });

      const rows = unwrap(await repo.transactionsBetween('2026-08-01', '2026-08-31'));
      expect(rows).toHaveLength(1);
      /* The P5 rule, stated as an assertion: an import refines its own guesses
       * and never overwrites a correction. `DO NOTHING` is what makes it
       * unconditional — there is no `SET` clause that could grow a field which
       * quietly reverts this. */
      expect(rows[0]?.category).toBe('skincare');
      expect(rows[0]?.isCategoryConfirmed).toBe(true);
    });

    it('counts the new and the already-seen rows separately in one batch', async () => {
      const seen = aStatementRow('hash-rent-aug', { dayKey: '2026-08-01' });
      await repo.importTransactions([seen], '2026-08-31T06:00:00.000Z');

      const outcome = unwrap(
        await repo.importTransactions(
          [
            { ...seen, id: newId() },
            aStatementRow('hash-utilities-aug', { dayKey: '2026-08-05' }),
            aStatementRow('hash-transport-aug', { dayKey: '2026-08-09' }),
          ],
          '2026-09-07T06:00:00.000Z',
        ),
      );

      /* Both numbers, always. An import reporting "3 transactions" when one of
       * them was already there is a report nobody can check. */
      expect(outcome).toEqual({ inserted: 2, skipped: 1 });
      expect(unwrap(await repo.transactionsBetween('2026-08-01', '2026-08-31'))).toHaveLength(3);
    });

    it('keeps every hand-entered transaction, however alike they look', async () => {
      const accountId = await anAccount();
      const entry = {
        accountId,
        amountMinor: -20_000n,
        currency: 'INR',
        occurredAt: '2026-08-30T13:00:00.000Z',
        zone: ZONE,
        dayKey: '2026-08-30',
        merchant: 'Chai stall',
      };

      await repo.recordTransaction({ ...entry, id: newId() });
      await repo.recordTransaction({ ...entry, id: newId() });

      const rows = unwrap(await repo.transactionsBetween('2026-08-30', '2026-08-30'));
      /* Two identical cups of chai on one afternoon is a fact, not a duplicate.
       * A hand entry has no source to hash, so `import_hash` is null and the
       * partial unique index does not see the row at all. */
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.importHash === null)).toBe(true);
    });
  });

  describe('amounts', () => {
    it('reads an amount back as the exact bigint it was written as', async () => {
      const accountId = await anAccount();
      const large = newId();
      const beyondDouble = newId();

      await repo.recordTransaction({
        id: large,
        accountId,
        amountMinor: 999_999_999_999n,
        currency: 'INR',
        occurredAt: '2026-08-30T10:00:00.000Z',
        zone: ZONE,
        dayKey: '2026-08-30',
      });
      await repo.recordTransaction({
        id: beyondDouble,
        accountId,
        amountMinor: 9_007_199_254_740_993n,
        currency: 'INR',
        occurredAt: '2026-08-30T11:00:00.000Z',
        zone: ZONE,
        dayKey: '2026-08-30',
      });

      const rows = unwrap(await repo.transactionsBetween('2026-08-30', '2026-08-30'));
      expect(rows.find((row) => row.id === large)?.amountMinor).toBe(999_999_999_999n);
      /*
       * 2^53 + 1, the smallest integer an IEEE double cannot represent:
       * `Number(9007199254740993n)` is 9007199254740992. No household reaches
       * that many minor units, and the magnitude is not the point — the point
       * is that nothing between the column and this assertion converts to
       * `number`, so the guarantee holds at any magnitude rather than up to
       * whichever one somebody last tested (§5.3).
       */
      expect(rows.find((row) => row.id === beyondDouble)?.amountMinor).toBe(9_007_199_254_740_993n);
    });

    it('keeps the sign of an outflow', async () => {
      const accountId = await anAccount();
      const id = newId();
      const written = unwrap(
        await repo.recordTransaction({
          id,
          accountId,
          amountMinor: -125_050n,
          currency: 'INR',
          occurredAt: '2026-08-30T10:00:00.000Z',
          zone: ZONE,
          dayKey: '2026-08-30',
        }),
      );
      /* Negative is money leaving — one convention, stated once in the schema.
       * A sign lost on the way through the driver would flip a month of
       * spending into a month of income and nothing would error. */
      expect(written.amountMinor).toBe(-125_050n);

      const rows = unwrap(await repo.transactionsBetween('2026-08-30', '2026-08-30'));
      expect(rows[0]?.amountMinor).toBe(-125_050n);
    });
  });

  describe('balances', () => {
    it('treats a second reading for the same day as a correction', async () => {
      const accountId = await anAccount();
      const day = '2026-08-30';

      await repo.recordBalance({ id: newId(), accountId, asOfDayKey: day, amountMinor: 500_000n, currency: 'INR' });
      const corrected = unwrap(
        await repo.recordBalance({
          id: newId(),
          accountId,
          asOfDayKey: day,
          amountMinor: 512_340n,
          currency: 'INR',
        }),
      );

      expect(corrected.amountMinor).toBe(512_340n);
      const rows = unwrap(await repo.balancesFor([accountId], day));
      /* One reading per account per day. Two rows for one morning would make
       * every net-worth figure built over them wrong by an amount nobody can
       * see from the total. */
      expect(rows).toHaveLength(1);
      expect(rows[0]?.amountMinor).toBe(512_340n);
    });

    it('returns readings at or before the given day, newest first', async () => {
      const accountId = await anAccount();
      for (const [asOfDayKey, amountMinor] of [
        ['2026-08-01', 100_000n],
        ['2026-08-15', 200_000n],
        ['2026-08-31', 300_000n],
      ] as const) {
        await repo.recordBalance({ id: newId(), accountId, asOfDayKey, amountMinor, currency: 'INR' });
      }

      const rows = unwrap(await repo.balancesFor([accountId], '2026-08-20'));
      /* Newest first, because a net worth "as at" a day is built from the most
       * recent reading at or before it — and the 31st has not happened yet from
       * the 20th's point of view. */
      expect(rows.map((row) => row.asOfDayKey)).toEqual(['2026-08-15', '2026-08-01']);
    });
  });

  describe('constraints the database enforces', () => {
    it('refuses a purchased item with no purchase instant', async () => {
      await expect(
        database.$client`
          INSERT INTO shopping_item (id, name, status)
          VALUES (${newId()}, 'Bought at some unknown moment', 'purchased')`,
      ).rejects.toThrow(/shopping_item_purchase_together/u);
    });

    it('refuses an amount with no currency', async () => {
      await expect(
        database.$client`
          INSERT INTO shopping_item (id, name, amount_minor)
          VALUES (${newId()}, 'Twelve hundred of something', 129900)`,
      ).rejects.toThrow(/shopping_item_amount_paired/u);
    });

    it('refuses an account closed before it was opened', async () => {
      await expect(
        database.$client`
          INSERT INTO financial_account (id, name, kind, currency, opened_on, closed_on)
          VALUES (${newId()}, 'Backwards', 'savings', 'INR', '2026-08-31', '2026-08-01')`,
      ).rejects.toThrow(/financial_account_dates_ordered/u);
    });

    it('refuses a subscription cancelled before it started', async () => {
      await expect(
        database.$client`
          INSERT INTO subscription (id, name, amount_minor, currency, cadence, started_on, cancelled_on)
          VALUES (${newId()}, 'Backwards', 49900, 'INR', 'monthly', '2026-08-31', '2026-08-01')`,
      ).rejects.toThrow(/subscription_dates_ordered/u);
    });

    it('refuses a second live budget for the same category, period and start', async () => {
      const shared = {
        category: 'groceries',
        period: 'monthly',
        currency: 'INR',
        effectiveFrom: '2026-08-01',
      } as const;

      unwrap(await repo.saveBudget({ ...shared, id: newId(), amountMinor: 1_500_000n }));

      /*
       * `saveBudget` keys its upsert on the id, deliberately: editing an
       * allowance is the same call as setting one. The natural key stays the
       * database's business, so a *second* budget for one category and period
       * is a contradiction the index rejects rather than something the
       * repository silently sums.
       *
       * Written raw because Drizzle wraps a driver error in a
       * `DrizzleQueryError` whose message is the failed SQL; the constraint
       * name survives only on the cause. Going straight at the client keeps
       * the assertion on Postgres's own words.
       */
      await expect(
        database.$client`
          INSERT INTO budget (id, category, period, amount_minor, currency, effective_from)
          VALUES (${newId()}, 'groceries', 'monthly', 1800000, 'INR', '2026-08-01')`,
      ).rejects.toThrow(/budget_category_unique/u);
    });

    it('refuses a second balance row for the same account and day', async () => {
      const accountId = await anAccount();
      await database.$client`
        INSERT INTO account_balance (id, account_id, as_of_day_key, amount_minor, currency)
        VALUES (${newId()}, ${accountId}, '2026-08-30', 500000, 'INR')`;

      /* `recordBalance` upserts past this, which is the correction path above.
       * Written raw here so the index itself is what is under test: the
       * repository's habit is not the guarantee. */
      await expect(
        database.$client`
          INSERT INTO account_balance (id, account_id, as_of_day_key, amount_minor, currency)
          VALUES (${newId()}, ${accountId}, '2026-08-30', 512340, 'INR')`,
      ).rejects.toThrow(/account_balance_day_unique/u);
    });
  });

  describe('subscriptions', () => {
    it('dates a cancellation, records why, and keeps the row readable', async () => {
      const id = newId();
      await repo.saveSubscription({
        id,
        name: 'A streaming service nobody opens',
        amountMinor: 64_900n,
        currency: 'INR',
        cadence: 'monthly',
        startedOn: '2024-01-15',
      });

      const cancelled = unwrap(
        await repo.cancelSubscription(id, '2026-08-31', 'Watched nothing in four months', '2026-08-31T09:00:00.000Z'),
      );
      expect(cancelled.cancelledOn).toBe('2026-08-31');
      expect(cancelled.cancellationNote).toBe('Watched nothing in four months');
      /* Cancelling is the most attentive act available here, so it counts as a
       * review — otherwise a settled commitment stays on the "nobody has looked
       * at this" list forever. */
      expect(cancelled.lastReviewedOn).toBe('2026-08-31');

      const rows = unwrap(await repo.subscriptions());
      /* A cancelled row is history, never removed. §4.9's question — what have
       * I committed to and stopped noticing — is answered partly by what was
       * let go, and when. */
      expect(rows.map((row) => row.id)).toContain(id);
    });
  });

  describe('shopping', () => {
    it('dates a purchase and links it to the transaction that paid for it', async () => {
      const accountId = await anAccount();
      const transactionId = newId();
      await repo.recordTransaction({
        id: transactionId,
        accountId,
        amountMinor: -129_900n,
        currency: 'INR',
        occurredAt: '2026-08-30T12:00:00.000Z',
        zone: ZONE,
        dayKey: '2026-08-30',
        merchant: 'A pharmacy',
        category: 'skincare',
      });

      const itemId = newId();
      await repo.saveShoppingItem({ id: itemId, name: 'Azelaic acid 15%', category: 'skincare' });

      const purchased = unwrap(
        await repo.markPurchased({ id: itemId, at: '2026-08-30T12:05:00.000Z', transactionId }),
      );

      expect(purchased.status).toBe('purchased');
      /* The instant travels with the status, always — an item that is bought
       * but undated is invisible to every question the purchase history exists
       * to answer, and `shopping_item_purchase_together` says so. */
      expect(purchased.purchasedAt).toBe('2026-08-30T12:05:00.000Z');
      /* The link is what turns a notepad into "skincare spend against
       * outcomes" (§4.9) at the level of a single product. */
      expect(purchased.transactionId).toBe(transactionId);
    });
  });
});
