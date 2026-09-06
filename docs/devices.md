# Devices

**Status:** complete against §2.3's "Wearable ingestion — Apple Health / Google
Fit import. Pull-based, batch, never a live stream", shipped 6 September 2026.
Ingest, the metric vocabulary, retention, and the two nightly steps that
maintain the table.
· **Blueprint sections:** §2.3, §5.2, §5.3, §5.4, §9.2, §9.3, §9.7, §8.9
**Related:** [observations.md](observations.md) · [health.md](health.md) ·
[background-jobs.md](background-jobs.md)

---

## 1. Why device data has its own table, and what that costs

§9.7 does the arithmetic before it makes the decision:

> Human-generated observations: roughly 50 per day at heavy use. Over twenty
> years, **under 400,000 rows.** This is a rounding error for Postgres.

> Device-generated samples are a different problem entirely: continuous heart
> rate at one-minute resolution is over half a million rows per year on its own,
> and a wearable emitting several such streams reaches tens of millions over
> twenty years.

So `observation` stays human-scale and `sample` is device-scale. The split is
not about size for its own sake — it is about which table gets to stay simple:

> Mixing them would force partitioning and retention complexity onto the human
> record — the part that must remain simple, complete, and forever — in order to
> accommodate device data whose value beyond 90 days is entirely in its
> aggregates anyway.

The cost of the split is that `sample` carries the complexity instead:
partitioning, a retention policy, a deduplication key that is not the primary
key, and two nightly steps to maintain. All four are consequences of that one
sentence, and none of them touches `observation`.

**What it does not cost is a second vocabulary.** `sample.metric_key` is a
foreign key to the same `metric` registry every human observation uses. That is
P3 working: Skin can query resting heart rate without knowing a watch exists,
because both speak the metric vocabulary. A device stream that invented its own
names would be a second database with extra steps.

## 2. Partitioning had to land before the importer, and it nearly did not

The schema comment on `sample` had deferred partitioning since week one, with a
reason attached: *converting an empty table is free — whereas partitioning a
populated one is not.* Wearable ingestion is the moment "empty" stops being
true, so migration `0015_sample_partitioning` shipped in its own commit
immediately before this feature, per §13.2's rule that migrations never bundle
with the features that use them.

Three properties of that migration are worth knowing:

**It refuses to run against a populated table.** Recreating the table is the
only way to partition it. A migration that silently dropped a year of
heart-rate data because it was re-run in the wrong order would be the worst
possible failure in a system whose first principle is that the record is
permanent. It counts the rows and raises with the count.

**It is a no-op once applied.** A migration that cannot be applied twice is a
migration that blocks a restore drill.

**There is a `DEFAULT` partition, on purpose.** Without one, an import carrying
a single 1970-epoch artefact — a real thing in wearable exports — fails the
entire batch. §8.9 requires missing data be shown as missing; the counterpart is
that malformed data should be *findable* rather than refused at the door. The
devices page reports the DEFAULT row count when it is not zero.

### The RLS gap this exposed

`rls.test.ts` filtered on `relkind = 'r'`. A partitioned *parent* is `p`, so the
moment `sample` became partitioned the parent went invisible to every assertion
in that file — the suite would have passed with RLS off on what will become the
largest table in the schema. Partitions themselves are `r` and were always
covered, but the parent is where a policy would be declared and where `FORCE`
has to be set.

That is the failure the file's own header warns about, one level up: the
migration cannot cover a table added later, and the test could not cover a
*kind* of table nobody had thought of.

## 3. The deduplication key is the natural key

Postgres requires the partition key in every unique constraint, so
`sample`'s primary key is `(id, observed_at)` — and it guarantees nothing
useful, because a re-import mints fresh ids.

The index that matters is `sample_source_metric_observed_unique` on
`(source_id, metric_key, observed_at)`. **One device cannot have produced two
readings of one metric at one instant**, which makes that the real key and makes
a re-import a no-op rather than a doubling.

This is not a nicety. §2.3 makes ingestion "pull-based, batch", which means the
operator *will* hand the importer a file that overlaps the last one, and they
should not have to know that. A doubled month of heart rate does not announce
itself — it just halves every average from then on.

`ON CONFLICT DO NOTHING`, not `DO UPDATE`. A device re-reporting an instant with
a different number has changed its mind about the past, and §9.1's append-only
principle says the first record stands.

### Deduplication happens twice

Once in `normaliseBatch`, within the batch, and once in Postgres. The database
one is the guarantee. The in-batch one exists because a single insert cannot
resolve a conflict against a row in *the same statement* — Postgres raises
`ON CONFLICT DO UPDATE command cannot affect row a second time` — and an export
that overlaps its own boundaries routinely carries one instant twice.

## 4. Three outcomes per row, and the difference between them is the design

