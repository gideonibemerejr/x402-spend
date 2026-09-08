/**
 * One real paid call on Solana devnet, labeled and published as a verified review.
 *
 * The Solana half of the end-to-end proof: the meter pays under the exact-SVM
 * scheme, records a receipt, and the label is posted to a review server that
 * checks it against the settlement on chain before accepting it.
 *
 * Unlike examples/live-sepolia.ts there is no local seller to pair with, so
 * RESOURCE_URL has to name an endpoint that actually quotes Solana devnet.
 *
 * Configure .env (see .env.example), then:
 *
 *   npm run example:live-solana
 *
 * The account needs devnet USDC (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 * and nothing else; the facilitator signs as fee payer and pays the fee.
 */
import { x402Client } from "@x402/core/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import { createSpend, SqliteSpendStore } from "../dist/index.js";

const PRIVATE_KEY = process.env.SVM_PRIVATE_KEY;
const RESOURCE_URL = process.env.RESOURCE_URL;
const REVIEW_ENDPOINT = process.env.REVIEW_ENDPOINT;

if (!PRIVATE_KEY || !RESOURCE_URL || !REVIEW_ENDPOINT) {
  const missing = Object.entries({ SVM_PRIVATE_KEY: PRIVATE_KEY, RESOURCE_URL, REVIEW_ENDPOINT })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  console.error(`missing in .env: ${missing.join(", ")} — see .env.example`);
  process.exit(1);
}

// base58 is how every Solana tool prints a secret key; the signer wants bytes.
const svmSigner = await createKeyPairSignerFromBytes(base58.decode(PRIVATE_KEY));
const client = new x402Client();
// No network list: with none given, the scheme registers for `solana:*`.
registerExactSvmScheme(client, { signer: svmSigner });

const store = new SqliteSpendStore("live-solana.db");
const spend = createSpend(client, store, {
  // Opt-in, per instance. Reviews are public and name the payer address.
  review: { endpoint: REVIEW_ENDPOINT },
});

console.log(`paying as ${svmSigner.address}`);
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
const result = await spend.label(id, "useful", { note: "live Solana devnet end-to-end check" });
console.log(result);

if (result.posted) {
  const resource = new URL(receipt!.resource.url);
  resource.search = "";
  resource.hash = "";
  const feed = new URL(REVIEW_ENDPOINT);
  feed.searchParams.set("resource", resource.toString());
  console.log(`published — read it back at ${feed}`);
} else {
  console.error(`not published: ${result.error}`);
}

store.close();
