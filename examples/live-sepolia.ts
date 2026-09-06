/**
 * One real paid call on Base Sepolia, labeled and published as a verified review.
 *
 * This is the end-to-end proof for 0.3: the meter pays, records a receipt, and
 * the label is posted to a review server that checks it against the settlement
 * transaction on chain before accepting it.
 *
 * Build first, then run:
 *
 *   npm run build
 *   EVM_PRIVATE_KEY=0x... RESOURCE_URL=https://some-paid-endpoint \
 *     node examples/live-sepolia.ts
 *
 * The account needs Base Sepolia USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 * and nothing else; the facilitator broadcasts and pays the gas.
 */
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { createSpend, SqliteSpendStore } from "../dist/index.js";

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
const RESOURCE_URL = process.env.RESOURCE_URL;
const REVIEWS_ENDPOINT =
  process.env.REVIEWS_ENDPOINT ?? "https://x402-spend-reviews.g-764.workers.dev/v1/reviews";

if (!PRIVATE_KEY || !RESOURCE_URL) {
  console.error("set EVM_PRIVATE_KEY and RESOURCE_URL");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const client = new x402Client();
registerExactEvmScheme(client, { signer: toClientEvmSigner(account) });

const store = new SqliteSpendStore("live-sepolia.db");
const spend = createSpend(client, store, {
  // Opt-in, per instance. Reviews are public and name the payer address.
  review: { endpoint: REVIEWS_ENDPOINT },
});

console.log(`paying as ${account.address}`);
const response = await spend.fetch(RESOURCE_URL, { taskClass: "live-check" });
console.log(`${response.status} ${response.statusText}`);

const id = spend.last();
if (!id) {
  console.error("no receipt: the call never reached a payment decision");
  process.exit(1);
}

const receipt = await store.get(id);
console.log({
  transaction: receipt?.transaction,
  payer: receipt?.payer,
  settled: receipt?.settled,
  amount: receipt?.amountSettled ?? receipt?.amountAuthorized,
  asset: receipt?.asset,
  network: receipt?.network,
});

// The label is written locally first; publishing is best effort and never throws.
const result = await spend.label(id, "used", "live Base Sepolia end-to-end check");
console.log(result);

if (result.posted) {
  const resource = new URL(receipt!.resource.url);
  resource.search = "";
  resource.hash = "";
  const feed = new URL(REVIEWS_ENDPOINT);
  feed.searchParams.set("resource", resource.toString());
  console.log(`published — read it back at ${feed}`);
} else {
  console.error(`not published: ${result.error}`);
}

store.close();
