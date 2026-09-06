/**
 * The meter: an instrumented fetch around `wrapFetchWithPayment`, with an
 * AsyncLocalStorage context per outer call.
 *
 * Everything the wrapper does for one call — every HTTP leg, payload creation,
 * and the client hooks — runs inside that call's async context, so concurrent
 * calls (even to the same URL) never share state. The instrumented inner fetch
 * records what only the transport can see (legs: kind, status, ms, bytes); the
 * client hooks record what only the protocol can see.
 *
 * Hook → receipt field mapping:
 *   onBeforePaymentCreation (PaymentCreationContext)
 *     paymentRequired.resource        → resource
 *     paymentRequired.x402Version     → x402Version
 *     paymentRequired.accepts.length  → offeredAlternatives
 *     selectedRequirements            → scheme, network, asset, amountAuthorized, payTo
 *   onPaymentResponse (PaymentResponseContext)
 *     settleResponse.success          → settled
 *     settleResponse.amount           → amountSettled (falls back to authorized on success; `upto` can settle less)
 *     settleResponse.transaction      → transaction
 *     settleResponse.payer            → payer
 *     discrimination                  → failure { stage: settle | verify | transport }
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { RECEIPT_SCHEMA_VERSION, type Leg, type Outcome, type SpendReceipt } from "./receipt.js";

export interface SpendStore {
  insert(r: SpendReceipt): Promise<void>;
  label(id: string, outcome: Outcome, note?: string): Promise<void>;
}

/** Per-call `fetch` options. `taskClass` lands on the receipt (the seed of a unit of work). */
export interface SpendFetchInit extends RequestInit {
  taskClass?: string;
}

export interface Spend {
  /** Drop-in paid fetch. Records a receipt for every call that reaches payment. */
  fetch(input: RequestInfo | URL, init?: SpendFetchInit): Promise<Response>;
  /** Attach the outcome — the column no bank can fill in. */
  label(id: string, outcome: Outcome, note?: string): Promise<void>;
  /**
   * Id of this meter's most recently recorded receipt, for labeling the call
   * you just made: `meter.label(meter.last()!, "used")`. With calls in flight
   * concurrently, "last" means last to finish — hold onto ids yourself there.
   */
  last(): string | undefined;
}

type Wire = Pick<
  SpendReceipt,
  | "resource"
  | "x402Version"
  | "scheme"
  | "network"
  | "asset"
  | "amountAuthorized"
  | "payTo"
  | "offeredAlternatives"
>;

type Settle = Pick<SpendReceipt, "settled" | "amountSettled" | "transaction" | "payer" | "failure">;

/** One outer call's state. Created per meter.fetch(), carried by AsyncLocalStorage. */
interface CallContext {
  id: string;
  started: number;
  method: string;
  taskClass?: string;
  legs: Leg[];
  paidLegs: number;
  /** Set by onBeforePaymentCreation. Absent → the call never reached payment (free call, not recorded). */
  wire?: Wire;
  /**
   * The parsed 402, captured by the instrumented fetch itself. Spend controls
   * run inside selectPaymentRequirements, BEFORE onBeforePaymentCreation, so a
   * refused offer fires no hook — this is the only wire source for that receipt.
   */
  paymentRequired402?: PaymentRequired;
  /** Set by onPaymentResponse (last write wins across a recovery retry). */
  settle?: Settle;
  /** A leg's fetch itself rejected (network error), as opposed to payload creation failing. */
  transportError?: Error;
}

/**
 * Wire fields for a 402 the client refused before selecting requirements.
 * No offer was accepted, so price the call at the cheapest one (by atomic
 * amount; entries with non-atomic amounts sort last).
 */
function wireFromRefusal(paymentRequired: PaymentRequired): Wire | undefined {
  const accepts = paymentRequired.accepts;
  if (accepts.length === 0) return undefined;
  const atomic = (r: PaymentRequirements) => (/^\d+$/.test(r.amount) ? BigInt(r.amount) : undefined);
  const cheapest = accepts.reduce((best, r) => {
    const a = atomic(r);
    const b = atomic(best);
    return a !== undefined && (b === undefined || a < b) ? r : best;
  });
  const res = paymentRequired.resource;
  return {
    resource: {
      url: res.url,
      serviceName: res.serviceName,
      description: res.description,
      tags: res.tags,
      mimeType: res.mimeType,
    },
    x402Version: paymentRequired.x402Version,
    scheme: cheapest.scheme,
    network: cheapest.network,
    asset: cheapest.asset,
    amountAuthorized: cheapest.amount,
    payTo: cheapest.payTo,
    offeredAlternatives: accepts.length,
  };
}

/**
 * Wraps an already-configured x402Client with metering. The client owns
 * schemes/signers; the meter only observes (its hooks never abort or recover).
 */
