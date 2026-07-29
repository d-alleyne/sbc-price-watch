# sbc-price-watch

Price and stock collection across retailers selling SBC / handheld gaming devices.

Feeds [SBC Arena](https://sbc-arena.netlify.app). Runs on a schedule, stores every reading, and
reports on its own reliability.

## Why it tracks price and stock, not specs

The original SBC Arena catalogued specifications. Specs are static — once scraped there is nothing
further to do, which is exactly why that project went dormant. Prices move, stock flickers, listings
disappear. That is what makes this worth running continuously, and what makes the data worth having.

## Design

**Zero dependencies.** Node's built-in `node:sqlite` (Node 22+) and `fetch`. No install step, so it
runs unchanged on a laptop, a Raspberry Pi, or in CI.

**Collection is separate from judgement.** `observations` stores raw readings and is append-only.
Grading happens over that table, so a bug in the scorer costs a re-run of `regrade.mjs` rather than a
re-scrape of every merchant — and price history survives instead of being overwritten by an UPDATE.
This is not hypothetical: the first grader counted `compare_at_price: 0` as invalid, when one
merchant uses zero to mean "not discounted". That single wrong assertion understated them by 100 rows
and would have been reported as a fact about their data quality.

**Sources are chosen, not forced.** Four merchants are collected through Shopify's documented public
`/products.json`, which is structured and stable. A fifth (DROIX) sits behind a Cloudflare Managed
Challenge and is **deliberately excluded** — see `merchants.json`, where each merchant carries a
written rationale for its collection method. Defeating bot protection is not on the table: it is
circumvention, and it is the arms race that shut down rpilocator in July 2026. The correct route
there is permission, via their affiliate programme.

## Usage

```bash
node run.mjs                    # collect from all enabled merchants
node run.mjs --only anbernic    # one merchant
node report.mjs                 # reliability, field quality, cost, change detection
node report.mjs --redact        # merchant names replaced with letters, share-safe
node report.mjs --json          # machine-readable
node regrade.mjs                # re-score stored observations after a grader change
```

The database is written to `data/prices.db` and is gitignored — it is regenerable and grows with
every run.

## What the report answers

- **Run reliability** per merchant: success rate, volume, latency.
- **Field quality** per merchant per field, split into `ok` / `missing` / `invalid`. Collapsing the
  last two loses the interesting half: a merchant omitting a SKU and a merchant sending an empty
  string are different facts, and only the second poisons a downstream join.
- **Cost per successful parse**, and the provider it was paid to. Currently $0.00, honestly, because
  every active source is a documented public endpoint.
- **Change detection** — price moves and stock flips against the previous snapshot.

## Schema

| Table | Holds |
|---|---|
| `runs` | one row per merchant per execution: method, HTTP outcome, bytes, duration, cost |
| `field_outcomes` | per-run per-field `ok`/`missing`/`invalid` counts |
| `observations` | append-only price/stock readings |

A failed merchant is recorded as a failed run rather than skipped. A gap in `runs` would read as "we
never looked", which is a different and more flattering claim than "we looked and it broke".
