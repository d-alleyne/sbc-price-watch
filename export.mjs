#!/usr/bin/env node
/**
 * export.mjs — reduce the observation store to the snapshot the website builds from.
 *
 *   node export.mjs                     write public/snapshot.json + public/catalogue.json
 *   node export.mjs --outdir path/      somewhere else
 *   node export.mjs --max-changes 500   cap the retained change history
 *
 * TWO files, not one, and the split is measured rather than guessed: the operating record —
 * merchants, runs, field grades, changes — is 7 KB, while the catalogue is 1,311 KB. Shipping them
 * together would make every visitor download the entire product catalogue to read a reliability
 * table, which is the one thing the primary audience actually came for. The site loads the
 * catalogue lazily, on the only route that needs it.
 *
 * Why the reduction lives here and not in the site: there is one implementation of the grading and
 * change-detection logic, and it is this repository's. If the site re-derived reliability rates or
 * recomputed changes from raw rows, two implementations of the same rules would exist and would
 * eventually disagree. Reducing on this side also means the site never needs node:sqlite, never
 * needs the database file, and never needs a credential — this repo is public, so the snapshot is
 * fetchable unauthenticated.
 *
 * The output is deliberately terse. It carries roughly 4,700 variants and is shipped to every
 * visitor, so keys are short and anything derivable at render time is left out.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const DB_PATH = argOf('--db', join(HERE, 'data', 'prices.db'));
const OUT_DIR = argOf('--outdir', join(HERE, 'public'));
const SNAPSHOT_PATH = join(OUT_DIR, 'snapshot.json');
const CATALOGUE_PATH = join(OUT_DIR, 'catalogue.json');
const MAX_CHANGES = Number(argOf('--max-changes', 500));
const SCHEMA_VERSION = 1;

const db = new DatabaseSync(DB_PATH, { readOnly: true });

const merchants = JSON.parse(readFileSync(join(HERE, 'merchants.json'), 'utf8'));

// ── RUNS ───────────────────────────────────────────────────────────────────────
// The whole operating record, not a window. These rows are small and they are the evidence.
const runs = db.prepare(`
  SELECT id, merchant, method, provider, started_at, finished_at, ok, http_status, error,
         products_seen, variants_seen, bytes, duration_ms, cost_usd
  FROM runs ORDER BY started_at
`).all();

/**
 * Freshness comes from the latest SUCCESSFUL run, never from the export time.
 *
 * This is the load-bearing line of the file. If `collected_at` were stamped at export, a rebuild
 * over an unchanged database would present week-old data as current — the exact silent decay that
 * made the previous version of this project dormant. A failed run must not advance it either, or a
 * merchant going down would read as a successful collection.
 */
const lastOk = runs.filter((r) => r.ok).map((r) => r.started_at).sort().at(-1) ?? null;

// ── FIELD QUALITY ──────────────────────────────────────────────────────────────
const fields = db.prepare(`
  SELECT merchant, field,
         SUM(CASE WHEN status='ok'      THEN count ELSE 0 END) AS ok,
         SUM(CASE WHEN status='missing' THEN count ELSE 0 END) AS missing,
         SUM(CASE WHEN status='invalid' THEN count ELSE 0 END) AS invalid
  FROM field_outcomes GROUP BY merchant, field
`).all().map((f) => {
  const total = f.ok + f.missing + f.invalid;
  return { ...f, total, rate: total ? f.ok / total : null };
}).sort((a, b) => a.merchant.localeCompare(b.merchant) || a.rate - b.rate);

// ── CURRENT CATALOGUE ──────────────────────────────────────────────────────────
// Latest observation per variant. Grouped by product so the site renders a product card with its
// variants rather than 4,700 loose rows.
const latest = db.prepare(`
  SELECT o.merchant, o.product_ext_id, o.variant_ext_id, o.handle, o.title, o.variant_title,
         o.vendor, o.product_type, o.sku, o.price, o.compare_at_price, o.currency,
         o.available, o.image_url
  FROM observations o
  JOIN (
    SELECT merchant, variant_ext_id, MAX(observed_at) AS m
    FROM observations GROUP BY merchant, variant_ext_id
  ) x ON o.merchant = x.merchant AND o.variant_ext_id = x.variant_ext_id AND o.observed_at = x.m
  ORDER BY o.merchant, o.title, o.variant_title
`).all();

const byProduct = new Map();
for (const r of latest) {
  const key = `${r.merchant}:${r.product_ext_id}`;
  let p = byProduct.get(key);
  if (!p) {
    p = {
      m: r.merchant, p: r.product_ext_id, h: r.handle, t: r.title,
      vendor: r.vendor || null, type: r.product_type || null, img: r.image_url || null,
      cur: r.currency, variants: [],
    };
    byProduct.set(key, p);
  }
  // Product-level image is whichever variant first supplied one; variants keep their own.
  if (!p.img && r.image_url) p.img = r.image_url;
  p.variants.push({
    v: r.variant_ext_id,
    vt: r.variant_title,
    sku: r.sku || null,
    price: r.price,
    _img: r.image_url || null,
    // `compare_at_price` absent and 0 both mean "not discounted" — litnxt encodes it as 0 where
    // others use null. Normalising to null here keeps the site from rendering a $0 strikethrough.
    was: r.compare_at_price ? r.compare_at_price : null,
    // Preserved as null, never coerced. null means the merchant did not supply availability, which
    // is a different claim from "out of stock" and must stay different all the way to the page.
    avail: r.available === null ? null : (r.available ? 1 : 0),
  });
}

