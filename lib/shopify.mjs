/**
 * shopify.mjs — adapter for Shopify's documented public /products.json endpoint.
 *
 * Why this and not HTML parsing: it is a documented, stable, structured endpoint. Parsing product
 * pages would mean re-deriving the same fields from markup that changes without notice, and would
 * put us in the anti-bot arms race that is currently shutting down rpilocator. The whole point of
 * choosing sources deliberately is to avoid inheriting that maintenance burden.
 *
 * Politeness: one request per page, a real contact-bearing User-Agent, and a delay between pages.
 * Shopify caps `limit` at 250.
 */

const PAGE_LIMIT = 250;
const UA = 'sbc-arena-pricebot/0.1 (+https://sbc-arena.netlify.app; contact: resume@alleyne.dev)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shopify CDN URLs carry a `?v=` cache-buster that changes when the asset is re-uploaded. Dropping
 *  it keeps the stored value stable across runs, so a re-upload does not read as a changed image. */
const stripQuery = (url) => (typeof url === 'string' && url ? url.split('?')[0] : null);

export async function fetchAll({ baseUrl, currency, maxPages = 10, delayMs = 800, timeoutMs = 25000 }) {
  const rows = [];
  let products = 0, bytes = 0, status = null, page = 1;

  for (; page <= maxPages; page++) {
    const url = `${baseUrl.replace(/\/$/, '')}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res, text;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ac.signal });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} on page ${page}`);
      err.httpStatus = res.status;
      throw err;
    }
    bytes += Buffer.byteLength(text, 'utf8');

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(`unparseable JSON on page ${page} (${text.slice(0, 60)}…)`);
      err.httpStatus = status;
      throw err;
    }

    const batch = data.products ?? [];
    if (batch.length === 0) break;
    products += batch.length;

    for (const p of batch) {
      // Variant art first, product art as the fallback. Most products carry only the product-level
      // image, but where a variant has its own it is the correct one for that row. Stored without
      // any sizing parameter: the canonical asset is the record, and consumers append `?width=N`
      // so one stored URL serves every rendered size.
      const productImage = stripQuery(p.images?.[0]?.src);
      for (const v of p.variants ?? []) {
        rows.push({
          image_url: stripQuery(v.featured_image?.src) ?? productImage,
          product_ext_id: String(p.id),
          variant_ext_id: String(v.id),
          handle: p.handle,
          title: p.title,
          variant_title: v.title,
          vendor: p.vendor,
          product_type: p.product_type,
          sku: v.sku,
          price: v.price,
          compare_at_price: v.compare_at_price,
          currency,
          // Shopify omits `available` on some storefronts. null means "not supplied", which the
          // grader must see as missing rather than silently coercing to false — a coerced false
          // would read downstream as "out of stock", which is a different and wrong claim.
          available: typeof v.available === 'boolean' ? v.available : null,
        });
      }
    }

    if (batch.length < PAGE_LIMIT) break;
    await sleep(delayMs);
  }

  return { rows, products, bytes, status, pages: page };
}
