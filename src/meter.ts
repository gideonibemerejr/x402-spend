/** Meter creation and per-call x402 payment instrumentation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { RECEIPT_SCHEMA_VERSION, type Leg, type Outcome, type SpendReceipt } from "./receipt.js";

/**
 * Persistence contract required by {@link createMeter}.
 *
 * Implementations may store receipts locally or remotely, but should preserve
 * receipt IDs and make label updates durable before resolving.
 */
export interface SpendStore {
  /**
   * Persists a finalized receipt.
   *
   * @param receipt - Receipt assembled after the paid call returns or throws.
   * @returns A promise that resolves after the receipt is durable.
   */
  insert(receipt: SpendReceipt): Promise<void>;
  /**
   * Updates the caller-assigned outcome for a stored receipt.
   *
   * @param id - Receipt UUID returned by {@link Spend.last} or retained by the caller.
   * @param outcome - New disposition of the paid result.
   * @param note - Optional explanation for the disposition.
   * @returns A promise that resolves after the update is durable.
   * @throws When no receipt exists for `id`, or when persistence fails.
   */
  label(id: string, outcome: Outcome, note?: string): Promise<void>;
}

/** Options accepted by {@link Spend.fetch}. */
export interface SpendFetchInit extends RequestInit {
  /** Optional caller-defined category copied onto the receipt for later aggregation. */
  taskClass?: string;
}

/**
 * Instrumented x402 client returned by {@link createMeter}.
 *
 * It behaves like `fetch` for callers while recording only requests that reach
 * a payment decision. It does not modify the client's schemes, signers, or
 * spend controls.
 */
export interface Spend {
  /**
   * Performs an HTTP request through the configured x402 client.
   *
   * Free responses pass through without a receipt. Paid attempts and decoded
   * payment refusals are finalized in the store before this promise settles.
   *
   * @param input - Request URL or existing `Request`.
   * @param init - Standard fetch options plus an optional task classification.
   * @returns The final response produced by the x402 wrapper.
   * @throws The original request, payment creation, or persistence error.
   */
  fetch(input: RequestInfo | URL, init?: SpendFetchInit): Promise<Response>;
  /**
   * Assigns a caller-known outcome to a stored receipt.
   *
   * @param id - Receipt UUID to update.
   * @param outcome - Whether the paid result was used, retried, discarded, or failed.
   * @param note - Optional explanation for the outcome.
   * @returns A promise that resolves after the store applies the label.
   */
  label(id: string, outcome: Outcome, note?: string): Promise<void>;
  /**
   * Returns the ID of the receipt most recently finalized by this meter.
   *
   * With concurrent calls, “most recent” means the last call to finish, not the
   * last one started. Concurrent callers should retain their own receipt IDs.
   *
   * @returns The latest receipt UUID, or `undefined` before any receipt exists.
   */
  last(): string | undefined;
}

/** Protocol fields collected before payment creation. */
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

/** Settlement fields collected after a payment response. */
type Settle = Pick<SpendReceipt, "settled" | "amountSettled" | "transaction" | "payer" | "failure">;

/** Mutable state for one logical call, isolated through `AsyncLocalStorage`. */
interface CallContext {
  /** Receipt UUID allocated when the outer call starts. */
  id: string;
  /** Epoch milliseconds captured when the outer call starts. */
  started: number;
  /** Normalized HTTP method recorded on the receipt. */
  method: string;
  /** Optional caller-defined work category. */
  taskClass?: string;
  /** Transport legs in request order. */
  legs: Leg[];
  /** Number of payment-bearing legs seen, used to distinguish recovery. */
  paidLegs: number;
  /** Fields captured by `onBeforePaymentCreation`; absent for free calls and early refusals. */
  wire?: Wire;
  /**
   * The parsed 402, captured by the instrumented fetch itself. Spend controls
   * run inside selectPaymentRequirements, BEFORE onBeforePaymentCreation, so a
   * refused offer fires no hook — this is the only wire source for that receipt.
   */
  paymentRequired402?: PaymentRequired;
  /** Fields captured by `onPaymentResponse`; the recovery response wins when present. */
  settle?: Settle;
  /** Transport rejection, distinguished from payment-payload creation failures. */
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
 * Wraps an already-configured x402 client with spend metering.
 *
 * The supplied client continues to own schemes, signers, selection, and spend
 * controls. The meter registers additive observation hooks but never aborts,
 * recovers, filters, or otherwise controls a payment. Use one meter per client
 * because x402 client hook registration is permanent.
 *
 * Each logical call runs in its own `AsyncLocalStorage` context. This keeps
 * concurrent calls isolated even when they target the same URL. Transport legs
 * supply status, latency, and byte counts; client hooks supply protocol and
 * settlement fields.
 *
 * @param client - Configured x402 client containing the caller's schemes and signers.
 * @param store - Destination for finalized receipts and later outcome labels.
 * @param fetchImpl - Fetch implementation to instrument; defaults to global `fetch`.
 * @returns A metered fetch interface bound to `client` and `store`.
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

  /**
   * Fetch implementation supplied to `wrapFetchWithPayment` so every transport
   * leg can be measured inside its logical call context.
   */
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

  /**
   * Builds and persists a receipt if the call reached a payment decision.
   *
   * @param call - Isolated state accumulated for the logical call.
   * @param finalStatus - HTTP status ultimately returned to the caller.
   * @param err - Error thrown while resolving the call, when applicable.
   */
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
