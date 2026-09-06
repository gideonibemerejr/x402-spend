/** Receipt schema and supporting types for recorded x402 client payments. */
import type { PaymentRequirements, ResourceInfo, SettleResponse } from "@x402/core/types";

/**
 * Current version of the persisted receipt schema.
 *
 * Consumers should use this field when migrating stored receipts across future
 * schema changes.
 */
export const RECEIPT_SCHEMA_VERSION = 1;

/**
 * Caller-assigned disposition of a paid response.
 *
 * - `used`: the response contributed to the caller's result.
 * - `retried`: the caller paid again for a replacement response.
 * - `discarded`: the response was valid but not useful.
 * - `failed`: the paid response could not be used because the task failed.
 * - `unlabeled`: no disposition has been assigned yet.
 */
export type Outcome = "used" | "retried" | "discarded" | "failed" | "unlabeled";

/**
 * One HTTP request/response exchange made while resolving a metered fetch.
 *
 * A single logical call can contain an initial 402 response, an optional
 * session negotiation, a paid request, and at most one recovery request.
 */
export interface Leg {
  /**
   * The leg's role in the x402 exchange.
   *
   * `initial` is the first request, `session` uses hook-supplied headers,
   * `paid` carries the first payment payload, and `recovery` carries a second
   * payload after a recoverable payment-response failure.
   */
  kind: "initial" | "session" | "paid" | "recovery";
  /** HTTP response status, or `0` when the transport failed before a response. */
  status: number;
  /** Wall-clock duration of this transport leg in milliseconds. */
  ms: number;
  /** Response size from `Content-Length`, when supplied; response bodies are never consumed for measurement. */
  bytes?: number;
}

/**
 * Client-side record of one HTTP call that reached an x402 payment decision.
 *
 * The receipt combines three ownership domains:
 *
 * - Wire fields reproduce payment requirements and settlement data from the
 *   protocol.
 * - Observed fields describe transport behavior measured by the client.
 * - Outcome fields are supplied by the caller after judging the response.
 *
 * Free requests are not recorded. A refused payment offer can still produce an
 * unsettled receipt when its payment requirements were decoded successfully.
 */
export interface SpendReceipt {
  /** Receipt schema version used when this record was created. */
  schema: typeof RECEIPT_SCHEMA_VERSION;
  /** UUID generated at call start; also suitable for the payment-identifier extension. */
  id: string;
  /** ISO 8601 timestamp captured at the start of the logical call. */
  ts: string;

  // ---- wire ----
  /** Uppercase HTTP method used for the request. */
  method: string;
  /** Server-declared resource metadata, limited to stable receipt fields. */
  resource: Pick<ResourceInfo, "url" | "serviceName" | "description" | "tags" | "mimeType">;
  /** x402 protocol version declared by the server. */
  x402Version: number;
  /** Payment scheme selected by the client, such as `exact`. */
  scheme: PaymentRequirements["scheme"];
  /** CAIP-2 network identifier selected for payment. */
  network: PaymentRequirements["network"];
  /** Asset identifier from the selected payment requirements. */
  asset: string;
  /** Maximum amount authorized, in the asset's atomic units. */
  amountAuthorized: string;
  /** Recipient address from the selected payment requirements. */
  payTo: string;
  /** Number of payment options in the server's `accepts` array. */
  offeredAlternatives: number;
  /** Whether the facilitator reported a successful settlement. */
  settled: boolean;
  /** Amount actually settled in atomic units; may be below authorization for the `upto` scheme. */
  amountSettled?: string;
  /** Settlement transaction identifier supplied by the facilitator. */
  transaction?: SettleResponse["transaction"];
  /** Payer identifier supplied by the settlement response. */
  payer?: string;
  /** Failure classification and optional protocol or transport reason. */
  failure?: {
    /** Operation that prevented successful settlement or delivery. */
    stage: "verify" | "settle" | "transport" | "payload";
    /** Human-readable reason supplied by the SDK, facilitator, or thrown error. */
    reason?: string;
  };

  // ---- observed ----
  /** Ordered transport legs observed during the logical call. */
  legs: Leg[];
  /** End-to-end duration in milliseconds, including client-side work between legs. */
  totalMs: number;
  /** Final HTTP status returned to the caller, or `0` if no response was received. */
  status: number;

  // ---- outcome ----
  /** Caller-assigned disposition; initialized to `unlabeled`. */
  outcome: Outcome;
  /** Optional caller-supplied explanation for the assigned outcome. */
  outcomeNote?: string;
  /** Caller-supplied work category, such as `web-search` or `geocode`. */
  taskClass?: string;
}
