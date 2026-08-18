/**
 * MW - SL - Rep Profitability
 *
 * Standalone Suitelet wrapper around the Rep Profitability card.
 *
 * Purpose: deploy the feature today without touching the Sales Department
 * Board. Same module, same query, same styling — just its own page with a
 * rep selector on top instead of taking the rep from the board's state.
 *
 * Once `Sales_Department_Board_Suitelet (1).js` is available to edit, the
 * board calls `mw_sl_rep_profitability_box.render({ repId })` directly and
 * this wrapper becomes optional. Nothing has to be rewritten — the card
 * itself is unchanged either way.
 *
 * Deploy: Suitelet, script id `customscript_mw_sl_rep_profit`,
 * deployment `customdeploy1`, Released, Available Without Login = No.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/query', './mw_sl_rep_profitability_box'], function (query, box) {
  'use strict';

  var REP_SQL = [
    'SELECT',
    '  t.employee             AS repid,',
    '  BUILTIN.DF(t.employee) AS rep,',
    '  -SUM(tl.netamount)     AS rev',
    'FROM transaction t',
    'JOIN transactionline tl ON tl.transaction = t.id',
    "WHERE t.type IN ('CustInvc', 'CashSale', 'CustCred')",
    "  AND t.posting = 'T'",
    "  AND tl.mainline = 'F'",
    "  AND tl.taxline = 'F'",
    "  AND tl.itemtype NOT IN ('ShipItem', 'TaxItem', 'TaxGroup')",
    '  AND tl.subsidiary = ?',
    '  AND t.employee IS NOT NULL',
    "  AND t.trandate >= TO_DATE(?, 'YYYY-MM-DD')",
    'GROUP BY t.employee, BUILTIN.DF(t.employee)',
    'HAVING -SUM(tl.netamount) <> 0',
    'ORDER BY rev DESC'
  ].join('\n');

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function listReps(fyStart) {
    return query.runSuiteQL({
      query: REP_SQL,
      params: [box.SUBSIDIARY_ID, fyStart]
    }).asMappedResults();
  }

  function selector(reps, selectedId) {
    var opts = reps.map(function (r) {
      var sel = String(r.repid) === String(selectedId) ? ' selected' : '';
      return '<option value="' + esc(r.repid) + '"' + sel + '>'
        + esc(String(r.rep || '').replace(/\s+/g, ' ').trim())
        + '</option>';
    }).join('');

    return '<form method="get" class="mw-rps-bar">'
      + '<label for="mw-rps-rep">Sales rep</label>'
      + '<select id="mw-rps-rep" name="rep" onchange="this.form.submit()">'
      + '<option value="">— select —</option>' + opts
      + '</select>'
      + '<noscript><button type="submit">Go</button></noscript>'
      + '</form>';
  }

  var PAGE_CSS = [
    '<style>',
    'body{margin:0;padding:22px;background:#eef1f4;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}',
    '.mw-rps-wrap{max-width:680px;margin:0 auto;}',
    '.mw-rps-bar{display:flex;align-items:center;gap:9px;margin-bottom:14px;}',
    '.mw-rps-bar label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;',
    'color:#667085;font-weight:600;}',
    '.mw-rps-bar select{font-size:13px;padding:6px 9px;border:1px solid #d0d5dd;',
    'border-radius:7px;background:#fff;color:#101828;min-width:230px;}',
    '</style>'
  ].join('');

  function onRequest(context) {
    if (context.request.method !== 'GET') {
      context.response.write('Method not allowed');
      return;
    }

    var win = box.buildWindows(new Date());
    var reps = listReps(win.fyStart);

    var repId = context.request.parameters.rep;
    // Default to the highest-revenue rep so the page is never empty on
    // first load; the selector still drives everything after that.
    if (!repId && reps.length) {
      repId = reps[0].repid;
    }

    var chosen = reps.filter(function (r) {
      return String(r.repid) === String(repId);
    })[0];

    var card = box.render({
      repId: repId,
      repName: chosen ? String(chosen.rep).replace(/\s+/g, ' ').trim() : null
    });

    context.response.write(
      PAGE_CSS
      + '<div class="mw-rps-wrap">'
      + selector(reps, repId)
      + card
      + '</div>'
    );
  }

  return { onRequest: onRequest };
});
