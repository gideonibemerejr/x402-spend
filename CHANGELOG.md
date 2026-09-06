# Changelog

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
