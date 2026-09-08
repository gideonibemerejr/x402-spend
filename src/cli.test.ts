import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { SqliteSpendStore } from "./store.js";
import type { SpendReceipt } from "./receipt.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", cli, ...args], { encoding: "utf8" });

test("CLI reports denominations with explicit scales and handles bad input without stacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "x402-spend-cli-"));
  const db = join(directory, "receipts.db");
  try {
    const store = new SqliteSpendStore(db);
    try {
      const receipt: SpendReceipt = {
        schema: 2, id: "a", ts: new Date().toISOString(), method: "GET",
        resource: { url: "https://api.test/paid" }, x402Version: 2,
        scheme: "exact", network: "eip155:84532", asset: "usdc", amountAuthorized: "10000",
        amountSettled: "10000", payTo: "seller", offeredAlternatives: 1,
        settled: true, legs: [], totalMs: 0, status: 200, outcome: "useful",
      };
      await store.insert(receipt);
      await store.insert({ ...receipt, id: "b", asset: "other", amountSettled: "123" });
    } finally { store.close(); }
    const report = run("report", "--db", db, "--asset-decimals", "eip155:84532/usdc=6",
      "--asset-decimals", "eip155:84532/other=2");
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /0\.010000/);
    assert.match(report.stdout, /1\.23/);
    assert.equal((report.stdout.match(/TOTAL/g) ?? []).length, 2);
    const unknown = run("report", "--db", db);
    assert.equal(unknown.status, 0);
    assert.match(unknown.stdout, /decimals unknown/);
    for (const args of [
      ["--since", "999999999999999999999999w"], ["--since", "garbage"],
      ["--decimals", "6"], ["--decimals", "256"], ["--decimals", ""],
      ["--asset-decimals", "invalid"], ["--asset-decimals", "eip155:84532/usdc=999"],
    ]) {
      const invalid = run("report", "--db", db, ...args);
      assert.equal(invalid.status, 1, args.join(" "));
      assert.equal(invalid.stdout, "");
      assert.match(invalid.stderr, /x402-spend:/);
      assert.doesNotMatch(invalid.stderr, /\n\s+at /);
    }
    assert.equal(run("--help").status, 0);
    assert.equal(run("report", "--db", join(directory, "missing.db")).status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
