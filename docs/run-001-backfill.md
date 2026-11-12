# Run 001 — verified-review backfill

This is a recovery/publishing workflow for the **September 15, 2026** paid research run. It does **not** replay the experiment, call paid x402 resources, or write to the original SQLite file.

The research report records **34 attempts**, **31 graded** (23 useful, eight not useful). Exactly **30** graded receipts carry independent transaction hashes: **22 useful, eight not useful**. The additional useful row, `geo-r-02`, used prepaid credit and has no independent settlement hash. It is **excluded** from the payment-verifiable registry, but retained in the research report.

The existing receipts have 24 recorded payers and six omitted payer fields. The command resolves every transaction using the reviews Worker's **read-only** `POST /v1/verify`, and requires one matching traced transfer (network, transaction, token/mint, recipient, atomic amount, and payer). It never guesses the payer from the EVM transaction sender or Solana fee payer. This check re-verifies **all 30**, not just the six missing a payer.

## Prerequisites

- Run from the local **`x402-spend`** repository directory, not `x402-spend-reviews` or `x402-spend-site`.
- Node >=22.5, `curl` installed; the original `run-001.db`, `examples/run-001.json`, and `examples/run-001.results.json` must exist locally.
- `https://api.x402spend.dev` must be reachable. The reviews Worker needs functioning chain RPC endpoints, including `RPC_URL_SOLANA` for Solana mainnet. This script makes only ordinary HTTP requests to the Worker, never reads RPC secrets.
- Do **not** use files from the voided first attempt (`run-001-attempt-1.*`). The command links each frozen plan row to the second attempt's `receiptId`, and rejects ambiguous settlement histories.

## Step 1 — audit (no remote writes)

```sh
cd /path/to/x402-spend
npm run test:backfill
npm run backfill:run-001
```

By default, the command reads the SQLite DB **read-only**, reconciles it with the frozen plan and results log, then verifies 30 on-chain transactions via the public `POST /v1/verify` lookup. This endpoint is a read-only lookup, despite using HTTP POST. There is a **3.5-second interval** between requests to stay under the Worker's 20/minute demo-route limit. Expect approximately two minutes for 30 queries.

The audit is written to `.backfill/run-001-audit.json` with owner-only file permissions (`0600`). Git ignores the entire `.backfill/` directory. **It contains payment hashes, payer addresses, and the proposed public review payloads**, so inspect it locally; do not paste it into tickets or commit it. The command prints the count summary, errors, and an approval SHA-256 without dumping wallet addresses.

Success requires **zero errors**, 34 planned and stored receipts, 31 graded responses, exactly 30 distinct transaction hashes, all 30 successfully traced payments, 22 useful + eight not useful, exactly one excluded row (`geo-r-02`), and no contradictions between receipt labels, results, and chain evidence. Otherwise, the audit is marked `ready: false` and publishing is refused.

The original free-text `outcomeNote` values are **not** automatically included in the public review payload. The audit flags how many were omitted. The binary outcomes, reason codes, recovery values, task classes, and payment evidence remain intact.

You can inspect a *summary without printing wallet addresses* with:

```sh
node -e 'const a=require("./.backfill/run-001-audit.json"); console.log({ready:a.ready,stats:a.stats,excluded:a.excluded.map(x=>x.planId),errors:a.errors,payersRecovered:a.entries.filter(x=>x.payerRecovered).length,notesOmitted:a.entries.filter(x=>x.noteOmitted).length,approvalSha256:a.approvalSha256})'
```

## Step 2 — publish (explicit production write, only after reviewing the audit)

**Do not run this command until you have inspected the audit and approved its contents.** It submits public reviews to production, including payer addresses. The approval hash must match the exact audit file; the command also rechecks the frozen plan, results, and SQLite receipts against their audit fingerprints and refuses audit files older than 72 hours.

```sh
npm run backfill:run-001 -- --publish \
  --audit .backfill/run-001-audit.json \
  --confirm <THE_FULL_APPROVAL_SHA256_FROM_THE_AUDIT>
```

The publish phase preflights each resource's existing public reviews and refuses conflicting verdicts instead of silently relabeling them. It posts at most one review per distinct transaction and reads the registry again to confirm `status: verified`, `proof: payment_traced`, and the original verdict. Existing matching records are skipped. Server-side `202 pending` is **not** counted as verified and must be checked after the Worker's scheduled retry; a failed batch can be run again, because the server deduplicates by transaction + payer and the command checks existing published reviews first.

The publish phase never runs the paid experiment or changes local receipt grades. Do **not** edit the audit file or substitute reconstructed wallet information. If evidence changes or the audit expires, regenerate it with Step 1.

## CLI options

| Flag | Effect |
| --- | --- |
| `--db <path>` | Local SQLite DB (audit; defaults to `run-001.db`) |
| `--plan <path>` | Frozen plan (audit; defaults to `examples/run-001.json`) |
| `--results <path>` | Valid second attempt log (audit; defaults to `examples/run-001.results.json`) |
| `--api <https-url>` | Review API base (audit; defaults to `https://api.x402spend.dev`) |
| `--out <path>` | Audit destination (default `.backfill/run-001-audit.json`) |
| `--delay-ms <n>` | Pause between requests; default 3500 ms to respect rate limits |
| `--publish --audit <file> --confirm <sha256>` | Separate, explicitly approved registry-write phase |

## Verification after publication

The public registry is at https://x402spend.dev/registry. It reads from `GET https://api.x402spend.dev/v1/reviews/recent` and shows payment-traced records. The expected Run 001 contribution is **22 useful and eight not useful** (30 in total), separate from the experiment-wide 23 useful and eight not useful. Count the submitted Run 001 receipts separately from any pre-existing reviews; registry totals may include earlier tests or subsequent users.

The registry is **not** proof that the grader's judgment is objectively true. On-chain verification establishes that a matching payment happened. It does not authenticate the human author of the review; keep that limitation prominent when presenting the research.
