/**
 * fields.mjs — per-field validation, and the tally that answers the reliability question.
 *
 * The distinction that matters and is easy to lose: a field can be
 *
 *   ok        present and plausible
 *   missing   absent or null — the merchant did not supply it
 *   invalid   present but unusable (price "0.00", a non-numeric string, a placeholder SKU)
 *
 * Collapsing "missing" and "invalid" into one bucket destroys the interesting half of the answer.
 * "Anbernic omits SKU" and "Anbernic sends SKU as an empty string" are different facts about a
 * merchant, and only the second one will silently poison a downstream join.
 */

export const FIELDS = ['price', 'compare_at_price', 'available', 'sku', 'title', 'variant_title'];

export function newTally() {
  const t = {};
  for (const f of FIELDS) t[f] = { ok: 0, missing: 0, invalid: 0 };
  return t;
}

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Money: present, numeric, non-negative. Zero is treated as invalid — Shopify uses 0.00 as a
 *  placeholder on unpriced/hidden variants far more often than it means "free". */
function checkMoney(v, { zeroIsValid = false } = {}) {
  if (isBlank(v)) return 'missing';
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n < 0) return 'invalid';
  if (n === 0 && !zeroIsValid) return 'invalid';
  return 'ok';
}

function checkBool(v) {
  if (v === null || v === undefined) return 'missing';
  return typeof v === 'boolean' ? 'ok' : 'invalid';
}

function checkText(v, { minLen = 1 } = {}) {
  if (isBlank(v)) return 'missing';
  if (typeof v !== 'string') return 'invalid';
  return v.trim().length >= minLen ? 'ok' : 'invalid';
}

/**
 * Grade one normalised row and fold the result into `tally`.
 * `compare_at_price` is legitimately absent when an item is not discounted, so a blank counts as
 * ok rather than missing — otherwise every merchant looks 60% unreliable on a field that is
 * working exactly as designed. Grading has to encode intent, not just presence.
 */
export function gradeRow(row, tally) {
  const g = {
    price: checkMoney(row.price),
    compare_at_price: isBlank(row.compare_at_price) ? 'ok' : checkMoney(row.compare_at_price),
    available: checkBool(row.available),
    sku: checkText(row.sku),
    title: checkText(row.title, { minLen: 2 }),
    variant_title: checkText(row.variant_title),
  };
  for (const [field, status] of Object.entries(g)) tally[field][status] += 1;
  return g;
}

export function summariseTally(tally) {
  const out = [];
  for (const [field, s] of Object.entries(tally)) {
    const total = s.ok + s.missing + s.invalid;
    if (!total) continue;
    out.push({ field, total, ok: s.ok, missing: s.missing, invalid: s.invalid, rate: s.ok / total });
  }
  return out.sort((a, b) => a.rate - b.rate); // least reliable first — the question being answered
}
