/** Pure aggregation and text formatting for x402 spend reports. */
import type { SpendReceipt } from "./receipt.js";

/** Aggregated spend and latency statistics for one exact resource URL. */
export interface EndpointStats {
  /** Exact `resource.url` shared by receipts in this group, including its query string. */
  resourceUrl: string;
  /** Number of receipts in the group. */
  calls: number;
  /** Number of receipts whose settlement succeeded. */
  settledCalls: number;
  /** Atomic units actually settled (settled calls only; `upto` settles less than authorized). */
  spendAtomic: bigint;
  /** Median effective cost of `used` receipts; unsettled receipts contribute zero. */
  medianCostPerUsedAtomic?: bigint;
  /** Number of receipts labeled `used`, whether settled or not. */
  usedCalls: number;
  /** Nearest-rank 50th percentile latency of final payment-bearing legs, in milliseconds. */
  p50PaidMs?: number;
  /** Nearest-rank 95th percentile latency of final payment-bearing legs, in milliseconds. */
  p95PaidMs?: number;
}

/** Aggregated report data ready for text or programmatic presentation. */
export interface Report {
  /** Optional lower-bound timestamp displayed in formatted output. */
  since?: Date;
  /** Per-URL statistics sorted by descending settled spend. */
  endpoints: EndpointStats[];
  /** Counts and settled spend across every endpoint in the report. */
  totals: {
    /** Total number of receipts. */
    calls: number;
    /** Total number of successfully settled receipts. */
    settledCalls: number;
    /** Total successfully settled amount in atomic units. */
    spendAtomic: bigint;
  };
}

/**
 * Parses a report time boundary from a duration or date string.
 *
 * Supported duration suffixes are minutes (`m`), hours (`h`), days (`d`), and
 * weeks (`w`). Other inputs are delegated to `Date.parse`.
 *
 * @param input - Duration such as `30m`, `24h`, `7d`, or `2w`, or a parseable date.
 * @param now - Reference time for duration subtraction; defaults to the current time.
 * @returns The absolute lower-bound timestamp.
 * @throws When `input` is neither a supported duration nor a parseable date.
 */
export function parseSince(input: string, now: Date = new Date()): Date {
  const m = /^(\d+)([mhdw])$/.exec(input.trim());
  if (m) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"];
    return new Date(now.getTime() - Number(m[1]) * ms);
  }
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) throw new Error(`x402-spend: cannot parse --since ${JSON.stringify(input)}; use 30m, 24h, 7d, 2w, or a date`);
  return new Date(parsed);
}

/**
 * Returns the effective settled amount for aggregation.
 *
 * @param receipt - Receipt to price.
 * @returns Zero for unsettled calls; otherwise the settled or authorized atomic amount.
 */
function settledAmount(receipt: SpendReceipt): bigint {
  if (!receipt.settled) return 0n;
  return BigInt(receipt.amountSettled ?? receipt.amountAuthorized);
}

/**
 * Finds latency for the payment-bearing leg that delivered the final result.
 *
 * @param receipt - Receipt whose legs should be inspected.
 * @returns Recovery latency when present, paid latency otherwise, or `undefined`.
 */
