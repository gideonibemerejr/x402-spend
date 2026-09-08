/** SQLite persistence for x402 spend receipts. */
import { DatabaseSync } from "node:sqlite";
import type { LabelDetail } from "./review.js";
import { RECEIPT_SCHEMA_VERSION, type Outcome, type SpendReceipt } from "./receipt.js";
import type { SpendStore } from "./spend.js";

/** Default database path used by {@link SqliteSpendStore} and the report CLI. */
export const DEFAULT_DB_PATH = "x402-spend.db";

/** SQL schema for the receipt table and report-oriented indexes. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL,
  resource_url      TEXT NOT NULL,
  network           TEXT NOT NULL,
  outcome           TEXT NOT NULL,
  outcome_reason    TEXT,
  outcome_recovery  TEXT,
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

/**
 * Brings a database written by an older version up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, so the two outcome columns are added here when absent, and the four
 * old labels are mapped onto the binary model in the same pass.
 *
 * The mapping is deliberately lossy in one direction only. `discarded` recorded
 * that a response was unusable but never which way, and choosing between
 * `wrong`, `empty` and `malformed` on its behalf would invent the very
 * distinction the reason codes exist to preserve — so those rows keep a null
 * reason, and a null reason on an old row means "never collected", not "none".
 */
function migrate(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(receipts)`).all() as { name: string }[]).map((c) => c.name)
  );
  if (!columns.has("outcome_reason")) db.exec(`ALTER TABLE receipts ADD COLUMN outcome_reason TEXT`);
  if (!columns.has("outcome_recovery")) db.exec(`ALTER TABLE receipts ADD COLUMN outcome_recovery TEXT`);

  db.exec(`
    UPDATE receipts SET outcome = 'useful',
      json = json_set(json, '$.outcome', 'useful', '$.schema', ${RECEIPT_SCHEMA_VERSION})
      WHERE outcome = 'used';
    UPDATE receipts SET outcome = 'not_useful', outcome_recovery = 'retried_same',
      json = json_set(json, '$.outcome', 'not_useful', '$.outcomeRecovery', 'retried_same',
                      '$.schema', ${RECEIPT_SCHEMA_VERSION})
      WHERE outcome = 'retried';
    UPDATE receipts SET outcome = 'not_useful',
      json = json_set(json, '$.outcome', 'not_useful', '$.schema', ${RECEIPT_SCHEMA_VERSION})
      WHERE outcome = 'discarded';
    UPDATE receipts SET outcome = 'not_useful', outcome_reason = 'no_response',
      json = json_set(json, '$.outcome', 'not_useful', '$.outcomeReason', 'no_response',
                      '$.schema', ${RECEIPT_SCHEMA_VERSION})
      WHERE outcome = 'failed';
  `);
}

/**
 * Finds the latency of the final payment-bearing leg.
 *
 * @param receipt - Receipt whose ordered legs should be inspected.
 * @returns Recovery latency when present, otherwise paid-leg latency, or `undefined`.
 */
function paidMs(receipt: SpendReceipt): number | undefined {
  for (let i = receipt.legs.length - 1; i >= 0; i--) {
    const leg = receipt.legs[i];
    if (leg.kind === "paid" || leg.kind === "recovery") return leg.ms;
  }
  return undefined;
}

/**
 * Local {@link SpendStore} backed by Node's built-in synchronous SQLite API.
 *
 * Each row stores the complete receipt as JSON for lossless round trips and
 * duplicates report-relevant scalar fields into indexed columns. Databases use
 * WAL journaling so readers can coexist with the spend's writes.
 *
 * Call {@link SqliteSpendStore.close} when the store is no longer needed.
 */
export class SqliteSpendStore implements SpendStore {
  private readonly db: DatabaseSync;

  /**
   * Opens a receipt database and initializes its schema if necessary.
   *
   * @param path - SQLite filename, `:memory:` for an ephemeral store, or the
   * default `x402-spend.db` when omitted.
   */
  constructor(path: string = DEFAULT_DB_PATH) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    migrate(this.db);
  }

  /**
   * Inserts a finalized receipt.
   *
   * Receipt IDs are primary keys; inserting the same ID twice rejects with the
   * underlying SQLite constraint error.
   *
   * @param receipt - Complete receipt to persist.
   * @returns A promise resolved after the synchronous SQLite insert completes.
   */
  async insert(receipt: SpendReceipt): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO receipts (id, ts, resource_url, network, outcome, outcome_note, task_class,
                               settled, amount_authorized, amount_settled, asset, status, paid_ms, total_ms, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receipt.id,
        receipt.ts,
        receipt.resource.url,
        receipt.network,
        receipt.outcome,
        receipt.outcomeNote ?? null,
        receipt.taskClass ?? null,
        receipt.settled ? 1 : 0,
        receipt.amountAuthorized,
        receipt.amountSettled ?? null,
        receipt.asset,
        receipt.status,
        paidMs(receipt) ?? null,
        receipt.totalMs,
        JSON.stringify(receipt)
      );
  }

  /**
   * Replaces a receipt's caller-assigned outcome and note.
   *
   * Both indexed columns and the stored JSON representation are updated in one
   * SQLite statement.
   *
   * @param id - Receipt UUID to update.
   * @param outcome - New caller-assigned disposition.
   * @param note - Optional explanation; omission clears the existing note.
   * @returns A promise resolved after the synchronous SQLite update completes.
   * @throws When the database contains no receipt with `id`.
   */
  /**
   * Reads back one stored receipt.
   *
   * @param id - Receipt UUID.
   * @returns The receipt as stored, or `undefined` when no receipt has that id.
   */
  async get(id: string): Promise<SpendReceipt | undefined> {
    const row = this.db.prepare(`SELECT json FROM receipts WHERE id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as SpendReceipt) : undefined;
  }

  async label(id: string, outcome: Outcome, verdict: LabelDetail = {}): Promise<void> {
    // json_set writes a SQL NULL as JSON null rather than removing the key, so
    // each optional field is cleared explicitly first and then set when present.
    const changed = this.db
      .prepare(
        `UPDATE receipts
         SET outcome = ?, outcome_reason = ?, outcome_recovery = ?, outcome_note = ?,
             json = json_set(
               json_remove(json, '$.outcomeReason', '$.outcomeRecovery', '$.outcomeNote'),
               '$.outcome', ?)
         WHERE id = ?`
      )
      .run(
        outcome, verdict.reason ?? null, verdict.recovery ?? null, verdict.note ?? null,
        outcome, id
      ).changes;
    if (changed === 0) throw new Error(`x402-spend: no receipt with id ${id}`);
    for (const [key, value] of [
      ["$.outcomeReason", verdict.reason],
      ["$.outcomeRecovery", verdict.recovery],
      ["$.outcomeNote", verdict.note],
    ] as const) {
      if (value === undefined) continue;
      this.db.prepare(`UPDATE receipts SET json = json_set(json, ?, ?) WHERE id = ?`)
        .run(key, value, id);
    }
  }

  /**
   * Lists stored receipts in ascending timestamp order.
   *
   * @param options - Optional lower-bound filter.
   * @param options.since - Include receipts at or after this timestamp.
   * @returns Parsed receipts, oldest first.
   */
  list(
    options: {
      /** Include only receipts at or after this timestamp. */
      since?: Date;
    } = {}
  ): SpendReceipt[] {
    const rows = options.since
      ? this.db.prepare("SELECT json FROM receipts WHERE ts >= ? ORDER BY ts").all(options.since.toISOString())
      : this.db.prepare("SELECT json FROM receipts ORDER BY ts").all();
    return rows.map((row) => JSON.parse((row as { json: string }).json) as SpendReceipt);
  }

  /** Closes the underlying SQLite connection. */
  close(): void {
    this.db.close();
  }
}