export function createMeter(client: x402Client, store: SpendStore, fetchImpl: typeof fetch = fetch): Spend {
  const als = new AsyncLocalStorage<CallContext>();

  client
    .onBeforePaymentCreation(async (ctx) => {
      const call = als.getStore();
      if (!call) return; // client used outside the meter
      const r = ctx.selectedRequirements;
      const res = ctx.paymentRequired.resource;
      call.wire = {
        resource: {
          url: res.url,
          serviceName: res.serviceName,
          description: res.description,
          tags: res.tags,
          mimeType: res.mimeType,
        },
        x402Version: ctx.paymentRequired.x402Version,
        scheme: r.scheme,
        network: r.network,
        asset: r.asset,
        amountAuthorized: r.amount,
        payTo: r.payTo,
        offeredAlternatives: ctx.paymentRequired.accepts.length,
      };
    })
    .onPaymentResponse(async (ctx) => {
      const call = als.getStore();
      if (!call) return;
      const s = ctx.settleResponse;
      call.settle = {
        settled: s?.success === true,
        amountSettled: s?.amount ?? (s?.success ? call.wire?.amountAuthorized : undefined),
        transaction: s?.transaction,
        payer: s?.payer,
        failure: ctx.error
          ? { stage: "transport", reason: ctx.error.message }
          : s && !s.success
            ? { stage: "settle", reason: s.errorReason ?? s.errorMessage }
            : !s && ctx.paymentRequired
              ? { stage: "verify", reason: ctx.paymentRequired.error }
              : undefined,
      };
    });

  // The fetch handed to wrapFetchWithPayment: sees every leg of every call.
  // A leg is paid iff the request carries a payment header; order does the rest.
  const instrumented: typeof fetch = async (input, init) => {
    const call = als.getStore();
    if (!call) return fetchImpl(input, init);
    const request = input instanceof Request ? input : new Request(input, init);
    const paid = request.headers.has("PAYMENT-SIGNATURE") || request.headers.has("X-PAYMENT");
    const kind: Leg["kind"] = paid
      ? call.paidLegs++ === 0
        ? "paid"
        : "recovery"
      : call.legs.length === 0
        ? "initial"
        : "session";
    const t0 = performance.now();
    try {
      const response = await fetchImpl(request);
      if (response.status === 402) {
        const header = response.headers.get("PAYMENT-REQUIRED");
        if (header) {
          try {
            call.paymentRequired402 = decodePaymentRequiredHeader(header);
          } catch {
            // unparseable 402: the wrapper will surface its own error
          }
        }
      }
      const leg: Leg = { kind, status: response.status, ms: Math.round(performance.now() - t0) };
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && response.headers.has("content-length")) leg.bytes = contentLength;
      call.legs.push(leg);
      return response;
    } catch (err) {
      // status 0 = the leg never got a response
      call.legs.push({ kind, status: 0, ms: Math.round(performance.now() - t0) });
      call.transportError = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  };

  const wrapped = wrapFetchWithPayment(instrumented, client);
  let lastId: string | undefined;

  async function finalize(call: CallContext, finalStatus: number | undefined, err?: unknown): Promise<void> {
    // No hook fired: either a free call (nothing to record), or the client
    // refused the offer before onBeforePaymentCreation (spend controls, no
    // matching scheme) — record the refusal, priced at the cheapest offer.
    const wire =
      call.wire ?? (err && call.paymentRequired402 ? wireFromRefusal(call.paymentRequired402) : undefined);
    if (!wire) return;
    const settle: Settle = call.settle ?? { settled: false };
    if (!settle.failure && err) {
      settle.failure = call.transportError
        ? { stage: "transport", reason: call.transportError.message }
        : { stage: "payload", reason: err instanceof Error ? err.message : String(err) };
    }
    const receipt: SpendReceipt = {
      schema: RECEIPT_SCHEMA_VERSION,
      id: call.id,
      ts: new Date(call.started).toISOString(),
      method: call.method,
      ...wire,
      ...settle,
      legs: call.legs,
      totalMs: Date.now() - call.started,
      status: finalStatus ?? call.legs[call.legs.length - 1]?.status ?? 0,
      outcome: "unlabeled",
      taskClass: call.taskClass,
    };
    await store.insert(receipt);
    lastId = call.id;
  }

  return {
    async fetch(input, init) {
      const call: CallContext = {
        id: randomUUID(),
        started: Date.now(),
        method: input instanceof Request ? input.method : (init?.method ?? "GET").toUpperCase(),
        taskClass: init?.taskClass,
        legs: [],
        paidLegs: 0,
      };
      try {
        const response = await als.run(call, () => wrapped(input, init));
        await finalize(call, response.status);
        return response;
      } catch (err) {
        await finalize(call, undefined, err);
        throw err;
      }
    },
    label: (id, outcome, note) => store.label(id, outcome, note),
    last: () => lastId,
  };
}
