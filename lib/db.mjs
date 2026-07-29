/**
 * db.mjs — SQLite store for price/stock observations.
 *
 * Uses node:sqlite (built in from Node 22) so the scraper has ZERO dependencies and runs anywhere
 * — laptop, Pi 5, GitHub Actions — without an install step.
 *
 * The schema is shaped by the evidence this project exists to produce, not by the UI:
 *
 *   runs             one row per merchant per execution — method, provider, cost, outcome.
 *                    Answers "effective cost per successful parse" and "which provider".
 *   field_outcomes   per-run, per-field counts of ok / missing / invalid.
 *                    Answers "which field was least reliable" PER MERCHANT. This is the table
 *                    that cannot be reconstructed after the fact, which is why it exists from
 *                    the first run rather than being added once the data looks interesting.
 *   observations     append-only price/stock readings. Never updated, so price history and
 *                    stock flapping are derivable rather than lost to an UPDATE.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant      TEXT    NOT NULL,
      method        TEXT    NOT NULL,
      provider      TEXT,
      started_at    TEXT    NOT NULL,
      finished_at   TEXT,
      ok            INTEGER NOT NULL DEFAULT 0,
      http_status   INTEGER,
      error         TEXT,
      products_seen INTEGER NOT NULL DEFAULT 0,
      variants_seen INTEGER NOT NULL DEFAULT 0,
      bytes         INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      cost_usd      REAL    NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS field_outcomes (
      run_id   INTEGER NOT NULL REFERENCES runs(id),
      merchant TEXT    NOT NULL,
      field    TEXT    NOT NULL,
      status   TEXT    NOT NULL CHECK (status IN ('ok','missing','invalid')),
      count    INTEGER NOT NULL,
      PRIMARY KEY (run_id, field, status)
    );

    CREATE TABLE IF NOT EXISTS observations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id            INTEGER NOT NULL REFERENCES runs(id),
      merchant          TEXT    NOT NULL,
      product_ext_id    TEXT    NOT NULL,
      variant_ext_id    TEXT    NOT NULL,
      handle            TEXT,
      title             TEXT,
      variant_title     TEXT,
      vendor            TEXT,
      product_type      TEXT,
      sku               TEXT,
      price             REAL,
      compare_at_price  REAL,
      currency          TEXT,
      available         INTEGER,
      observed_at       TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_obs_variant ON observations (merchant, variant_ext_id, observed_at);
    CREATE INDEX IF NOT EXISTS idx_obs_run     ON observations (run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_merch  ON runs (merchant, started_at);
  `);
  return db;
}

export function startRun(db, { merchant, method, provider }) {
  const stmt = db.prepare(
    `INSERT INTO runs (merchant, method, provider, started_at) VALUES (?, ?, ?, ?)`
  );
  const info = stmt.run(merchant, method, provider ?? null, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function finishRun(db, runId, patch) {
  const cols = ['ok', 'http_status', 'error', 'products_seen', 'variants_seen', 'bytes', 'duration_ms', 'cost_usd'];
  const set = cols.filter((c) => patch[c] !== undefined);
  db.prepare(
    `UPDATE runs SET finished_at = ?, ${set.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
  ).run(new Date().toISOString(), ...set.map((c) => patch[c]), runId);
}

export function recordFieldOutcomes(db, runId, merchant, tally) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO field_outcomes (run_id, merchant, field, status, count) VALUES (?, ?, ?, ?, ?)`
  );
  for (const [field, statuses] of Object.entries(tally)) {
    for (const [status, count] of Object.entries(statuses)) {
      if (count > 0) stmt.run(runId, merchant, field, status, count);
    }
  }
}

export function insertObservations(db, runId, merchant, rows) {
  const stmt = db.prepare(`
    INSERT INTO observations
      (run_id, merchant, product_ext_id, variant_ext_id, handle, title, variant_title,
       vendor, product_type, sku, price, compare_at_price, currency, available, observed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const now = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        runId, merchant, r.product_ext_id, r.variant_ext_id, r.handle ?? null, r.title ?? null,
        r.variant_title ?? null, r.vendor ?? null, r.product_type ?? null, r.sku ?? null,
        r.price ?? null, r.compare_at_price ?? null, r.currency ?? null,
        r.available === null || r.available === undefined ? null : (r.available ? 1 : 0),
        now
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
