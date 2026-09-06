/**
 * Acceptance test for build step 1 (HANDOFF.md):
 * two concurrent paid calls to the same URL produce two correct, distinct receipts.
 *
 * The fake server speaks x402 v2 over HTTP with the header codecs from
 * `@x402/core/http` — no chain, no facilitator. Each payment payload carries a
 * per-call nonce from the mock scheme client; the server keys the settlement
 * (transaction, payer, settled amount) and the paid-leg delay off that nonce,
 * so a receipt that mixes up two in-flight calls is detectable on every axis:
 * wire fields, settlement, and timing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { x402Client } from "@x402/core/client";
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { createMeter, type SpendStore } from "./meter.js";
import type { Outcome, SpendReceipt } from "./receipt.js";

const NETWORK = "eip155:84532";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // testnet USDC
const PAY_TO = "0x1111111111111111111111111111111111111111";
const AMOUNT = "10000"; // atomic units

/** Paid-leg delay per nonce. Call holding nonce 1 must finish AFTER the one holding nonce 2. */
const DELAY_MS: Record<number, number> = { 1: 250, 2: 25 };

class MemoryStore implements SpendStore {
  receipts: SpendReceipt[] = [];
  async insert(r: SpendReceipt) {
    this.receipts.push(r);
  }
  async label(_id: string, _outcome: Outcome, _note?: string) {}
}

function paymentRequiredFor(url: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, serviceName: "fake-paid-api", description: "test resource" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        asset: ASSET,
        amount: AMOUNT,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

/** 402 on unpaid requests; on paid requests, settle keyed off the payload nonce after a per-nonce delay. */
function startFakeServer(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const url = `http://localhost:${(server.address() as { port: number }).port}${req.url}`;
    const sig = req.headers["payment-signature"];
    if (!sig) {
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequiredFor(url)) });
      res.end();
      return;
    }
    const payload = decodePaymentSignatureHeader(String(sig));
    const nonce = (payload.payload as { nonce: number }).nonce;
    await new Promise((r) => setTimeout(r, DELAY_MS[nonce] ?? 0));
    res.writeHead(200, {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true,
        transaction: `0xtx-${nonce}`,
        network: NETWORK,
        payer: `0xpayer-${nonce}`,
        amount: `500${nonce}`, // distinct settled amount per call (upto-style)
      }),
      "content-type": "application/json",
    });
    res.end(JSON.stringify({ nonce }));
  });
  server.listen(0);
  return once(server, "listening").then(() => ({
    server,
    url: `http://localhost:${(server.address() as { port: number }).port}`,
  }));
}

function makeClient(): x402Client {
  let nextNonce = 1;
  const mockScheme: SchemeNetworkClient = {
    scheme: "exact",
    createPaymentPayload: async (x402Version) => ({
      x402Version,
      payload: { nonce: nextNonce++ },
    }),
  };
  // spendControls off: the mock scheme has no findDefaultAsset, and the default
  // controls reject assets they cannot price.
  return new x402Client().setSpendControls(false).register(NETWORK, mockScheme);
}

test("two concurrent paid calls to the same URL produce two correct, distinct receipts", async () => {
  const { server, url } = await startFakeServer();
  try {
    const store = new MemoryStore();
    const meter = createMeter(makeClient(), store);
    const resource = `${url}/paid`;

    const [resA, resB] = await Promise.all([meter.fetch(resource), meter.fetch(resource)]);

    // Both calls succeeded and got distinct settlements.
    const bodyA = (await resA.json()) as { nonce: number };
    const bodyB = (await resB.json()) as { nonce: number };
    assert.deepEqual([bodyA.nonce, bodyB.nonce].sort(), [1, 2]);

    assert.equal(store.receipts.length, 2);
    const [r1, r2] = store.receipts;
    assert.notEqual(r1.id, r2.id);

    for (const nonce of [1, 2]) {
      // The receipt is correct if its settlement, wire fields, and timing all
      // belong to the same call — the URL-keyed pending map got these crossed.
      const r = store.receipts.find((r) => r.transaction === `0xtx-${nonce}`);
      assert.ok(r, `missing receipt for nonce ${nonce}`);
      assert.equal(r.schema, 1);
      assert.equal(r.method, "GET");
      assert.equal(r.resource.url, resource);
      assert.equal(r.resource.serviceName, "fake-paid-api");
      assert.equal(r.x402Version, 2);
      assert.equal(r.scheme, "exact");
      assert.equal(r.network, NETWORK);
      assert.equal(r.asset, ASSET);
      assert.equal(r.amountAuthorized, AMOUNT);
      assert.equal(r.payTo, PAY_TO);
      assert.equal(r.offeredAlternatives, 1);
      assert.equal(r.settled, true);
      assert.equal(r.amountSettled, `500${nonce}`);
      assert.equal(r.payer, `0xpayer-${nonce}`);
      assert.equal(r.failure, undefined);
      assert.equal(r.status, 200);
      assert.equal(r.outcome, "unlabeled");

      // Legs: initial 402, then the paid retry.
      assert.deepEqual(
        r.legs.map((l) => [l.kind, l.status]),
        [
          ["initial", 402],
          ["paid", 200],
        ]
      );

      // Timing belongs to this call, not the concurrent one: the server held
      // nonce 1's paid leg ~250ms and nonce 2's ~25ms.
      const paidMs = r.legs[1].ms;
      if (nonce === 1) assert.ok(paidMs >= 200, `nonce 1 paid leg took ${paidMs}ms, expected >= 200`);
      else assert.ok(paidMs < 200, `nonce 2 paid leg took ${paidMs}ms, expected < 200`);
      assert.ok(r.totalMs >= paidMs);
    }
  } finally {
    server.close();
  }
});

