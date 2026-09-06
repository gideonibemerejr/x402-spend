/** Spend creation and per-call x402 payment instrumentation. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { RECEIPT_SCHEMA_VERSION, type Leg, type Outcome, type SpendReceipt } from "./receipt.js";
import { buildSubmission, postReview, type LabelResult, type ReviewOptions } from "./review.js";

/**
 * Persistence contract required by {@link createSpend}.
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
  /**
   * Reads back a stored receipt.
   *
   * Needed to publish a review, which is assembled from the receipt rather than
   * from whatever the caller happens to still hold.
   *
   * @param id - Receipt UUID.
   * @returns The receipt, or `undefined` when no receipt has that id.
   */
  get(id: string): Promise<SpendReceipt | undefined>;
}

/**
 * Receipt persistence failed. `cause` is the storage error; `receipt` can be
 * inspected or retained for storage recovery without repeating the paid call.
 * A response means the request returned before persistence failed. It does not
 * imply settlement succeeded: inspect the receipt's settlement fields.
 * Custom stores may reject after committing, so retry safety belongs to the store.
 */
export class SpendPersistenceError extends Error {
  readonly receipt: SpendReceipt;
  readonly response?: Response;
  readonly requestError?: unknown;

  constructor(receipt: SpendReceipt, cause: unknown, result: CallResult) {
    super("x402-spend: receipt persistence failed; the payment may already have completed", { cause });
    this.name = "SpendPersistenceError";
    this.receipt = receipt;
    if (result.ok) this.response = result.response;
    else this.requestError = result.error;
  }
}

/**
 * Init fields the `Request` constructor already carries, plus this package's own
 * `taskClass`. Everything else a caller passed is framework territory and is
 * forwarded to the transport untouched.
 */
const STANDARD_INIT_KEYS = new Set([
  "method", "headers", "body", "mode", "credentials", "cache", "redirect",
  "referrer", "referrerPolicy", "integrity", "keepalive", "signal", "window",
  "duplex", "priority", "taskClass",
]);

/**
 * Extracts the init fields a `Request` would silently drop.
 *
 * Frameworks extend `fetch` with their own options — Next.js reads
 * `next: { revalidate, tags }` — and constructing a `Request` throws those away.
 * Only the non-standard keys are forwarded, so a caller's init can never
 * overwrite the headers or body the payment wrapper put on the request.
 *
 * @returns The extra fields, or `undefined` when the caller passed none, which
 *   leaves the common path calling `fetchImpl` exactly as before.
 */
function initExtrasFrom(init?: SpendFetchInit): Record<string, unknown> | undefined {
  if (!init) return undefined;
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(init)) {
    if (!STANDARD_INIT_KEYS.has(key)) extras[key] = value;
  }
  return Object.keys(extras).length > 0 ? extras : undefined;
}

/** Explicit outcome also preserves falsy thrown values, including undefined. */
type CallResult = { ok: true; response: Response } | { ok: false; error: unknown };

/** Wiring for {@link createSpend}. */
export interface SpendOptions {
  /** Fetch implementation to instrument; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Where to publish labeled receipts as verified reviews. Omit or pass `false`
   * to keep receipts local, which is the default: publishing is opt-in per
   * spend because a review is public and names the payer address.
   */
  review?: ReviewOptions | false;
}

/** Options accepted by {@link Spend.fetch}. */
export interface SpendFetchInit extends RequestInit {
  /** Optional caller-defined category copied onto the receipt for later aggregation. */
  taskClass?: string;
}