function paidMs(receipt: SpendReceipt): number | undefined {
  for (let i = receipt.legs.length - 1; i >= 0; i--) {
    const leg = receipt.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

/**
 * Calculates the integer median of an ascending bigint collection.
 *
 * Even-sized collections use integer division and therefore round toward zero.
 */
function medianBigint(sorted: bigint[]): bigint | undefined {
  if (sorted.length === 0) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** Returns the nearest-rank percentile from an ascending numeric collection. */
function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/**
 * Aggregates receipts into per-endpoint and overall spend statistics.
 *
 * Grouping uses the exact `resource.url`, including query strings. Amounts stay
 * as `bigint` atomic units until presentation to avoid precision loss.
 *
 * This function does not filter by `since`; callers should provide an already
 * filtered receipt collection. The timestamp is retained only for report
 * metadata and display.
 *
 * @param receipts - Receipts to aggregate.
 * @param since - Optional lower-bound metadata associated with `receipts`.
 * @returns Deterministically ordered report data.
 */
export function buildReport(receipts: SpendReceipt[], since?: Date): Report {
  const byUrl = new Map<string, SpendReceipt[]>();
  for (const r of receipts) {
    const list = byUrl.get(r.resource.url) ?? [];
    list.push(r);
    byUrl.set(r.resource.url, list);
  }

  const endpoints: EndpointStats[] = [...byUrl.entries()].map(([resourceUrl, rs]) => {
    const settled = rs.filter((r) => r.settled);
    const used = rs.filter((r) => r.outcome === "used");
    const usedCosts = used.map(settledAmount).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const paid = rs.map(paidMs).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
    return {
      resourceUrl,
      calls: rs.length,
      settledCalls: settled.length,
      spendAtomic: settled.reduce((sum, r) => sum + settledAmount(r), 0n),
      medianCostPerUsedAtomic: medianBigint(usedCosts),
      usedCalls: used.length,
      p50PaidMs: percentile(paid, 50),
      p95PaidMs: percentile(paid, 95),
    };
  });
  endpoints.sort((a, b) => (a.spendAtomic < b.spendAtomic ? 1 : a.spendAtomic > b.spendAtomic ? -1 : 0));

  return {
    since,
    endpoints,
    totals: {
      calls: receipts.length,
      settledCalls: endpoints.reduce((n, e) => n + e.settledCalls, 0),
      spendAtomic: endpoints.reduce((sum, e) => sum + e.spendAtomic, 0n),
    },
  };
}

/**
 * Formats an integer atomic amount as a fixed-point decimal string.
 *
 * @param amount - Signed amount in atomic units.
 * @param decimals - Non-negative number of asset decimal places.
 * @returns Fixed-point value without locale-specific separators.
 *
 * @example
 * formatAtomic(5001n, 6); // "0.005001"
 */
export function formatAtomic(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals) || "0";
  const frac = decimals > 0 ? `.${abs.slice(abs.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/**
 * Renders report data as an aligned plain-text table.
 *
 * @param report - Aggregated data produced by {@link buildReport}.
 * @param options - Formatting options.
 * @param options.decimals - Asset decimals used to display atomic amounts; defaults to `6`.
 * @returns A complete report suitable for terminal output.
 */
export function formatReport(
  report: Report,
  options: {
    /** Asset decimals used to display atomic amounts; defaults to `6`. */
    decimals?: number;
  } = {}
): string {
  const decimals = options.decimals ?? 6;
  const fmt = (amount: bigint) => formatAtomic(amount, decimals);
  const pct = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((100 * n) / of)}%`);
  const ms = (e: EndpointStats) => (e.p50PaidMs === undefined ? "-" : `${e.p50PaidMs}/${e.p95PaidMs}`);

  const rows = report.endpoints.map((e) => [
    e.resourceUrl,
    String(e.calls),
    pct(e.settledCalls, e.calls),
    fmt(e.spendAtomic),
    e.medianCostPerUsedAtomic === undefined ? `- (0 used)` : `${fmt(e.medianCostPerUsedAtomic)} (${e.usedCalls} used)`,
    ms(e),
  ]);
  rows.push([
    "TOTAL",
    String(report.totals.calls),
    pct(report.totals.settledCalls, report.totals.calls),
    fmt(report.totals.spendAtomic),
    "",
    "",
  ]);

  const header = ["ENDPOINT", "CALLS", "SETTLED", "SPEND", "MED COST/USED", "P50/P95 PAID MS"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd();

  const period = report.since ? `since ${report.since.toISOString()}` : "all time";
  return [
    `x402-spend report — ${period} · amounts are atomic units ÷ 10^${decimals}`,
    "",
    line(header),
    ...rows.map(line),
  ].join("\n");
}
