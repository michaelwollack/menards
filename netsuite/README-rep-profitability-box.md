# Rep Profitability Box — Sales Department Board

Fills the open grid slot to the **left of the Alerts card** on the Sales
Department Board (script `7840` / `customscript_mw_sl_sales_dashboard`,
file `Sales_Department_Board_Suitelet (1).js`).

## What it shows

The **currently selected rep only**, scoped to **Promier Products
(subsidiary 1)**, fiscal year to date — laid out like the Customer
Profitability report: a summary tile strip over a ranked breakout table.

Tiles: Revenue · Gross Profit · Margin · Margin vs LY.

Breakout table, one row per customer, ranked by gross profit:

| Column | Meaning |
|---|---|
| Customer | `transaction.entity`, NetSuite id prefix stripped |
| Revenue | Item-line revenue, excluding shipping and tax |
| GP $ | Revenue less estimated cost |
| GP % | Gross margin |
| vs LY | Margin change in points vs the **same window** last year |

Plus a total row, and a `⚠` on any customer whose margin is overstated
because part of that revenue has no cost estimate (the tooltip gives the
exact percentage missing).

## Files

| File | Role |
|---|---|
| `mw_sl_rep_profitability_box.js` | The card. Renders to an HTML string. No entry point, no deployment of its own. |
| `mw_sl_rep_profitability_sl.js` | Standalone Suitelet wrapper — deploys the card as its own page with a rep selector, so the feature is usable before the board is edited. |

The card is the same object in both paths. Deploying the wrapper first
does not create work to undo later: when the board is wired up it calls
`box.render({ repId })` and the wrapper simply becomes optional.

## Option A — deploy standalone today (no board changes)

1. Upload **both** files to **SuiteScripts** (File Cabinet folder `-15`).
2. Create a Script record from `mw_sl_rep_profitability_sl.js`:
   - Type **Suitelet**, ID `customscript_mw_sl_rep_profit`
   - Deployment `customdeploy1`, Status **Released**
   - Available Without Login **No**
3. Open the deployment URL. The rep selector defaults to the
   highest-revenue rep, so the page is never empty on first load.

## Option B — install into the Sales Department Board

1. Upload `mw_sl_rep_profitability_box.js` to the **SuiteScripts** folder
   (File Cabinet folder `-15`, where the other `mw_*` board scripts live).
2. In `Sales_Department_Board_Suitelet (1).js`, add the module to the
   existing `define([...])` dependency list:

   ```js
   define(['N/query', /* ...existing... */, './mw_sl_rep_profitability_box'],
     function (query, /* ...existing... */, repProfitBox) {
   ```

3. Where the board writes the open cell to the left of Alerts, emit the
   card, passing the board's **already-resolved selected rep**:

   ```js
   var repProfitHtml = repProfitBox.render({
     repId:   selectedRepId,     // whatever the board already uses for the
                                 // "MY ORDERS" / rep-scoped Alerts section
     repName: selectedRepName    // optional; derived from the data if omitted
   });
   ```

   The card deliberately does **not** resolve the selected rep itself —
   the board already owns that state, and duplicating the logic would let
   the two sections disagree. With no `repId` it renders a neutral
   "Select a rep" placeholder rather than erroring.

   Then write `repProfitHtml` into that cell exactly the way the Alerts
   box's HTML is written — it is a complete, self-contained fragment
   (scoped `<style>` + `<div class="mw-rpb">`), so it needs no wrapper and
   will not inherit or fight the board's existing CSS.

If the board builds its cells with `serverWidget` inline HTML fields,
`render()`'s return value is what goes into the field's `defaultValue`.

## Assumptions worth confirming

**The board integration has not been performed.**
`Sales_Department_Board_Suitelet (1).js` could not be read or written from
this environment: the egress proxy denies `4854895.app.netsuite.com` at
org-policy level, and NetSuite's REST record API refuses the `file` record
type. The file is not mirrored in Box, Drive, or any accessible repo. The
wiring in Option B is therefore written against the board's public shape,
not against its source, and needs a human to apply it. Option A exists so
the feature is not blocked on that.

**Styling is inferred, not copied.** "Make it look like the Customer
Profitability breakout" was implemented from the report's *name and shape*
— tile strip over ranked table — because the egress proxy blocks
`4854895.app.netsuite.com`, so `mw_sl_customer_profit.js` could not be
read. If that report uses a specific tile order, palette or column set,
send a screenshot and this will be matched properly.

**Breakout dimension is customer.** A rep's profitability broken out by
the customers they sell. If the intended breakout is by item, category or
month instead, only the `GROUP BY` and one column label change.

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

Cody, FY26 to date, Promier only — his two largest accounts are the two
with the worst cost coverage:

| Customer | Revenue | Revenue carrying a cost | Margin shown |
|---|---|---|---|
| Walmart Stores | $10.22M | $5.00M (49%) | 74.5% ⚠ |
| Menard, Inc | $4.43M | $4.51M (100%) | 32.6% |
| Dollar General | $1.06M | $1.08M (100%) | 37.0% |
| 40 Boxes | $130K | $77K (59%) | 82.1% ⚠ |

Because Walmart is 63% of his revenue and 41% of it has no cost estimate,
his headline margin and his "up 0.8 pts vs LY" are both flattered. Read
the Menard and Dollar General rows as the trustworthy ones — Dollar
General margin is **down 10.7 pts** year over year on roughly half the
revenue, which is the kind of thing this box exists to surface.

Three things to fix at the source, none of them in this file:

1. **Cost estimates are missing on a large share of revenue**, heaviest in
   the Walmart and B2C/channel business. Until item cost estimates are
   populated, every margin here reads high.
2. **$7.75M FYTD account-wide has no sales rep set at all**, so it belongs
   to nobody's card. Worth assigning before this goes in front of the team.
3. **Duplicate employee records.** `Matt  Pell` (id 35496), `Matt Pell`
   (id 35495) and `Pell Matt` (id 36025) are three records for one person,
   so selecting one of them shows a third of his business. Same pattern on
   the Kelly Brand records. Merging those in NetSuite fixes it everywhere,
   not just here.

## Verification performed

- Module's generated SQL executed against the production account,
  rep-scoped and subsidiary-scoped — no errors.
- Fiscal window boundaries unit-checked, including the Sep 30 → Oct 1
  year rollover.
- Bind-parameter count checked against `?` placeholders (10 = 10),
  including the subsidiary and rep binds in the right positions.
- Standalone Suitelet checked: defaults to the highest-revenue rep,
  selector lists every rep with Promier activity, collapses double spaces
  in employee names, honours an explicit `?rep=` parameter, and rejects
  non-GET requests.
- Render checked against real FY26 data for Cody: sorts by GP descending,
  strips entity-id prefixes, drops fully inactive customers, raises
  coverage warnings with the correct missing percentage, renders the
  no-rep placeholder, and totals to $16.10M revenue / $9.68M GP / 60.1%
  margin — the Promier-only figure, correctly $0.92M below his
  all-subsidiary total.