`normaliseBatch` classifies every row into one of three buckets, and the screen
reports all three separately.

| Outcome | Cause | What happens |
|---|---|---|
| **Accepted** | Mapped, converted, in range | Becomes a `sample` |
| **Skipped** | No metric registered for this identifier | Counted and named, never fatal |
| **Rejected** | Mapped, but the number cannot be trusted | Counted, named, **not stored** |

The asymmetry between the second and third rows is the whole point.

An Apple Health export carries well over a hundred quantity types, most of which
this system has no metric for and no intention of adding one. If an unknown
identifier failed the batch, the first real export would fail and the operator's
only recourse would be to hand-edit XML. So unknowns are skipped — and *named*,
so the list doubles as a shopping list for the next metric worth registering.

A **known** identifier arriving in an unexpected unit is a different thing
entirely. Silently storing pounds in a column that means kilograms is the single
worst thing an importer can do, and §5.3's canonical-unit rule exists precisely
so a five-year trend cannot be poisoned that way. Unknown unit, unparseable
instant, or a value outside the metric's registered bounds — all refused.

A timestamp without a UTC offset is refused rather than assumed to be local.
§5.3: *"A workout at '7am' during travel is a materially different fact from one
at 7am at home."* A wearable export is the artefact most likely to cross
timezones, and a guess would misplace every reading from a flight with nothing
afterwards able to tell that it had.

**A skip is not an error, and neither is a duplicate.** Re-importing an
overlapping export is the normal case. Collapsing the three counts into one
failure number would train the operator to stop re-importing, which is how a
month goes missing.

## 5. Blood oxygen maps onto the vital, and nothing else does

Every stream metric is new — `body.heart_rate`, `body.steps`,
`body.energy.active` and six others — except one. A watch's blood-oxygen reading
and a fingertip pulse oximeter's are the same measurement by the same method,
differing in reliability rather than in meaning, so
`HKQuantityTypeIdentifierOxygenSaturation` maps onto the existing
`body.vitals.spo2`. Splitting them would give the operator two SpO2 charts and
no honest way to say which one is their oxygen saturation.

The opposite decision was made for heart rate, and for the same kind of reason.
`body.vitals.heart_rate_resting` is a single number a person took deliberately;
`body.heart_rate` is several hundred readings a day, none of them chosen.
Collapsing them would make "my resting heart rate" mean two different things
depending on which row answered.

## 6. Retention: ninety days, then hourly, then gone

§9.7 requires "full resolution for 90 days, then downsampled to hourly
aggregates and the raw rows dropped".

Dropping raw rows is irreversible, which sits uneasily beside P2's permanent
record. §9.7 makes the trade explicitly — device data's value beyond 90 days "is
entirely in its aggregates anyway" — and the honest reading is that a heart-rate
reading from a Tuesday afternoon three years ago carries no information its
hourly mean does not. Two things keep that from becoming a quiet lie: the
aggregate row is flagged `is_downsampled` so nothing renders it as a reading,
and the devices page shows the aggregate count beside the row count. §8.9's
"missing data is shown as missing" has a quieter counterpart — **coarsened data
must be shown as coarsened.**

### Which aggregate, and the three that have none

The aggregation comes from the metric registry, and getting it wrong is
invisible until the raw rows are gone. Averaging step count under-reports a day
sixtyfold; summing heart rate is not a quantity anybody has ever wanted.

Three domain aggregations have no honest hourly form:

- `median` — no cheap `GROUP BY` form over tens of millions of rows.
- `last` — would keep one arbitrary reading per hour and throw the rest away.
  That is sampling, not aggregation, and it would make a chart look like full
  resolution while being a sixtieth of it.
- `count` — of a stream, counts how often the *device chose to report*, which is
  a property of the firmware rather than of the body.

A metric mapping to one of those keeps its raw rows past ninety days, and the
nightly step names it in the run log. That is the safe direction: the table
grows, and growth is visible, whereas a wrong collapse is not. `downsample.test.ts`
asserts that no currently-registered wearable metric falls into this case.

### The collapse is three ordered statements, not one clever one

The tempting version is a single data-modifying CTE that `DELETE ... RETURNING`s
the raw rows, groups them, and inserts the aggregates. **It is wrong in a way
that only shows up on the hour boundary.**

Every statement in a `WITH` sees one snapshot, and `ON CONFLICT` checks
uniqueness against a dirty snapshot in which a row deleted by *this same
command* is still present. An aggregate landing on an hour that already had a
raw reading at `HH:00:00` would conflict with the row being deleted beside it,
do nothing, and leave that hour with neither the readings nor their mean.

Aggregate, delete, insert — three statements in one transaction — avoids it
entirely: by the time the insert runs, the delete is visible to it. A crash
between them rolls back to full resolution, which is the right direction, since
re-running from raw rows is free and re-deriving from deleted ones is
impossible. `sample.repository.test.ts` has a test for exactly the boundary
case.

