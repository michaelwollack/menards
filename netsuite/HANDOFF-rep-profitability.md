# Handoff — Rep Profitability card for the Sales Department Board

**Drop this whole file into a Claude session that can read the NetSuite
File Cabinet.** It is self-contained: the working card source is in the
appendix, so you do not need the originating repo.

---

## 1. What to build

Add a **Rep Profitability** card to the Sales Department Board, in the
empty grid slot **to the left of the Alerts card**.

Requirements, from the board owner (Michael Wollack, COO):

1. Show **only the rep currently selected on the board** — not a
   leaderboard of all reps. The board already has this state; it drives
   the "MY ORDERS" section of the Alerts card ("Cody — Shippable Past Due
   Orders").
2. Scope to **subsidiary Promier Products (internal id `1`)** only.
3. **Make it look like the Customer Profitability breakout.** ← this is
   the part that still needs doing; see §2.

**Target script:** `7840` / `customscript_mw_sl_sales_dashboard`
**Target file:** `SuiteScripts/Sales_Department_Board_Suitelet (1).js`
(File Cabinet id `7863705`, folder `-15`, ~207 KB)

## 2. The one open task: match the Customer Profitability styling

A working card already exists (appendix) and is verified against live
data, but **its styling is inferred, not copied.** The originating session
could not read the Customer Profitability report — the egress proxy denies
`4854895.app.netsuite.com` and NetSuite's REST API refuses the `file`
record type, so no route to the File Cabinet existed.

**You should be able to read it. Please do, and align the card to it:**

| Script | Script ID | File | File Cabinet id |
|---|---|---|---|
| MW - SL - Customer Profitability Report | `customscript_mw_sl_cust_profit` (id 8893) | `mw_sl_customer_profit.js` | 7969709 |
| MW - SL - Item Tier Profitability | `customscript_mw_sl_tier_profit` (id 8895) | `mw_sl_tier_profit.js` | 7975634 |

Read `mw_sl_customer_profit.js` and align the card's:

- summary tile set, order, and wording
- table column set, order, and header casing
- number formatting (does it abbreviate `$16.10M`, or show full figures?)
- colour tokens for positive/negative/neutral deltas
- card chrome — radius, shadow, padding, heading weight

The current card guesses "summary tile strip over a ranked breakout
table." If Customer Profitability does something different, **follow it**
— consistency across the two reports matters more than the current
layout.

Also read `Sales_Department_Board_Suitelet (1).js` itself for:

- how the board resolves the **selected rep** (variable name / URL param).
  Pass that into `render({ repId })`. Do **not** re-derive it — if the
  card and the Alerts section disagree about who is selected, the board
  is worse than before.
- how sibling cards are emitted into grid cells, and whether the board
  uses `serverWidget` INLINEHTML fields or raw HTML assembly.
- whether the board already has a CSS reset or card class the box should
  adopt instead of its own scoped styles.

## 3. Data contract — already validated, do not re-derive

This SQL was executed against production and returns correct results.
Reuse it as-is unless the styling work forces a column change.

```sql
SELECT
  BUILTIN.DF(t.entity)    AS customer,
  BUILTIN.DF(t.employee)  AS rep,
  -SUM(CASE WHEN t.trandate >= TO_DATE(?, 'YYYY-MM-DD') THEN tl.netamount ELSE 0 END) AS rev_fytd,
  -SUM(CASE WHEN t.trandate >= TO_DATE(?, 'YYYY-MM-DD') THEN tl.netamount - NVL(tl.costestimate, 0) ELSE 0 END) AS gp_fytd,
  -SUM(CASE WHEN t.trandate >= TO_DATE(?, 'YYYY-MM-DD') AND tl.costestimate IS NOT NULL THEN tl.netamount ELSE 0 END) AS rev_with_cost,
  -SUM(CASE WHEN t.trandate BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD') THEN tl.netamount ELSE 0 END) AS rev_ly,
  -SUM(CASE WHEN t.trandate BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD') THEN tl.netamount - NVL(tl.costestimate, 0) ELSE 0 END) AS gp_ly
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type IN ('CustInvc', 'CashSale', 'CustCred')
  AND t.posting = 'T'
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND tl.itemtype NOT IN ('ShipItem', 'TaxItem', 'TaxGroup')
  AND tl.subsidiary = ?
  AND t.employee = ?
  AND t.trandate >= TO_DATE(?, 'YYYY-MM-DD')
GROUP BY BUILTIN.DF(t.entity), BUILTIN.DF(t.employee)
```

Bind order (10 params): `fyStart, fyStart, fyStart, lyStart, lyEnd,
lyStart, lyEnd, SUBSIDIARY_ID, repId, lyStart`.

### Why it is written this way

**Rep field is `transaction.employee`.** That is the Sales Rep header
field on these transactions. It is `NULL` on a large block of B2C /
channel revenue — see §4.

**Item lines only.** `mainline='F'`, `taxline='F'`, and `itemtype NOT IN
('ShipItem','TaxItem','TaxGroup')`. This makes the revenue base match
NetSuite's own `estgrossprofit` basis.

**Gross profit uses `transactionline.costestimate`,** the same input
NetSuite's `estgrossprofit` field uses. Verified line-for-line against
cash sale `CSAB-62955`:

| | |
|---|---|
| item line `netamount` | −159.99 |
| item line `costestimate` | −35.00 |
| computed GP | 124.99 |
| header `estgrossprofit` | 124.99 ✓ |
| computed margin | 78.12% |
| header `estgrossprofitpercent` | 0.7812 ✓ |

**Actual posted COGS is deliberately NOT used, and you should not
"improve" it to COGS without a redesign.** On these transactions COGS does
not post to the invoice or cash sale — it posts on the item fulfillment.
Checked on transaction `14835841`: accounting lines are AR (668), revenue
(54) and shipping income (108); there is no COGS line. Attributing real
COGS to a rep needs a fulfillment-to-order join, which belongs in a
reporting layer, not a dashboard card.

**Fiscal year is Oct 1 – Sep 30** (FY25 = 10/1/24 – 9/30/25, per the FY25
Top-10 Customers report). The `accountingperiod` table is **not**
queryable via SuiteQL in this account — both `accountingperiod` and
`accountingPeriod` return "Record not found" — so the boundary is a
constant (`FY_START_MONTH = 10`) in the module. The prior-year window is
the *same* window shifted back one year, so the comparison is like-for-like
rather than a full prior year against a partial current one.

**Subsidiary is `tl.subsidiary`, id 1 = Promier Products.** Verified: this
filter moves Cody's FYTD revenue from $17.02M (all subsidiaries) to
$16.10M.

## 4. Data-quality problems this card exposes

These are real conditions in the account, not bugs. The card flags them
rather than silently showing flattering numbers — **keep that behaviour.**

Cody Grandadam, FY26 to date, Promier only:

| Customer | Revenue | Revenue carrying a cost | Margin shown |
|---|---|---|---|
| Walmart Stores | $10.22M | $5.00M (49%) | 74.5% ⚠ |
| Menard, Inc | $4.43M | $4.51M (100%) | 32.6% |
| Dollar General | $1.06M | $1.08M (100%) | 37.0% |
| 40 Boxes | $130K | $77K (59%) | 82.1% ⚠ |

Walmart is 63% of his revenue and 41% of it has no cost estimate, so his
headline margin and his "▲0.8 pts vs LY" are both flattered. Dollar
General margin is **down 10.7 pts YoY** — that is the signal the card
exists to surface.

Three source-data issues, none fixable in this file:

1. **Cost estimates missing on a large share of revenue**, heaviest in
   Walmart and B2C/channel. Until item cost estimates are populated every
   margin reads high. This is why the `⚠` and the coverage tooltip exist.
2. **$7.75M FYTD account-wide has `employee IS NULL`** — no rep at all, so
   it belongs to nobody's card.
3. **Duplicate employee records.** `Matt  Pell` (35496), `Matt Pell`
   (35495) and `Pell Matt` (36025) are three records for one person;
   selecting one shows a third of his business. Same pattern on the Kelly
   Brand records.

## 5. Reps with Promier activity (FY26 TD, sanity reference)

| id | Rep | Revenue |
|---|---|---|
| 8 | Cody D Grandadam | $16.10M |
| 10391 | Don Kuffel | $7.49M |
| 6737 | Kristopher B Fredrickson | $1.76M |
| 42236 | Timothy Campbell | $865K |
| 35455 | Amazon Sales | $353K |
| 63474 | Maxwill Marquez | $259K |
| 10087 | House Account | $86K |
| 60627 | Shopify Channel | $71K |
| 60634 | Unassigned Rep | $32K |

If your integration produces materially different numbers for Cody
(expect **$16.10M revenue / $9.68M GP / 60.1% margin**, top customer
Walmart), something is wrong — check the subsidiary filter first.

## 6. Integration steps

1. Upload the appendix module to **SuiteScripts** (folder `-15`) as
   `mw_sl_rep_profitability_box.js`.
2. Add it to the board's `define([...])`:
   ```js
   define(['N/query', /* ...existing... */, './mw_sl_rep_profitability_box'],
     function (query, /* ...existing... */, repProfitBox) {
   ```
3. In the open cell left of Alerts:
   ```js
   var repProfitHtml = repProfitBox.render({
     repId:   selectedRepId,    // the board's existing selected-rep value
     repName: selectedRepName   // optional
   });
   ```
   `render()` returns one complete self-contained fragment (scoped
   `<style>` + `<div class="mw-rpb">`). With no `repId` it returns a
   neutral "Select a rep" placeholder rather than throwing — keep that,
   the board should never blow up because nothing is selected yet.
4. Restyle per §2.

## 7. Verification checklist

- [ ] Card renders in the correct slot, left of Alerts, at the board's
      own card width — no horizontal page scroll.
- [ ] Changing the board's selected rep changes the card, and the card
      always agrees with the Alerts "MY ORDERS" section.
- [ ] Cody reconciles: $16.10M / $9.68M / 60.1%, Walmart top row.
- [ ] Switching subsidiary context does not leak non-Promier data.
- [ ] Styling matches `mw_sl_customer_profit.js`.
- [ ] `⚠` still appears on Walmart and 40 Boxes with the correct missing
      percentages (41% and 41%).
- [ ] Governance is fine — one SuiteQL call per render.
- [ ] No `repId` → placeholder, no error.

## 8. Prior work

Branch `claude/netsuite-sales-dashboard-gxtd4m` of
`github.com/michaelwollack/menards`, folder `netsuite/`:

| File | Role |
|---|---|
| `mw_sl_rep_profitability_box.js` | The card (appendix below) |
| `mw_sl_rep_profitability_sl.js` | Standalone Suitelet wrapper — deploys the card as its own page with a rep selector, no board changes needed |
| `README-rep-profitability-box.md` | Install and rationale |

The standalone wrapper is a fallback, not a competing design: it calls the
same `box.render()`. If the board integration lands, the wrapper becomes
optional and nothing needs rewriting.

---

## Appendix — `mw_sl_rep_profitability_box.js`

Verified: SQL executes clean against production rep- and
subsidiary-scoped; bind params 10 = 10 in the right positions; fiscal
window boundaries unit-checked including the Sep 30 → Oct 1 rollover;
render checked against real FY26 data.

```javascript
/**
 * MW - SL - Rep Profitability Box
 *
 * Dashboard card for the Sales Department Board
 * (script 7840 / customscript_mw_sl_sales_dashboard).
 *
 * Sits in the open slot to the left of the Alerts card. Shows the
 * profitability of the *currently selected rep only*, broken out by
 * customer, in the shape of the Customer Profitability report: a summary
 * tile strip over a ranked breakout table.
 *
 * Scope is Promier Products (subsidiary 1) only.
 *
 * Self-contained on purpose: all CSS is scoped under the `mw-rpb-`
 * prefix and the whole card is returned as one HTML string, so it drops
 * into the board without touching its stylesheet or layout engine.
 * See README-rep-profitability-box.md for wiring.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['N/query'], function (query) {
  'use strict';

  // Promier Products. The board is a Promier sales tool; Accubow, OzCut
  // and the other subsidiaries are deliberately out of scope.
  var SUBSIDIARY_ID = 1;

  // Promier fiscal year runs Oct 1 - Sep 30 (FY25 = 10/1/24 - 9/30/25).
  // NetSuite's accounting period table is not exposed to SuiteQL in this
  // account, so the boundary lives here. Change this one constant if the
  // fiscal calendar ever moves.
  var FY_START_MONTH = 10; // 1-based: October

  // Customers below this share of revenue carrying a cost estimate get
  // flagged. Their margin is overstated because missing cost reads as zero.
  var COVERAGE_WARN_THRESHOLD = 0.9;

  var DEFAULT_ROW_LIMIT = 8;

  /**
   * One selected rep, broken out by customer.
   *
   * Item lines only - shipping and tax lines are excluded so the revenue
   * base matches NetSuite's own estgrossprofit basis (verified line-by-line
   * against cash sale CSAB-62955).
   *
   * Cost is `costestimate`, the same input NetSuite uses for
   * estgrossprofit. Actual COGS is not usable here: it posts on the item
   * fulfillment, not the invoice, so it is not attributable to the rep on
   * the sales transaction without a separate fulfillment-to-order join.
   */
  var D = "TO_DATE(?, 'YYYY-MM-DD')";

  var SQL = [
    'SELECT',
    '  BUILTIN.DF(t.entity)    AS customer,',
    '  BUILTIN.DF(t.employee)  AS rep,',
    '  -SUM(CASE WHEN t.trandate >= ' + D + ' THEN tl.netamount ELSE 0 END) AS rev_fytd,',
    '  -SUM(CASE WHEN t.trandate >= ' + D + ' THEN tl.netamount - NVL(tl.costestimate, 0) ELSE 0 END) AS gp_fytd,',
    '  -SUM(CASE WHEN t.trandate >= ' + D + ' AND tl.costestimate IS NOT NULL THEN tl.netamount ELSE 0 END) AS rev_with_cost,',
    '  -SUM(CASE WHEN t.trandate BETWEEN ' + D + ' AND ' + D + ' THEN tl.netamount ELSE 0 END) AS rev_ly,',
    '  -SUM(CASE WHEN t.trandate BETWEEN ' + D + ' AND ' + D + ' THEN tl.netamount - NVL(tl.costestimate, 0) ELSE 0 END) AS gp_ly',
    'FROM transaction t',
    'JOIN transactionline tl ON tl.transaction = t.id',
    "WHERE t.type IN ('CustInvc', 'CashSale', 'CustCred')",
    "  AND t.posting = 'T'",
    "  AND tl.mainline = 'F'",
    "  AND tl.taxline = 'F'",
    "  AND tl.itemtype NOT IN ('ShipItem', 'TaxItem', 'TaxGroup')",
    '  AND tl.subsidiary = ?',
    '  AND t.employee = ?',
    '  AND t.trandate >= ' + D,
    'GROUP BY BUILTIN.DF(t.entity), BUILTIN.DF(t.employee)'
  ].join('\n');

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function iso(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  /**
   * Fiscal-year-to-date window, plus the same window shifted back one
   * year so the comparison is like-for-like (same number of selling days,
   * not a full prior year against a partial current year).
   */
  function buildWindows(asOf) {
    var fyStartYear = (asOf.getMonth() + 1) >= FY_START_MONTH
      ? asOf.getFullYear()
      : asOf.getFullYear() - 1;

    return {
      fyStart: iso(new Date(fyStartYear, FY_START_MONTH - 1, 1)),
      lyStart: iso(new Date(fyStartYear - 1, FY_START_MONTH - 1, 1)),
      lyEnd: iso(new Date(asOf.getFullYear() - 1, asOf.getMonth(), asOf.getDate())),
      label: 'FY' + String(fyStartYear + 1).slice(2) + ' to date'
    };
  }

  function fetchRows(win, repId) {
    var results = query.runSuiteQL({
      query: SQL,
      params: [
        win.fyStart, win.fyStart, win.fyStart,
        win.lyStart, win.lyEnd,
        win.lyStart, win.lyEnd,
        SUBSIDIARY_ID, repId, win.lyStart
      ]
    }).asMappedResults();

    return results.map(function (r) {
      return {
        customer: cleanName(r.customer),
        rep: r.rep || '',
        revFytd: Number(r.rev_fytd) || 0,
        gpFytd: Number(r.gp_fytd) || 0,
        revWithCost: Number(r.rev_with_cost) || 0,
        revLy: Number(r.rev_ly) || 0,
        gpLy: Number(r.gp_ly) || 0
      };
    });
  }

  // Customer display names come back as "651 Menard, Inc" - the leading
  // token is the NetSuite entity id, which is noise in a meeting.
  function cleanName(name) {
    return String(name || '').replace(/^\d+\s+/, '') || 'Unnamed';
  }

  function margin(gp, rev) {
    return rev > 0 ? gp / rev : null;
  }

  function money(n) {
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (abs >= 1000000) return sign + '$' + (abs / 1000000).toFixed(2) + 'M';
    if (abs >= 1000) return sign + '$' + Math.round(abs / 1000) + 'K';
    return sign + '$' + abs.toFixed(0);
  }

  function pct(n) {
    return n === null ? '--' : (n * 100).toFixed(1) + '%';
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var CSS = [
    '<style>',
    '.mw-rpb{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;',
    'background:#fff;border-radius:14px;padding:20px 22px;box-sizing:border-box;height:100%;',
    'box-shadow:0 1px 3px rgba(16,24,40,.08),0 1px 2px rgba(16,24,40,.04);}',
    '.mw-rpb-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}',
    '.mw-rpb-title{font-size:17px;font-weight:700;color:#101828;}',
    '.mw-rpb-period{font-size:11px;color:#98a2b3;white-space:nowrap;}',
    '.mw-rpb-rep{font-size:12.5px;color:#475467;margin-top:2px;}',
    '.mw-rpb-rep b{color:#101828;font-weight:600;}',
    /* summary tile strip */
    '.mw-rpb-tiles{display:flex;gap:10px;margin:14px 0 4px;flex-wrap:wrap;}',
    '.mw-rpb-tile{flex:1 1 108px;background:#f9fafb;border:1px solid #eaecf0;border-radius:9px;padding:9px 11px;}',
    '.mw-rpb-tile-l{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:#98a2b3;font-weight:600;}',
    '.mw-rpb-tile-v{font-size:19px;font-weight:700;color:#101828;margin-top:3px;font-variant-numeric:tabular-nums;}',
    /* breakout table */
    '.mw-rpb-scroll{overflow-x:auto;margin-top:12px;}',
    '.mw-rpb table{width:100%;border-collapse:collapse;font-size:12.5px;}',
    '.mw-rpb th{text-align:right;font-weight:600;color:#667085;padding:6px 7px;',
    'border-bottom:1px solid #eaecf0;white-space:nowrap;font-size:10px;text-transform:uppercase;letter-spacing:.04em;}',
    '.mw-rpb th:first-child,.mw-rpb td:first-child{text-align:left;}',
    '.mw-rpb td{padding:7px;border-bottom:1px solid #f2f4f7;white-space:nowrap;text-align:right;',
    'color:#101828;font-variant-numeric:tabular-nums;}',
    '.mw-rpb tbody tr:hover{background:#f9fafb;}',
    '.mw-rpb-cust{font-weight:500;max-width:190px;overflow:hidden;text-overflow:ellipsis;}',
    '.mw-rpb-gp{font-weight:600;}',
    '.mw-rpb-up{color:#067647;}',
    '.mw-rpb-down{color:#b42318;}',
    '.mw-rpb-flat{color:#98a2b3;}',
    '.mw-rpb-warn{color:#b54708;cursor:help;margin-left:4px;font-weight:700;}',
    '.mw-rpb tfoot td{border-top:2px solid #eaecf0;border-bottom:none;font-weight:700;padding-top:9px;}',
    '.mw-rpb-note{margin-top:12px;font-size:10.5px;color:#98a2b3;line-height:1.5;}',
    '.mw-rpb-empty{padding:34px 0;text-align:center;color:#98a2b3;font-size:12.5px;}',
    '</style>'
  ].join('');

  function deltaMarkup(m, mLy) {
    if (m === null || mLy === null) {
      return { cls: 'mw-rpb-flat', text: '--' };
    }
    var pts = (m - mLy) * 100;
    if (pts > 0.05) return { cls: 'mw-rpb-up', text: '▲ ' + pts.toFixed(1) + ' pts' };
    if (pts < -0.05) return { cls: 'mw-rpb-down', text: '▼ ' + Math.abs(pts).toFixed(1) + ' pts' };
    return { cls: 'mw-rpb-flat', text: '— 0.0 pts' };
  }

  function shell(win, repLabel, inner) {
    return CSS
      + '<div class="mw-rpb">'
      + '<div class="mw-rpb-head">'
      + '<span class="mw-rpb-title">Rep Profitability</span>'
      + '<span class="mw-rpb-period">' + win.label + ' &middot; Promier Products</span>'
      + '</div>'
      + '<div class="mw-rpb-rep">' + repLabel + '</div>'
      + inner
      + '</div>';
  }

  /**
   * Returns the complete HTML for the card.
   *
   * @param {Object}  options
   * @param {number}  options.repId     internal id of the selected rep.
   *                                    Pass the board's existing selected-rep
   *                                    value; the card does not resolve it.
   * @param {string} [options.repName]  display name, if the board already has it
   * @param {number} [options.limit]    max customer rows (default 8)
   * @param {Date}   [options.asOf]     as-of date (default today)
   * @returns {string} HTML
   */
  function render(options) {
    var opts = options || {};
    var asOf = opts.asOf || new Date();
    var win = buildWindows(asOf);
    var limit = opts.limit || DEFAULT_ROW_LIMIT;

    if (!opts.repId) {
      return shell(win, 'No rep selected',
        '<div class="mw-rpb-empty">Select a rep to see their profitability breakout.</div>');
    }

    var rows = fetchRows(win, opts.repId).filter(function (r) {
      return r.revFytd !== 0 || r.gpFytd !== 0 || r.revLy !== 0;
    });

    var repName = opts.repName
      || (rows.length && rows[0].rep)
      || 'Selected rep';
    var repLabel = '<b>' + esc(repName) + '</b> &middot; by customer';

    if (!rows.length) {
      return shell(win, repLabel,
        '<div class="mw-rpb-empty">No posted Promier sales for this rep in ' + win.label + '.</div>');
    }

    rows.sort(function (a, b) { return b.gpFytd - a.gpFytd; });

    var tot = rows.reduce(function (a, r) {
      a.rev += r.revFytd; a.gp += r.gpFytd; a.cov += r.revWithCost;
      a.revLy += r.revLy; a.gpLy += r.gpLy;
      return a;
    }, { rev: 0, gp: 0, cov: 0, revLy: 0, gpLy: 0 });

    var totMargin = margin(tot.gp, tot.rev);
    var totMarginLy = margin(tot.gpLy, tot.revLy);
    var totDelta = deltaMarkup(totMargin, totMarginLy);

    var tiles = ''
      + '<div class="mw-rpb-tiles">'
      + '<div class="mw-rpb-tile"><div class="mw-rpb-tile-l">Revenue</div>'
      + '<div class="mw-rpb-tile-v">' + money(tot.rev) + '</div></div>'
      + '<div class="mw-rpb-tile"><div class="mw-rpb-tile-l">Gross Profit</div>'
      + '<div class="mw-rpb-tile-v">' + money(tot.gp) + '</div></div>'
      + '<div class="mw-rpb-tile"><div class="mw-rpb-tile-l">Margin</div>'
      + '<div class="mw-rpb-tile-v">' + pct(totMargin) + '</div></div>'
      + '<div class="mw-rpb-tile"><div class="mw-rpb-tile-l">Margin vs LY</div>'
      + '<div class="mw-rpb-tile-v ' + totDelta.cls + '">' + totDelta.text + '</div></div>'
      + '</div>';

    var shown = rows.slice(0, limit);
    var flagged = 0;

    var body = shown.map(function (r) {
      var m = margin(r.gpFytd, r.revFytd);
      var d = deltaMarkup(m, margin(r.gpLy, r.revLy));
      var coverage = r.revFytd > 0 ? r.revWithCost / r.revFytd : 1;
      var warn = '';
      if (coverage < COVERAGE_WARN_THRESHOLD) {
        flagged++;
        warn = '<span class="mw-rpb-warn" title="Cost estimate missing on '
          + Math.round((1 - coverage) * 100)
          + '% of this revenue - margin shown is overstated">&#9888;</span>';
      }
      return '<tr>'
        + '<td class="mw-rpb-cust" title="' + esc(r.customer) + '">' + esc(r.customer) + '</td>'
        + '<td>' + money(r.revFytd) + '</td>'
        + '<td>' + money(r.gpFytd) + '</td>'
        + '<td class="mw-rpb-gp">' + pct(m) + warn + '</td>'
        + '<td class="' + d.cls + '">' + d.text + '</td>'
        + '</tr>';
    }).join('');

    var hidden = rows.length - shown.length;
    var notes = [];
    if (hidden > 0) {
      notes.push(hidden + ' more customer' + (hidden === 1 ? '' : 's') + ' not shown; total row covers all.');
    }
    if (flagged > 0) {
      notes.push('&#9888; = cost estimate missing on part of that revenue, so the margin shown is too high.');
    }
    notes.push('Gross profit uses estimated cost, the same basis as NetSuite gross profit. '
      + 'Posted invoices, cash sales and credit memos, Promier Products only.');

    var table = '<div class="mw-rpb-scroll"><table>'
      + '<thead><tr><th>Customer</th><th>Revenue</th><th>GP $</th><th>GP %</th><th>vs LY</th></tr></thead>'
      + '<tbody>' + body + '</tbody>'
      + '<tfoot><tr>'
      + '<td>Total</td>'
      + '<td>' + money(tot.rev) + '</td>'
      + '<td>' + money(tot.gp) + '</td>'
      + '<td class="mw-rpb-gp">' + pct(totMargin) + '</td>'
      + '<td class="' + totDelta.cls + '">' + totDelta.text + '</td>'
      + '</tr></tfoot>'
      + '</table></div>'
      + '<div class="mw-rpb-note">' + notes.join('<br>') + '</div>';

    return shell(win, repLabel, tiles + table);
  }

  return {
    render: render,
    // exported for reuse / unit checking
    buildWindows: buildWindows,
    SUBSIDIARY_ID: SUBSIDIARY_ID,
    SQL: SQL
  };
});
```
