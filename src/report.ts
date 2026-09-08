/** Pure aggregation and text formatting for x402 spend reports. */
import type { SpendReceipt } from "./receipt.js";

/** Identifies one denomination. Asset identifiers are kept exactly as recorded. */
export interface Denomination {
  network: string;
  asset: string;
}

/** Counts and monetary data for one asset on one network. */
export interface DenominationStats extends Denomination {
  calls: number;
  settledCalls: number;
  /** Sum of valid settled amounts only; partial when invalidAmountCalls is nonzero. */
  spendAtomic: bigint;
  /**
   * Spend on calls that were not useful. Waste, regardless of how the caller
   * recovered: retrying and going elsewhere both cost money and both follow the
   * same failure.
   */
  wasteAtomic: bigint;
  /** Calls labeled `useful`. Unlabeled calls count as neither. */
  usefulCalls: number;
  notUsefulCalls: number;
  /** Settled receipts excluded from monetary statistics because their amount is invalid. */
  invalidAmountCalls: number;
}

/** Statistics for one exact resource URL and denomination. */
export interface EndpointStats extends DenominationStats {
  resourceUrl: string;
  /** Median price of settled `useful` samples; unsettled calls are unpriced, not zero. */
  medianCostPerUsefulAtomic?: bigint;
  /** Useful calls that carry a valid settled price and back the median. */
  costSamples: number;
  /** Useful calls that never settled; unpriced, so they are kept out of the median. */
  unsettledUsefulCalls: number;
  p50PaidMs?: number;
  p95PaidMs?: number;
}

export interface Report {
  /** Display metadata only; callers supply already-filtered receipts. */
  since?: Date;
  /** Sorted by denomination, then descending spend within that denomination. */
  endpoints: EndpointStats[];
  /** Counts across all denominations, never a combined monetary total. */
  totals: { calls: number; settledCalls: number; invalidAmountCalls: number };
  denominations: DenominationStats[];
}

/** Explicit formatting metadata; unknown denominations remain in atomic units. */
export interface AssetDecimals extends Denomination {
  decimals: number;
}

/** Duration (30m, 24h, 7d, 2w) or parseable date → report time boundary. */
export function parseSince(input: string, now: Date = new Date()): Date {
  const m = /^(\d+)([mhdw])$/.exec(input.trim());
  const ms = m
    ? { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "m" | "h" | "d" | "w"]
    : 0;
  const parsed = new Date(m ? now.getTime() - Number(m[1]) * ms : Date.parse(input));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`x402-spend: cannot parse --since ${JSON.stringify(input)}; use 30m, 24h, 7d, 2w, or a date`);
  }
  return parsed;
}

/** Undefined denotes invalid monetary data, not a zero-cost settlement. */
function settledAmount(receipt: SpendReceipt): bigint | undefined {
  if (!receipt.settled) return 0n;
  const amount = receipt.amountSettled ?? receipt.amountAuthorized;
  return typeof amount === "string" && /^\d+$/.test(amount) ? BigInt(amount) : undefined;
}

