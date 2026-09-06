/**
 * Receipt store on `node:sqlite` (built into Node >= 22.5). Zero deps, no
 * native compile step.
 *
 * One table. The full receipt lives in a JSON column; the columns the report
 * filters and groups on (resource_url, network, ts, outcome, task_class) are
 * broken out and indexed, plus the scalars the report aggregates.
 */
import { DatabaseSync } from "node:sqlite";
import type { MeterReceipt, Outcome } from "./receipt.js";
import type { MeterStore } from "./meter.js";

export const DEFAULT_DB_PATH = "x402-spend.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL,
  resource_url      TEXT NOT NULL,
  network           TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  outcome_note      TEXT,
  task_class        TEXT,
  settled           INTEGER NOT NULL,
  amount_authorized TEXT NOT NULL,
  amount_settled    TEXT,
  asset             TEXT NOT NULL,
  status            INTEGER NOT NULL,
  paid_ms           INTEGER,
  total_ms          INTEGER NOT NULL,
  json              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_resource_url ON receipts (resource_url);
CREATE INDEX IF NOT EXISTS idx_receipts_network      ON receipts (network);
CREATE INDEX IF NOT EXISTS idx_receipts_ts           ON receipts (ts);
CREATE INDEX IF NOT EXISTS idx_receipts_outcome      ON receipts (outcome);
CREATE INDEX IF NOT EXISTS idx_receipts_task_class   ON receipts (task_class);
`;

/** Latency of the paid leg that delivered (the recovery leg when there was one). */
function paidMs(r: MeterReceipt): number | undefined {
  for (let i = r.legs.length - 1; i >= 0; i--) {
    const leg = r.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

export class SqliteMeterStore implements MeterStore {
  private readonly db: DatabaseSync;

  constructor(path: string = DEFAULT_DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  async insert(r: MeterReceipt): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO receipts (id, ts, resource_url, network, outcome, outcome_note, task_class,
                               settled, amount_authorized, amount_settled, asset, status, paid_ms, total_ms, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        r.id,
        r.ts,
        r.resource.url,
        r.network,
        r.outcome,
        r.outcomeNote ?? null,
        r.taskClass ?? null,
        r.settled ? 1 : 0,
        r.amountAuthorized,
        r.amountSettled ?? null,
        r.asset,
        r.status,
        paidMs(r) ?? null,
        r.totalMs,
        JSON.stringify(r)
      );
  }

  async label(id: string, outcome: Outcome, note?: string): Promise<void> {
    const changed = this.db
      .prepare(
        `UPDATE receipts
         SET outcome = ?, outcome_note = ?,
             json = json_set(json, '$.outcome', ?, '$.outcomeNote', ?)
         WHERE id = ?`
      )
      .run(outcome, note ?? null, outcome, note ?? null, id).changes;
    if (changed === 0) throw new Error(`x402-spend: no receipt with id ${id}`);
  }

  /** Receipts at or after `since` (all of them when omitted), oldest first. */
  list(opts: { since?: Date } = {}): MeterReceipt[] {
    const rows = opts.since
      ? this.db.prepare("SELECT json FROM receipts WHERE ts >= ? ORDER BY ts").all(opts.since.toISOString())
      : this.db.prepare("SELECT json FROM receipts ORDER BY ts").all();
    return rows.map((row) => JSON.parse((row as { json: string }).json) as MeterReceipt);
  }

  close(): void {
    this.db.close();
  }
}
