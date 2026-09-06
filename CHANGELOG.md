# Changelog

## 0.2.0

Reports are now denomination-safe: receipts are grouped by network and asset instead of summed across
currencies, `Report.totals.spendAtomic` is removed in favour of per-denomination totals, `formatReport`
rejects a single `--decimals` when the report spans several denominations, malformed settled amounts are
excluded and counted rather than throwing, unsettled `used` calls no longer enter the median cost as zero,
receipt persistence failures throw `SpendPersistenceError` with the receipt and response attached, and
`label` without a note clears a previously stored one. Breaking changes take a minor bump before 1.0.
