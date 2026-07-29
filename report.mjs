#!/usr/bin/env node
/**
 * report.mjs — turn accumulated runs into the operating record.
 *
 *   node scraper/report.mjs                 full report
 *   node scraper/report.mjs --days 30       window it
 *   node scraper/report.mjs --json          machine-readable
 *   node scraper/report.mjs --redact        omit merchant names (share-safe)
 *
 * Four sections, each answering a question that is asked of anyone claiming production scraping
 * experience:
 *
 *   RELIABILITY   per merchant, did the run succeed, how often, how fast
 *   FIELD QUALITY per merchant per field, ok/missing/invalid — and the least reliable field named
 *   COST          effective cost per successful parse, and the provider it was paid to
 *   CHANGE        price moves and stock flips detected, which is the proof it is running over time
 *
 * --redact exists because the artifact is meant to be shareable. It strips merchant identities and
 * keeps the shape, so the numbers can be shown without publishing a target list.
 */

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const has = (f) => argv.includes(f);

const DB_PATH = argOf('--db') ?? join(HERE, 'data', 'prices.db');
const DAYS = Number(argOf('--days') ?? 0);
const REDACT = has('--redact');
const AS_JSON = has('--json');

const since = DAYS > 0 ? new Date(Date.now() - DAYS * 864e5).toISOString() : '1970-01-01';
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const label = (() => {
  const map = new Map();
  return (m) => {
    if (!REDACT) return m;
    if (!map.has(m)) map.set(m, `merchant-${String.fromCharCode(65 + map.size)}`);
    return map.get(m);
  };
})();

const pct = (n) => `${(n * 100).toFixed(1)}%`;

// ── RELIABILITY ────────────────────────────────────────────────────────────────
const reliability = db.prepare(`
  SELECT merchant, method,
         COUNT(*)                                   AS runs,
         SUM(ok)                                    AS ok_runs,
         SUM(variants_seen)                         AS variants,
         ROUND(AVG(NULLIF(duration_ms,0)))          AS avg_ms,
         SUM(bytes)                                 AS bytes,
         SUM(cost_usd)                              AS cost,
         MAX(started_at)                            AS last_run
  FROM runs WHERE started_at >= ?
  GROUP BY merchant ORDER BY merchant
`).all(since);

// ── FIELD QUALITY ──────────────────────────────────────────────────────────────
const fieldRows = db.prepare(`
  SELECT f.merchant, f.field,
         SUM(CASE WHEN f.status='ok'      THEN f.count ELSE 0 END) AS ok,
         SUM(CASE WHEN f.status='missing' THEN f.count ELSE 0 END) AS missing,
         SUM(CASE WHEN f.status='invalid' THEN f.count ELSE 0 END) AS invalid
  FROM field_outcomes f JOIN runs r ON r.id = f.run_id
  WHERE r.started_at >= ?
  GROUP BY f.merchant, f.field
`).all(since);

// ── CHANGE DETECTION ───────────────────────────────────────────────────────────
// Compares each variant's latest observation against its previous one. Proves the system is
// running over time rather than having been scraped once - the exact failure that made the
// original SBC Arena dormant.
const changes = db.prepare(`
  WITH ranked AS (
    SELECT merchant, variant_ext_id, title, variant_title, price, available, observed_at,
           ROW_NUMBER() OVER (PARTITION BY merchant, variant_ext_id ORDER BY observed_at DESC) AS rn
    FROM observations
  ),
  paired AS (
    SELECT a.merchant, a.title, a.variant_title,
           b.price AS prev_price, a.price AS curr_price,
           b.available AS prev_avail, a.available AS curr_avail
    FROM ranked a JOIN ranked b
      ON a.merchant = b.merchant AND a.variant_ext_id = b.variant_ext_id
    WHERE a.rn = 1 AND b.rn = 2
  )
  SELECT merchant, title, variant_title, prev_price, curr_price, prev_avail, curr_avail
  FROM paired
  WHERE (prev_price IS NOT curr_price AND prev_price <> curr_price)
     OR (prev_avail IS NOT curr_avail AND prev_avail <> curr_avail)
  ORDER BY merchant, ABS(COALESCE(curr_price,0) - COALESCE(prev_price,0)) DESC
`).all();

const distinctSnapshots = db.prepare(
  `SELECT merchant, COUNT(DISTINCT observed_at) AS snaps FROM observations GROUP BY merchant`
).all();
const snapsBy = Object.fromEntries(distinctSnapshots.map((r) => [r.merchant, r.snaps]));

// ── OUTPUT ─────────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ reliability, fieldRows, changes, snapshots: distinctSnapshots }, null, 2));
  db.close();
  process.exit(0);
}

