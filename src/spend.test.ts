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
import { createSpend, SpendPersistenceError, type SpendFetchInit, type SpendStore } from "./spend.js";
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
  async label(id: string, outcome: Outcome, note?: string) {
    const receipt = this.receipts.find((r) => r.id === id);
    if (!receipt) return;
    receipt.outcome = outcome;
    if (note !== undefined) receipt.outcomeNote = note;
  }
  async get(id: string) {
    return this.receipts.find((r) => r.id === id);
  }
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
    const spend = createSpend(makeClient(), store);
    const resource = `${url}/paid`;

    const [resA, resB] = await Promise.all([spend.fetch(resource), spend.fetch(resource)]);

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
    const spend = createSpend(makeClient(), store);
    const res = await spend.fetch(`http://localhost:${(server.address() as { port: number }).port}/free`);
    assert.equal(res.status, 200);
    assert.equal(store.receipts.length, 0);
  } finally {
    server.close();
  }
});

test("smoke: spend → sqlite store → label(last()) → report", async () => {
  const { SqliteSpendStore } = await import("./store.js");
  const { buildReport, formatReport } = await import("./report.js");
  const { server, url } = await startFakeServer();
  try {
    const store = new SqliteSpendStore(":memory:");
    const spend = createSpend(makeClient(), store);

    await spend.fetch(`${url}/paid`, { taskClass: "web-search" });
    assert.ok(spend.last());
    await spend.label(spend.last()!, "used", "worth it");

    const [r] = store.list();
    assert.equal(r.id, spend.last());
    assert.equal(r.outcome, "used");
    assert.equal(r.outcomeNote, "worth it");
    assert.equal(r.taskClass, "web-search");

    const out = formatReport(buildReport(store.list()), { decimals: 6 });
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
    const spend = createSpend(client, store);
    const resource = `http://localhost:${(server.address() as { port: number }).port}/paid`;

    await assert.rejects(() => spend.fetch(resource), /spendControls/);

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

/** Deterministic v2 exchange; no sockets or payment network required. */
function fakeTransport(onPaid?: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (!request.headers.has("PAYMENT-SIGNATURE")) {
      return new Response(null, { status: 402, headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequiredFor(request.url)),
      } });
    }
    if (onPaid) return onPaid(request);
    return new Response("delivered", { headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true, transaction: "0xtx", network: NETWORK, amount: "5000",
      }),
    } });
  };
}

test("storage failure after payment attempts one insert and preserves the response and receipt", async () => {
  const failure = new Error("disk full");
  const attempts: SpendReceipt[] = [];
  let fail = false;
  const store: SpendStore = {
    insert: async (r) => { attempts.push(r); if (fail) throw failure; },
    label: async () => {},
    get: async () => undefined,
  };
  const spend = createSpend(makeClient(), store, fakeTransport());
  await spend.fetch("https://api.test/paid");
  const previousId = spend.last();
  fail = true;
  let caught: unknown;
  try { await spend.fetch("https://api.test/paid"); } catch (error) { caught = error; }
  assert.equal(attempts.length, 2, "one successful write and one failed write, with no retry");
  assert.ok(caught instanceof SpendPersistenceError);
  const error = caught;
  assert.ok(error.response);
  assert.equal(error.name, "SpendPersistenceError");
  assert.equal(error.cause, failure);
  assert.equal(error.receipt, attempts[1]);
  assert.equal(error.receipt.settled, true);
  assert.equal(error.receipt.failure, undefined);
  assert.equal(await error.response.text(), "delivered");
  assert.equal(error.requestError, undefined);
  assert.equal(spend.last(), previousId);
});

test("transport and persistence failures remain inspectable without a second insert", async () => {
  const transportFailure = new Error("connection reset");
  const storageFailure = new Error("database unavailable");
  let attempts = 0;
  const spend = createSpend(makeClient(), {
    insert: async () => { attempts++; throw storageFailure; }, label: async () => {},
    get: async () => undefined,
  }, fakeTransport(async () => { throw transportFailure; }));
  let caught: unknown;
  try { await spend.fetch("https://api.test/paid"); } catch (error) { caught = error; }
  assert.equal(attempts, 1);
  assert.ok(caught instanceof SpendPersistenceError);
  const error = caught;
  assert.equal(error.cause, storageFailure);
  assert.equal(error.requestError, transportFailure);
  assert.equal(error.response, undefined);
  assert.equal(error.receipt.failure?.stage, "transport");
  assert.equal(error.receipt.status, 0);
  assert.equal(spend.last(), undefined);
});