// Most variants share the product's image. Keeping a per-variant copy only where it actually
// differs drops a long CDN URL off ~4,000 rows for no loss of information.
const products = [...byProduct.values()].map((p) => ({
  ...p,
  variants: p.variants.map(({ _img, ...v }) => (_img && _img !== p.img ? { ...v, img: _img } : v)),
}));

// ── CHANGES ────────────────────────────────────────────────────────────────────
// Every consecutive pair per variant, so this is a history rather than the latest diff that
// report.mjs prints. LAG over the observation stream gives each reading its predecessor.
const detected = db.prepare(`
  WITH seq AS (
    SELECT merchant, variant_ext_id, title, variant_title, price, available, observed_at,
           LAG(price)     OVER w AS prev_price,
           LAG(available) OVER w AS prev_avail
    FROM observations
    WINDOW w AS (PARTITION BY merchant, variant_ext_id ORDER BY observed_at)
  )
  SELECT merchant, variant_ext_id, title, variant_title, observed_at,
         prev_price, price, prev_avail, available
  FROM seq
  WHERE prev_price IS NOT NULL
    AND (price IS NOT prev_price OR available IS NOT prev_avail)
  ORDER BY observed_at DESC
`).all();

const fresh = [];
for (const c of detected) {
  const base = { at: c.observed_at, m: c.merchant, v: c.variant_ext_id, t: c.title, vt: c.variant_title };
  if (c.price !== c.prev_price) fresh.push({ ...base, kind: 'price', from: c.prev_price, to: c.price });
  if (c.available !== c.prev_avail) fresh.push({ ...base, kind: 'stock', from: c.prev_avail, to: c.available });
}

/**
 * Merge into whatever the committed snapshot already holds.
 *
 * The database is a working set restored from an Actions cache, and a cache can be evicted. The
 * committed snapshot is the durable store, so change history has to accumulate in git rather than
 * be regenerated from rows that may no longer exist. Union on a key that is stable across runs, so
 * re-exporting the same database twice is a no-op rather than a duplication.
 */
const changeKey = (c) => `${c.at}|${c.m}|${c.v}|${c.kind}`;
const merged = new Map();
if (existsSync(SNAPSHOT_PATH)) {
  try {
    for (const c of JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')).changes ?? []) merged.set(changeKey(c), c);
  } catch (e) {
    console.warn(`! existing snapshot unreadable, starting change history fresh: ${e.message}`);
  }
}
for (const c of fresh) merged.set(changeKey(c), c);

const changes = [...merged.values()]
  .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  .slice(0, MAX_CHANGES);

// ── WRITE ──────────────────────────────────────────────────────────────────────
const meta = {
  generated_at: new Date().toISOString(),
  collected_at: lastOk,
  schema_version: SCHEMA_VERSION,
};

const snapshot = {
  ...meta,
  merchants: merchants.map((m) => ({
    slug: m.slug, name: m.name, base_url: m.base_url, currency: m.currency,
    method: m.method, enabled: m.enabled, method_rationale: m.method_rationale,
  })),
  runs,
  fields,
  changes,
  // Totals live here so the operating record can state catalogue size without loading the
  // catalogue — the homepage quotes these and stays at a few kilobytes.
  totals: {
    products: products.length,
    variants: products.reduce((a, p) => a + p.variants.length, 0),
    in_stock: products.reduce((a, p) => a + p.variants.filter((v) => v.avail === 1).length, 0),
    unknown_stock: products.reduce((a, p) => a + p.variants.filter((v) => v.avail === null).length, 0),
  },
};

// The catalogue repeats `collected_at` so a consumer holding only this file can still tell how old
// it is, and `schema_version` so the two files can never be read as a matched pair when they are not.
const catalogue = { ...meta, products };

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot));
writeFileSync(CATALOGUE_PATH, JSON.stringify(catalogue));
db.close();

const kb = (p) => (statSync(p).size / 1024).toFixed(0);
console.log(
  `snapshot  → ${SNAPSHOT_PATH}  ${kb(SNAPSHOT_PATH)} KB\n` +
  `catalogue → ${CATALOGUE_PATH}  ${kb(CATALOGUE_PATH)} KB\n` +
  `  collected_at ${lastOk ?? 'never'}\n` +
  `  ${snapshot.totals.products} products · ${snapshot.totals.variants} variants ` +
  `(${snapshot.totals.in_stock} in stock, ${snapshot.totals.unknown_stock} unknown) · ` +
  `${products.filter((p) => p.img).length} with images\n` +
  `  ${runs.length} runs · ${fields.length} field grades · ` +
  `${changes.length} changes (${fresh.length} detected this pass)`
);
