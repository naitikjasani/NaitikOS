'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { uuidV7 } from '@naitikos/shared';
import { SPEND_CATEGORIES, SPEND_CATEGORY_LABELS, systemClock } from '@naitikos/core';
import type { SpendCategory } from '@naitikos/core';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  FileField,
  Inline,
  Stack,
  Text,
} from '@naitikos/design-system';

import type { TransactionsBoard } from '@/lib/platform/money';
import { importTransactions, setCategory, type ImportRow } from '../services/moneyClient';

/**
 * `/money/transactions` — §4.9's "import over entry, absolutely (P1)".
 *
 * ## There is no add-a-transaction form on this page, and that is the design
 *
 * §4.9: "Manual transaction logging will not be sustained and should not be
 * designed for." A form here would be used enthusiastically for nine days and
 * then abandoned, leaving a record that is complete for one week of every year
 * — worse than no record, because the gaps are invisible. The wire does carry a
 * single-row kind for the transaction a statement will never show; it is not
 * the path this screen offers, because the path a screen offers is the path
 * that gets taken.
 *
 * ## The file is read here, in the browser
 *
 * `await file.text()`, parsed client-side, posted as rows. Handing the server a
 * URL or a path to read would turn one endpoint into a proxy for arbitrary
 * outbound requests — anything the server can reach, aimed by whoever holds a
 * session — and the operator already had the file in order to name it.
 *
 * ## The hash is over what the source guarantees, not over the line
 *
 * Date, amount and description: three fields a bank will still emit the same
 * way next month. A hash over the whole CSV line folds in column order,
 * whitespace padding, a running-balance column and a "reference" field some
 * exporters regenerate on every download — and any one of those changing turns
 * every historical row into a new transaction, which the operator discovers as
 * a doubled month rather than as an error.
 *
 * The narrow hash occasionally collides: two identical ₹200 coffees on the same
 * day are one hash, and the second is skipped. That is the better failure. One
 * row missing and counted in the skip total is visible; a month silently
 * double-counted is not, and it poisons every budget and every category chart
 * built on top of it.
 *
 * The description is normalised — collapsed whitespace, lower-cased — before it
 * is hashed, for the same reason: a re-export that pads a column differently is
 * the same transaction and must produce the same hash.
 *
 * ## `{ inserted, skipped }` in plain sentences, and a skip is not an error
 *
 * Re-importing a statement is the normal case, not the exception. "412 rows, 9
 * new" is the only summary that says whether the run did what the operator
 * expected. Reporting the 403 as failures would train them to stop
 * re-importing, which is how a month goes missing.
 *
 * ## The uncategorised count is at the top, above the list
 *
 * `spendByCategory` skips an uncategorised transaction rather than filing it
 * under `other`, so every budget and every category total understates itself by
 * exactly this queue. The number belongs where it is read before the totals
 * are, not underneath them.
 */
