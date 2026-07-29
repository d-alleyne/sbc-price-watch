#!/usr/bin/env node
/**
 * regrade.mjs — recompute field_outcomes from stored observations.
 *
 *   node scraper/regrade.mjs
 *
 * Why this exists. Grading happens at scrape time, so a bug in the grader is baked into every
 * historical tally — and the first version had one: `compare_at_price: 0` was scored invalid, when
 * on at least one merchant zero is simply how "no discount" is encoded. That single wrong assertion
 * understated a merchant by 100 rows and would have been reported as a fact about their data.
 *
 * Because `observations` stores the RAW values and is append-only, grading is reproducible: the
 * scorer can be corrected and the whole history re-scored without re-scraping anyone. That is the
 * point of separating collection from judgement — a broken measurement should cost a re-run of the
 * scorer, not a re-run of the collection, and certainly not a wrong published number.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newTally, gradeRow } from './lib/fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DB_PATH = argOf('--db') ?? join(HERE, 'data', 'prices.db');

const db = new DatabaseSync(DB_PATH);
const runs = db.prepare(`SELECT id, merchant FROM runs WHERE ok = 1 ORDER BY id`).all();

const before = db.prepare(
  `SELECT field, SUM(count) n FROM field_outcomes WHERE status <> 'ok' GROUP BY field ORDER BY n DESC`
).all();

const del = db.prepare(`DELETE FROM field_outcomes WHERE run_id = ?`);
const ins = db.prepare(
  `INSERT OR REPLACE INTO field_outcomes (run_id, merchant, field, status, count) VALUES (?,?,?,?,?)`
);
const rowsFor = db.prepare(
  `SELECT price, compare_at_price, available, sku, title, variant_title FROM observations WHERE run_id = ?`
);

let regraded = 0;
db.exec('BEGIN');
try {
  for (const r of runs) {
    const rows = rowsFor.all(r.id);
    if (rows.length === 0) continue;
    const tally = newTally();
    for (const row of rows) {
      gradeRow({ ...row, available: row.available === null ? null : Boolean(row.available) }, tally);
    }
    del.run(r.id);
    for (const [field, statuses] of Object.entries(tally)) {
      for (const [status, count] of Object.entries(statuses)) {
        if (count > 0) ins.run(r.id, r.merchant, field, status, count);
      }
    }
    regraded++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const after = db.prepare(
  `SELECT field, SUM(count) n FROM field_outcomes WHERE status <> 'ok' GROUP BY field ORDER BY n DESC`
).all();

console.log(`regraded ${regraded} run(s)\n`);
const map = (rows) => Object.fromEntries(rows.map((r) => [r.field, r.n]));
const b = map(before), a = map(after);
const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])];
console.log(`${'field'.padEnd(20)} ${'not-ok before'.padStart(14)} ${'after'.padStart(8)} ${'delta'.padStart(8)}`);
for (const f of fields.sort()) {
  const bn = b[f] ?? 0, an = a[f] ?? 0;
  console.log(`${f.padEnd(20)} ${String(bn).padStart(14)} ${String(an).padStart(8)} ${String(an - bn).padStart(8)}`);
}
db.close();
