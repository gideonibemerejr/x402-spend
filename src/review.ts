/** Publishing a labeled receipt as a review, verified against its settlement. */
import type { Outcome, OutcomeReason, OutcomeRecovery, SpendReceipt } from "./receipt.js";

/** Outcomes that can be published. `unlabeled` is absent: it is not a verdict. */
export type ReviewOutcome = Exclude<Outcome, "unlabeled">;

/**
 * What a client publishes about one settled call, and nothing else.
 *
 * Receipt internals stay local: legs, byte counts, HTTP status, method, offered
 * alternatives and the local receipt id are never sent. `transaction` and
 * `payer` are required because they are what makes the record checkable.
 */
export interface ReviewSubmission {
  schema: 1;
  /** `resource.url` with its query string and fragment stripped. */
  resourceUrl: string;
  taskClass?: string;
  /** CAIP-2 chain identifier, e.g. `eip155:8453`. */
  network: string;
  asset: string;
  /** Settled amount in atomic units. */
  amount: string;
  payTo: string;
  transaction: string;
  payer: string;
  outcome: ReviewOutcome;
  /** Required when the outcome is `not_useful`, absent when it is `useful`. */
  reason?: OutcomeReason;
  recovery?: OutcomeRecovery;
  note?: string;
  paidMs?: number;
  ts: string;
}

/** Everything a label carries besides the outcome itself. */
export interface LabelDetail {
  /** Why the response was not useful. Required on `not_useful`, refused on `useful`. */
  reason?: OutcomeReason;
  /** What the caller did next. Optional everywhere. */
  recovery?: OutcomeRecovery;
  /** Free text alongside the code, so specifics survive without widening the closed set. */
  note?: string;
}

/** Where and how to publish reviews. Off unless configured. */
export interface ReviewOptions {
  /** Full URL of the reviews endpoint, e.g. `https://reviews.example/v1/reviews`. */
  endpoint: string;
  /** Overrides the spend's fetch for review posts only. */
  fetchImpl?: typeof fetch;
  /** Deadline for one post. Defaults to 3 s; a review is never worth stalling a caller. */
  timeoutMs?: number;
}

/**
 * Result of labeling a receipt.
 *
 * `posted` describes only whether the review reached the server. The local
 * label is written first and unconditionally, so `posted: false` never means
 * the label was lost.
 */
export interface LabelResult {
  posted: boolean;
  /** Verification state reported by the server: `verified` once proved, `pending` while it cannot be. */
  status?: "verified" | "pending";
  /** Why the review was not posted, when it was not. */
  error?: string;
}

/** Latency of the payment-bearing leg that delivered the final result. */
function paidMs(receipt: SpendReceipt): number | undefined {
  for (let i = receipt.legs.length - 1; i >= 0; i--) {
    const leg = receipt.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

/**
 * Strips the query string and fragment from a resource URL.
 *
 * Reviews are public, and API keys live in query strings often enough that
 * publishing one unedited would leak a credential. A URL that cannot be parsed
 * is passed through for the server to refuse rather than silently altered.
 */
function publicUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Builds the review for a labeled receipt.
 *
 * @returns The submission, or `undefined` when the receipt has no settlement to
 *   verify — a refused offer or a transport failure leaves nothing checkable.
 */
export function buildSubmission(
  receipt: SpendReceipt,
  outcome: ReviewOutcome,
  verdict: LabelDetail = {}
): ReviewSubmission | undefined {
  if (!receipt.transaction || !receipt.payer) return undefined;
  const amount = receipt.amountSettled ?? receipt.amountAuthorized;
  return {
    schema: 1,
    resourceUrl: publicUrl(receipt.resource.url),
    ...(receipt.taskClass !== undefined ? { taskClass: receipt.taskClass } : {}),
    network: receipt.network,
    asset: receipt.asset,
    amount,
    payTo: receipt.payTo,
    transaction: receipt.transaction,
    payer: receipt.payer,
    outcome,
    ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    ...(verdict.recovery !== undefined ? { recovery: verdict.recovery } : {}),
    ...(verdict.note !== undefined ? { note: verdict.note } : {}),
    ...(paidMs(receipt) !== undefined ? { paidMs: paidMs(receipt) } : {}),
    ts: receipt.ts,
  };
}

/**
 * Posts one review.
 *
 * Never throws: a review server that is down, slow, or unhappy with a
 * submission is not the caller's problem, and must not surface as an error from
 * `label()`. 201 (verified), 200 (already on record) and 202 (parked until the
 * chain can be reached) all count as posted.
 */
export async function postReview(
  submission: ReviewSubmission,
  options: ReviewOptions,
  defaultFetch: typeof fetch
): Promise<LabelResult> {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  try {
    const response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      const detail = await response.text().catch(() => "");
      return { posted: false, error: `review endpoint returned ${response.status}${detail ? `: ${detail}` : ""}` };
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    const status = body.status === "pending" || body.status === "verified" ? body.status : undefined;
    return { posted: true, status: status ?? (response.status === 202 ? "pending" : "verified") };
  } catch (cause: unknown) {
    return { posted: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
