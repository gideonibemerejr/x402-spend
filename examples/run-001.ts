/**
 * Run 001: pays every row of the frozen plan, once, in order, and labels nothing.
 *
 * The plan is `examples/run-001.json`, committed before any payment per step 2
 * of RESEARCH-METHOD.md's protocol. Each row carries the question and the
 * expected answer, written in advance, so the labels applied afterward are
 * graded against something that provably predates the response.
 *
 * **This script does not label.** That is not an omission to fix later. The
 * method makes the hand labels the reference set that any automatic labeler is
 * validated against, and a harness that labeled its own calls would be
 * measuring itself. It pays, records, and stops.
 *
 * Calls are sequential. There are only ~32 of them, and running them in
 * parallel would make the latency figures measure contention instead of the
 * endpoint.
 *
 * Configure .env (see .env.example), then:
 *
 *   npm run example:run-001 -- --check   # validate the plan, pay nothing
 *   npm run example:run-001              # pay every row
 *
 * RESOURCE_URL is unused: every row names its own endpoint.
 *
 * The run is resumable. Each attempt is appended to a results log and a row
 * that already settled is skipped on a later pass, because the alternative is
 * paying for it twice.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { createSpend, SqliteSpendStore, type SpendReceipt } from "../dist/index.js";

const PLAN_PATH = "examples/run-001.json";
const RESULTS_PATH = "examples/run-001.results.json";
const DB_PATH = "run-001.db";

/**
 * The categories the method scopes run 001 to.
 *
 * Closed, and checked before the first payment, because a typo here would
 * silently drop a row out of its category's tally and the tally is the finding.
 * Anything outside this set failed the checkability rule and has no business in
 * the run.
 */
const CATEGORY = [
  "geocode_forward",
  "geocode_reverse",
  "search_known",
  "search_relevance",
  "weather",
  "price",
] as const;

/**
 * Difficulty tiers for known-answer search, two queries each.
 *
 * A failure means something different in each — coverage, index depth, index
 * freshness, or whether the endpoint returns the value rather than pages that
 * might contain it — so the tier has to survive into the dataset to be read
 * back out of it.
 */
const TIER = ["easy_famous", "specific_public", "recent", "precise_numeric"] as const;

type Category = (typeof CATEGORY)[number];
type Tier = (typeof TIER)[number];