const totalRuns = reliability.reduce((a, r) => a + r.runs, 0);
const totalOk = reliability.reduce((a, r) => a + r.ok_runs, 0);
const totalVariants = reliability.reduce((a, r) => a + r.variants, 0);
const totalCost = reliability.reduce((a, r) => a + r.cost, 0);

console.log(`\nSBC ARENA — price/stock collection report${DAYS ? `  (last ${DAYS}d)` : ''}${REDACT ? '  [REDACTED]' : ''}`);
console.log('='.repeat(78));

console.log(`\nRUN RELIABILITY`);
console.log(`${'merchant'.padEnd(14)} ${'method'.padEnd(22)} ${'runs'.padStart(5)} ${'ok'.padStart(6)} ${'variants'.padStart(9)} ${'avg'.padStart(7)}`);
for (const r of reliability) {
  console.log(
    `${label(r.merchant).padEnd(14)} ${r.method.padEnd(22)} ${String(r.runs).padStart(5)} ` +
    `${pct(r.ok_runs / r.runs).padStart(6)} ${String(r.variants).padStart(9)} ${(r.avg_ms + 'ms').padStart(7)}`
  );
}
console.log(`${'—'.repeat(14)} ${'ALL'.padEnd(22)} ${String(totalRuns).padStart(5)} ${pct(totalOk / (totalRuns || 1)).padStart(6)} ${String(totalVariants).padStart(9)}`);

console.log(`\nFIELD QUALITY  (ok rate per field; least reliable first)`);
const byMerchant = {};
for (const f of fieldRows) (byMerchant[f.merchant] ??= []).push(f);
for (const [merchant, fields] of Object.entries(byMerchant)) {
  const scored = fields
    .map((f) => ({ ...f, total: f.ok + f.missing + f.invalid }))
    .filter((f) => f.total > 0)
    .map((f) => ({ ...f, rate: f.ok / f.total }))
    .sort((a, b) => a.rate - b.rate);
  const worst = scored[0];
  console.log(`\n  ${label(merchant)}`);
  for (const f of scored) {
    const flag = f === worst && f.rate < 1 ? '  ← least reliable' : '';
    console.log(
      `    ${f.field.padEnd(18)} ${pct(f.rate).padStart(7)}   ` +
      `ok ${String(f.ok).padStart(5)}  missing ${String(f.missing).padStart(5)}  invalid ${String(f.invalid).padStart(5)}${flag}`
    );
  }
  if (worst && worst.rate === 1) console.log(`    (all fields complete)`);
}

console.log(`\nCOST`);
const paid = reliability.filter((r) => r.cost > 0);
if (paid.length === 0) {
  console.log(`  $0.00 — every merchant so far is served by a documented public endpoint.`);
  console.log(`  No managed provider is in the path yet, so there is no cost-per-parse figure to`);
  console.log(`  report. DROIX (403, needs a provider) is the source that will produce one.`);
} else {
  for (const r of paid) {
    console.log(`  ${label(r.merchant).padEnd(14)} $${r.cost.toFixed(4)} over ${r.variants} parses = $${(r.cost / r.variants).toFixed(6)}/parse`);
  }
  console.log(`  TOTAL  $${totalCost.toFixed(4)} over ${totalVariants} parses = $${(totalCost / totalVariants).toFixed(6)}/successful parse`);
}

console.log(`\nCHANGE DETECTION`);
const multi = Object.entries(snapsBy).filter(([, n]) => n > 1);
if (multi.length === 0) {
  console.log(`  Only one snapshot per merchant so far — run again to detect changes.`);
} else {
  const priceMoves = changes.filter((c) => c.prev_price !== c.curr_price);
  const stockFlips = changes.filter((c) => c.prev_avail !== c.curr_avail);
  console.log(`  ${priceMoves.length} price change(s), ${stockFlips.length} stock flip(s) since previous snapshot`);
  for (const c of changes.slice(0, 12)) {
    const bits = [];
    if (c.prev_price !== c.curr_price) bits.push(`${c.prev_price} → ${c.curr_price}`);
    if (c.prev_avail !== c.curr_avail) bits.push(`stock ${c.prev_avail ? 'in' : 'out'} → ${c.curr_avail ? 'in' : 'out'}`);
    const name = `${c.title}${c.variant_title && c.variant_title !== 'Default Title' ? ` (${c.variant_title})` : ''}`;
    console.log(`    ${label(c.merchant).padEnd(12)} ${name.slice(0, 44).padEnd(44)} ${bits.join(', ')}`);
  }
  if (changes.length > 12) console.log(`    … and ${changes.length - 12} more`);
}

console.log('');
db.close();
