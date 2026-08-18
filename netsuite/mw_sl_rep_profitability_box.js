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
