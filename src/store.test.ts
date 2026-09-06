import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteMeterStore } from "./store.js";
import type { MeterReceipt } from "./receipt.js";

function receipt(overrides: Partial<MeterReceipt> = {}): MeterReceipt {
  return {
    schema: 1,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    method: "GET",
    resource: { url: "http://api.test/paid" },
    x402Version: 2,
    scheme: "exact",
    network: "eip155:84532",
    asset: "0xusdc",
    amountAuthorized: "10000",
    payTo: "0xseller",
    offeredAlternatives: 1,
    settled: true,
    amountSettled: "5000",
    transaction: "0xtx",
    payer: "0xpayer",
    legs: [
      { kind: "initial", status: 402, ms: 12 },
      { kind: "paid", status: 200, ms: 87, bytes: 42 },
    ],
    totalMs: 110,
    status: 200,
    outcome: "unlabeled",
    ...overrides,
  };
}

test("insert / list roundtrip preserves the receipt", async () => {
  const store = new SqliteMeterStore(":memory:");
  const r = receipt();
  await store.insert(r);
  assert.deepEqual(store.list(), [r]);
  store.close();
});

test("label updates outcome in place, including inside the JSON", async () => {
  const store = new SqliteMeterStore(":memory:");
  const r = receipt();
  await store.insert(r);
  await store.label(r.id, "used", "answered the question");
  const [row] = store.list();
  assert.equal(row.outcome, "used");
  assert.equal(row.outcomeNote, "answered the question");
  store.close();
});

test("label throws on unknown id", async () => {
  const store = new SqliteMeterStore(":memory:");
  await assert.rejects(() => store.label("nope", "used"), /no receipt with id/);
  store.close();
});

test("list({since}) filters on ts", async () => {
  const store = new SqliteMeterStore(":memory:");
  const old = receipt({ ts: "2026-01-01T00:00:00.000Z" });
  const recent = receipt({ ts: "2026-09-01T00:00:00.000Z" });
  await store.insert(old);
  await store.insert(recent);
  assert.deepEqual(
    store.list({ since: new Date("2026-06-01") }).map((r) => r.id),
    [recent.id]
  );
  assert.equal(store.list().length, 2);
  store.close();
});
