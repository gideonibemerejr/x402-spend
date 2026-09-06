# Post-launch roadmap

Updated September 6, 2026. Code baseline: `main` at `7ac8739` (merged PR #2). The six corrective fixes and minimal CI are implemented on `feat/changesets-release` for review; nothing has been merged or published from this work.

## Ship the fixes, then dogfood

The review package is one focused PR: the five reproduced bugs below plus denomination-safe reporting, with regression tests written before the fixes and build-and-test CI on Node 22 and 24. After review, collect real receipts before investing in more release automation, protocol coverage, or cleanup.

The target remains dogfooded testnet numbers before **September 15**. CI and release infrastructure must not become a separate milestone that pushes that work back.

## Current state

- The public API is `Spend`, `SpendStore`, `SpendReceipt`, `SpendFetchInit`, and `SqliteSpendStore`. The factory remains `createMeter`; its implementation is `src/meter.ts`. PR #2 removed the old names without aliases and expanded API documentation.
- The baseline had 12 tests. The corrective branch has **26 passing tests**, verified on Node **24.20.0** and **22.23.2**, including the original concurrency acceptance test and new storage-error, request-override, amount, date, denomination, and CLI regressions.
- The package dry run after a build included compiled code and declarations and excluded tests. No CI workflow was tracked at the reviewed baseline.
- The repository's `HANDOFF.md` describes the original build. The local `~/code/ventures/HANDOFF-CODEX.md` supplied subsequent context, but its pending-rename and unpublished status are now historical.
- No live payments, testnet dogfood, or npm publishing occurred during this review.

Keep the product buyer-side and observational. The caller's x402 client owns payment policy, signers, and recovery. Retain SQLite, no new runtime dependencies, per-call `AsyncLocalStorage`, and the same-URL concurrency test. Preserve receipt field names; any later session schema bump must include a compatibility design and handoff update.

## 1. One corrective PR

**Implemented for review.** Regression tests reproduced the failures before the production changes. Receipt finalization was fixed first; the receipt schema remains version 1.

| Reproduced issue | Change | Acceptance |
| --- | --- | --- |
| Failed `store.insert` after a successful paid response causes `finalize` to run again | Separate request completion from persistence; finalize once | Exactly one insert attempt per recordable call, including storage failure; no automatic payment retry |
| A GET `Request` overridden with POST in `init` is recorded as GET | Derive the recorded method from the effective request | Receipt method matches transport; request body survives |
| `label()` without a note writes JSON null against an optional-string type | Clear the JSON note key when no note is supplied | Set, clear, and roundtrip a note without returning null |
| Malformed `amountSettled` throws in `BigInt` and kills the report | Validate monetary strings at the report boundary | Valid rows remain reportable; invalid monetary data is visibly counted, never silently priced as zero |
| Overflowing `parseSince` duration returns an invalid Date | Validate the calculated timestamp | Oversized durations produce a useful error; normal durations still work |
| Different assets/networks are added into one monetary total | Group endpoint amounts and totals by `asset` + `network` | No combined monetary total or raw-amount ranking across denominations |

For finalization, x402-spend owns the single write attempt and preservation of request/payment and storage errors. Retain the receipt on a persistence error so the caller can inspect it, and distinguish storage failure after a response from request failure. Preserve `last()` updating only after confirmed persistence. The caller decides how to respond; duplicate-safe storage retries are a separate contract, not part of this fix.

For denominations, resolve decimals per asset/network using explicit metadata or configuration rather than one global scaling assumption. If decimals are unknown, display clearly labeled atomic units rather than guessing. Keep this bounded; no currency conversion or external pricing service is needed. `Report` and `EndpointStats` are public types, so account for compatibility when choosing their new shape.

**Report compatibility:** `Report.totals` now contains counts only; monetary totals are in `Report.denominations`. Formatting defaults to atomic units; use per-asset `assetDecimals` / `--asset-decimals`, or `--decimals` for a single denomination. The README includes migration guidance.

**Release version:** the proposed corrective release is `0.1.1`, subject to checking the published API. Current main already removes the Meter-named exports; if the published `0.1.0` exposes them, releasing that main requires a minor version under the proposed pre-1.0 policy, or a compatible patch branch. A breaking report type change also affects that choice. Decide the version from the actual release diff; do not turn this into another tooling project.

## 2. Minimal CI

**Implemented:** one `ci.yml` checks out the repository, sets up a **22 / 24** matrix, runs `npm ci`, then `npm test` (which builds). It runs on pushes and PRs and has no publishing job.

Defer the rest of the former release-workflow section until there is a second contributor or second consumer: automated release PR/publish orchestration, tarball consumer test infrastructure, OIDC setup, prerelease channels, and publish retry/deprecation runbooks. None is a dogfood prerequisite.

Gideon is handling Changesets installation and configuration. That work remains his; it does not expand the critical path or authorize agent installation/configuration.

## 3. Dogfood before more housekeeping

Use two real testnet endpoints and roughly 20 labeled calls each, then run a one-day report. Replace the README's fake-server sample with actual output identifying the network, denomination, date, and sample size. Reconcile the report against observed settlements and judge whether its labels explain usefulness.

Gideon supplies the funded signer and endpoints. Do not generate or manage keys. Keep credentials and receipt databases out of commits. Confirm live endpoint/SDK details when performing the run.

Start preparation alongside the corrective PR. Further edge-case investigations, cleanup, and product additions wait for real receipts unless an observed defect invalidates this run.

## Cost metric decision

**Recommendation: exclude unsettled receipts from cost statistics and count unsettled `used` receipts separately.** The JSDoc currently describes them as zero-cost samples, but documenting that behavior does not make the resulting median a useful price measure. Update documentation and tests together when changing it.

This remains an explicit product decision for Gideon, separate from the agreed six-issue corrective PR. Keep it visible when reviewing the dogfood report rather than silently presenting an unsettled call as a cheap paid result. Confirmed session access needs its own treatment; it is not a failed settlement.

## After real receipts

Preserve these ideas, then prioritize them using the dogfood evidence:

- **Session access:** record confirmed `SIGN-IN-WITH-X` access with `amountSettled: "0"` and a `viaSession` flag. Plan a schema bump, session detection, and attribution of the opening payment before claiming an amortized session cost. Do not classify every free response as a session receipt.
- **Receipt IDs per call:** add `Spend.call()` returning `{ response, receiptId }`, with defined free-call and error behavior; retain `Spend.fetch()` as drop-in fetch. `last()` can race under concurrency and remains stale after a free call.
- **Transport and protocol coverage:** recovery, session negotiation, verification/settlement failures, aborts, malformed 402 headers, and v1 diagnostics. Trace real SDK paths and add tests before declaring new bugs. Keep payment decisions with the caller's client.
- **CLI and storage:** concise CLI errors, input bounds, actual contention behavior, and read-only reporting if observed usage warrants it.
- **Focused cleanup:** share paid-leg latency and wire-field helpers, consolidate test fixtures, review unused development dependencies, and make contributor guidance current. Benchmark before optimizing statements, indexes, or aggregation.
- **Report usefulness:** task/outcome filters, label coverage, discarded spend, cost per used result, export formats, and deliberate query-string grouping/redaction.

**README clarification completed:** bytes come only from `Content-Length`. Responses without that header, including typical chunked responses, have no recorded byte count. Bodies are not consumed for measurement.

Bazaar discovery, a public price-comparison page, a work-unit extension, and opt-in aggregation remain later proposals. Real receipts should guide which of them is worth building.
