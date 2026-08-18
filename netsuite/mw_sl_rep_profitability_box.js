/**
 * MW - SL - Rep Profitability Box
 *
 * Drop-in dashboard card for the Sales Department Board
 * (script 7840 / customscript_mw_sl_sales_dashboard).
 *
 * Fills the open grid slot next to the Alerts box with a per-rep
 * profitability breakdown: revenue, gross profit, margin %, and the
 * year-over-year margin swing, for the fiscal year to date.
 *
 * Self-contained on purpose: all CSS is scoped under the `mw-rpb-`
 * prefix and all markup is returned as a single HTML string, so this
 * can be dropped into the board without touching its stylesheet or
 * layout engine. See README-rep-profitability-box.md for wiring.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['N/query'], function (query) {
  'use strict';

  // Promier fiscal year runs Oct 1 - Sep 30 (FY25 = 10/1/24 - 9/30/25).
  // NetSuite's accounting period table is not exposed to SuiteQL in this
  // account, so the boundary lives here. Change this one constant if the
  // fiscal calendar ever moves.
  var FY_START_MONTH = 10; // 1-based: October

  // Reps below this share of revenue carrying a cost estimate get flagged.
  // Their margin is overstated because the missing cost reads as zero.
  var COVERAGE_WARN_THRESHOLD = 0.9;

  var DEFAULT_ROW_LIMIT = 8;

  /**
   * Sales transactions only, item lines only. Shipping and tax lines are
   * excluded so the revenue base matches NetSuite's own estgrossprofit
   * basis (verified line-by-line against CSAB-62955).
   *
   * Cost is `costestimate`, the same input NetSuite uses for
   * estgrossprofit. Actual COGS is not usable here: it posts on the item
   * fulfillment, not the invoice, so it is not attributable to the rep on
   * the sales transaction without a separate fulfillment-to-order join.
   */
  // Dates are bound as YYYY-MM-DD strings and cast explicitly with TO_DATE.
  // Binding a bare string against a date column relies on the account's
  // display format, which is not something this card should depend on.
  var D = "TO_DATE(?, 'YYYY-MM-DD')";

  var SQL = [
    'SELECT',
    '  t.employee                                  AS repid,',
    '  BUILTIN.DF(t.employee)                      AS rep,',
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
    '  AND t.trandate >= ' + D,
    'GROUP BY t.employee, BUILTIN.DF(t.employee)'
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
   * not full prior year vs partial current year).
   */
  function buildWindows(asOf) {
    var fyStartYear = (asOf.getMonth() + 1) >= FY_START_MONTH
      ? asOf.getFullYear()
      : asOf.getFullYear() - 1;

    var fyStart = new Date(fyStartYear, FY_START_MONTH - 1, 1);
    var lyStart = new Date(fyStartYear - 1, FY_START_MONTH - 1, 1);
    var lyEnd = new Date(asOf.getFullYear() - 1, asOf.getMonth(), asOf.getDate());

    return {
      fyStart: iso(fyStart),
      lyStart: iso(lyStart),
      lyEnd: iso(lyEnd),
      label: 'FY' + String(fyStartYear + 1).slice(2) + ' to date'
    };
  }

  function fetchRows(win) {
    var results = query.runSuiteQL({
      query: SQL,
      params: [
        win.fyStart, win.fyStart, win.fyStart,
        win.lyStart, win.lyEnd,
        win.lyStart, win.lyEnd,
        win.lyStart
      ]
    }).asMappedResults();

    return results.map(function (r) {
      return {
        repId: r.repid,
        rep: r.rep || 'Unassigned / channel',
        revFytd: Number(r.rev_fytd) || 0,
        gpFytd: Number(r.gp_fytd) || 0,
        revWithCost: Number(r.rev_with_cost) || 0,
        revLy: Number(r.rev_ly) || 0,
        gpLy: Number(r.gp_ly) || 0
      };
    });
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
    'background:#fff;border:1px solid #dfe3e8;border-radius:8px;padding:14px 16px;box-sizing:border-box;height:100%;}',
    '.mw-rpb-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:2px;}',
    '.mw-rpb-title{font-size:14px;font-weight:600;color:#1b2733;letter-spacing:.01em;}',
    '.mw-rpb-period{font-size:11px;color:#8a94a0;white-space:nowrap;}',
    '.mw-rpb-sub{font-size:11px;color:#8a94a0;margin-bottom:10px;}',
    '.mw-rpb-scroll{overflow-x:auto;}',
    '.mw-rpb table{width:100%;border-collapse:collapse;font-size:12px;}',
    '.mw-rpb th{text-align:right;font-weight:600;color:#6b7683;padding:5px 6px;',
    'border-bottom:1px solid #e6e9ed;white-space:nowrap;font-size:11px;text-transform:uppercase;letter-spacing:.03em;}',
    '.mw-rpb th:first-child,.mw-rpb td:first-child{text-align:left;}',
    '.mw-rpb td{padding:6px;border-bottom:1px solid #f2f4f6;white-space:nowrap;text-align:right;color:#1b2733;}',
    '.mw-rpb tbody tr:hover{background:#f7f9fb;}',
    '.mw-rpb-rep{font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis;}',
    '.mw-rpb-gp{font-variant-numeric:tabular-nums;font-weight:600;}',
    '.mw-rpb-up{color:#1a7f4b;}',
    '.mw-rpb-down{color:#c0392b;}',
    '.mw-rpb-flat{color:#8a94a0;}',
    '.mw-rpb-warn{color:#b7791f;cursor:help;margin-left:4px;font-weight:700;}',
    '.mw-rpb tfoot td{border-top:2px solid #dfe3e8;border-bottom:none;font-weight:700;padding-top:8px;}',
    '.mw-rpb-note{margin-top:10px;font-size:10.5px;color:#8a94a0;line-height:1.45;}',
    '.mw-rpb-empty{padding:24px 0;text-align:center;color:#8a94a0;font-size:12px;}',
    '</style>'
  ].join('');

  function marginCell(m, flagged) {
    var warn = flagged
      ? '<span class="mw-rpb-warn" title="Cost estimate missing on part of this rep\'s revenue - margin is overstated">&#9888;</span>'
      : '';
    return '<td class="mw-rpb-gp">' + pct(m) + warn + '</td>';
  }

  function deltaCell(m, mLy) {
    if (m === null || mLy === null) {
      return '<td class="mw-rpb-flat">--</td>';
    }
    var pts = (m - mLy) * 100;
    var cls = pts > 0.05 ? 'mw-rpb-up' : (pts < -0.05 ? 'mw-rpb-down' : 'mw-rpb-flat');
    var arrow = pts > 0.05 ? '&#9650;' : (pts < -0.05 ? '&#9660;' : '&#8212;');
    return '<td class="' + cls + '">' + arrow + ' ' + Math.abs(pts).toFixed(1) + ' pts</td>';
  }

  /**
   * Returns the complete HTML for the card. Drop the string into the
   * board's open grid cell next to Alerts.
   *
   * @param {Object} [options]
   * @param {number} [options.limit] max rep rows to show (default 8)
   * @param {Date}   [options.asOf]  as-of date (default today)
   * @returns {string} HTML
   */
  function render(options) {
    var opts = options || {};
    var limit = opts.limit || DEFAULT_ROW_LIMIT;
    var asOf = opts.asOf || new Date();
    var win = buildWindows(asOf);

    var rows = fetchRows(win).filter(function (r) {
      return r.revFytd !== 0 || r.gpFytd !== 0;
    });

    rows.sort(function (a, b) {
      return b.gpFytd - a.gpFytd;
    });

    var totals = rows.reduce(function (acc, r) {
      acc.revFytd += r.revFytd;
      acc.gpFytd += r.gpFytd;
      acc.revWithCost += r.revWithCost;
      acc.revLy += r.revLy;
      acc.gpLy += r.gpLy;
      return acc;
    }, { revFytd: 0, gpFytd: 0, revWithCost: 0, revLy: 0, gpLy: 0 });

    var shown = rows.slice(0, limit);
    var flaggedCount = 0;

    var body = shown.map(function (r) {
      var m = margin(r.gpFytd, r.revFytd);
      var mLy = margin(r.gpLy, r.revLy);
      var coverage = r.revFytd > 0 ? r.revWithCost / r.revFytd : 1;
      var flagged = coverage < COVERAGE_WARN_THRESHOLD;
      if (flagged) flaggedCount++;

      return '<tr>'
        + '<td class="mw-rpb-rep" title="' + esc(r.rep) + '">' + esc(r.rep) + '</td>'
        + '<td>' + money(r.revFytd) + '</td>'
        + '<td>' + money(r.gpFytd) + '</td>'
        + marginCell(m, flagged)
        + deltaCell(m, mLy)
        + '</tr>';
    }).join('');

    if (!shown.length) {
      body = '<tr><td colspan="5" class="mw-rpb-empty">No posted sales in ' + win.label + '.</td></tr>';
    }

    var totalMargin = margin(totals.gpFytd, totals.revFytd);
    var totalMarginLy = margin(totals.gpLy, totals.revLy);

    var hidden = rows.length - shown.length;
    var notes = [];
    if (hidden > 0) {
      notes.push(hidden + ' more rep' + (hidden === 1 ? '' : 's') + ' not shown; total row covers all.');
    }
    if (flaggedCount > 0) {
      notes.push('&#9888; = cost estimate missing on part of that revenue, so the margin shown is too high.');
    }
    notes.push('Gross profit uses estimated cost, the same basis as NetSuite gross profit. Posted invoices, cash sales and credit memos.');

    return CSS
      + '<div class="mw-rpb">'
      + '<div class="mw-rpb-head">'
      + '<span class="mw-rpb-title">Rep Profitability</span>'
      + '<span class="mw-rpb-period">' + win.label + '</span>'
      + '</div>'
      + '<div class="mw-rpb-sub">Ranked by gross profit &middot; margin vs same period last year</div>'
      + '<div class="mw-rpb-scroll"><table>'
      + '<thead><tr><th>Rep</th><th>Revenue</th><th>GP $</th><th>GP %</th><th>vs LY</th></tr></thead>'
      + '<tbody>' + body + '</tbody>'
      + '<tfoot><tr>'
      + '<td>All reps</td>'
      + '<td>' + money(totals.revFytd) + '</td>'
      + '<td>' + money(totals.gpFytd) + '</td>'
      + '<td class="mw-rpb-gp">' + pct(totalMargin) + '</td>'
      + deltaCell(totalMargin, totalMarginLy)
      + '</tr></tfoot>'
      + '</table></div>'
      + '<div class="mw-rpb-note">' + notes.join('<br>') + '</div>'
      + '</div>';
  }

  return {
    render: render,
    // exported for reuse / unit checking
    buildWindows: buildWindows,
    SQL: SQL
  };
});
