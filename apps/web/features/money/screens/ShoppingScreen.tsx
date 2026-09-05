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
  Inline,
  Stack,
  Text,
  TextField,
} from '@naitikos/design-system';

import type { ShoppingBoard, ShoppingRow } from '@/lib/platform/money';
import { markPurchased, saveShoppingItem } from '../services/moneyClient';

/**
 * `/money/shopping` — §3.2's "shopping list & purchase history".
 *
 * ## One list at two moments, not two lists
 *
 * The schema keeps wanted and bought in one table because they are one object
 * seen twice, and splitting them would mean copying an item across on purchase
 * and then keeping two spellings of the same thing in step for twenty years.
 * The screen follows the table: the same row carries what it was expected to
 * cost and, once bought, what it did.
 *
 * The link to a transaction is what makes this more than a notepad — it is how
 * §4.9's "supplement and skincare spend against outcomes" becomes answerable
 * for an individual product rather than for a category.
 *
 * ## Dropped is an outcome with its own button
 *
 * `dropped` sits beside `purchased` at equal weight, and neither is a delete.
 * The reason is the one that makes `abandoned` a first-class learning status: a
 * list that can only be bought from accumulates things nobody wants any more,
 * and a list like that stops being opened — at which point the record loses
 * both halves, the wanting and the deciding against.
 *
 * "I decided against this in March, because I found a cheaper one" is
 * information. A delete throws it away and leaves the item free to reappear on
 * the list next month with nobody remembering why it left.
 *
 * ## The total says what it does not include
 *
 * Most things go on a list before anyone checks a price, so the wanted total
 * covers only the priced items and the count of unpriced ones is printed beside
 * it. A total that quietly excluded a third of the list would be a smaller
 * number that looks complete, which is worse than no total at all.
 */
