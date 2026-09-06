/**
 * Report aggregation, pure functions over receipts so the numbers are testable
 * without a terminal. The CLI (`cli.ts`) does the parsing and printing.
 *
 * Spend is summed in atomic units (BigInt — amounts are strings on the wire)
 * and only formatted at the edge, with a configurable `decimals` (default 6,
 * USDC). The report says which power of ten it divided by.
 */
import type { SpendReceipt } from "./receipt.js";

export interface EndpointStats {
  resourceUrl: string;
  calls: number;
  settledCalls: number;
  /** Atomic units actually settled (settled calls only; `upto` settles less than authorized). */
  spendAtomic: bigint;
  /** Median settled cost across receipts labeled `used`. Undefined until something is labeled. */
  medianCostPerUsedAtomic?: bigint;
  usedCalls: number;
  p50PaidMs?: number;
  p95PaidMs?: number;
}

export interface Report {
  since?: Date;
  endpoints: EndpointStats[];
  totals: { calls: number; settledCalls: number; spendAtomic: bigint };
}

/** "30m" | "24h" | "7d" | "2w" | ISO date → Date. */
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

function settledAmount(r: SpendReceipt): bigint {
  if (!r.settled) return 0n;
  return BigInt(r.amountSettled ?? r.amountAuthorized);
}

function paidMs(r: SpendReceipt): number | undefined {
  for (let i = r.legs.length - 1; i >= 0; i--) {
    const leg = r.legs[i];
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

/** Atomic units → decimal string, e.g. formatAtomic(5001n, 6) → "0.005001". */
export function formatAtomic(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const abs = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = abs.slice(0, abs.length - decimals) || "0";
  const frac = decimals > 0 ? `.${abs.slice(abs.length - decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${frac}`;
}

export function formatReport(report: Report, opts: { decimals?: number } = {}): string {
  const decimals = opts.decimals ?? 6;
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
