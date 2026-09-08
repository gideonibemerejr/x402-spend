# x402-spend

A bank statement for your agent's x402 spend. It records every paid HTTP call — price, chain, settlement, latency per leg — plus the one column no bank can fill in: **was it worth it**.

## Install

```sh
npm install x402-spend @x402/core @x402/fetch
```

Node ≥ 22.5 (the store is `node:sqlite` — no native deps).

## Usage

Wrap the x402 client you already have. It only observes; your client keeps owning schemes, signers, and spend controls.

```ts
import { createSpend, SqliteSpendStore } from "x402-spend";

const spend = createSpend(client, new SqliteSpendStore()); // ./x402-spend.db
const res = await spend.fetch("https://api.example.com/search?q=x402", { taskClass: "web-search" });
```

`spend.fetch` is a drop-in fetch: free calls pass through unrecorded; any call that reaches payment writes a receipt — wire fields from the protocol, per-leg latency and status from the transport.

### The label

The receipt starts `unlabeled`. Only the caller knows whether the thing it paid for actually worked, so say so:

```ts
await spend.label(spend.last()!, "useful");                          // it answered the question
await spend.label(id, "not_useful", { reason: "stale" });            // paid, but worthless
await spend.label(id, "not_useful", {
  reason: "wrong", recovery: "went_elsewhere", note: "wrong city",
});
```

**Two outcomes, not four**: `useful` · `not_useful`. The response either gave you what you were
after or it did not. Whether you then retried, went elsewhere or gave up is *recovery* from that
failure, on its own axis, because retrying and discarding both cost money and both follow the same
failure. `unlabeled` is the state before a judgment, kept distinct so an unjudged call is never
counted as a judgment either way.

`reason` is required on `not_useful` and refused on `useful` — "it worked" is not a finding about
anything. One of `no_response` · `empty` · `malformed` · `wrong` · `stale` · `insufficient`: a closed
set, so reasons aggregate across calls instead of each describing one. `wrong`, `empty` and
`malformed` stay apart deliberately, because the difference between an endpoint that is broken and
one that is lying is a different fact about a seller.

`recovery` is optional everywhere and never an outcome: `none` · `retried_same` · `went_elsewhere` ·
`abandoned`. `note` is free text alongside the code, so specifics survive without widening the set.

## Publishing reviews

A label is worth something to other buyers, but only if it can be checked. Point a spend at a review
server and each label is also published as a review **verified against its settlement transaction** —
the transaction hash is the proof of purchase.

```ts
const spend = createSpend(client, new SqliteSpendStore(), {
  review: { endpoint: "https://x402-spend-reviews.g-764.workers.dev/v1/reviews" },
});

const result = await spend.label(id, "useful", { note: "clean answer" });
// { posted: true, status: "verified" }
```

`label()` returns `{ posted, status, error? }`. `status` is `verified` once the server has matched the
payment against the chain, or `pending` when it accepted the review but could not reach the chain yet
and will retry.

**Off by default, opt-in per spend**, because a review is public.

**What is sent**, and nothing else:

`resourceUrl` · `taskClass` · `network` · `asset` · `amount` · `payTo` · `transaction` · `payer` ·
`outcome` · `note` · `paidMs` · `ts`

**What is not sent:** transport legs, byte counts, HTTP status, method, offered alternatives, and the
local receipt id. The query string and fragment are stripped from `resourceUrl` before it leaves the
machine, because API keys live in query strings.

**A published review includes the payer address.** That is disclosed, not hidden: it is what lets
anyone re-check the claim against the chain. Published reviews are licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Nothing about posting can cost you a label. The local write happens first and always; a review server
that is down, slow (3 s timeout), or unhappy with the submission comes back as `{ posted: false,
error }` and is never thrown. A receipt with no settlement — a refused offer, a transport failure — is
never published, and `unlabeled` is not a publishable verdict.