/** CAIP-2, the same two families the review server verifies. */
const CAIP2 = /^(eip155:[1-9]\d{0,18}|solana:[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * Network spellings seen in 402 quotes, mapped to CAIP-2.
 *
 * A deliberate local copy of the review server's alias table rather than an
 * import: this is an example in a different package, and the server owns the
 * canonical list. Kept to the spellings a seller in this run might quote, so a
 * row asking for Base is not sent elsewhere because the quote said `base`.
 */
const ALIASES: Readonly<Record<string, string>> = {
  base: "eip155:8453",
  "base-mainnet": "eip155:8453",
  "base-sepolia": "eip155:84532",
  avalanche: "eip155:43114",
  "avalanche-fuji": "eip155:43113",
  arbitrum: "eip155:42161",
  "arbitrum-one": "eip155:42161",
  bsc: "eip155:56",
  bnb: "eip155:56",
  "binance-smart-chain": "eip155:56",
  polygon: "eip155:137",
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:mainnet": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana:mainnet-beta": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "solana:devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

const canonicalNetwork = (network: string): string =>
  CAIP2.test(network) ? network : (ALIASES[network.toLowerCase()] ?? network);

/**
 * One pre-registered call.
 *
 * `endpoint` is the full URL as it will be requested, query string included;
 * `query` is the same request written for a reader, which is what the label is
 * graded against alongside `expected`. The review server strips the query
 * string before publishing, so every call to one provider aggregates under one
 * resource URL — which is the intent, not a loss.
 */
interface PlanRow {
  /** Stable and unique. It is how a row is matched to its receipt and its label. */
  id: string;
  endpoint: string;
  /** Sampling is across distinct providers, so this is what the spread is measured on. */
  provider: string;
  /** As frozen from x402 Trust before the run, not as looked up during it. */
  grade: string;
  /** The price quoted at freeze time, as displayed. Drift from it is a finding. */
  price: string;
  network: string;
  category: Category;
  /** Required on `search_known`, where the tier is part of what is being tested. */
  tier?: Tier;
  /** What is being asked, in one line. */
  query: string;
  /** What a correct answer looks like. The pre-registration; without it the label is a mood. */
  expected: string;
  /** Defaults to GET. */
  method?: string;
  /** Request body for endpoints that take one. Sent as JSON. */
  body?: unknown;
}

/** What one attempt produced. Appended whether it worked or not. */
interface RowResult {
  id: string;
  attemptedAt: string;
  ok: boolean;
  status?: number;
  receiptId?: string;
  transaction?: string;
  network?: string;
  asset?: string;
  amount?: string;
  settled?: boolean;
  /** Set only when the settlement landed on a different network than the plan named. */
  networkAsked?: string;
  paidMs?: number;
  error?: string;
}

/**
 * Reads the plan and refuses anything the run could not honestly report on.
 *
 * Everything is checked before the first payment rather than row by row. A plan
 * that fails halfway leaves money spent on a run that cannot be published as
 * the one that was pre-registered, and money is the thing here that does not
 * come back.
 */
function loadPlan(path: string): PlanRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    fail(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed)) fail(`${path}: must be an array of rows`);

  const problems: string[] = [];
  const awaiting = new Set<string>();
  const seen = new Set<string>();
  for (const [index, row] of (parsed as PlanRow[]).entries()) {
    // 1-based: the reader is counting entries in a JSON file, not indexing one.
    const where = `row ${index + 1}${typeof row?.id === "string" ? ` (${row.id})` : ""}`;
    const complain = (message: string) => problems.push(`${where}: ${message}`);

    if (typeof row !== "object" || row === null) {
      complain("must be an object");
      continue;
    }
    for (const field of ["id", "endpoint", "provider", "grade", "price"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") complain(`${field} is required`);
    }
    // Counted rather than complained about one by one. A frozen sample whose
    // mechanical fields are filled and whose instrument columns are not yet
    // written is a normal state to commit, and listing it twice per row would
    // bury the problems that are actually wrong.
    for (const field of ["query", "expected"] as const) {
      if (typeof row[field] !== "string") complain(`${field} must be a string`);
      else if (row[field].trim() === "") awaiting.add(row.id ?? where);
    }
    if (typeof row.id === "string") {
      if (seen.has(row.id)) complain("id is not unique");
      seen.add(row.id);
    }
    if (typeof row.endpoint === "string" && !URL.canParse(row.endpoint)) {
      complain("endpoint must be an absolute URL");
    }
    if (!CAIP2.test(String(row.network))) {
      complain(`network must be a CAIP-2 id, one of eip155:<chain> or solana:<genesis>`);
    }
    if (!CATEGORY.includes(row.category)) {
      complain(`category must be one of ${CATEGORY.join(", ")}`);
    }
    // The tier exists to tell four kinds of search failure apart. Outside
    // known-answer search there is nothing for it to distinguish, so a tier
    // there is a mislabeled row rather than extra detail.
    if (row.category === "search_known" && row.tier === undefined) {
      complain(`tier is required on search_known: one of ${TIER.join(", ")}`);
    }
    if (row.tier !== undefined && !TIER.includes(row.tier)) {
      complain(`tier must be one of ${TIER.join(", ")}`);
    }
    if (row.category !== "search_known" && row.tier !== undefined) {
      complain("tier belongs to search_known only");
    }
  }

  if (problems.length) fail(`${path} is not a runnable plan:\n  ${problems.join("\n  ")}`);
  if (parsed.length === 0) {
    fail(
      `${path} has no rows. It is the pre-registered expectation set: write the question and the ` +
        `expected answer for each call and commit them before paying anyone, per protocol step 2.`
    );
  }
  if (awaiting.size) {
    fail(
      `${path}: ${awaiting.size} of ${parsed.length} rows still need \`query\` and \`expected\`.\n` +
        `They are the pre-registered expectation set and are written by hand before anyone is paid, ` +
        `per protocol step 2 — the label is graded against them, so a row without them cannot be ` +
        `honestly reviewed.\n  ${[...awaiting].join(", ")}`
    );
  }
  return parsed as PlanRow[];
}

/**
 * What each row has already done, from the results log.
 *
 * A settled attempt wins over any later one. A row can settle and then fail on
 * a subsequent pass — the endpoint went down after it was paid — and taking
 * merely the latest attempt would forget the payment, re-pay the row, and leave
 * the spend understated by the amount it just spent twice.
 */
function loadResults(path: string): Map<string, RowResult> {
  let rows: RowResult[] = [];
  try {
    rows = JSON.parse(readFileSync(path, "utf8")) as RowResult[];
  } catch {
    // No log yet, or an unreadable one: this is the first pass either way.
    return new Map();
  }
  const best = new Map<string, RowResult>();
  for (const result of rows) {
    const held = best.get(result.id);
    if (!held?.settled) best.set(result.id, result);
  }
  return best;
}

/** Latency of the payment-bearing leg that delivered the final result. */
function paidMs(receipt: SpendReceipt): number | undefined {
  for (let i = receipt.legs.length - 1; i >= 0; i--) {
    const leg = receipt.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
const SVM_PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const REVIEW_ENDPOINT = process.env.REVIEW_ENDPOINT;
/**
 * Hard per-payment ceiling, the one the method commits to.
 *
 * The client's own default is $1, which is two orders of magnitude above what
 * this run expects to pay for a call. A row that suddenly quotes more than this
 * is refused rather than bought, and the refusal is the finding.
 */
const MAX_PER_CALL = process.env.MAX_PER_CALL ?? "$0.25";

if (!REVIEW_ENDPOINT) fail("missing in .env: REVIEW_ENDPOINT — see .env.example");

const plan = loadPlan(PLAN_PATH);

/**
 * `--check` validates the plan and pays nothing.
 *
 * Without it, confirming that the plan is complete and running the run are the
 * same command: the moment the last `expected` is written, the thing that used
 * to refuse starts spending. Nobody should have to rebuild the plan's validity
 * in their head to find out whether it is safe to type.
 */
if (process.argv.includes("--check")) {
  const perCategory = new Map<string, Set<string>>();
  for (const row of plan) {
    const providers = perCategory.get(row.category) ?? new Set<string>();
    providers.add(row.provider);
    perCategory.set(row.category, providers);
  }
  console.log(`${PLAN_PATH}: ${plan.length} rows, complete and runnable. Nothing was paid.`);
  for (const [category, providers] of perCategory) {
    const calls = plan.filter((row) => row.category === category).length;
    console.log(`  ${category.padEnd(18)} ${String(calls).padStart(2)} calls / ${providers.size} providers`);
  }
  const networks = new Map<string, number>();
  for (const row of plan) networks.set(row.network, (networks.get(row.network) ?? 0) + 1);
  for (const [network, count] of networks) console.log(`  ${network} — ${count}`);
  console.log(`\nTo run it for real: npm run example:run-001`);
  process.exit(0);
}

const done = loadResults(RESULTS_PATH);

// Only the families the plan actually uses need a key, so a Solana-free run
// does not demand a Solana wallet to refuse to use.
const families = new Set(plan.map((row) => row.network.split(":")[0]));
if (families.has("eip155") && !EVM_PRIVATE_KEY) fail("missing in .env: EVM_PRIVATE_KEY — the plan has eip155 rows");
if (families.has("solana") && !SVM_PRIVATE_KEY) fail("missing in .env: SVM_PRIVATE_KEY — the plan has solana rows");

/**
 * The network the row being paid asked for, read by the selector below.
 *
 * A module-level handoff rather than an argument because the selector is fixed
 * at client construction and cannot see the call. That is only safe because
 * this run is strictly sequential — one row is in flight at a time — and it is
 * another reason not to make these calls concurrent.
 */
let wantedNetwork: string | undefined;

/**
 * Picks the payment option on the network the plan named.
 *
 * The default selector takes the first option offered, which would leave the
 * plan's `network` column decorative: a provider quoting Base, Solana and
 * Avalanche would always be paid on whichever it happened to list first. Axis 1
 * needs a verified payment on each of the five networks, so which one a row
 * settles on has to be the plan's decision rather than the seller's ordering.
 *
 * Falls back to the first option when the row's network is not offered. The
 * receipt then records what was actually paid, and the mismatch is visible in
 * the results log rather than hidden by a refusal.
 */
const selectNetwork = (_version: number, options: PaymentRequirements[]): PaymentRequirements =>
  options.find((option) => canonicalNetwork(option.network) === wantedNetwork) ?? options[0];

// Default assets only, under a hard per-payment ceiling. `allowedAssets: true`
// was here for BNB, whose Binance-Peg USDC is not a Circle issue and so is not
// a default asset the ceiling reaches. BNB left the run when the sample froze —
// its whole catalog presence is one grade B provider in out-of-scope categories
// — and with it the reason to accept any asset at all. Every network the plan
// now names quotes Circle USDC, which the scheme recognizes, so the tighter
// setting costs the run nothing and refuses an unrecognized token outright.
const client = new x402Client(selectNetwork).setSpendControls({ maxAmountPerPayment: MAX_PER_CALL });

let evmAddress: string | undefined;
if (EVM_PRIVATE_KEY && families.has("eip155")) {
  const account = privateKeyToAccount(EVM_PRIVATE_KEY as `0x${string}`);
  evmAddress = account.address;
  registerExactEvmScheme(client, { signer: toClientEvmSigner(account) });
}
let svmAddress: string | undefined;
if (SVM_PRIVATE_KEY && families.has("solana")) {
  // base58 is how every Solana tool prints a secret key; the signer wants bytes.
  const signer = await createKeyPairSignerFromBytes(base58.decode(SVM_PRIVATE_KEY));
  svmAddress = signer.address;
  registerExactSvmScheme(client, { signer });
}

const store = new SqliteSpendStore(DB_PATH);
// Configured now so the labels applied by hand afterward publish without
// rewiring. Nothing is published during this run, because nothing is labeled.
const spend = createSpend(client, store, { review: { endpoint: REVIEW_ENDPOINT } });

const pending = plan.filter((row) => !done.get(row.id)?.settled);
const resumed = plan.length - pending.length;

console.log(`run 001 — ${plan.length} rows, ${pending.length} to pay, cap ${MAX_PER_CALL} per call`);
if (evmAddress) console.log(`  eip155 payer ${evmAddress}`);
if (svmAddress) console.log(`  solana payer ${svmAddress}`);
if (resumed) console.log(`  ${resumed} already settled on an earlier pass, skipped`);
console.log();

const results: RowResult[] = [...done.values()];
const failures: RowResult[] = [];
/**
 * Spend per network and asset, across every pass.
 *
 * Never summed into one number: BNB carries Binance-Peg USDC rather than a
 * Circle issue, so a single total across the five networks would add up
 * different money and read as if it meant something.
 */
const spent = new Map<string, bigint>();
const tally = (result: RowResult) => {
  if (!result.settled || !result.network || !result.asset) return;
  if (result.amount === undefined || !/^\d+$/.test(result.amount)) return;
  const denomination = `${result.network} ${result.asset}`;
  spent.set(denomination, (spent.get(denomination) ?? 0n) + BigInt(result.amount));
};
for (const result of done.values()) tally(result);

for (const [index, row] of pending.entries()) {
  const position = `${String(index + 1).padStart(2, " ")}/${pending.length}`;
  process.stdout.write(`${position} ${row.id} ${row.category} ${row.provider} … `);

  wantedNetwork = row.network;
  const attempt: RowResult = { id: row.id, attemptedAt: new Date().toISOString(), ok: false };
  let receipt: SpendReceipt | undefined;
  // `last()` is the most recent receipt on the spend, not this call's: a row
  // that never reaches a payment decision leaves it pointing at the row before.
  // Taken unguarded in a loop, that attributes one payment to two rows and
  // doubles the spend tally, so this row only claims an id that is new.
  const before = spend.last();
  const receiptOf = async (): Promise<SpendReceipt | undefined> => {
    const id = spend.last();
    if (!id || id === before) return undefined;
    attempt.receiptId = id;
    return store.get(id);
  };
  try {
    const response = await spend.fetch(row.endpoint, {
      method: row.method ?? "GET",
      ...(row.body !== undefined
        ? { body: JSON.stringify(row.body), headers: { "content-type": "application/json" } }
        : {}),
      // Categories aggregate in the report without anyone re-deriving them.
      taskClass: row.category,
    });
    attempt.status = response.status;
    // Drained so the connection closes and the byte count on the receipt is real.
    await response.arrayBuffer().catch(() => undefined);

    receipt = await receiptOf();
    attempt.ok = response.ok;
    if (!response.ok) attempt.error = `HTTP ${response.status}`;
  } catch (cause) {
    // One dead endpoint must not end the run: the rest of the plan is still
    // worth collecting, and a row that never settled is itself an Axis 2 count.
    attempt.error = cause instanceof Error ? cause.message : String(cause);
    receipt = await receiptOf();
  }

  if (receipt) {
    attempt.transaction = receipt.transaction;
    attempt.network = receipt.network;
    attempt.asset = receipt.asset;
    attempt.amount = receipt.amountSettled ?? receipt.amountAuthorized;
    attempt.settled = receipt.settled;
    attempt.paidMs = paidMs(receipt);
    // Recorded rather than refused: a row that settled on a network the plan did
    // not ask for still paid, and Axis 1 needs to see which networks were
    // actually reachable rather than which ones were requested.
    if (canonicalNetwork(receipt.network) !== row.network) attempt.networkAsked = row.network;
    tally(attempt);
  }

  // A free 200 is not a settlement failure, it is an endpoint that did not
  // charge — a different Axis 2 count, and saying so here keeps the summary
  // from reading as if a payment had been attempted and lost.
  const settlement = receipt?.settled
    ? `settled ${attempt.amount} ${attempt.transaction ?? "(no tx)"}`
    : receipt
      ? "receipt, not settled"
      : attempt.status !== undefined
        ? "no 402, answered free"
        : "no receipt";
  console.log(
    [`${attempt.status ?? "—"}`, attempt.receiptId, settlement, attempt.error]
      .filter(Boolean)
      .join(" · ")
  );

  results.push(attempt);
  if (!attempt.ok || !receipt?.settled) failures.push(attempt);
  // Written after every row, not at the end: a crash on row 20 must not cost
  // the record of the nineteen payments that already left the wallet.
  writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
}

console.log();
console.log(`attempted ${pending.length}, failed ${failures.length}`);
for (const failure of failures) {
  const why =
    failure.error ??
    (failure.settled
      ? "settled but the response was not usable as delivered"
      : failure.receiptId
        ? "payment did not settle"
        : "no 402: the endpoint answered without charging");
  console.log(`  ${failure.id}: ${why}`);
}
for (const [denomination, total] of spent) console.log(`  spent ${total} atomic on ${denomination}`);

console.log();
console.log(`results: ${RESULTS_PATH} · receipts: ${DB_PATH}`);
console.log("nothing is labeled. Label by hand against each row's `expected`, then the labels publish.");

store.close();
