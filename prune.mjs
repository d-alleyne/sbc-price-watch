#!/usr/bin/env node
/**
 * prune.mjs — keep the observation store bounded.
 *
 *   node prune.mjs                 delete observations older than 14 days
 *   node prune.mjs --days 30       different window
 *   node prune.mjs --dry-run       report what would go, delete nothing
 *
 * `runs` and `field_outcomes` are NEVER pruned. They are small, they accumulate slowly, and they
 * are the operating record this project exists to produce — the reliability history is the evidence,
 * so deleting it to save space would be deleting the point.
 *
 * `observations` are different. They arrive at roughly 4,700 rows per run, the overwhelming majority
 * identical to the previous run, and only two consumers need them: change detection, which needs the
 * previous snapshot, and regrade.mjs, which needs a working window. An unbounded history costs about
 * 9,400 rows a day and buys nothing.
 */

import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const DB_PATH = argOf('--db', join(HERE, 'data', 'prices.db'));
const DAYS = Number(argOf('--days', 14));
const DRY = argv.includes('--dry-run');

const cutoff = new Date(Date.now() - DAYS * 864e5).toISOString();
const db = new DatabaseSync(DB_PATH);
const sizeMb = () => (statSync(DB_PATH).size / 1048576).toFixed(2);

const before = sizeMb();
const total = db.prepare(`SELECT COUNT(*) AS n FROM observations`).get().n;
const doomed = db.prepare(`SELECT COUNT(*) AS n FROM observations WHERE observed_at < ?`).get(cutoff).n;

console.log(`prune: cutoff ${cutoff} (${DAYS}d)`);
console.log(`  ${total} observations, ${doomed} older than the cutoff`);

if (DRY) {
  console.log('  --dry-run, nothing deleted');
  db.close();
  process.exit(0);
}

if (doomed === 0) {
  console.log(`  nothing to do (${before} MB)`);
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
try {
  db.prepare(`DELETE FROM observations WHERE observed_at < ?`).run(cutoff);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// Reclaims the pages the delete freed. Without it the file keeps its high-water mark, which defeats
// the purpose when the file is being carried between CI runs in a cache.
db.exec('VACUUM');
db.close();

console.log(`  deleted ${doomed}, kept ${total - doomed} · ${before} MB → ${sizeMb()} MB`);
