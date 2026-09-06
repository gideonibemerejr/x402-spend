# Post-launch roadmap

Drafted September 6, 2026 against `main` at `e94fbdd`. This is a proposed work sequence, not approval of every product or API change below.

## Context and incoming work

The README defines the product: a local, buyer-side statement of x402 spend with caller-owned outcome labels. Improve the accuracy and usefulness of that statement first.

Sources reviewed: `README.md`, the repository's `HANDOFF.md`, and Gideon's local `~/code/ventures/HANDOFF-CODEX.md`. The repository handoff describes the original build; its instruction to replace a URL-keyed meter is historical. Current code already uses `AsyncLocalStorage`. The local handoff also has an older “not published” status; Gideon reports that the package is now published.

**Already in flight:** `feature/spend-era-api` in Gideon's local checkout has a staged rename across ten files. It changes the public names to `Spend`, `SpendStore`, `SpendReceipt`, `SpendFetchInit`, and `SqliteSpendStore`, while retaining `createMeter` and `src/meter.ts`. No compatibility aliases, per the recorded decision. Leave that change for Gideon to author; do not reproduce it here. After it reaches `main`, update this roadmap branch before implementation. The names below describe that incoming API.

**Constraints carried forward:**

- Buyer side only; the meter observes and does not choose, abort, recover, or filter payments.
- The caller's x402 client owns schemes, signers, and spend controls.
- Keep `node:sqlite`, no native dependencies, and no new runtime dependencies.
- Preserve per-call `AsyncLocalStorage` and the existing same-URL concurrency acceptance test.
- Receipt field names are fixed. Any proposed schema change needs an explicit design and corresponding handoff update.
- Keep task classes as caller-supplied free text.

## Baseline

- `npm ci --ignore-scripts --no-audit --no-fund` completed.
- `npm test`: **12/12 passing** on Node **24.20.0**; includes the TypeScript build.
- `npm pack --dry-run --json` after the build: 15 package files, with compiled JavaScript and declarations; test files excluded.
- No CI workflow is tracked. Passing locally does not establish the advertised minimum Node or peer-SDK compatibility.
- Focused, chain-free probes reproduced the six issues marked **reproduced** below. These were audit probes, not committed regression tests or production fixes.
- No live payment, testnet dogfood run, or npm release was performed for this review.

## Work sequence

Each row is a small proposed PR. Start with regression tests for behavior changes; keep mechanical cleanup separate so reviews stay focused. S = a focused change; M = several related paths or a compatibility decision. These are scope estimates, not calendar promises.

| Order | Work | Why it matters | Size / dependency |
| --- | --- | --- | --- |
| 0 | Land the existing Spend API rename | Establish the API subsequent work should target | In flight; Gideon authors |
| 1 | Finalize receipts once and preserve error context | Avoid duplicate writes and obscured payment errors | S; after rename |
| 2 | Correct report amounts and asset boundaries | Make spend totals trustworthy | M; report API decision |
| 3 | Verify transport and protocol edge cases | Ensure receipts describe what actually happened | M; split by path |
| 4 | Harden CLI, SQLite roundtrips, and package checks | Make the installed tool dependable | S–M; can be separate PRs |
| 5 | Dogfood two real testnet endpoints | Validate usefulness before broader product work | Caller-funded signer; target before Sept 15 |
| 6 | Consolidate internals and contributor documentation | Reduce duplication after semantics are tested | S; after behavior fixes |
| 7 | Improve labeling and report workflows | Help callers answer “was it worth it?” | M; proposed API/product decisions |

Dogfood is the handoff's deadline item. It does not need to wait for every cleanup PR. Start its preparation alongside the early fixes; use a controlled single-asset dataset and land any defect that would invalidate its receipts or report before presenting the results.

## 1. Receipt finalization and error handling

**Reproduced — `src/meter.ts`, `fetch` and `finalize`:** a successful paid response followed by a rejected `store.insert` enters the catch block and calls `finalize` again. The audit store saw two insert attempts for one call. The source also shows that an insert failure while recording a failed fetch can replace the original fetch error.

Proposed work:

- Separate transport completion from persistence and attempt finalization exactly once per outer call.
- Define storage-error behavior explicitly. Preserve the original payment/transport error and storage failure together when both occur. Do not silently swallow persistence failures or change the caller's payment policy.
- Update `last()` only after a confirmed insert.