test("free (non-402) calls are not recorded", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ free: true }));
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const store = new MemoryStore();
    const meter = createMeter(makeClient(), store);
    const res = await meter.fetch(`http://localhost:${(server.address() as { port: number }).port}/free`);
    assert.equal(res.status, 200);
    assert.equal(store.receipts.length, 0);
  } finally {
    server.close();
  }
});

test("smoke: meter → sqlite store → label(last()) → report", async () => {
  const { SqliteSpendStore } = await import("./store.js");
  const { buildReport, formatReport } = await import("./report.js");
  const { server, url } = await startFakeServer();
  try {
    const store = new SqliteSpendStore(":memory:");
    const meter = createMeter(makeClient(), store);

    await meter.fetch(`${url}/paid`, { taskClass: "web-search" });
    assert.ok(meter.last());
    await meter.label(meter.last()!, "used", "worth it");

    const [r] = store.list();
    assert.equal(r.id, meter.last());
    assert.equal(r.outcome, "used");
    assert.equal(r.outcomeNote, "worth it");
    assert.equal(r.taskClass, "web-search");

    const out = formatReport(buildReport(store.list()));
    assert.match(out, /0\.005001 \(1 used\)/); // nonce 1 settles 5001 atomic units
    store.close();
  } finally {
    server.close();
  }
});

test("a 402 refused under spend controls still produces a receipt (settled: false, failure.stage: payload, cheapest offer as amountAuthorized)", async () => {
  // Two offers, expensive first: the receipt must price the call at the CHEAPEST one.
  const accepts: PaymentRequirements[] = [
    { scheme: "exact", network: NETWORK, asset: ASSET, amount: "999999", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
    { scheme: "exact", network: NETWORK, asset: "0xcheap", amount: "2000", payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60, extra: {} },
  ];
  const server = createServer((req, res) => {
    const url = `http://localhost:${(server.address() as { port: number }).port}${req.url}`;
    res.writeHead(402, {
      "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url, serviceName: "fake-paid-api" },
        accepts,
      }),
    });
    res.end();
  });
  server.listen(0);
  await once(server, "listening");
  try {
    const store = new MemoryStore();
    // Default spend controls stay ON: the mock scheme has no findDefaultAsset,
    // so selectPaymentRequirements rejects every offer before any hook fires.
    const client = new x402Client().register(NETWORK, {
      scheme: "exact",
      createPaymentPayload: async (x402Version) => ({ x402Version, payload: {} }),
    });
    const meter = createMeter(client, store);
    const resource = `http://localhost:${(server.address() as { port: number }).port}/paid`;

    await assert.rejects(() => meter.fetch(resource), /spendControls/);

    assert.equal(store.receipts.length, 1);
    const r = store.receipts[0];
    assert.equal(r.settled, false);
    assert.equal(r.failure?.stage, "payload");
    assert.match(r.failure?.reason ?? "", /spendControls/);
    assert.equal(r.amountAuthorized, "2000");
    assert.equal(r.asset, "0xcheap");
    assert.equal(r.payTo, "0x2222222222222222222222222222222222222222");
    assert.equal(r.scheme, "exact");
    assert.equal(r.network, NETWORK);
    assert.equal(r.resource.url, resource);
    assert.equal(r.offeredAlternatives, 2);
    assert.equal(r.x402Version, 2);
    assert.deepEqual(r.legs.map((l) => [l.kind, l.status]), [["initial", 402]]);
    assert.equal(r.status, 402);
    assert.equal(r.amountSettled, undefined);
    assert.equal(r.transaction, undefined);
    assert.equal(r.outcome, "unlabeled");
  } finally {
    server.close();
  }
});