test("successful persistence preserves the original rejected value, even undefined", async () => {
  for (const failure of [new Error("connection reset"), undefined]) {
    const store = new MemoryStore();
    const spend = createSpend(makeClient(), store, fakeTransport(async () => { throw failure; }));
    let rejected = false;
    try { await spend.fetch("https://api.test/paid"); } catch (error) {
      rejected = true;
      assert.equal(error, failure);
    }
    assert.equal(rejected, true);
    assert.equal(store.receipts.length, 1);
    assert.equal(store.receipts[0].failure?.stage, "transport");
  }
});

test("Request init overrides match the recorded method and preserve body across legs", async () => {
  const store = new MemoryStore();
  const seen: Array<[string, string]> = [];
  const transport = fakeTransport();
  const spend = createSpend(makeClient(), store, async (input, init) => {
    const request = new Request(input, init);
    seen.push([request.method, await request.clone().text()]);
    return transport(request);
  });
  await spend.fetch(new Request("https://api.test/paid"), { method: "post", body: "hello" });
  assert.deepEqual(seen, [["POST", "hello"], ["POST", "hello"]]);
  assert.equal(store.receipts[0].method, "POST");
});

/**
 * A paid response that names the payer as well as the transaction. The default
 * fake omits the payer, which leaves a receipt with nothing checkable.
 */
const settledTransport = () =>
  fakeTransport(async () => new Response("delivered", {
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({
        success: true, transaction: "0xtx-review", network: NETWORK, amount: "5000",
        payer: "0xpayer-review",
      }),
    },
  }));

test("review posting is off unless configured, and never blocks the local label", async () => {
  const store = new MemoryStore();
  const spend = createSpend(makeClient(), store, { fetchImpl: settledTransport() });
  await spend.fetch("https://api.test/paid");

  const result = await spend.label(spend.last()!, "used", "worth it");
  assert.deepEqual(result, { posted: false });
  assert.equal(store.receipts[0].outcome, "used");
  assert.equal(store.receipts[0].outcomeNote, "worth it");
});

test("a configured review endpoint receives exactly one post carrying no receipt internals", async () => {
  const store = new MemoryStore();
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const reviewFetch: typeof fetch = async (input, init) => {
    posts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "srv-1", status: "verified", verified: true }, { status: 201 });
  };

  const spend = createSpend(makeClient(), store, {
    fetchImpl: settledTransport(),
    review: { endpoint: "https://reviews.test/v1/reviews", fetchImpl: reviewFetch },
  });
  await spend.fetch("https://api.test/paid?key=secret#frag", { taskClass: "web-search" });
  const result = await spend.label(spend.last()!, "used", "worth it");

  assert.deepEqual(result, { posted: true, status: "verified" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://reviews.test/v1/reviews");

  const body = posts[0].body;
  // Query string and fragment carry credentials often enough that publishing
  // one unedited would leak a key.
  assert.equal(body.resourceUrl, "https://api.test/paid");
  assert.equal(body.outcome, "used");
  assert.equal(body.note, "worth it");
  assert.equal(body.taskClass, "web-search");
  assert.equal(body.schema, 1);
  assert.ok(body.transaction);
  assert.ok(body.payer);
  for (const local of ["id", "legs", "status", "method", "offeredAlternatives", "outcomeNote", "totalMs"]) {
    assert.equal(Object.hasOwn(body, local), false, `${local} must stay local`);
  }
});

test("201, 200 and 202 all count as posted, and 202 reports the review as pending", async () => {
  for (const [status, expected] of [[201, "verified"], [200, "verified"], [202, "pending"]] as const) {
    const store = new MemoryStore();
    const spend = createSpend(makeClient(), store, {
      fetchImpl: settledTransport(),
      review: {
        endpoint: "https://reviews.test/v1/reviews",
        fetchImpl: async () => Response.json({ id: "x", status: expected }, { status }),
      },
    });
    await spend.fetch("https://api.test/paid");
    assert.deepEqual(await spend.label(spend.last()!, "used"), { posted: true, status: expected });
  }
});

