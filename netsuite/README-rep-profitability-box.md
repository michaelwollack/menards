# Rep Profitability Box — Sales Department Board

Fills the open grid slot next to **Alerts** on the Sales Department Board
(script `7840` / `customscript_mw_sl_sales_dashboard`, file
`Sales_Department_Board_Suitelet (1).js`).

## What it shows

Per sales rep, fiscal year to date, ranked by gross profit:

| Column | Meaning |
|---|---|
| Rep | `transaction.employee` (the Sales Rep header field) |
| Revenue | Item-line revenue, excluding shipping and tax |
| GP $ | Revenue less estimated cost |
| GP % | Gross margin |
| vs LY | Margin change in points vs the **same window** last year |

Plus an all-reps total row, and a `⚠` on any rep whose margin is
overstated because part of their revenue has no cost estimate.

## Install

1. Upload `mw_sl_rep_profitability_box.js` to the **SuiteScripts** folder
   (File Cabinet folder `-15`, where the other `mw_*` board scripts live).
2. In `Sales_Department_Board_Suitelet (1).js`, add the module to the
   existing `define([...])` dependency list:

   ```js
   define(['N/query', /* ...existing... */, './mw_sl_rep_profitability_box'],
     function (query, /* ...existing... */, repProfitBox) {
   ```

3. Where the board writes the open cell next to Alerts, emit the card:

   ```js
   var repProfitHtml = repProfitBox.render();        // defaults: top 8 reps, today
   // var repProfitHtml = repProfitBox.render({ limit: 6 });
   ```

   Then write `repProfitHtml` into that cell exactly the way the Alerts
   box's HTML is written — it is a complete, self-contained fragment
   (scoped `<style>` + `<div class="mw-rpb">`), so it needs no wrapper and
   will not inherit or fight the board's existing CSS.

If the board builds its cells with `serverWidget` inline HTML fields,
`render()`'s return value is what goes into the field's `defaultValue`.

## Assumptions worth confirming

**Fiscal year is Oct 1 – Sep 30.** Taken from the FY25 Top-10 Customers
report ("October 1, 2024 – September 30, 2025"). NetSuite's accounting
period table is not queryable via SuiteQL in this account, so the boundary
is the `FY_START_MONTH` constant at the top of the module. One-line change
if that is wrong.

**Gross profit uses estimated cost** (`transactionline.costestimate`) —
the same input NetSuite's own `estgrossprofit` field uses. Verified
line-for-line against cash sale `CSAB-62955`: revenue 159.99, cost 35.00,
GP 124.99, margin 78.12% — matches the header `estgrossprofit` and
`estgrossprofitpercent` exactly.

Actual posted COGS is deliberately **not** used. On these transactions
COGS does not post to the invoice or cash sale — it posts on the item
fulfillment. Attributing it back to a rep needs a fulfillment-to-order
join that belongs in a reporting layer, not in a dashboard card.

## Known data problems this box surfaces

These are real conditions in the account today, not defects in the card.
The `⚠` exists so they are visible rather than silently flattering.

| Rep | FYTD revenue | Revenue carrying a cost | Margin shown |
|---|---|---|---|
| Unassigned Rep | $31.5K | $49.50 (0.2%) | 100.0% ⚠ |
| Ryan R Cavaletto | $79.4K | $41.4K (52%) | 100.0% ⚠ |
| *(no rep set)* | $7.75M | $4.92M (63%) | 90.7% ⚠ |
| Cody D Grandadam | $17.02M | $11.80M (69%) | 61.0% ⚠ |
| Matt Pell | $1.43M | $0.87M (61%) | 74.4% ⚠ |

Three things to fix at the source, none of them in this file:

1. **Cost estimates are missing on a large share of revenue**, heaviest in
   the B2C / channel business. Until item cost estimates are populated,
   every margin here reads high.
2. **$7.75M FYTD has no sales rep set at all** — the second-largest block
   of revenue on the board. It renders as "Unassigned / channel".
3. **Duplicate employee records.** `Matt  Pell` (id 35496), `Matt Pell`
   (id 35495) and `Pell Matt` (id 36025) are three records for one person,
   so his numbers split across three rows. Same pattern on the Kelly Brand
   records. Merging those in NetSuite fixes it everywhere, not just here.

## Verification performed

- Module's generated SQL executed against the production account —
  27 rows, no errors.
- Fiscal window boundaries unit-checked, including the Sep 30 → Oct 1
  year rollover.
- Bind-parameter count checked against `?` placeholders (8 = 8).
- Render checked against real FY26 data: sorts by GP descending, excludes
  zero-activity reps, labels null reps, raises coverage warnings, and
  totals to $37.01M revenue / $24.23M GP / 65.5% margin, down 1.0 pt YoY.
