# x402-spend — handoff to Claude Code

**What this is.** A drop-in wrapper for the x402 v2 client that records every paid HTTP call
(price, recipient, chain, settlement, latency per leg, status) plus a caller-supplied outcome
label (used / retried / discarded / failed). A bank statement for an agent's spend, with the
one column no bank can fill in: was it worth it. Buyer side only. Nothing here is seller-side.

**Owner:** Gideon. Decisions below are his; proposals are marked. Do not promote proposals to
decisions by repetition.

---

## Decisions (Gideon)

- Build the meter first. Client-side, TypeScript, against `@x402/core` v2.
- Move fast: dogfooded numbers on testnet before Sept 15 (Cloudflare default-block date).
- README must be clear. First-class, not an afterthought.

## Proposals (Claude, not yet accepted)

- `node:sqlite` (`DatabaseSync`, built into Node ≥22.5) for the store: zero deps, no native compile step.
- Correlate legs per call with `AsyncLocalStorage` instead of a URL-keyed pending map (the
  current `meter.ts` draft uses the pending map and it is fragile: concurrent calls to the same
  URL collide).
- Follow-ons, in order: `x402-spend report` CLI → Bazaar crawler → public price-comps page →
  work-unit Extension proposal to the x402 Foundation working group.

## Open questions

- Task class taxonomy (the "unit"). Start with a free-text `taskClass` the caller supplies.
- Whether a zero-amount offer settles cleanly through the reference SDK (matters for the
  archive-server thread, not for the meter).
- Opt-in aggregation format for the comps dataset. Not needed for v0.1.

---

## Verified facts about the SDK (read from the repo + installed `@x402/core` 2.25.0)

Packages: `@x402/core` (subpaths `/client`, `/http`, `/types`, `/server`), `@x402/fetch`,
`@x402/extensions`. Repo: `github.com/x402-foundation/x402`, `typescript/packages/*`.

### Client hooks (`@x402/core/client`, class `x402Client`)
```
onBeforePaymentCreation((ctx: PaymentCreationContext) => Promise<void | {abort:true, reason}>)
onAfterPaymentCreation((ctx: PaymentCreatedContext) => Promise<void>)
onPaymentCreationFailure((ctx) => Promise<void | {recovered:true, payload}>)
onPaymentResponse((ctx: PaymentResponseContext) => Promise<void | {recovered:true}>)
```
`PaymentCreationContext = { paymentRequired: PaymentRequired; selectedRequirements: PaymentRequirements }`
`PaymentResponseContext = { paymentPayload; requirements; settleResponse?; paymentRequired?; error? }`
Discriminate the response: `settleResponse.success:true` → settled; `success:false` → settle failed;
`paymentRequired` with no `settleResponse` → verify failed; `error` → transport/parse error.

Hooks see the protocol only. They do NOT see HTTP method, real status, per-leg latency, or bytes.
Those must come from wrapping `fetch` itself (see flow below).

### Wire types (`@x402/core/types`)
```
PaymentRequirements { scheme; network /*CAIP-2, e.g. "eip155:8453"*/; asset; amount /*atomic units, string*/; payTo; maxTimeoutSeconds; extra }
PaymentRequired     { x402Version; error?; resource: ResourceInfo; accepts: PaymentRequirements[]; extensions? }
ResourceInfo        { url; description?; mimeType?; serviceName?; tags?; iconUrl? }
PaymentPayload      { x402Version; resource?; accepted: PaymentRequirements; payload; extensions? }
SettleResponse      { success; errorReason?; errorMessage?; payer?; transaction; network; amount? /*actual settled, for `upto`*/; ... }
```
There is an `upto` scheme: settled amount can be less than authorized. Record both.

### `wrapFetchWithPayment(fetch, client)` control flow (`@x402/fetch`)
1. `fetch(request)` → if status ≠ 402, return as-is (free call; meter should not record by default).
2. Parse `PAYMENT-REQUIRED` header (+ optional JSON body) → `PaymentRequired`.
3. `httpClient.handlePaymentRequired(...)` may return hook headers (e.g. wallet session); if so,
   one extra `fetch` leg; if that returns non-402, done (no payment).
4. `client.createPaymentPayload(paymentRequired)` → runs the creation hooks.
5. Retry with `PAYMENT-SIGNATURE` header → `fetch` leg #2 (the paid leg).
6. `httpClient.processPaymentResult(payload, getHeader, status)` reads `PAYMENT-RESPONSE`,
   runs `onPaymentResponse` hooks; if a hook returns `{recovered:true}` there is one more
   paid `fetch` leg with a fresh payload.

