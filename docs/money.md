# Money

**Status:** complete against §3.2's `/money` block, shipped 1 September 2026
(§12's V3 Q2). Accounts, transactions, budgets, subscriptions, shopping and net
worth.
· **Blueprint sections:** §4.9, §5.3, §5.4, §5.5, §9.3, §10.6, §13
**Related:** [work.md](work.md) · [nutrition.md](nutrition.md) ·
[observations.md](observations.md)

---

## 1. Money is last, and being last is what makes it buildable

§4.9 is unusually candid about where this pillar sits:

> Last in priority: excellent third-party tools exist, and the cross-domain
> linkage is thinner than the others. Where it does link, it links well —
> supplement and skincare spend against outcomes, food spend against nutrition
> quality, and the correlation between financial stress and anxiety episodes,
> which is worth knowing.

§13's finding 12 sharpens it into a rule:

> A dedicated finance app will beat the Money pillar... NaitikOS should own the
> domains where *integration* is the value, and it should not compete on
> features in domains where it cannot win.

Both sentences are budget, not modesty. Because this module arrived last it
could be scoped against four pillars that already exist, and everything it
declines to build is something a finance product would have had to build
speculatively. There is no double-entry ledger, no reconciliation workflow, no
cost-basis tracking, no tax lot, no split-transaction model and no bill
scheduler. Each is a real feature of a real product; each is a fight this
system has already decided not to have.

What being last actually buys is that `spend_category` could be drawn from the
joins rather than from a taxonomy. `supplements` and `skincare` are top-level
categories in a seventeen-item list because §4.2 and §4.3 already exist to be
joined against — see §7.

## 2. Import over entry, and the hash that makes it safe

§4.9:

> Import over entry, absolutely (P1). Manual transaction logging will not be
> sustained and should not be designed for.

Taken seriously, that changes the shape of the write path rather than just its
priority. `transaction_import` accepts a batch of up to 5,000 rows; the
single-row `transaction` kind exists for the transaction a statement will never
carry, not as the path the operator is expected to live in.

**Re-import is the normal case, not the error case.** A statement gets
downloaded again because the month was not finished the first time, or because
one row was missing, or because the file was lost. So `money_transaction`
carries `import_hash` with a partial unique index on it, and the server treats a
collision as a skip rather than a conflict. A run reports `{ inserted, skipped }`
in plain sentences afterwards, because "412 rows, 9 new" is the only summary
that tells the operator whether the import did what they thought.

**The hash is computed over what the source guarantees, not over the raw line.**
Date, amount and description — three fields a bank will still emit in the same
form next month. A hash over the whole CSV line would fold in column order,
whitespace padding, a running balance column and a "reference" field that some
exporters regenerate per download; any of those changing turns every historical
row into a new transaction, and the operator discovers it as a doubled month
rather than as an error. The narrower hash occasionally collides — two identical
₹200 coffees on one day — and that is the better failure: one row skipped and
visible, rather than a month silently double-counted.

Deduplication lives in the schema rather than in the importer for the same
reason `task_completed_together` is a `CHECK`. A convention is not a guarantee,
and this particular convention has to hold for twenty years across every
importer anyone writes later.

## 3. There are no exchange rates, anywhere

No rate table, no rate provider, no conversion function, no "display currency"
setting. `addAmounts` refuses two different currencies rather than converting
them, and it refuses in `core` so that no caller can decide otherwise.

This costs something real and it is worth naming. An operator holding an INR
current account and a USD brokerage account cannot see one net worth figure.
The `/money/networth` line is per-currency, and if there are two currencies
there are two lines.

The alternative is worse in a way that is easy to miss. A rate is a fact about a
*moment*, so a converted historical total is only meaningful paired with the
rate used and the date it was taken — and a system that stored the total without
them would produce a net-worth chart whose 2027 figures silently changed every
time it was redrawn. That is not a chart with a caveat, it is a chart that
cannot be compared against itself, and comparability is the entire reason this
record exists (§1.2). A live rate feed is also a network dependency with an
outage story, inside a module §13 already ruled out competing on.

Two honest lines beat one number nobody can reconstruct.

## 4. Balances are observed, never computed

`account_balance` is a reading: an account, a day, an amount. Nothing rolls
transactions forward into a balance, and the wire has no kind that asks for it.

A running total derived from imported transactions is wrong from the first
missing statement and then stays wrong forever, silently, with the error
compounding into every later figure. A number read off the account is a fact
with a date on it. This is §9.3(4)'s two-sources-of-truth argument — the same
one that stops a goal owning its progress — applied to money.

The cost is staleness, and staleness is stated rather than hidden.
`STALE_BALANCE_DAYS` marks a reading past its useful life, and `/money/networth`
says in words how many accounts contributed a stale figure. **A net worth built
from a six-month-old balance is a number, not a fact**, and the screen is
required to say which one it is showing.

## 5. `is_liability`, and the error it prevents

`financial_account.is_liability` is stored rather than derived from `kind`.

Deriving it would put the sign convention in whichever caller happened to be
summing, and the sign convention is the single easiest thing in this domain to
get wrong. A credit card with ₹40,000 on it is **−₹40,000** of net worth. A
sum that added it instead of subtracting it is wrong by ₹80,000 — twice the
balance — and it is wrong in the flattering direction, which is exactly the kind
of error that does not get noticed.

Storing it means the decision is made once, by a human, on the day the account
is created, and every later sum reads it rather than re-deciding. `kind` is
descriptive; `is_liability` is arithmetic. A `wallet` holding a prepaid balance
and a `wallet` representing a credit line are the same kind and opposite signs.

## 6. Budgets own no spending

`budget` holds a category, a period, an amount and a window. It has no `spent`
column, and adding one would be the same mistake §4.10 refuses when it forbids a
goal from owning its progress.

Spending is summed from `money_transaction` on every read. The moment a stored
total exists it is a cache, and the first recategorisation drifts it — silently,
because nothing recomputes a column nobody wrote to. `/money/budgets` sums live
and pays the query cost, which is trivial against a personal ledger and cheap
against being wrong for a year.

**A ratio with no denominator is `null`, and `null` renders as a sentence.**
`budgetStanding` returns `null` for the ratio when the budget is not active over
the period being asked about, and the screen prints the reason — "this budget
starts next month" — rather than 0%. §10.9 asks for *"insufficient data"* rather
than a guess, and a progress bar at zero is not the absence of a claim; it is a
specific wrong one, and on a budget page the wrong one is reassuring.

## 7. Why `supplements` and `skincare` are their own categories

Seventeen categories, and two of them look far too specific for a list that
folds all of housing into `rent` and `utilities`.

They are there because §4.9's justification for the entire pillar names them:

> supplement and skincare spend against outcomes, food spend against nutrition
> quality

Those are the joins. §4.2 holds a skincare product register and per-region
daily state; §4.3 holds foods and their macros. Folding supplement spend into a
`health` bucket alongside a dentist's bill and a prescription would make "what
did the routine cost, and did the skin change" unanswerable without a
per-merchant reclassification nobody would maintain. A category is cheap; a
join that cannot be made is the pillar failing at the thing it exists for.

Everything else is coarse deliberately. A forty-category taxonomy is a finance
product's feature (§13's finding 12 again), and more practically: a category the
operator has to think about before choosing is one that gets chosen
inconsistently, which makes every total built from it a lie. Coarse and
consistent beats fine and drifting.

