import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatAtomic, formatReport, parseSince } from "./report.js";
import type { Leg, Outcome, SpendReceipt } from "./receipt.js";

function receipt(url: string, opts: { settled?: boolean; amount?: string; outcome?: Outcome; paidMs?: number } = {}): SpendReceipt {
  const legs: Leg[] = [{ kind: "initial", status: 402, ms: 10 }];
  if (opts.paidMs !== undefined) legs.push({ kind: "paid", status: opts.settled === false ? 402 : 200, ms: opts.paidMs });
  return {
    schema: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    method: "GET",
    resource: { url },
    x402Version: 2,
    scheme: "exact",
    network: "eip155:84532",
    asset: "0xusdc",
    amountAuthorized: "10000",
    payTo: "0xseller",
    offeredAlternatives: 1,
    settled: opts.settled ?? true,
    amountSettled: opts.settled === false ? undefined : opts.amount ?? "10000",
    legs,
    totalMs: 100,
    status: opts.settled === false ? 402 : 200,
    outcome: opts.outcome ?? "unlabeled",
    ...(opts.settled === false ? { failure: { stage: "settle" as const } } : {}),
  };
}

test("buildReport: spend, success rate, median cost per used, paid-leg percentiles", () => {
  const url = "http://api.test/search";
  const receipts = [
    receipt(url, { amount: "100", outcome: "used", paidMs: 100 }),
    receipt(url, { amount: "300", outcome: "used", paidMs: 200 }),
    receipt(url, { amount: "900", outcome: "discarded", paidMs: 300 }),
    receipt(url, { settled: false, paidMs: 400 }),
    receipt("http://api.test/other", { amount: "50", paidMs: 50 }),
  ];
  const report = buildReport(receipts);

  assert.equal(report.endpoints.length, 2);
  const [search, other] = report.endpoints; // sorted by spend, descending
  assert.equal(search.resourceUrl, url);
  assert.equal(search.calls, 4);
  assert.equal(search.settledCalls, 3);
  assert.equal(search.spendAtomic, 1300n); // unsettled call costs nothing
  assert.equal(search.medianCostPerUsedAtomic, 200n); // even count: mean of 100, 300
  assert.equal(search.usedCalls, 2);
  assert.equal(search.p50PaidMs, 200);
  assert.equal(search.p95PaidMs, 400);
  assert.equal(other.spendAtomic, 50n);
  assert.equal(other.medianCostPerUsedAtomic, undefined);

  assert.deepEqual(report.totals, { calls: 5, settledCalls: 4, spendAtomic: 1350n });
});

test("formatAtomic pads to the requested decimals", () => {
  assert.equal(formatAtomic(5001n, 6), "0.005001");
  assert.equal(formatAtomic(1_234_567n, 6), "1.234567");
  assert.equal(formatAtomic(0n, 6), "0.000000");
  assert.equal(formatAtomic(42n, 0), "42");
});

test("formatReport names the atomic-unit scaling", () => {
  const out = formatReport(buildReport([receipt("http://api.test/x", { amount: "10000", paidMs: 80 })]));
  assert.match(out, /atomic units ÷ 10\^6/);
  assert.match(out, /TOTAL\s+1\s+100%\s+0\.010000/);
});

test("parseSince handles durations and dates", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  assert.equal(parseSince("7d", now).toISOString(), "2026-08-30T12:00:00.000Z");
  assert.equal(parseSince("30m", now).toISOString(), "2026-09-06T11:30:00.000Z");
  assert.equal(parseSince("2026-09-01", now).getTime(), Date.parse("2026-09-01"));
  assert.throws(() => parseSince("yesterday-ish"), /cannot parse --since/);
});
