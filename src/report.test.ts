import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, formatAtomic, formatReport, parseSince } from "./report.js";
import type { Leg, Outcome, SpendReceipt } from "./receipt.js";

function receipt(url: string, opts: { settled?: boolean; amount?: string; outcome?: Outcome; paidMs?: number } = {}): SpendReceipt {
  const legs: Leg[] = [{ kind: "initial", status: 402, ms: 10 }];
  if (opts.paidMs !== undefined) legs.push({ kind: "paid", status: opts.settled === false ? 402 : 200, ms: opts.paidMs });
  return {
    schema: 2,
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

test("buildReport: spend, success rate, median cost per useful, paid-leg percentiles", () => {
  const url = "http://api.test/search";
  const receipts = [
    receipt(url, { amount: "100", outcome: "useful", paidMs: 100 }),
    receipt(url, { amount: "300", outcome: "useful", paidMs: 200 }),
    receipt(url, { amount: "900", outcome: "not_useful", paidMs: 300 }),
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
  assert.equal(search.medianCostPerUsefulAtomic, 200n); // even count: mean of 100, 300
  assert.equal(search.usefulCalls, 2);
  assert.equal(search.p50PaidMs, 200);
  assert.equal(search.p95PaidMs, 400);
  assert.equal(other.spendAtomic, 50n);
  assert.equal(other.medianCostPerUsefulAtomic, undefined);

  assert.deepEqual(report.totals, { calls: 5, settledCalls: 4, invalidAmountCalls: 0 });
  // Waste is the 900 spent on the not-useful call; the unsettled one cost nothing.
  assert.equal(search.wasteAtomic, 900n);
  assert.equal(search.notUsefulCalls, 1);
  assert.deepEqual(report.denominations, [{ network: "eip155:84532", asset: "0xusdc",
    calls: 5, settledCalls: 4, spendAtomic: 1350n, wasteAtomic: 900n,
    usefulCalls: 2, notUsefulCalls: 1, invalidAmountCalls: 0 }]);
});

test("formatAtomic pads to the requested decimals", () => {
  assert.equal(formatAtomic(5001n, 6), "0.005001");
  assert.equal(formatAtomic(1_234_567n, 6), "1.234567");
  assert.equal(formatAtomic(0n, 6), "0.000000");
  assert.equal(formatAtomic(42n, 0), "42");
});

test("formatReport names the atomic-unit scaling", () => {
  const out = formatReport(buildReport([receipt("http://api.test/x", { amount: "10000", paidMs: 80 })]), { decimals: 6 });
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

test("overflowing durations and invalid reference dates are rejected", () => {
  for (const input of ["99999999999999999999999w", "99999999999999999999999m"]) {
    assert.throws(() => parseSince(input), /cannot parse --since/);
  }
  assert.throws(() => parseSince("1d", new Date(NaN)), /cannot parse --since/);
});

test("one malformed settled amount does not hide valid report data", () => {
  const rows = [receipt("http://api.test/x", { amount: "100", outcome: "useful" })];
  for (const amount of ["$0.10", "", " ", "1.2", "-1", "0x10", "1e3"]) {
    rows.push(receipt("http://api.test/x", { amount, outcome: "useful" }));
  }
  const report = buildReport(rows);
  assert.equal(report.endpoints[0].spendAtomic, 100n);
  assert.equal(report.endpoints[0].medianCostPerUsefulAtomic, 100n);
  assert.equal(report.endpoints[0].calls, 8);
  assert.match(formatReport(report), /7.*invalid amount/i);
  assert.match(formatReport(report), /partial/i);
});

test("receipts are separated by network and asset even at the same endpoint", () => {
  const a = receipt("http://api.test/x", { amount: "100" });
  const report = buildReport([a, { ...a, id: "b", asset: "0xother" },
    { ...a, id: "c", network: "eip155:8453" }]);
  assert.equal(report.endpoints.length, 3);
  assert.equal(Object.hasOwn(report.totals, "spendAtomic"), false, "no mixed-denomination total");
  const out = formatReport(report);
  assert.match(out, /0xother/);
  assert.match(out, /eip155:8453/);
  assert.equal((out.match(/TOTAL/g) ?? []).length, 3);
  assert.throws(() => formatReport(report, { decimals: 6 }), /single denomination/i);
});

test("decimals resolve per denomination and unknown assets stay atomic", () => {
  const a = receipt("http://api.test/x", { amount: "1234567" });
  const b = { ...a, id: "b", asset: "other", amountSettled: "12345" };
  const c: SpendReceipt = { ...a, id: "c", network: "eip155:8453", amountSettled: "42" };
  const report = buildReport([a, b, c]);
  assert.deepEqual(report.denominations.map((d) => d.spendAtomic).sort((a, b) => a < b ? -1 : 1), [42n, 12345n, 1234567n]);
  const output = formatReport(report, { assetDecimals: [
    { network: a.network, asset: a.asset, decimals: 6 },
    { network: b.network, asset: b.asset, decimals: 2 },
  ] });
  assert.match(output, /1\.234567/);
  assert.match(output, /123\.45/);
  assert.match(output, /eip155:8453 · 0xusdc · amounts are atomic units \(decimals unknown\)/);
  assert.match(output, /TOTAL\s+1\s+100%\s+42/);
  assert.throws(() => formatReport(report, { assetDecimals: [
    { network: a.network, asset: a.asset, decimals: 6 },
    { network: a.network, asset: a.asset, decimals: 2 },
  ] }), /conflicting decimals/);
});

test("all-invalid amounts remain visibly partial and do not produce cost samples", () => {
  const report = buildReport([receipt("http://api.test/x", { amount: "broken", outcome: "useful" })]);
  assert.equal(report.totals.invalidAmountCalls, 1);
  assert.equal(report.denominations[0].invalidAmountCalls, 1);
  assert.equal(report.endpoints[0].medianCostPerUsefulAtomic, undefined);
  assert.equal(report.endpoints[0].costSamples, 0);
  assert.match(formatReport(report), /0\/1 useful samples/);
  assert.match(formatReport(report), /partial/);
});

test("report preserves exact amounts, authorized fallback, empty data and since metadata", () => {
  const a = receipt("http://api.test/x", { amount: "900719925474099300000", outcome: "useful" });
  const b = { ...a, id: "b", amountSettled: undefined, amountAuthorized: "123" };
  const c = { ...a, id: "c", amountSettled: "0" };
  const d = { ...a, id: "d", amountSettled: "bad" }; // must not fall back to authorized
  const since = new Date("2099-01-01");
  const report = buildReport([a, b, c, d], since);
  assert.equal(report.totals.calls, 4); // since does not filter
  assert.equal(report.since, since);
  assert.equal(report.denominations[0].spendAtomic, 900719925474099300123n);
  assert.equal(report.denominations[0].invalidAmountCalls, 1);
  assert.equal(report.endpoints[0].medianCostPerUsefulAtomic, 123n);
  assert.match(formatReport(buildReport([])), /No receipts/);
  assert.deepEqual(buildReport([]).denominations, []);
});

test("unsettled used receipts are unpriced and stay out of the median", () => {
  const report = buildReport([
    receipt("http://api.test/x", { amount: "100", outcome: "useful" }),
    receipt("http://api.test/x", { settled: false, outcome: "useful" }),
  ]);
  assert.equal(report.endpoints[0].medianCostPerUsefulAtomic, 100n);
  assert.equal(report.endpoints[0].costSamples, 1);
  assert.equal(report.endpoints[0].unsettledUsefulCalls, 1);
  assert.equal(report.endpoints[0].usefulCalls, 2);
});

test("a used endpoint with no settled call reports no median at all", () => {
  const report = buildReport([receipt("http://api.test/x", { settled: false, outcome: "useful" })]);
  assert.equal(report.endpoints[0].medianCostPerUsefulAtomic, undefined);
  assert.equal(report.endpoints[0].costSamples, 0);
  assert.equal(report.endpoints[0].unsettledUsefulCalls, 1);
  assert.equal(report.endpoints[0].usefulCalls, 1);
});

test("decimal formatting rejects invalid or unbounded scales", () => {
  for (const decimals of [-1, 0.5, NaN, Infinity, 256]) {
    assert.throws(() => formatAtomic(1n, decimals), /decimals must be/);
  }
});