export function TransactionsScreen({
  board,
  zone,
}: {
  readonly board: TransactionsBoard;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [categorising, setCategorising] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  const categorise = useMutation({
    mutationFn: async (input: { readonly id: string; readonly category: SpendCategory }) => {
      await setCategory(input.id, input.category);
    },
    onSuccess: () => {
      setCategorising(null);
      setProblem(null);
      refresh();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not set that category.');
    },
  });

  return (
    <Stack gap="6">
      <Import board={board} zone={zone} onImported={refresh} />

      <Stack gap="1">
        <Inline gap="6" wrap>
          <Figure label="Rows in this window" value={String(board.transactions.length)} />
          <Figure label="Waiting for a category" value={String(board.uncategorised)} />
        </Inline>
        <Text role="caption" tone="tertiary">
          {board.uncategorised === 0
            ? `${board.fromDayKey} to ${board.toDayKey}. Everything imported in this window is categorised.`
            : `${board.fromDayKey} to ${board.toDayKey}. An uncategorised row is in no category total, so every budget on the next page understates itself by these ${String(board.uncategorised)}.`}
        </Text>
      </Stack>

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      {board.transactions.length === 0 ? (
        <EmptyState
          title="Nothing in this window"
          description="Export a CSV from your bank and drop it above. Import is the path this pillar is built around; typing rows in is not."
        />
      ) : (
        <Stack gap="2">
          {board.transactions.map((txn) => (
            <Card key={txn.id} variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Inline gap="3" align="center" justify="between">
                    <Stack gap="1">
                      <Text role="body" as="span">
                        {txn.merchant ?? txn.rawDescription ?? 'No description on the statement'}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {txn.dayKey}
                        {txn.accountName === null ? '' : ` · ${txn.accountName}`}
                        {txn.merchant !== null && txn.rawDescription !== null
                          ? ` · ${txn.rawDescription}`
                          : ''}
                      </Text>
                    </Stack>
                    <Stack gap="1" align="end">
                      <Text role="metric-m" as="span">
                        {txn.amount}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {txn.isOutflow ? 'out' : 'in'} · {txn.currency}
                      </Text>
                    </Stack>
                  </Inline>

                  <Inline gap="2" align="center" wrap>
                    {txn.categoryLabel === null ? (
                      <Badge tone="caution">Uncategorised</Badge>
                    ) : (
                      /*
                        A confirmed category and an imported guess are drawn
                        differently on purpose. `is_category_confirmed` is what
                        lets a re-import refine its own guesses without
                        overwriting a human decision (P5), and a reader deciding
                        whether to trust a total needs to see which is which.
                      */
                      <Badge tone={txn.isCategoryConfirmed ? 'accent' : 'neutral'}>
                        {txn.categoryLabel}
                        {txn.isCategoryConfirmed ? '' : ' · guessed'}
                      </Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCategorising(categorising === txn.id ? null : txn.id);
                      }}
                    >
                      {categorising === txn.id ? 'Close' : 'Categorise'}
                    </Button>
                  </Inline>

                  {categorising === txn.id && (
                    <Inline gap="2" wrap>
                      {SPEND_CATEGORIES.map((category) => (
                        <Button
                          key={category}
                          size="sm"
                          variant={category === txn.category ? 'primary' : 'secondary'}
                          aria-pressed={category === txn.category}
                          disabled={categorise.isPending}
                          onClick={() => {
                            categorise.mutate({ id: txn.id, category });
                          }}
                        >
                          {SPEND_CATEGORY_LABELS[category]}
                        </Button>
                      ))}
                    </Inline>
                  )}
                </Stack>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <Stack gap="1">
      <Text role="caption" tone="tertiary">
        {label}
      </Text>
      <Text role="metric-m" as="span">
        {value}
      </Text>
    </Stack>
  );
}

/* ======================================================================
 * The import
 * ====================================================================== */

/** What a parse produced: rows to send, and what it could not read. */
type Parsed = {
  readonly rows: readonly ImportRow[];
  readonly unreadable: number;
  readonly fromDayKey: string | null;
  readonly toDayKey: string | null;
  readonly columns: string;
};

function Import({
  board,
  zone,
  onImported,
}: {
  readonly board: TransactionsBoard;
  readonly zone: string;
  readonly onImported: () => void;
}): ReactNode {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [dayFirst, setDayFirst] = useState(true);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [outcome, setOutcome] = useState<{ readonly inserted: number; readonly skipped: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);

  const account = board.accounts.find((option) => option.id === accountId) ?? null;
  const currency = account?.currency.toUpperCase() ?? board.defaultCurrency;

  const read = useMutation({
    mutationFn: async (file: File) => {
      /* Read in the browser — see the header. The server never fetches. */
      const text = await file.text();
      return parseStatement(text, { currency, dayFirst });
    },
    onSuccess: (result: Parsed) => {
      setParsed(result);
      setOutcome(null);
      setProblem(
        result.rows.length === 0
          ? 'No rows could be read from that file. It needs a header row naming a date column and either an amount column or a debit and credit pair.'
          : null,
      );
    },
    onError: (error: unknown) => {
      setParsed(null);
      setProblem(error instanceof Error ? error.message : 'Could not read that file.');
    },
  });

  const send = useMutation({
    mutationFn: async (rows: readonly ImportRow[]) => {
      return importTransactions({ accountId, zone, rows });
    },
    onSuccess: (result: { readonly inserted: number; readonly skipped: number }) => {
      setOutcome(result);
      setParsed(null);
      setProblem(null);
      onImported();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not import those rows.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <Text role="title-3" as="h2">
            Import a statement
          </Text>
          <Text role="caption" tone="tertiary">
            Re-importing a statement you have already imported is a no-op, not a double count. That
            is the normal case, and the counts below say how much of a run was new.
          </Text>

          {board.accounts.length > 0 && (
            <Stack gap="1">
              <Text role="caption" tone="tertiary">
                Which account this statement is from. The rows are denominated in its currency.
              </Text>
              <Inline gap="2" wrap>
                {board.accounts.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={option.id === accountId ? 'primary' : 'secondary'}
                    aria-pressed={option.id === accountId}
                    onClick={() => {
                      setAccountId(option.id === accountId ? null : option.id);
                      setParsed(null);
                    }}
                  >
                    {option.name} · {option.currency.toUpperCase()}
                  </Button>
                ))}
              </Inline>
            </Stack>
          )}

          {/*
            `03/04/2026` is two dates and the file does not say which. Guessing
            from the data works until a statement happens to contain no day
            above twelve, at which point three months land in the wrong months
            with nothing to show for it — so the operator states the convention
            instead.
          */}
          <Stack gap="1">
            <Text role="caption" tone="tertiary">
              How dates are written in the file. `03/04/2026` is the 3rd of April or the 4th of
              March, and nothing in a CSV says which.
            </Text>
            <Inline gap="2" wrap>
              <Button
                size="sm"
                variant={dayFirst ? 'primary' : 'secondary'}
                aria-pressed={dayFirst}
                onClick={() => {
                  setDayFirst(true);
                  setParsed(null);
                }}
              >
                Day first
              </Button>
              <Button
                size="sm"
                variant={dayFirst ? 'secondary' : 'primary'}
                aria-pressed={!dayFirst}
                onClick={() => {
                  setDayFirst(false);
                  setParsed(null);
                }}
              >
                Month first
              </Button>
            </Inline>
          </Stack>

          <FileField
            label="The CSV"
            accept=".csv,text/csv"
            hint={`Read here in the browser and posted as rows, in ${currency}. Nothing fetches a file on your behalf.`}
            onFilesSelected={(files) => {
              const file = files[0];
              /* `noUncheckedIndexedAccess` is on, and an empty selection is a
                 real thing a file input produces. */
              if (file === undefined) return;
              read.mutate(file);
            }}
          />

          {read.isPending && (
            <Text role="body-sm" tone="secondary">
              Reading it.
            </Text>
          )}

          {parsed !== null && parsed.rows.length > 0 && (
            <Stack gap="2">
              <Text role="body-sm">
                {String(parsed.rows.length)} {parsed.rows.length === 1 ? 'row' : 'rows'} read
                {parsed.fromDayKey === null || parsed.toDayKey === null
                  ? ''
                  : `, ${parsed.fromDayKey} to ${parsed.toDayKey}`}
                . Columns used: {parsed.columns}.
              </Text>
              {parsed.unreadable > 0 && (
                <Text role="body-sm" tone="secondary">
                  {String(parsed.unreadable)}{' '}
                  {parsed.unreadable === 1 ? 'line was' : 'lines were'} left out because the date or
                  the amount could not be read. They are named here rather than skipped quietly — a
                  line dropped in silence is a transaction that never existed.
                </Text>
              )}
              <Inline gap="2">
                <Button
                  variant="primary"
                  disabled={send.isPending}
                  onClick={() => {
                    send.mutate(parsed.rows);
                  }}
                >
                  Import {String(parsed.rows.length)}{' '}
                  {parsed.rows.length === 1 ? 'row' : 'rows'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setParsed(null);
                  }}
                >
                  Discard
                </Button>
              </Inline>
            </Stack>
          )}

          {outcome !== null && (
            <Stack gap="1">
              <Text role="body-sm">
                {String(outcome.inserted)} new{' '}
                {outcome.inserted === 1 ? 'transaction' : 'transactions'} recorded.
              </Text>
              {outcome.skipped > 0 && (
                <Text role="body-sm" tone="secondary">
                  {String(outcome.skipped)} {outcome.skipped === 1 ? 'row was' : 'rows were'}{' '}
                  already in the record and were skipped. That is what re-importing a statement is
                  supposed to do.
                </Text>
              )}
            </Stack>
          )}

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Text role="caption" tone="tertiary">
            Imported rows arrive without a category. Nothing here guesses one from a merchant name:
            a rules engine is a maintenance surface that quietly recategorises history, and the
            queue above is honest about what has not been looked at.
          </Text>
        </Stack>
      </CardBody>
    </Card>
  );
}

/* ======================================================================
 * Reading a bank CSV
 * ====================================================================== */

/**
 * A minimal RFC-4180 reader.
 *
 * Quoted fields, doubled quotes inside them, and newlines inside quotes — the
 * whole grammar a bank export actually uses. A dependency for this would be a
 * dependency in the browser bundle for thirty lines of state machine, and C2
 * asks the opposite question: what will still build in 2046.
 */
function readCsv(text: string): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      /* CRLF is one line break, not two. */
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  row.push(field);
  rows.push(row);

  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}

const DATE_HEADERS = [
  'date',
  'txn date',
  'tran date',
  'transaction date',
  'value date',
  'posting date',
  'book date',
];
const AMOUNT_HEADERS = ['amount', 'transaction amount', 'amt', 'value'];
const DEBIT_HEADERS = ['debit', 'debit amount', 'withdrawal', 'withdrawal amt', 'withdrawal amount', 'dr'];
const CREDIT_HEADERS = ['credit', 'credit amount', 'deposit', 'deposit amt', 'deposit amount', 'cr'];
const DESCRIPTION_HEADERS = [
  'description',
  'narration',
  'particulars',
  'details',
  'remarks',
  'transaction details',
  'transaction remarks',
];

function columnOf(header: readonly string[], names: readonly string[]): number {
  return header.findIndex((cell) => names.includes(cell.trim().toLowerCase()));
}

function cellAt(row: readonly string[], index: number): string {
  return index < 0 ? '' : (row[index] ?? '');
}

/**
 * `1,234.50`, `₹1,234.50`, `(1,234.50)`, `1234.50 Dr` → a wire amount.
 *
 * **Negative is money leaving** — one convention, decided in the schema and
 * applied here rather than at each call site. Parentheses and a `Dr` marker are
 * both accepted because both are how a statement writes a debit, and a reader
 * who typed neither would still be sure of what they meant.
 */
function readAmount(raw: string, forceOutflow: boolean): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const parenthesised = /^\(.*\)$/u.test(trimmed);
  const marked = /\b(dr|debit)\b/iu.test(trimmed);
  const digits = trimmed.replace(/[^0-9.-]/gu, '');
  if (!/^-?\d+(\.\d+)?$/u.test(digits)) return null;

  const magnitude = digits.startsWith('-') ? digits.slice(1) : digits;
  if (magnitude === '' || Number(magnitude) === 0) return null;

  const outflow = forceOutflow || parenthesised || marked || digits.startsWith('-');
  return outflow ? `-${magnitude}` : magnitude;
}

/**
 * A day key from whatever the statement wrote.
 *
 * `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YY` and the month-first readings of the
 * last two. Parsed by regex and integer arithmetic, never by `new Date` — §11.3
 * bans it because it resolves in the runtime's zone, and a statement's date has
 * no zone at all.
 */
function readDayKey(raw: string, dayFirst: boolean): string | null {
  const trimmed = raw.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(trimmed);
  if (iso !== null) return `${iso[1] ?? ''}-${iso[2] ?? ''}-${iso[3] ?? ''}`;

  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/u.exec(trimmed);
  if (parts === null) return null;

  const first = parts[1] ?? '';
  const second = parts[2] ?? '';
  const yearRaw = parts[3] ?? '';

  const day = dayFirst ? first : second;
  const month = dayFirst ? second : first;
  /* A two-digit year is this century. A bank statement from 1998 is not a thing
   * this system will be handed, and guessing a pivot would be worse than saying
   * so here. */
  const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;

  const dayNumber = Number(day);
  const monthNumber = Number(month);
  if (dayNumber < 1 || dayNumber > 31 || monthNumber < 1 || monthNumber > 12) return null;

  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/*
 * FNV-1a, 128-bit, hex.
 *
 * A hash rather than the composite key itself, because the wire caps
 * `importHash` at 200 characters and a description can run to 500. Not a
 * cryptographic digest: `crypto.subtle` is asynchronous and absent outside a
 * secure context, and nothing here needs collision *resistance against an
 * adversary* — only a stable fingerprint of three fields. Thirty-two hex
 * characters make an accidental collision across a few thousand rows
 * vanishingly unlikely, and the deliberate collision — the same amount, day and
 * description twice — is the intended behaviour, not a flaw.
 */
const FNV_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME = 0x0000000001000000000000000000013bn;
const FNV_MASK = (1n << 128n) - 1n;

function importHashOf(dayKey: string, amount: string, description: string): string {
  /*
   * Date, amount, description — and the description normalised first, because a
   * re-export that pads a column differently is the same transaction. Column
   * order, a running-balance column and a regenerated reference field are all
   * deliberately absent: see the module header.
   */
  const canonical = `${dayKey}|${amount}|${description.trim().replace(/\s+/gu, ' ').toLowerCase()}`;
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK;
  }
  return hash.toString(16).padStart(32, '0');
}

function parseStatement(
  text: string,
  options: { readonly currency: string; readonly dayFirst: boolean },
): Parsed {
  const rows = readCsv(text);

  /*
   * The header is found rather than assumed to be line one. Bank exports
   * routinely open with an account name, an address and a blank line, and a
   * parser that took the first row as the header would report a whole statement
   * as unreadable.
   */
  let headerIndex = -1;
  for (let index = 0; index < Math.min(rows.length, 25); index += 1) {
    const candidate = rows[index] ?? [];
    const hasDate = columnOf(candidate, DATE_HEADERS) >= 0;
    const hasAmount =
      columnOf(candidate, AMOUNT_HEADERS) >= 0 ||
      columnOf(candidate, DEBIT_HEADERS) >= 0 ||
      columnOf(candidate, CREDIT_HEADERS) >= 0;
    if (hasDate && hasAmount) {
      headerIndex = index;
      break;
    }
  }

  if (headerIndex < 0) {
    return { rows: [], unreadable: rows.length, fromDayKey: null, toDayKey: null, columns: 'none found' };
  }

  const header = rows[headerIndex] ?? [];
  const dateColumn = columnOf(header, DATE_HEADERS);
  const amountColumn = columnOf(header, AMOUNT_HEADERS);
  const debitColumn = columnOf(header, DEBIT_HEADERS);
  const creditColumn = columnOf(header, CREDIT_HEADERS);
  const descriptionColumn = columnOf(header, DESCRIPTION_HEADERS);

  const used = [
    cellAt(header, dateColumn).trim(),
    amountColumn >= 0 ? cellAt(header, amountColumn).trim() : null,
    debitColumn >= 0 ? cellAt(header, debitColumn).trim() : null,
    creditColumn >= 0 ? cellAt(header, creditColumn).trim() : null,
    descriptionColumn >= 0 ? cellAt(header, descriptionColumn).trim() : null,
  ].filter((name): name is string => name !== null && name !== '');

  const parsed: ImportRow[] = [];
  let unreadable = 0;
  const seen = new Set<string>();

  for (const row of rows.slice(headerIndex + 1)) {
    const dayKey = readDayKey(cellAt(row, dateColumn), options.dayFirst);
    if (dayKey === null) {
      unreadable += 1;
      continue;
    }

    /*
     * A single signed column, or a debit/credit pair. The pair is the common
     * shape in an Indian statement, and its debit column is written positive —
     * so it is negated here rather than trusted, which is the one place this
     * parser overrides what the file says.
     */
    const amount =
      amountColumn >= 0
        ? readAmount(cellAt(row, amountColumn), false)
        : (readAmount(cellAt(row, debitColumn), true) ??
          readAmount(cellAt(row, creditColumn), false));

    if (amount === null) {
      unreadable += 1;
      continue;
    }

    const description = cellAt(row, descriptionColumn).trim();
    const importHash = importHashOf(dayKey, amount, description);

    /*
     * A repeat inside one file is dropped here rather than posted.
     * The server would refuse the second one anyway — the unique index is the
     * real guarantee — but posting a batch that contradicts itself and reading
     * back a skip count that includes it would make the numbers below harder to
     * trust than they need to be.
     */
    if (seen.has(importHash)) {
      unreadable += 1;
      continue;
    }
    seen.add(importHash);

    parsed.push({
      id: uuidV7(systemClock.nowMillis()),
      amount,
      currency: options.currency,
      /* Noon UTC on the stated day, the convention every day-anchored instant
       * in this system uses: midnight sits on a boundary a DST rule can push
       * into the day before. The server derives the day key from this and the
       * batch's zone. */
      occurredAt: `${dayKey}T12:00:00.000Z`,
      rawDescription: description === '' ? null : description,
      /* The raw string is evidence and is stored as printed. A merchant is the
       * operator's own name for it, and nothing here invents one. */
      merchant: null,
      /* No rules engine. `docs/money.md` §10: a learned classifier is a
       * maintenance surface that quietly recategorises history. */
      category: null,
      importHash,
    });
  }

  const days = parsed.map((row) => row.occurredAt.slice(0, 10)).sort((a, b) => a.localeCompare(b));

  return {
    rows: parsed,
    unreadable,
    fromDayKey: days[0] ?? null,
    toDayKey: days[days.length - 1] ?? null,
    columns: used.join(', '),
  };
}