The `GROUP BY` runs in Postgres; only the aggregates come back to Node, at most
24 per metric per day.

## 7. Two nightly steps, in that order

§5.2 permits exactly one scheduled entry point, so both are steps in the nightly
run rather than crons of their own.

**`maintain-partitions`** calls `ensure_sample_partition` for this month and the
next two. Two months of lookahead rather than one, because C3 says the system
"must survive three-week gaps in attention" and the failure mode of a missed
month is an import silently landing in DEFAULT. It also reports the DEFAULT row
count, because an unread signal is not a signal.

**`downsample-samples`** runs after it, and the order is not arbitrary: both
touch the same table, and creating a partition takes a brief `ACCESS EXCLUSIVE`
lock on the parent. Doing that first means the lock is taken against a quiet
table rather than queued behind a collapse deleting a month of rows.

Neither halts the run. A missed partition means an import lands in DEFAULT —
stored, findable, slightly slower. A missed collapse means the table stays at
full resolution for another day. Both recover by running again tomorrow.

The cutoff is truncated to the hour, and that is load-bearing rather than tidy:
a run at 03:00 and a re-run at 03:47 collapse exactly the same set. A cutoff
carrying minutes would split one hour across two runs, and the second would
overwrite a complete aggregate with a partial one. §5.2's "idempotent, safe to
re-run" is a property of that arithmetic.

## 8. The wire, and what it deliberately does not accept

`POST /api/samples` takes a bounded batch of rows in the *platform's* own
vocabulary — `identifier`, `value`, `unit` — capped at 10,000 per request.

**It does not accept an `export.xml`.** A file from a phone worn for years is
routinely hundreds of megabytes; accepting it whole would mean the operator
presses a button and waits, with no partial progress, no way to retry the half
that failed, and one timeout between them and the import. The splitting happens
in the browser where the file already is, and a failed chunk is re-sent — free,
because the natural key makes it a no-op.

Chunks go sequentially. Six concurrent ones would be faster and would also have
six inserts competing for the same unique index on overlapping instants; at n=1,
on a file exported a handful of times a year, that is not a trade worth making.

**It does not accept a metric key.** §9.2 makes the registry the single
vocabulary; a client that could write `body.weight` directly could write a heart
rate into it, and the row would be indistinguishable from a real one forever.
The mapping table is the only thing allowed to decide that a heart rate is a
heart rate.

**It does not accept a `source_id`.** Provenance is resolved server-side from
the platform and the importer version. A client choosing its own could
attribute a stream to the wrong device or — worse — a different source on every
chunk, which would defeat the deduplication key and turn a re-import into a
doubling.

**It does not accept a URL or a file path.** Same reason the bank CSV import
does not: it would turn one endpoint into a proxy for arbitrary outbound
requests, aimed by whoever holds a session.

Ids are minted server-side here, unlike every capture path in this system. §5.7
wants a client-minted UUIDv7 so a record has its identity offline, but a sample
has no offline identity to preserve — the device already recorded it, the phone
is replaying it, and the row's real identity is `(source, metric, instant)`.

Permission is `observation:write`. A sample is a reading; it does not change how
any other reading is interpreted, the way a metric definition or a nutrition
target would. §5.4 splits permissions by blast radius, and this sits on the
narrow side despite being the largest table in the system.

## 9. What the page shows, and what it refuses to

`/body/devices` shows coverage: which metrics arrived, how many readings each
has, over what span, and how many of those are hourly aggregates.

**There is no chart.** Charts over device metrics read the nightly rollups
(§5.6) like every other chart in this system. A page computing its own mean over
`sample` would be a second definition of what a daily average means, and it
would drift the first time the rollup definition changed.

The import lives on this page rather than on `/settings/integrations`, which
argues the principle for the other two imports: *an import that runs somewhere
other than where its results appear gives the operator nothing to check the
result against.* A device import needs that more than the others, not less —
nobody can eyeball four hundred thousand heart-rate readings, so the coverage
table *is* the check, and it has to be beside the button.

## 10. What is not built

**No HealthKit connection, and there will not be one.** HealthKit is native-only
with no web API. The Health app's own export is the only route, and it is XML
that must be converted to JSON before it reaches this system. That conversion is
a client-side step this repository does not ship.

**No Google Fit API connection.** Same posture as the bank: an OAuth token held
by this system against a third party's health data is exactly the egress P7
exists to refuse. The Google mappings exist for an exported file.

**No live sync, ever.** §2.3 is explicit: "never a live stream." A background
sync would be a second scheduler (§5.2), a second source of write pressure, and
a standing outbound connection — three liabilities in exchange for freshness
nobody needs from a metric they look at weekly.