So the instrumented `fetch` you pass in sees every leg. Classify a leg by whether the request
carries `PAYMENT-SIGNATURE` (paid) and by order. Use `Content-Length` for bytes; never consume
the body.

### Spend controls (gotcha)
`x402Client` defaults to allowing only assets `findDefaultAsset` recognizes, capped at $1 per
payment (`DEFAULT_MAX_AMOUNT_PER_PAYMENT`). Mock schemes don't implement `findDefaultAsset`, so
tests must call `client.setSpendControls(false)` or every requirement is rejected. The real EVM
scheme does implement it, so testnet USDC passes the asset check; the $1 cap still applies, so
pick dogfood endpoints priced under $1 or raise `maxAmountPerPayment`.

### Helpers for an in-process smoke test (no chain needed)
`@x402/core/http` exports `encodePaymentRequiredHeader(paymentRequired)` and
`encodePaymentResponseHeader(settleResponse)`. A fake server can return 402 with the first,
then 200 with the second. Register a mock `SchemeNetworkClient` on the client:
```
{ scheme: "exact", createPaymentPayload: async (v, req) => ({ x402Version: v, payload: { fake: true } }) }
client.register("eip155:84532", mock)
```

### Extensions worth knowing (`@x402/extensions`)
- `payment-identifier`: client attaches an idempotency `id` on `PaymentPayload.extensions`
  when the server declares the extension. Use the receipt `id` here when available.
- `offer-receipt`: server-signed offer (payment fields only, no prose) in the 402 and a signed
  receipt on delivery `{ network, resourceUrl, payer, issuedAt, transaction }`. Store the raw
  signed receipt if present; it is proof of delivery, nothing more.
- `bazaar`: discovery metadata. `DiscoveredHTTPResource { resourceUrl, description, serviceName,
  tags, method, routeTemplate, discoveryInfo: { input, output: {type, format, example} } }`.
  The crawler for the comps page reads this.

### Testnet dogfood
Base Sepolia (`eip155:84532`), public facilitator `https://x402.org/facilitator`, testnet USDC
from Circle's faucet. USDC has 6 decimals; report should format atomic units with a
configurable `decimals` (default 6) and say so.

---

## Files in this handoff

- `src/receipt.ts` — schema, FINAL. Three sections (wire / observed / outcome), `Leg[]` per call.
  Do not change field names without updating this document.
- `src/meter.ts` — REFERENCE ONLY. Do not extend it. Its only value is showing which receipt
  fields come from which hook context. Its structure is wrong: it matches a payment's start
  and finish by resource URL in a pending map, so two concurrent calls to the same endpoint
  overwrite each other and produce a receipt with the wrong timing and settlement. It also
  fakes method, status, and latency because the hooks cannot see them. Delete it and write
  the real `meter.ts` from the fetch-wrapper flow above with a per-call context
  (`AsyncLocalStorage`). Keep only the hook → field mapping.
- `package.json`, `tsconfig.json` — ESM, NodeNext, `bin: x402-spend`, peer deps on `@x402/*`.

## Build order

1. Rewrite `src/meter.ts` from scratch: instrumented `fetch` + `AsyncLocalStorage` per-call
   context; the instrumented fetch records each leg (kind, status, ms, bytes) on the context;
   the four hooks attach wire fields to the same context; finalize the receipt when the outer
   call returns or throws. Acceptance (a): two concurrent paid calls to the same URL produce two
   correct, distinct receipts. Acceptance (b): a 402 the client refuses under spend controls
   still produces a receipt with `settled: false`, `failure.stage: "payload"`, and the cheapest
   `accepts[]` entry as `amountAuthorized`. Spend controls run inside
   `selectPaymentRequirements`, BEFORE `onBeforePaymentCreation`, so no hook fires on a
   refusal; the instrumented fetch must carry the parsed 402 into the finalize path itself.
2. Store: `node:sqlite`, one table, JSON for nested fields, indexed columns for
   `resource_url`, `network`, `ts`, `outcome`, `task_class`.
3. `meter.label(id, outcome, note?)` and a `meter.last()` convenience for labeling the call
   you just made.
4. CLI: `x402-spend report [--db path] [--since 7d]` → spend by endpoint, success rate,
   median cost per `used` result, p50/p95 paid-leg latency.
5. Smoke test with the fake server; then testnet dogfood on two Bazaar-listed endpoints.
6. README: what it is in two sentences, install, three-line usage, the label call, the report
   screenshot, what it does NOT do (no seller side, no routing yet), privacy (local only,
   nothing leaves the machine in v0.1).
