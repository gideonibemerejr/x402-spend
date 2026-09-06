# x402-spend

A bank statement for your agent's x402 spend. It records every paid HTTP call — price, chain, settlement, latency per leg — plus the one column no bank can fill in: **was it worth it**.

## Install

```sh
npm install x402-spend @x402/core @x402/fetch
```

Node ≥ 22.5 (the store is `node:sqlite` — no native deps).

## Usage

Wrap the x402 client you already have. The meter only observes; your client keeps owning schemes, signers, and spend controls.

```ts
import { createMeter, SqliteSpendStore } from "x402-spend";

const meter = createMeter(client, new SqliteSpendStore()); // ./x402-spend.db
const res = await meter.fetch("https://api.example.com/search?q=x402", { taskClass: "web-search" });
```

`meter.fetch` is a drop-in fetch: free calls pass through unrecorded; any call that reaches payment writes a receipt — wire fields from the protocol, per-leg latency and status from the transport.

### The label

The receipt starts `unlabeled`. Only the caller knows whether the thing it paid for actually worked, so say so:

```ts
await meter.label(meter.last()!, "used");          // it answered the question
await meter.label(id, "discarded", "stale data");  // paid, but worthless
```

Outcomes: `used` · `retried` · `discarded` · `failed` · `unlabeled`.

## The report

```sh
x402-spend report --since 7d --decimals 6
```

```
x402-spend report — since 2026-08-30T11:49:33.549Z · 14 calls · 14 settled

eip155:84532 · 0x036CbD53842c5426634e7929541eC2318f3dCF7e · amounts are atomic units ÷ 10^6

ENDPOINT                        CALLS  SETTLED     SPEND      MED COST/USED  P50/P95 PAID MS
http://localhost:50643/search       9     100%  0.108000  0.012000 (6 used)          238/295
http://localhost:50643/geocode      5     100%  0.012500  0.002500 (4 used)            49/64
TOTAL                              14     100%  0.120500
```

The sample above is from a fake server, not a live payment run. Reports show spend by endpoint, settlement rate, median cost per **used** result, and p50/p95 paid-leg latency. Each asset/network has its own table and monetary total. Amounts use actual settlement when supplied (which can be less than authorization under `upto`). Invalid settled amounts are excluded from monetary statistics with a visible warning and count; totals in that group are marked partial.

The default is **atomic units**. `--decimals 6` is a convenience for a report containing only one denomination. For multiple assets, specify each scale explicitly; unspecified assets stay atomic:

```sh
x402-spend report --since 7d \
  --asset-decimals eip155:84532/0x036CbD53842c5426634e7929541eC2318f3dCF7e=6
```

Repeat `--asset-decimals network/asset=decimals` as needed. Matching uses exact recorded network and asset identifiers. Use `--db` for a non-default database path. No token metadata or prices are fetched automatically.

The median still includes unsettled receipts labeled `used` as zero-cost samples; changing that metric is a separate roadmap decision. Invalid monetary samples are excluded and their sample count is shown.

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
  await meter.fetch(url);
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

Local only. Receipts go to a SQLite file on your machine; nothing leaves it in v0.1.

## Development roadmap

See the [post-launch roadmap](docs/ROADMAP.md) for verified findings, current API contracts, and the proposed order of reliability work and cleanup.
