# x402-spend — handoff to Codex

**What this is.** A drop-in wrapper for the x402 v2 client that records every paid HTTP call
(price, recipient, chain, settlement, latency per leg, status) plus a caller-supplied outcome
label (used / retried / discarded / failed). A bank statement for an agent's spend, with the
one column no bank can fill in: was it worth it. Buyer side only. Nothing here is seller-side.

**State.** v0.1 is built and green: meter, sqlite store, labeling, report CLI, README. 12 tests
pass (`npm test`). Not published to npm. The remaining work is below, in order. The package was
renamed from `x402-meter` to `x402-spend`; internal identifiers still say "meter" on purpose
(see step 1).

**Owner:** Gideon (gideon.ibemere.jr@gmail.com). Decisions below are his; proposals are marked.
Do not promote proposals to decisions by repetition.

**Deadline:** dogfooded numbers on testnet before **Sept 15** (Cloudflare default-block date).
Step 3 is the only thing that date needs.

---

## Rules that bind

- `src/receipt.ts` is FINAL. Do not rename fields without updating this document.
- Buyer side only. No seller-side code.
- Store is `node:sqlite`. No native deps, no new runtime deps at all.
- The meter observes; it never aborts, recovers, or filters payments. Spend policy lives in
  the caller's `x402Client`.
- Per-call state rides an `AsyncLocalStorage` context created in `meter.fetch`. Never
  correlate by URL — that was the original sin this rewrite fixed (two concurrent calls to
  the same URL collided). The acceptance tests in `src/meter.test.ts` guard this; keep them.

## What each file is

- `src/receipt.ts` — schema, FINAL. wire / observed / outcome sections, `Leg[]` per call.
- `src/meter.ts` — `createMeter(client, store, fetchImpl?)` → `{ fetch, label, last }`.
  Instrumented fetch inside `wrapFetchWithPayment`; hooks attach wire/settle fields to the
  ALS context; receipts finalize when the outer call returns or throws. Includes the
  spend-control-refusal path (`wireFromRefusal`): a 402 the client refuses still produces a
  receipt priced at the cheapest `accepts[]` entry, `failure.stage: "payload"`.
- `src/store.ts` — `SqliteMeterStore`. One table, full receipt as JSON, indexed columns for
  `resource_url`, `network`, `ts`, `outcome`, `task_class` plus report scalars. WAL mode.
- `src/report.ts` — pure aggregation (BigInt atomic sums, median cost per `used`, p50/p95
  paid-leg ms) + formatting. `src/cli.ts` — `x402-spend report [--db] [--since] [--decimals]`.
- `src/*.test.ts` — 12 tests: acceptance (a) concurrency, (b) spend-control refusal, free
  calls unrecorded, full-stack smoke, store roundtrips, report math.

---

## Verified facts about the SDK (read from installed `@x402/core` 2.25.0 / `@x402/fetch` 2.25.0)

### Client hooks (`@x402/core/client`, class `x402Client`)
```
onBeforePaymentCreation((ctx: PaymentCreationContext) => Promise<void | {abort:true, reason}>)
onAfterPaymentCreation((ctx: PaymentCreatedContext) => Promise<void>)
onPaymentCreationFailure((ctx) => Promise<void | {recovered:true, payload}>)
onPaymentResponse((ctx: PaymentResponseContext) => Promise<void | {recovered:true}>)
```
Hooks see the protocol only; the instrumented fetch sees method/status/latency/bytes. Both
run inside the caller's async context, so ALS propagates into them — that is the whole design.

