/**
 * x402-spend receipt (schema 1)
 *
 * One row per paid HTTP call. Assembled client-side from three sources, and the
 * sections matter because they have different owners:
 *
 *   wire     – what the protocol carries. Field names track @x402/core types.
 *   observed – what only the client can measure: latency per leg, status, bytes.
 *   outcome  – what only the caller can say: did the thing we paid for work.
 *
 * Nothing in the wire or observed sections is opinion. The outcome section is
 * the reason this package exists.
 */
import type { PaymentRequirements, ResourceInfo, SettleResponse } from "@x402/core/types";

export const RECEIPT_SCHEMA_VERSION = 1;

export type Outcome = "used" | "retried" | "discarded" | "failed" | "unlabeled";

export interface Leg {
  /** "initial" = first request (expects 402), "paid" = retry with PAYMENT-SIGNATURE, "recovery" = second paid attempt after a recoverable failure, "session" = hook-supplied headers (e.g. wallet session) */
  kind: "initial" | "session" | "paid" | "recovery";
  status: number;
  ms: number;
  /** From Content-Length when present; the meter never reads the body */
  bytes?: number;
}

export interface SpendReceipt {
  schema: typeof RECEIPT_SCHEMA_VERSION;
  /** UUID generated at call start. Also usable as an idempotency key for the payment-identifier extension. */
  id: string;
  /** ISO-8601, call start */
  ts: string;

  // ---- wire ----
  method: string;
  resource: Pick<ResourceInfo, "url" | "serviceName" | "description" | "tags" | "mimeType">;
  x402Version: number;
  scheme: PaymentRequirements["scheme"];
  network: PaymentRequirements["network"];
  asset: string;
  /** Atomic units, from the accepted requirements */
  amountAuthorized: string;
  payTo: string;
  /** How many payment options the server offered (accepts.length) */
  offeredAlternatives: number;
  settled: boolean;
  /** Atomic units actually settled; differs from authorized under the `upto` scheme */
  amountSettled?: string;
  transaction?: SettleResponse["transaction"];
  payer?: string;
  failure?: { stage: "verify" | "settle" | "transport" | "payload"; reason?: string };

  // ---- observed ----
  legs: Leg[];
  /** Sum of leg durations plus client-side work between them */
  totalMs: number;
  /** Final HTTP status returned to the caller */
  status: number;

  // ---- outcome ----
  outcome: Outcome;
  outcomeNote?: string;
  /** Caller-supplied bucket ("web-search", "geocode"). This is the seed of a unit of work. */
  taskClass?: string;
}