test("a review server that is down, slow or unhappy never reaches the caller", async () => {
  const cases: [string, typeof fetch, RegExp][] = [
    ["refused", async () => { throw new Error("ECONNREFUSED"); }, /ECONNREFUSED/],
    ["500", async () => new Response("boom", { status: 500 }), /returned 500/],
    ["422", async () => new Response("bad asset", { status: 422 }), /returned 422: bad asset/],
    // AbortSignal.timeout's own timer is unref'd, so with a fake fetch holding
    // no sockets the loop can drain before it fires and this promise would
    // never settle. A ref'd timer keeps the process alive until the abort lands.
    ["timeout", (_i, init) => new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("abort never fired")), 5_000);
      (init?.signal as AbortSignal).addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new Error("The operation was aborted"));
      });
    }), /abort/i],
  ];
  for (const [name, reviewFetch, reason] of cases) {
    const store = new MemoryStore();
    const spend = createSpend(makeClient(), store, {
      fetchImpl: settledTransport(),
      review: { endpoint: "https://reviews.test/v1/reviews", fetchImpl: reviewFetch, timeoutMs: 20 },
    });
    await spend.fetch("https://api.test/paid");

    const result = await spend.label(spend.last()!, "used", "worth it");
    assert.equal(result.posted, false, name);
    assert.match(result.error ?? "", reason, name);
    // The label is the caller's data and is written regardless.
    assert.equal(store.receipts[0].outcome, "used", name);
  }
});

test("nothing is posted without a settlement to verify, or for an unlabeled verdict", async () => {
  const store = new MemoryStore();
  let posts = 0;
  const spend = createSpend(makeClient(), store, {
    fetchImpl: fakeTransport(async () => { throw new Error("connection reset"); }),
    review: {
      endpoint: "https://reviews.test/v1/reviews",
      fetchImpl: async () => { posts++; return Response.json({}, { status: 201 }); },
    },
  });
  try { await spend.fetch("https://api.test/paid"); } catch { /* transport failure is expected */ }

  const id = store.receipts[0].id;
  assert.equal(store.receipts[0].transaction, undefined);
  assert.deepEqual(await spend.label(id, "failed"), { posted: false, error: "no settlement to verify" });

  assert.deepEqual(await spend.label(id, "unlabeled"),
    { posted: false, error: "unlabeled is not a publishable verdict" });
  assert.equal(posts, 0);
});

test("the deprecated positional fetch form still works for one release", async () => {
  const store = new MemoryStore();
  const spend = createSpend(makeClient(), store, settledTransport());
  await spend.fetch("https://api.test/paid");
  assert.equal(store.receipts.length, 1);
  assert.deepEqual(await spend.label(spend.last()!, "used"), { posted: false });
});

test("non-standard init fields survive the Request construction and reach every leg", async () => {
  const store = new MemoryStore();
  const seen: { paid: boolean; init: RequestInit | undefined }[] = [];
  const transport = settledTransport();

  const spend = createSpend(makeClient(), store, {
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.push({ paid: request.headers.has("PAYMENT-SIGNATURE"), init });
      return transport(request, init);
    },
  });

  // `next` is Next.js's own extension to fetch init; a Request drops it.
  await spend.fetch("https://api.test/paid", {
    taskClass: "web-search",
    next: { revalidate: 60 },
  } as SpendFetchInit & { next: { revalidate: number } });

  assert.equal(seen.length, 2, "one initial leg and one paid leg");
  assert.deepEqual(seen.map((s) => s.paid), [false, true]);
  for (const { paid, init } of seen) {
    const leg = paid ? "paid" : "initial";
    assert.deepEqual((init as { next?: unknown })?.next, { revalidate: 60 }, `next missing on the ${leg} leg`);
    // taskClass is this package's own field and must not be forwarded as fetch init.
    assert.equal(Object.hasOwn(init ?? {}, "taskClass"), false, `taskClass leaked on the ${leg} leg`);
  }
  assert.equal(store.receipts[0].taskClass, "web-search");
});

test("forwarded init cannot overwrite the payment headers the wrapper set", async () => {
  const store = new MemoryStore();
  const paidRequests: Request[] = [];
  const transport = settledTransport();

  const spend = createSpend(makeClient(), store, {
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.has("PAYMENT-SIGNATURE")) paidRequests.push(request);
      return transport(request, init);
    },
  });

  // A caller passing headers and a body must not be able to strip the payment
  // signature off the paid leg by having them replayed over it.
  await spend.fetch("https://api.test/paid", {
    method: "POST",
    body: "hello",
    headers: { "x-caller": "1" },
  });

  assert.equal(paidRequests.length, 1);
  assert.ok(paidRequests[0].headers.get("PAYMENT-SIGNATURE"), "payment signature survived");
  assert.equal(store.receipts[0].method, "POST");
});