Hook registration is additive and permanent on the client: `createMeter` registers its two
hooks each time it is called. One meter per client. (A second meter's hooks no-op outside
their own ALS context, so it is not corrupting, just wasteful — but don't.)

### `wrapFetchWithPayment` control flow (`@x402/fetch`)
initial fetch → (402?) parse `PAYMENT-REQUIRED` header → optional hook-header "session" leg →
`createPaymentPayload` (creation hooks) → paid leg with `PAYMENT-SIGNATURE` →
`processPaymentResult` (response hooks) → optional one "recovery" paid leg. Leg classification
in the meter: payment header present → paid/recovery by order; else initial/session by order.

### Spend controls (gotcha, verified in source)
Defaults allow only assets the scheme's `findDefaultAsset` recognizes, capped at $1/payment.
Mock schemes have no `findDefaultAsset` → **every** offer is rejected inside
`selectPaymentRequirements`, BEFORE any hook fires; tests must `client.setSpendControls(false)`.
The real EVM scheme passes the asset check; the $1 cap still applies on testnet.

### v1 protocol (verified in source, NOT handled by the meter)
`processPaymentResult` returns early for `x402Version === 1` before firing `onPaymentResponse`
hooks. A settled v1 call would therefore produce a receipt with `settled: false` and no
failure. The meter is v2-only today. Decide in step 2: detect v1 and either record it
correctly from the raw `PAYMENT-RESPONSE` header or refuse loudly — silence is the one wrong
option.

### Misc verified
- Header codecs (`@x402/core/http`): `encodePaymentRequiredHeader`, `encodePaymentResponseHeader`,
  `decodePaymentSignatureHeader`, etc. are plain base64+JSON, no zod on decode. Fake servers
  only need the right shape (`PaymentRequirements.extra` is required by the type).
- `SettleResponse.amount` = actual settled (the `upto` scheme settles ≤ authorized). Meter
  records both; report sums settled.
- Node 24: `node --test <dir>` fails; the npm test script uses the `"dist/**/*.test.js"` glob.
- Fake-server pattern for chain-free tests: see `startFakeServer` in `src/meter.test.ts` —
  mock scheme stamps a per-call nonce into the payload; server keys settlement + delay off it.

---

## Remaining work, in order

### 1. Rename pass (mechanical, one commit, zero behavior change)
Internal "meter" identifiers → "spend"-era names: `src/meter.ts` → `src/spend.ts` (or keep the
file and rename exports), `createMeter`, `Meter`, `MeterStore`, `MeterReceipt`, `MeterFetchInit`,
`SqliteMeterStore`. Nothing is published, so exported names are free to change — no aliases
needed. Proposal: `createSpendMeter` is clumsy; `createMeter` reads fine even under the new
package name, so an acceptable outcome is renaming only the types (`SpendReceipt`, `SpendStore`)
and keeping `createMeter`. Gideon decides; do it in one commit either way. Update README
imports and this document.

### 2. Edge-case tests
An audit fan-out was started and killed before verdicts, so these are **candidates from
reading the source, not verified findings**. For each: write the test first, trace the actual
SDK path, then decide fix vs document. Highest value first:

- Report crashes on one bad receipt: `BigInt(amountSettled)` throws if a server sends a
  non-atomic amount (e.g. `"$0.10"`). One malformed receipt should not kill the whole report —
  guard, count, and report the skips.
- v1 flow (see verified facts above) — decide record-or-refuse, test the decision.
- Unparseable 402 (missing/garbled `PAYMENT-REQUIRED` header): wrapper throws, meter's own
  decode also fails → no wire → **no receipt**. Probably acceptable (nothing was offered);
  make it a documented, tested behavior either way.
- Paid leg returns 402 (verify failed, no recovery): wrapper *returns* that response rather
  than throwing; hooks did fire, so a receipt exists with `failure.stage: "verify"` — assert it.
- Recovery leg end-to-end: `onPaymentResponse` returning `{recovered:true}` → three legs
  `[initial, paid, recovery]`, settle fields from the second attempt (last hook write wins).
- Session leg: `x402HTTPClient.onPaymentRequired` returning headers → `session` leg kind; and
  the unpaid-resolution case (session leg returns 200) records nothing.
- POST with a body: method lands on the receipt; body survives the wrapper's clone dance
  across legs (it clones — verify with a body-echoing fake server).
- Store under contention: no busy timeout is set; a CLI read during a write burst can hit
  SQLITE_BUSY. Consider `PRAGMA busy_timeout`.
- CLI: bad `--since` currently throws a raw stack trace; catch and print the message.
- Report grouping is exact `resource.url` including query string — decide if that is the
  "endpoint" (proposal: strip query for grouping, keep full URL in the receipt).

### 3. Testnet dogfood (the Sept 15 item)
Recipe: `@x402/evm` `ExactEvmScheme` with a funded signer, Base Sepolia (`eip155:84532`),
testnet USDC from Circle's faucet, facilitator `https://x402.org/facilitator`. Real scheme →
default spend controls are fine under $1; raise `maxAmountPerPayment` via `setSpendControls`
if an endpoint prices higher. Pick two Bazaar-listed endpoints, make ~20 labeled calls each,
run `x402-spend report --since 1d`, put the real output in the README (replacing the
fake-server sample). Needs Gideon's key — do not generate or manage keys yourself.

### 4. Follow-ons (proposals, unchanged)
`x402-spend report` CLI is done; next in line: Bazaar crawler (the `bazaar` extension's
`DiscoveredHTTPResource` is the input) → public price-comps page → work-unit Extension
proposal to the x402 Foundation working group.

## Open questions (still open)

- Task class taxonomy. Free-text `taskClass` for now.
- Whether a zero-amount offer settles cleanly through the reference SDK.
- Opt-in aggregation format for the comps dataset. Not needed for v0.1.