Acceptance: one insert attempt on success or failure; a rejecting store never causes a second finalization; both causes remain inspectable when transport and persistence fail; concurrent calls retain distinct receipts.

## 2. Report correctness

**Reproduced — `src/report.ts`, `buildReport`:** two settled receipts for the same URL but different assets/networks produce one endpoint row and one combined monetary total. Raw atomic units across different assets are not a meaningful shared currency. `--decimals` changes formatting only.

**Reproduced — `settledAmount`:** a receipt with `amountSettled: "$0.10"` throws in `BigInt` and prevents the entire report from rendering.

Proposed work:

- Group monetary results by network and asset as well as endpoint; show totals per denomination. Do not rank different assets by raw atomic amount or imply a currency conversion.
- Until a multi-asset report API is settled, an explicit mixed-denomination error is a possible smaller first fix.
- Validate atomic amount strings at the reporting boundary. Keep valid rows reportable and visibly count/explain invalid monetary data; never silently convert malformed amounts into zero spend.
- Resolve the documented metric contract: `medianCostPerUsedAtomic` says “settled cost,” but currently includes an unsettled receipt labeled `used` as zero. Decide whether that sample should be excluded, and test the denominator.
- Document `buildReport(receipts, since)` semantics: today `since` labels the report; filtering happens in `store.list`. Either make that contract explicit or enforce the window in aggregation.

Acceptance: distinct denominations cannot produce an unlabeled combined spend total; malformed data is visible without losing valid results; actual settled amounts still take precedence over authorized amounts; all-unlabeled, empty, unsettled-used, and very large atomic amounts are covered.

Compatibility: `Report` and `EndpointStats` are public exports. Review their shape before changing them. This does not require renaming receipt fields.

## 3. Fetch semantics and SDK paths

**Reproduced — `src/meter.ts`:** passing a GET `Request` with `{ method: "POST", body: "hello" }` records `method: "GET"`. The installed SDK constructs `new Request(input, init)`, so the actual transport request uses POST. Derive observed metadata from the effective request without consuming its body.

Carry forward these **investigation candidates** from the local handoff. Trace the installed SDK and add tests before declaring fixes necessary:

- POST body and headers survive the initial, paid, and recovery legs; Request/init overrides agree with receipt metadata.
- Paid-leg verify failure, settlement failure, payload failure, rejected fetch, and abort signals produce accurate status and failure stages.
- Recovery yields `[initial, paid, recovery]` and the final settlement. Include recovery followed by transport failure so stale settlement state cannot misdescribe the last attempt.
- Session headers create a session leg; an unpaid session resolution creates no paid receipt. First establish how the public factory can accept/configure the SDK HTTP client that owns these hooks; do not test an unreachable setup.
- Missing, garbled, or structurally invalid 402 headers have deliberate behavior and preserve the SDK's error. Header decoding is not structural validation.
- **SDK source verified, end-to-end not yet tested:** v1 settlement processing returns before response hooks. Document v2 support and design an explicit unsupported-version diagnostic or correct observation of v1. Do not introduce payment refusal casually: the handoff's “record-or-refuse” candidate must be reconciled with the observer-only rule.
- Refused offers currently select the smallest raw atomic amount, even across different assets, and store it as `amountAuthorized`. Preserve the existing acceptance test until a decision is made; document that this is a representative offer, not actual authorization or a cross-currency price comparison.

Acceptance: each supported path has a deterministic chain-free regression test; no observation consumes the response body; receipt metadata matches actual requests; the meter itself never initiates recovery or overrides spend controls.

## 4. CLI, storage, and release checks

**Reproduced — `src/store.ts`, `label`:** labeling without a note writes JSON null, so `list()` returns `outcomeNote: null` despite the declared optional-string type. Remove the JSON key when no note is supplied, or otherwise align runtime data with the existing schema contract. Test setting and clearing a note.

**Reproduced — `src/report.ts`, `parseSince`:** an overflowing duration returns an invalid Date rather than a useful validation error.

**Source observations and proposed work:**

