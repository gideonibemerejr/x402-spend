#!/usr/bin/env node
/** Command-line entry point for rendering reports from a local receipt database. */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_DB_PATH, SqliteSpendStore } from "./store.js";
import { buildReport, formatReport, parseSince } from "./report.js";

const USAGE = `usage: x402-spend report [--db path] [--since 7d] [--decimals 6]

  --db        receipt database (default: ${DEFAULT_DB_PATH})
  --since     window: 30m, 24h, 7d, 2w, or a date (default: all time)
  --decimals  format atomic amounts as units of 10^-decimals (default: 6, USDC)`;

/** Parses CLI arguments, renders the requested report, and sets the process exit code. */
function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string", default: DEFAULT_DB_PATH },
      since: { type: "string" },
      decimals: { type: "string", default: "6" },
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
  const decimals = Number(values.decimals);
  if (!Number.isInteger(decimals) || decimals < 0) {
    console.error(`x402-spend: --decimals must be a non-negative integer, got ${values.decimals}`);
    process.exitCode = 1;
    return;
  }

  const since = values.since ? parseSince(values.since) : undefined;
  const store = new SqliteSpendStore(values.db);
  try {
    console.log(formatReport(buildReport(store.list({ since }), since), { decimals }));
  } finally {
    store.close();
  }
}

main();