`shopping_item.linked_entity_type` takes the same join one level finer — down to
the individual product rather than the category — which is how "is the ₹4,000
serum doing anything" becomes answerable at all.

## 8. `bigint` minor units in storage, decimal strings on the wire

§5.3: *"Integer minor units plus an ISO-4217 code — never a float."* `1250n` +
`'INR'` is ₹12.50. The `money()` helper in `columns.ts` is the only way an
amount is declared, so no table can quietly deviate, and a bare number with no
currency is not a monetary value at all — which matters over a record meant to
outlive at least one relocation.

The boundary rule follows from a JavaScript fact: **`bigint` is not
JSON-serialisable.** `JSON.stringify({ n: 1n })` throws, and a React Server
Component cannot serialise one into a Client Component's props either — the
error arrives at runtime, in the browser, as an unhelpful serialisation
complaint rather than as a type error.

So:

| Layer | Representation |
|---|---|
| Postgres, `core` | `bigint` minor units + ISO-4217 code |
| The wire (`contracts/money.ts`) | decimal **string** + code — `'12.50'`, `'INR'` |
| A board handed to a screen | **display string** via `formatAmount` |

Conversion happens at exactly two points: `parseAmount` in `/api/money`, and
`formatAmount` in `lib/platform/money.ts`. Every board that crosses the
server/client line carries formatted strings rather than `bigint`, and the
loaders say so in a comment, because this is the failure a later maintainer
hits — usually by adding one convenient raw field to a board and finding out in
production.