See [x402-spend-reviews](https://github.com/gideonibemerejr/x402-spend-reviews) for the verification
rule, and `examples/live-sepolia.ts` for one real paid call end to end.

`examples/live-solana.ts` is the same call on Solana devnet, under the exact-SVM scheme. There is no
`seller-solana.ts` to pair it with: a local Solana seller would need a facilitator that settles
Solana, which is a longer detour than it is worth when the Base loop already proved the plumbing. So
`RESOURCE_URL` has to name a real endpoint that quotes a Solana network.

## The report

```sh
x402-spend report --since 7d --decimals 6
```

```
x402-spend report — since 2026-08-30T11:49:33.549Z · 14 calls · 14 settled

eip155:84532 · 0x036CbD53842c5426634e7929541eC2318f3dCF7e · amounts are atomic units ÷ 10^6

10 useful · 4 not useful · waste 0.036000 · cost per useful result 0.012050

ENDPOINT                        CALLS  SETTLED     SPEND    MED COST/USEFUL  P50/P95 PAID MS
http://localhost:50643/search       9     100%  0.108000  0.012000 (6 useful)        238/295
http://localhost:50643/geocode      5     100%  0.012500  0.002500 (4 useful)          49/64
TOTAL                              14     100%  0.120500
```

The sample above is from a fake server, not a live payment run.

**Waste and cost per useful result lead**; raw spend is the second question. Cost per useful result
is total spend ÷ the count of `useful` — everything spent reaching a `not_useful` answer counts
against the results that were worth having, regardless of how you recovered. Reports then show spend
by endpoint, settlement rate, median cost per **useful** result, and p50/p95 paid-leg latency. Each asset/network has its own table and monetary total. Amounts use actual settlement when supplied (which can be less than authorization under `upto`). Invalid settled amounts are excluded from monetary statistics with a visible warning and count; totals in that group are marked partial.

The default is **atomic units**. `--decimals 6` is a convenience for a report containing only one denomination. For multiple assets, specify each scale explicitly; unspecified assets stay atomic:

```sh
x402-spend report --since 7d \
  --asset-decimals eip155:84532/0x036CbD53842c5426634e7929541eC2318f3dCF7e=6
```

Repeat `--asset-decimals network/asset=decimals` as needed. Matching uses exact recorded network and asset identifiers. Use `--db` for a non-default database path. No token metadata or prices are fetched automatically.

Unsettled receipts labeled `useful` are unpriced rather than counted as zero-cost samples, and are reported separately. Invalid monetary samples are excluded and their sample count is shown.

### Programmatic report compatibility

`report.totals` contains counts only. Read spend from `report.denominations`, whose entries include `network`, `asset`, `spendAtomic`, and `invalidAmountCalls`. Endpoint rows also carry network/asset identifiers. `buildReport(receipts, since)` treats `since` as display metadata; filter receipts before calling it.

```ts
import { buildReport, formatReport } from "x402-spend";

const report = buildReport(store.list());
for (const total of report.denominations) {
  console.log(total.network, total.asset, total.spendAtomic);
}
const text = formatReport(report, {
  assetDecimals: [{ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 }],
});
```

### Receipt storage failures

`SpendPersistenceError` exposes the finalized `receipt`, the storage error as `cause`, and either the returned `response` or the original `requestError`. A storage failure can follow a successful payment. x402-spend attempts one insert; it does not repeat the paid request or retry persistence. A custom store may reject after committing, so inspect the error and the store's retry contract before retrying storage.

```ts
import { SpendPersistenceError } from "x402-spend";

try {
  await spend.fetch(url);
} catch (error) {
  if (error instanceof SpendPersistenceError) {
    console.error("Receipt storage failed", error.receipt.id, error.cause);
    // The response body, if any, remains available on error.response.
  }
  throw error;
}
```

Bytes are recorded only from `Content-Length`. Responses without that header, including typical chunked responses, have no byte count; response bodies are not consumed for measurement.

## What it does NOT do

- **No seller side.** Buyer receipts only.
- **No routing.** It tells you which endpoint was worth it; it does not pick one for you (yet).
- **No spend enforcement.** Caps and allowlists stay in your x402 client where they belong.

## Privacy

Local only by default. Receipts go to a SQLite file on your machine and nothing leaves it unless you
configure `review`, which is opt-in per `createSpend` call. When you do, only the review fields listed
above are sent — never the receipt — and a published review is public and includes the payer address.

## [Roadmap](https://github.com/gideonibemerejr/x402-spend/issues?q=is%3Aissue+is%3Aopen+label%3Aroadmap)

1. Recovery inference: a second paid call to the same endpoint or task class within a window records `recovery: retried_same` on the first without a `label()` call.
2. Receipt id returned from the call (`spend.call()` → `{ response, id }`), so concurrent callers don't depend on `last()`.
3. Session access recorded: calls served under a wallet session with no payment, `amountSettled: "0"`, so cost per used result is honest across a session.
4. Tool-call wrapper for MCP clients, then Vercel AI SDK, so the label is set by the loop, not by the developer.
5. Opt-in self-grade: one model call at the end of a run to propose an outcome and reason. Validated against hand labels, with its agreement rate published alongside anything it computes; a labeler checked against itself proves nothing.
6. A work-unit Extension proposal to the x402 Foundation, written from real receipts.

Not planned: routing, spend enforcement, or anything seller-side.

See [docs/ROADMAP.md](docs/ROADMAP.md) for verified findings, current API contracts, and the order of reliability work and cleanup.
