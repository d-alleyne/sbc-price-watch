#!/usr/bin/env node
/**
 * run.mjs — one scrape cycle across the configured merchants.
 *
 *   node scraper/run.mjs                 all enabled merchants
 *   node scraper/run.mjs --only anbernic single merchant
 *   node scraper/run.mjs --db /tmp/x.db  alternate store
 *
 * Every run records, per merchant: the method used, HTTP outcome, bytes, duration, cost, and a
 * per-field ok/missing/invalid tally. A failed merchant is recorded as a failed run rather than
 * being skipped — a gap in the run table would otherwise read as "we never looked", which is a
 * different and more flattering claim than "we looked and it broke".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, startRun, finishRun, recordFieldOutcomes, insertObservations } from './lib/db.mjs';
import { fetchAll } from './lib/shopify.mjs';
import { newTally, gradeRow, summariseTally } from './lib/fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

const DB_PATH = argOf('--db') ?? join(HERE, 'data', 'prices.db');
const ONLY = argOf('--only');

const merchants = JSON.parse(readFileSync(join(HERE, 'merchants.json'), 'utf8'))
  .filter((m) => m.enabled)
  .filter((m) => !ONLY || m.slug === ONLY);

if (merchants.length === 0) {
  console.error(ONLY ? `no enabled merchant matching "${ONLY}"` : 'no enabled merchants');
  process.exit(2);
}

const db = openDb(DB_PATH);
console.log(`db: ${DB_PATH}\n`);

let failures = 0;

for (const m of merchants) {
  const runId = startRun(db, { merchant: m.slug, method: m.method, provider: null });
  const t0 = Date.now();
  process.stdout.write(`${m.slug.padEnd(12)} ${m.method} … `);

  try {
    if (m.method !== 'shopify_products_json') {
      throw new Error(`method "${m.method}" has no adapter yet`);
    }

    const { rows, products, bytes, status } = await fetchAll({ baseUrl: m.base_url, currency: m.currency });

    const tally = newTally();
    for (const r of rows) gradeRow(r, tally);

    insertObservations(db, runId, m.slug, rows);
    recordFieldOutcomes(db, runId, m.slug, tally);

    const duration = Date.now() - t0;
    finishRun(db, runId, {
      ok: 1, http_status: status, products_seen: products, variants_seen: rows.length,
      bytes, duration_ms: duration, cost_usd: 0,
    });

    // Only name a weakest field when one is actually weak. Reporting "least reliable: price 100.0%"
    // on a clean merchant reads as a defect that does not exist.
    const worst = summariseTally(tally)[0];
    const note = worst && worst.rate < 1
      ? `  · least reliable: ${worst.field} ${(worst.rate * 100).toFixed(1)}%`
      : '  · all fields complete';
    console.log(
      `OK  ${products} products / ${rows.length} variants, ${(bytes / 1024).toFixed(0)}KB, ${duration}ms${note}`
    );
  } catch (err) {
    failures++;
    const duration = Date.now() - t0;
    finishRun(db, runId, {
      ok: 0, http_status: err.httpStatus ?? null, error: String(err.message).slice(0, 300),
      duration_ms: duration, cost_usd: 0,
    });
    console.log(`FAIL ${err.message}`);
  }
}

db.close();
console.log(`\n${merchants.length - failures}/${merchants.length} merchants ok`);
process.exit(failures === merchants.length ? 1 : 0);
