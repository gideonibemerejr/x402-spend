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
x402-spend report --since 7d
```

```
x402-spend report — since 2026-08-30T11:49:33.549Z · amounts are atomic units ÷ 10^6

ENDPOINT                        CALLS  SETTLED     SPEND      MED COST/USED  P50/P95 PAID MS
http://localhost:50643/search       9     100%  0.108000  0.012000 (6 used)          238/295
http://localhost:50643/geocode      5     100%  0.012500  0.002500 (4 used)            49/64
TOTAL                              14     100%  0.120500
```

Spend by endpoint, settlement rate, median cost per **used** result, and p50/p95 paid-leg latency. Amounts are settled atomic units (under the `upto` scheme that can be less than authorized; the meter records both). Formatting divides by `10^--decimals`, default 6 (USDC) — pass `--decimals` for other assets, `--db` for a non-default database path.

## What it does NOT do

- **No seller side.** Buyer receipts only.
- **No routing.** It tells you which endpoint was worth it; it does not pick one for you (yet).
- **No spend enforcement.** Caps and allowlists stay in your x402 client where they belong.

## Privacy

Local only. Receipts go to a SQLite file on your machine; nothing leaves it in v0.1.
