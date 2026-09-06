#!/usr/bin/env node
/** Command-line entry point for rendering reports from a local receipt database. */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_DB_PATH, SqliteSpendStore } from "./store.js";
import { buildReport, formatReport, parseSince, formatAtomic, type AssetDecimals } from "./report.js";

const USAGE = `usage: x402-spend report [--db path] [--since 7d] [--decimals 6] [--asset-decimals network/asset=6]

  --db        receipt database (default: ${DEFAULT_DB_PATH})
  --since     window: 30m, 24h, 7d, 2w, or a date (default: all time)
  --decimals  decimal places for a single-denomination report (default: atomic units)
  --asset-decimals  network/asset=decimals; repeat for each denomination`;

/** Parses CLI arguments, renders the requested report, and sets the process exit code. */
function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string", default: DEFAULT_DB_PATH },
      since: { type: "string" },
      decimals: { type: "string" },
      "asset-decimals": { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || positionals[0] !== "report") {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (!existsSync(values.db)) {
    console.error(`x402-spend: no database at ${values.db} (nothing metered yet?)`);
    process.exitCode = 1;
    return;
  }
  const decimals = values.decimals === undefined ? undefined : parseDecimals(values.decimals);
  const assetDecimals: AssetDecimals[] = (values["asset-decimals"] ?? []).map((value) => {
    const match = /^([^/]+)\/(.+)=(\d+)$/.exec(value);
    if (!match) throw new Error("x402-spend: --asset-decimals must be network/asset=decimals");
    return { network: match[1], asset: match[2], decimals: parseDecimals(match[3]) };
  });

  const since = values.since ? parseSince(values.since) : undefined;
  const store = new SqliteSpendStore(values.db);
  try {
    console.log(formatReport(buildReport(store.list({ since }), since), { decimals, assetDecimals }));
  } finally {
    store.close();
  }
}

function parseDecimals(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("x402-spend: decimals must be an integer from 0 to 255");
  const decimals = Number(value);
  formatAtomic(0n, decimals);
  return decimals;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