export function ShoppingScreen({
  board,
  zone,
}: {
  readonly board: ShoppingBoard;
  readonly zone: string;
}): ReactNode {
  const router = useRouter();
  const [settling, setSettling] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = (): void => {
    router.refresh();
  };

  return (
    <Stack gap="6">
      <AddItem board={board} onSaved={refresh} />

      <Inline gap="6" wrap>
        <Figure
          label={`On the list, in ${board.currency}`}
          /* Never zero: an unpriced list is not a free one. */
          value={board.wantedTotal ?? 'Nothing on the list carries a price'}
        />
        <Figure label="Items wanted" value={String(board.wanted.length)} />
        <Figure label="Of those, unpriced" value={String(board.wantedUnpriced)} />
      </Inline>

      {board.wantedUnpriced > 0 && (
        <Text role="caption" tone="tertiary">
          The total covers only the {String(board.wanted.length - board.wantedUnpriced)} priced{' '}
          {board.wanted.length - board.wantedUnpriced === 1 ? 'item' : 'items'}. Most things go on a
          list before anyone checks a price, and a total that hid that would look complete.
        </Text>
      )}

      {board.excludedCurrencies.length > 0 && (
        <Text role="body-sm" tone="secondary">
          Items priced in {listCurrencies(board.excludedCurrencies)} are on the list below with their
          own figures and are not in the total. This system holds no exchange rates, so nothing is
          converted and nothing is summed across currencies.
        </Text>
      )}

      {problem !== null && (
        <Text role="body-sm" tone="critical">
          {problem}
        </Text>
      )}

      <Stack gap="2">
        <Text role="title-3" as="h2">
          Wanted
        </Text>
        {board.wanted.length === 0 ? (
          <EmptyState
            title="Nothing on the list"
            description="An empty list is a fine state. Items here can point at a product the rest of the system already tracks — that is what makes the spend answerable later."
          />
        ) : (
          board.wanted.map((item) => (
            <Card key={item.id} variant="outlined">
              <CardBody>
                <Stack gap="2">
                  <Inline gap="3" align="center" justify="between">
                    <Stack gap="1">
                      <Text role="body" as="span">
                        {item.name}
                      </Text>
                      <Text role="caption" tone="tertiary">
                        {describeItem(item)}
                      </Text>
                    </Stack>
                    <Inline gap="2">
                      <Button
                        size="sm"
                        variant={settling === item.id ? 'ghost' : 'primary'}
                        onClick={() => {
                          setSettling(settling === item.id ? null : item.id);
                        }}
                      >
                        {settling === item.id ? 'Close' : 'Settle it'}
                      </Button>
                    </Inline>
                  </Inline>

                  {item.note !== null && (
                    <Text role="body-sm" tone="secondary">
                      {item.note}
                    </Text>
                  )}

                  {settling === item.id && (
                    <Settle
                      item={item}
                      board={board}
                      zone={zone}
                      onDone={() => {
                        setSettling(null);
                        refresh();
                      }}
                      onProblem={setProblem}
                    />
                  )}
                </Stack>
              </CardBody>
            </Card>
          ))
        )}
      </Stack>

      {board.purchased.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Bought
          </Text>
          {board.purchased.map((item) => (
            <Card key={item.id} variant="outlined">
              <CardBody>
                <Inline gap="3" align="center" justify="between">
                  <Stack gap="1">
                    <Text role="body" as="span">
                      {item.name}
                    </Text>
                    <Text role="caption" tone="tertiary">
                      {describeItem(item)}
                      {item.purchasedAt === null ? '' : ` · bought ${item.purchasedAt.slice(0, 10)}`}
                      {/* Whether the purchase found its transaction. Said out
                          loud because the join is the point of this table. */}
                      {item.transactionId === null ? ' · not matched to a transaction' : ' · matched'}
                    </Text>
                  </Stack>
                  <Badge tone="positive">Bought</Badge>
                </Inline>
              </CardBody>
            </Card>
          ))}
        </Stack>
      )}

      {board.dropped.length > 0 && (
        <Stack gap="2">
          <Text role="title-3" as="h2">
            Decided against
          </Text>
          <Text role="caption" tone="tertiary">
            Kept rather than deleted. Why something left the list is the half of the record that
            stops it quietly returning next month.
          </Text>
          {board.dropped.map((item) => (
            <Card key={item.id} variant="outlined">
              <CardBody>
                <Stack gap="1">
                  <Inline gap="3" align="center" justify="between">
                    <Text role="body" as="span">
                      {item.name}
                    </Text>
                    <Badge tone="neutral">Dropped</Badge>
                  </Inline>
                  {item.note !== null && (
                    <Text role="body-sm" tone="secondary">
                      {item.note}
                    </Text>
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

function describeItem(item: ShoppingRow): string {
  const parts: string[] = [];
  if (item.categoryLabel !== null) parts.push(item.categoryLabel);
  if (item.quantity !== null) parts.push(`×${String(item.quantity)}`);
  /* No price is a real state and the commonest one. Said in words rather than
     drawn as a dash, which reads like a value that failed to load. */
  parts.push(item.amount ?? 'no price recorded');
  if (item.linkedEntityType !== null) parts.push(`restocks a ${item.linkedEntityType}`);
  return parts.join(' · ');
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

/** `['USD', 'AED']` → `'USD and AED'`. A sentence, not a comma-joined list. */
function listCurrencies(codes: readonly string[]): string {
  if (codes.length <= 1) return codes.join('');
  return `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1] ?? ''}`;
}

/** What the wire accepts: a decimal string in major units, never a `number`. */
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/u;

/* ======================================================================
 * Bought it, or decided against it
 * ====================================================================== */

function Settle({
  item,
  board,
  zone,
  onDone,
  onProblem,
}: {
  readonly item: ShoppingRow;
  readonly board: ShoppingBoard;
  readonly zone: string;
  readonly onDone: () => void;
  readonly onProblem: (message: string | null) => void;
}): ReactNode {
  const [paid, setPaid] = useState('');
  const [note, setNote] = useState('');

  const settle = useMutation({
    mutationFn: async (outcome: 'purchased' | 'dropped') => {
      const amount = paid.trim();
      const priced = outcome === 'purchased' && AMOUNT_PATTERN.test(amount);
      await markPurchased({
        id: item.id,
        outcome,
        /* The server stamps the instant; the zone is what makes it a day in the
         * operator's calendar rather than in the runtime's. */
        zone,
        /*
         * Not matched to a transaction here. The row it belongs to is in an
         * import that may not have arrived yet — a statement lags a purchase by
         * days — and guessing the match from an amount would attach the wrong
         * ₹400 as often as the right one.
         */
        transactionId: null,
        amount: priced ? amount : null,
        currency: priced ? board.currency : null,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      onProblem(null);
      onDone();
    },
    onError: (error: unknown) => {
      onProblem(error instanceof Error ? error.message : 'Could not settle that item.');
    },
  });

  return (
    <Stack gap="3">
      <TextField
        label={`What it actually cost, in ${board.currency}`}
        hint="Optional. Leave it empty and the item is recorded as bought with no price, which is honest — an invented figure is not."
        inputMode="decimal"
        value={paid}
        onChange={(event) => {
          setPaid(event.target.value);
        }}
      />

      <TextField
        label="Note"
        hint="On the dropped path this is the reason, and the reason is the whole value of recording it."
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />

      {/*
        Two buttons of equal weight. Dropping is an outcome, not a failure to
        reach one, and burying it behind a menu would teach the operator that
        the only legitimate end for a listed item is buying it.
      */}
      <Inline gap="2" wrap>
        <Button
          size="sm"
          variant="primary"
          disabled={settle.isPending}
          onClick={() => {
            settle.mutate('purchased');
          }}
        >
          Bought it
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={settle.isPending}
          onClick={() => {
            settle.mutate('dropped');
          }}
        >
          Decided against it
        </Button>
      </Inline>
    </Stack>
  );
}

/* ======================================================================
 * Adding to the list
 * ====================================================================== */

function AddItem({
  board,
  onSaved,
}: {
  readonly board: ShoppingBoard;
  readonly onSaved: () => void;
}): ReactNode {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<SpendCategory | null>(null);
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const priced = AMOUNT_PATTERN.test(amount.trim());
      const count = Number.parseInt(quantity.trim(), 10);
      await saveShoppingItem({
        id: uuidV7(systemClock.nowMillis()),
        name: name.trim(),
        category,
        quantity: Number.isInteger(count) && count > 0 ? count : null,
        /* Half a monetary value is not a smaller fact, it is an unreadable one:
         * the schema pairs amount and currency with a CHECK, so both go or
         * neither does. */
        amount: priced ? amount.trim() : null,
        currency: priced ? board.currency : null,
        note: note.trim() === '' ? null : note.trim(),
      });
    },
    onSuccess: () => {
      setName('');
      setQuantity('');
      setAmount('');
      setNote('');
      setProblem(null);
      onSaved();
    },
    onError: (error: unknown) => {
      setProblem(error instanceof Error ? error.message : 'Could not add that item.');
    },
  });

  return (
    <Card variant="raised">
      <CardBody>
        <Stack gap="3">
          <TextField
            label="Add to the list"
            placeholder="Niacinamide serum"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />

          <Inline gap="2" wrap>
            {SPEND_CATEGORIES.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === category ? 'primary' : 'secondary'}
                aria-pressed={option === category}
                onClick={() => {
                  setCategory(option === category ? null : option);
                }}
              >
                {SPEND_CATEGORY_LABELS[option]}
              </Button>
            ))}
          </Inline>

          <TextField
            label="Quantity"
            inputMode="numeric"
            value={quantity}
            onChange={(event) => {
              setQuantity(event.target.value);
            }}
          />

          <TextField
            label={`What you expect it to cost, in ${board.currency}`}
            hint="Optional, and usually unknown — that is why the list can hold an unpriced item without pretending otherwise."
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
            }}
          />

          <TextField
            label="Note"
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />

          {problem !== null && (
            <Text role="body-sm" tone="critical">
              {problem}
            </Text>
          )}

          <Inline gap="2">
            <Button
              variant="primary"
              disabled={name.trim() === '' || save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              Add it
            </Button>
          </Inline>
        </Stack>
      </CardBody>
    </Card>
  );
}