The string is not a wrapper around a number. A JSON number is an IEEE-754
double, and §5.3 rules floats out for money for the reason every finance system
eventually learns. `'0.1'` is exact; `0.1` is not.

The scale is not fixed at two digits in the regex, either. Minor units are
per-currency — JPY has none, KWD has three — so `MINOR_UNITS` and
`minorUnitsFor` own that knowledge and `parseAmount` enforces it. A regex
assuming two would reject a valid Kuwaiti amount.

## 9. The screens assert nothing

§4.9 mentions *"the correlation between financial stress and anxiety episodes,
which is worth knowing"*, and this is where restraint matters most, because it
is the most tempting claim in the system.

Nothing in `/money` says it. Spend by category and an anxiety series can be laid
next to each other and read by a person; the software does not connect them.
§10.6's five controls govern any claim stronger than adjacency, and none of them
is satisfied by two charts on a page — least of all for a pair where the causal
arrow plausibly runs both ways and a third variable (a bad month at work,
already in §4.8) plausibly drives both.

There is also **no composite financial health score**. It would need weights;
the weights would be invented; and a single number renders "spending 10% over
budget with no debt" and "on budget with a maxed card" as identical while
looking authoritative about a judgement nobody made deliberately. The same
argument §4.8 makes against a project health score, and it applies harder here
because a money score is the one an operator would actually take a decision on.

Four surfaces state four things plainly — where it went, what is committed, what
is owned, what is owed — and stop.

One consequence worth stating: **no account number, IBAN, sort code or card
PAN** is stored. §5.5 tiers storage by sensitivity, and none of those
identifiers earns its risk here. The questions this pillar answers need accounts
told apart, not payments addressed to them; `institution` and `name` do that. A
record that cannot be used to move money is a record whose loss is survivable.

## 10. What is deliberately not built

| Not built | Why |
|---|---|
| Exchange rates and a single-currency net worth | §3. A converted historical total is meaningless without the rate and its date, and a chart that silently changes its own past is worse than two honest lines. |
| Bank API / open-banking sync | A credential store, an OAuth refresh loop and a per-institution breakage surface, for a module §13 says not to compete in. CSV import is boring, offline, and works with every institution that exists. |
| Double-entry, reconciliation, cost basis, tax lots, splits | §1. Real features of real finance products. This module is scoped to the joins in §4.9 and nothing else. |
| A composite financial health score | §9. Invented weights, and the one number an operator would actually act on. |
| Any stated link between spend and anxiety | §9. §4.9 names the correlation as worth *knowing*; §10.6's five controls govern saying it, and none is met. |
| Automatic categorisation by merchant rules | An imported guess is allowed and `is_category_confirmed` keeps it distinguishable from a human decision, so a re-import refines its own guesses without overwriting a correction (P5). A learned rules engine is a maintenance surface that quietly recategorises history. |
| Bill scheduling and payment reminders | `subscription.next_due_on` records what is known; it does not become a scheduler. Notifications are a separate consent surface (§10.10) and this is not the pillar to open it with. |
| Investment holdings, prices, performance | Balances are observed (§4). An investment account contributes its stated balance and nothing else. Prices are a live feed, and a live feed is §3's problem again. |
| Receipt OCR into transactions | The document vault (§4.11) already extracts; nothing reads from that side into Money yet. A lens, when it earns its keep — not a second extraction pipeline. |