/**
 * Instrumented x402 client returned by {@link createSpend}.
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
   * @throws The original request/payment error, or `SpendPersistenceError` if recording fails.
   */
  fetch(input: RequestInfo | URL, init?: SpendFetchInit): Promise<Response>;
  /**
   * Assigns a caller-known outcome to a stored receipt.
   *
   * The local write happens first and always. When review posting is
   * configured, the label is then published as a review verified against the
   * receipt's settlement; a failed post is reported, never thrown, and never
   * undoes the local label.
   *
   * @param id - Receipt UUID to update.
   * @param outcome - Whether the paid result was used, retried, discarded, or failed.
   * @param note - Optional explanation for the outcome.
   * @returns Whether a review was published, and why not when it was not.
   */
  label(id: string, outcome: Outcome, note?: string): Promise<LabelResult>;
  /**
   * Returns the ID of the receipt most recently finalized by this spend.
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
  /** Non-standard init fields the caller supplied, forwarded to every transport leg. */
  initExtras?: Record<string, unknown>;
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
 * controls. It registers additive observation hooks but never aborts,
 * recovers, filters, or otherwise controls a payment. Use one spend per client
 * because x402 client hook registration is permanent.
 *
 * Each logical call runs in its own `AsyncLocalStorage` context. This keeps
 * concurrent calls isolated even when they target the same URL. Transport legs
 * supply status, latency, and byte counts; client hooks supply protocol and
 * settlement fields.
 *
 * @param client - Configured x402 client containing the caller's schemes and signers.
 * @param store - Destination for finalized receipts and later outcome labels.
 * @param options - Fetch implementation to instrument, and optional review publishing.
 * @returns A metered fetch interface bound to `client` and `store`.
 */
export function createSpend(client: x402Client, store: SpendStore, options?: SpendOptions): Spend;
/**
 * @deprecated Pass `{ fetchImpl }` instead. The positional form is accepted for
 * one release so 0.2 callers keep working, and is removed in 0.4.
 */
export function createSpend(client: x402Client, store: SpendStore, fetchImpl: typeof fetch): Spend;
export function createSpend(
  client: x402Client,
  store: SpendStore,
  optionsOrFetch: SpendOptions | typeof fetch = {}
): Spend {
  const options: SpendOptions =
    typeof optionsOrFetch === "function" ? { fetchImpl: optionsOrFetch } : optionsOrFetch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const review = options.review === false ? undefined : options.review;
  const als = new AsyncLocalStorage<CallContext>();

  client
    .onBeforePaymentCreation(async (ctx) => {
      const call = als.getStore();
      if (!call) return; // client used outside the spend
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
      const response = call.initExtras
        ? await fetchImpl(request, call.initExtras as RequestInit)
        : await fetchImpl(request);
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
   * @param result - Response or rejection from the request, before persistence.
   */
  async function finalize(call: CallContext, result: CallResult): Promise<void> {
    const err = result.ok ? undefined : result.error;
    // No hook fired: either a free call (nothing to record), or the client
    // refused the offer before onBeforePaymentCreation (spend controls, no
    // matching scheme) — record the refusal, priced at the cheapest offer.
    const wire =
      call.wire ?? (!result.ok && call.paymentRequired402 ? wireFromRefusal(call.paymentRequired402) : undefined);
    if (!wire) return;
    const settle: Settle = { ...(call.settle ?? { settled: false }) };
    if (!settle.failure && !result.ok) {
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
      status: result.ok ? result.response.status : (call.legs[call.legs.length - 1]?.status ?? 0),
      outcome: "unlabeled",
      taskClass: call.taskClass,
    };
    try {
      await store.insert(receipt);
    } catch (cause) {
      throw new SpendPersistenceError(receipt, cause, result);
    }
    lastId = call.id;
  }

  return {
    async fetch(input, init) {
      const request = new Request(input, init);
      const call: CallContext = {
        id: randomUUID(),
        started: Date.now(),
        method: request.method,
        taskClass: init?.taskClass,
        initExtras: initExtrasFrom(init),
        legs: [],
        paidLegs: 0,
      };
      let result: CallResult;
      try {
        result = { ok: true, response: await als.run(call, () => wrapped(request)) };
      } catch (error) {
        result = { ok: false, error };
      }
      await finalize(call, result);
      if (!result.ok) throw result.error;
      return result.response;
    },
    async label(id, outcome, note) {
      // The local write happens first and always; publishing is best effort.
      await store.label(id, outcome, note);
      if (!review) return { posted: false };
      if (outcome === "unlabeled") {
        return { posted: false, error: "unlabeled is not a publishable verdict" };
      }
      const receipt = await store.get(id);
      if (!receipt) return { posted: false, error: `no receipt with id ${id}` };
      const submission = buildSubmission(receipt, outcome, note);
      if (!submission) return { posted: false, error: "no settlement to verify" };
      return postReview(submission, review, fetchImpl);
    },
    last: () => lastId,
  };
}