function paidMs(receipt: SpendReceipt): number | undefined {
  for (let i = receipt.legs.length - 1; i >= 0; i--) {
    const leg = receipt.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

function medianBigint(sorted: bigint[]): bigint | undefined {
  if (sorted.length === 0) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const denominationKey = (d: Denomination) => JSON.stringify([d.network, d.asset]);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Groups by exact URL, network, and asset; keeps monetary arithmetic in BigInt.
 * `since` is display metadata only, not a filter. Invalid settled amounts are
 * excluded from monetary statistics and counted; receipt and settlement counts
 * still include those calls. Unsettled `used` calls have no price, so they are
 * counted separately rather than entering the median as zero. No currency
 * conversion is performed.
 */
export function buildReport(receipts: SpendReceipt[], since?: Date): Report {
  const groups = new Map<string, SpendReceipt[]>();
  for (const r of receipts) {
    const key = JSON.stringify([r.network, r.asset, r.resource.url]);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const endpoints: EndpointStats[] = [...groups.values()].map((rs) => {
    const amounts = rs.map(settledAmount);
    const usefulCosts = amounts.filter((amount, i): amount is bigint =>
      rs[i].outcome === "useful" && rs[i].settled && amount !== undefined
    ).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const paid = rs.map(paidMs).filter((ms): ms is number => ms !== undefined).sort((a, b) => a - b);
    return {
      resourceUrl: rs[0].resource.url,
      network: rs[0].network,
      asset: rs[0].asset,
      calls: rs.length,
      settledCalls: rs.filter((r) => r.settled).length,
      spendAtomic: amounts.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n),
      wasteAtomic: amounts.reduce<bigint>(
        (sum, amount, i) => sum + (rs[i].outcome === "not_useful" ? (amount ?? 0n) : 0n), 0n),
      usefulCalls: rs.filter((r) => r.outcome === "useful").length,
      notUsefulCalls: rs.filter((r) => r.outcome === "not_useful").length,
      invalidAmountCalls: amounts.filter((amount) => amount === undefined).length,
      medianCostPerUsefulAtomic: medianBigint(usefulCosts),
      costSamples: usefulCosts.length,
      unsettledUsefulCalls: rs.filter((r) => r.outcome === "useful" && !r.settled).length,
      p50PaidMs: percentile(paid, 50),
      p95PaidMs: percentile(paid, 95),
    };
  });
  endpoints.sort((a, b) => compareText(a.network, b.network) || compareText(a.asset, b.asset) ||
    (a.spendAtomic < b.spendAtomic ? 1 : a.spendAtomic > b.spendAtomic ? -1 : 0) ||
    compareText(a.resourceUrl, b.resourceUrl));

  const denominations = new Map<string, DenominationStats>();
  for (const e of endpoints) {
    const key = denominationKey(e);
    const total = denominations.get(key) ?? {
      network: e.network, asset: e.asset, calls: 0, settledCalls: 0, spendAtomic: 0n,
      wasteAtomic: 0n, usefulCalls: 0, notUsefulCalls: 0, invalidAmountCalls: 0,
    };
    total.calls += e.calls;
    total.settledCalls += e.settledCalls;
    total.spendAtomic += e.spendAtomic;
    total.wasteAtomic += e.wasteAtomic;
    total.usefulCalls += e.usefulCalls;
    total.notUsefulCalls += e.notUsefulCalls;
    total.invalidAmountCalls += e.invalidAmountCalls;
    denominations.set(key, total);
  }
  return {
    since, endpoints, denominations: [...denominations.values()],
    totals: {
      calls: receipts.length,
      settledCalls: endpoints.reduce((sum, e) => sum + e.settledCalls, 0),
      invalidAmountCalls: endpoints.reduce((sum, e) => sum + e.invalidAmountCalls, 0),
    },
  };
}

/** Fixed-point formatting with bounded decimal places (0–255). */
function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("x402-spend: decimals must be an integer from 0 to 255");
  }
}

export function formatAtomic(amount: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = amount < 0n;
  const abs = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals) || "0";
  const frac = decimals > 0 ? `.${abs.slice(abs.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

/** Render a separate labeled table per denomination; default to atomic units. */
export function formatReport(
  report: Report,
  options: {
    /** Convenience override allowed only when the report has a single denomination. */
    decimals?: number;
    /** Per-network/asset decimal configuration takes precedence over the convenience override. */
    assetDecimals?: AssetDecimals[];
  } = {}
): string {
  if (options.decimals !== undefined) {
    assertDecimals(options.decimals);
    if (report.denominations.length > 1) {
      throw new Error("x402-spend: --decimals requires a single denomination; use --asset-decimals for each network/asset");
    }
  }
  const scales = new Map<string, number>();
  for (const entry of options.assetDecimals ?? []) {
    assertDecimals(entry.decimals);
    const key = denominationKey(entry);
    if (scales.has(key) && scales.get(key) !== entry.decimals) {
      throw new Error(`x402-spend: conflicting decimals for ${entry.network}/${entry.asset}`);
    }
    scales.set(key, entry.decimals);
  }
  const period = report.since ? `since ${report.since.toISOString()}` : "all time";
  const output = [`x402-spend report — ${period} · ${report.totals.calls} calls · ${report.totals.settledCalls} settled`];
  if (report.denominations.length === 0) output.push("", "No receipts in this period.");
  const pct = (n: number, of: number) => of === 0 ? "-" : `${Math.round((100 * n) / of)}%`;
  for (const d of report.denominations) {
    const decimals = scales.get(denominationKey(d)) ?? options.decimals;
    const fmt = (amount: bigint) => decimals === undefined ? String(amount) : formatAtomic(amount, decimals);
    const endpoints = report.endpoints.filter((e) => e.network === d.network && e.asset === d.asset);
    const rows = endpoints.map((e) => [
      e.resourceUrl, String(e.calls), pct(e.settledCalls, e.calls), fmt(e.spendAtomic),
      `${e.medianCostPerUsefulAtomic === undefined ? "-" : fmt(e.medianCostPerUsefulAtomic)} (${e.costSamples === e.usefulCalls ? `${e.usefulCalls} useful` : `${e.costSamples}/${e.usefulCalls} useful samples`})`,
      e.p50PaidMs === undefined ? "-" : `${e.p50PaidMs}/${e.p95PaidMs}`,
    ]);
    rows.push(["TOTAL", String(d.calls), pct(d.settledCalls, d.calls), fmt(d.spendAtomic), "", ""]);
    const header = ["ENDPOINT", "CALLS", "SETTLED", "SPEND", "MED COST/USEFUL", "P50/P95 PAID MS"];
    const widths = header.map((h, i) => rows.reduce((width, row) => Math.max(width, row[i].length), h.length));
    const line = (cells: string[]) => cells.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join("  ").trimEnd();
    // Waste and cost per useful result lead; raw spend is the second question.
    // What a run cost is spend divided by the results that were worth having,
    // and everything spent reaching a not-useful answer counts against it.
    const costPerUseful = d.usefulCalls === 0 ? undefined : d.spendAtomic / BigInt(d.usefulCalls);
    output.push("", `${d.network} · ${d.asset} · amounts are atomic units${decimals === undefined ? " (decimals unknown)" : ` ÷ 10^${decimals}`}`);
    output.push(
      `${d.usefulCalls} useful · ${d.notUsefulCalls} not useful · ` +
      `waste ${fmt(d.wasteAtomic)} · ` +
      `cost per useful result ${costPerUseful === undefined ? "-" : fmt(costPerUseful)}`
    );
    if (d.invalidAmountCalls) {
      output.push(`WARNING: ${d.invalidAmountCalls} settled receipt(s) with invalid amounts excluded from monetary statistics; spend is partial.`);
    }
    output.push("", line(header), ...rows.map(line));
  }
  return output.join("\n");
}
