# Changelog

## 0.3.1

`createSpend` builds one `Request` per call, and constructing it dropped every init field the fetch
spec does not define — including Next.js's `next: { revalidate, tags }`, so a meter used inside a
route handler silently lost its caching and revalidation behaviour. Non-standard init fields are now
forwarded to the transport on every leg. Only non-standard keys travel, so a caller's headers or body
can never be replayed over the ones the payment wrapper set, and `taskClass` stays this package's own
rather than leaking into fetch init. ([#4](https://github.com/gideonibemerejr/x402-spend/issues/4))

0.3.0 was tagged but never published; 0.3.1 is the first release carrying the review support below.

## 0.3.0

`createMeter` is now `createSpend` and `meter.ts` is `spend.ts`, with no alias: the value it returns
has always been a `Spend`, and the two names disagreeing was a papercut worth spending a version on.
The third argument is now an options object, `{ fetchImpl, review }`; passing a bare `fetch`
positionally still works this release and is removed in 0.4.

Labeled receipts can be published as reviews that a server verifies against the settlement
transaction, which is the point of the release: the transaction hash is the proof of purchase.
Publishing is opt-in per `createSpend` call, because a review is public and names the payer address.
`label()` now returns `{ posted, status, error? }` and posts one review when configured. The local
label is written first and always, so a review server that is down, slow, or unhappy is reported
rather than thrown and never costs the caller their label. Receipts with no settlement are never
published, and `unlabeled` is not a publishable verdict. Query strings and fragments are stripped
from the resource URL before it leaves the machine, because API keys live in them.

`SpendStore` gains `get(id)`, which `SqliteSpendStore` implements. Custom stores must add it.

Breaking changes take a minor bump before 1.0.

## 0.2.0

Reports are now denomination-safe: receipts are grouped by network and asset instead of summed across
currencies, `Report.totals.spendAtomic` is removed in favour of per-denomination totals, `formatReport`
rejects a single `--decimals` when the report spans several denominations, malformed settled amounts are
excluded and counted rather than throwing, unsettled `used` calls no longer enter the median cost as zero,
receipt persistence failures throw `SpendPersistenceError` with the receipt and response attached, and
`label` without a note clears a previously stored one. Breaking changes take a minor bump before 1.0.