- CLI parsing and date failures escape `main` as stack traces. Return concise errors and nonzero exit codes; validate extra positional arguments and bound decimals/date inputs. Add subprocess tests for help, missing DB, invalid input, and a valid report.
- Reporting opens the writable store, sets WAL, and runs schema DDL. Explore a read-only report path and test actual writer/reader contention before selecting busy-timeout behavior.
- Add runtime validation where JavaScript callers or decoded wire data can bypass TypeScript, especially outcomes and monetary strings. Keep the scope small and dependency-free.
- Add CI for build/tests plus the supported Node range. Verify the advertised Node >=22.5 requirement against SQLite startup behavior and adjust support documentation if needed.
- Peer dependencies currently accept every version >=2.0.0, while the handoff verified 2.25.0. Test a defensible compatibility range and constrain unsupported majors if appropriate.
- Add a clean build before packaging and a tarball consumer smoke test: import the public API and run CLI help outside the checkout. The successful dry run above only proves packaging after a manual build.
- Once the incoming rename lands, add release notes and migration examples for the removed Meter names. Respect the no-alias decision; choose the next version explicitly because consumers already exist.

Acceptance: clear CLI errors, schema-consistent roundtrips, automated checks on clean checkouts, and an installable tarball with working exports/bin and documented runtime support.

## 5. Testnet dogfood

Carry forward the local handoff's target: two real endpoints, approximately 20 labeled calls each, Base Sepolia/testnet USDC, then a one-day report with actual output replacing the fake-server sample in the README.

Preparation can proceed without credentials: build an opt-in example harness, document required environment variables, make database/output locations explicit, and define what counts as used/discarded/retried/failed. Keep any harness dependencies development-only and out of the runtime package.

Gideon supplies the funded signer and endpoint choices. Do not generate or manage keys. Verify live SDK and endpoint details when executing; the handoff's examples are inputs to that check, not proof of current availability.

Acceptance: real receipts reconcile with observed settlements; labels reflect delivered usefulness; report denomination is explicit; the README sample identifies its network, date, and sample size. No secrets or private receipt database are committed.

## 6. Focused code cleanup

Perform these once regression tests establish the intended behavior:

- Extract duplicated final paid/recovery latency selection from `store.ts` and `report.ts` into one internal receipt helper.
- Extract the repeated resource/requirements-to-wire mapping in the meter, while keeping refusal selection distinct from accepted requirements.
- Consolidate receipt fixtures and fake-server helpers across tests, retaining the concurrency test's distinctive per-call assertions.
- Consider preparing SQLite statements once per store; benchmark before broader storage or aggregation optimization.
- Remove the apparently unused development dependency on `@x402/extensions` if no imminent test or dogfood work needs it.
- Add a minimal formatting/type-check workflow using development tooling only.
- Mark the original repository handoff as historical and document the current architecture, one-meter-per-client hook lifecycle, store closing, v2 support, and release steps. Keep implementation guidance in a canonical contributor document.

No framework migration, directory expansion, or wholesale meter rewrite is warranted by the current package size.

## 7. Proposed product improvements after dogfood

These are proposals, not accepted scope:

1. **Per-call receipt association.** `last()` means last recorded call to finish, and remains unchanged after a free call. The README pattern can label the wrong receipt when calls overlap or a free call follows a paid one. Design an additive API that associates a receipt ID with a particular call while preserving drop-in fetch behavior. Document the limitation immediately.
2. **Useful report slices.** Network, asset, task class, outcome, and JSON/CSV export; define serialization of BigInt as atomic strings.
3. **Better value metrics.** Label coverage, discarded spend, and total spend per used result alongside the existing median. Define denominators explicitly; a median of used calls does not include the cost of discarded work.
4. **Endpoint grouping and privacy controls.** Full query strings currently split rows and may contain sensitive data. Make grouping/redaction deliberate and configurable; preserve exact grouping by default until the policy is agreed.
5. **Scale only when measured.** Profile larger datasets before adding pagination, specialized SQL aggregation, migrations, retention, or new indexes.

Bazaar discovery, a public price-comparison page, and a work-unit extension remain the handoff's later proposals. They depend on trustworthy, useful local data and an explicit opt-in sharing design.

## Recommended first implementation

After the rename lands, start with **one-time receipt finalization and error preservation**. It is small, has a reproduced failure, affects every paid call when storage fails, and can be fixed without changing the receipt schema. Follow with denomination-safe reporting, then the focused transport regressions and dogfood run.
