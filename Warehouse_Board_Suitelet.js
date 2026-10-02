/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/ui/serverWidget', 'N/search', 'N/url', 'N/redirect', 'N/log', 'N/https', 'N/runtime', 'N/query', 'N/format', 'N/record', 'N/cache', 'N/task', '/SuiteScripts/mw_lib_cardnav'], function(file, serverWidget, search, url, redirect, log, https, runtime, query, format, record, cache, task, cardnav) {


  // ── Shared board theme ────────────────────────────────────────────────
  // All styling for this board lives in one File Cabinet stylesheet:
  //   /SuiteScripts/Projects/KodiakTheme/kodiak.css
  // It is read server-side and inlined rather than <link>ed, because
  // NetSuite caches media.nl URLs hard enough that edits can appear stale
  // for hours. Cached per execution; never edit CSS in this file.
  var KODIAK_CSS = null;
  function kodiakCss() {
    if (KODIAK_CSS) return KODIAK_CSS;   // cache successes only
    try { KODIAK_CSS = file.load({ id: '/SuiteScripts/Projects/KodiakTheme/kodiak.css' }).getContents(); }
    catch (e) {
      // Most likely 'Script Execution Usage Limit Exceeded' — file.load
      // costs 10 units. Do NOT cache the failure: KODIAK_CSS is module
      // scoped and NetSuite reuses the module, so caching '' here would
      // serve an unstyled page for the life of the execution context.
      log.error('kodiakCss', (e && e.message) || String(e));
      return '';
    }
    return KODIAK_CSS;
  }

  // Link the stylesheet instead of inlining it. The shared sheet is ~261KB
  // and was being pasted into every board page, so the browser re-parsed it on
  // every navigation and could cache nothing across the boards. As a <link> it
  // is fetched once and reused everywhere.
  //
  // Falls back to inlining if the URL cannot be resolved, so a board can never
  // end up unstyled.
  var KODIAK_HREF;
  function kodiakLink() {
    if (KODIAK_HREF === undefined) {
      try { KODIAK_HREF = file.load({ id: '/SuiteScripts/Projects/KodiakTheme/kodiak.css' }).url; }
      catch (e) { KODIAK_HREF = ''; }
    }
    return KODIAK_HREF
      ? '<link rel="stylesheet" href="' + KODIAK_HREF + '">'
      : '<style>' + kodiakCss() + '<' + '/style>';
  }

  var SUITELET_TITLE = 'Warehouse Board';
  var ITEM_RESULT_LIMIT = 50;
  var TRAN_RESULT_LIMIT = 20;

  function normalizeTerm(raw) {
    return String(raw || '').trim();
  }

  function digitsOnly(raw) {
    return String(raw || '').replace(/[^\d]/g, '').trim();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  function escapeJs(s) {
    // For embedding a value inside a single-quoted JS string literal
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // TEMP per-section timing (2026-08-27): &sbtime=1 dumps section millis into
  // the page; AJAX replies carry theirs under _t.
  /* ── ONE cache bundle (2026-08-28, "sped it up") ──────────────────────────
     Measured: main page 8.4s of which Upcoming Projects 4.8s + five alert
     saved searches 2.9s; then the deferred stats grid 3.7s and Connecteam
     1.8s. All company-wide, so one PROTECTED bundle serves everyone --
     PROTECTED and single-entry both by measurement (PUBLIC does not persist
     in this account, and sibling keys thrash; see the Sales board history).
     RF monitor and activity stay live. &fresh=1 rewarms. */
  var WB_CACHE = null, WB_FRESH = false, WB_BUNDLE = null;
  // Set when any stats search fails to load (e.g. permissions): a degraded
  // compute must never be cached for everyone — that is how 08-28's all-zero
  // grid happened (private searches + one unlucky user's loader run).
  var WB_DEGRADED = false;
  var WB_CT_MAX_AGE = 300000;
  var WB_ALERT_IDS = ['3123', '3118', '3121', '4556', '5158'];
  function wbPut(val) {
    try {
      if (val && val.deg) return;   // never persist a degraded compute
      if (!WB_CACHE) WB_CACHE = cache.getCache({ name: 'wb_board_v1', scope: cache.Scope.PROTECTED });
      WB_CACHE.put({ key: 'bundle', value: JSON.stringify(val), ttl: 900 });
    } catch (e) { }
  }
  function wbCt() {
    var sc = runtime.getCurrentScript();
    return buildClockedInHtml(sc.getParameter({ name: 'custscript_wb_ct_apikey' }) || '',
                              sc.getParameter({ name: 'custscript_wb_ct_clockid' }) || '');
  }
  function buildWbBundle(withCt, prevCt, prevCtAt) {
    stampContainerReceipts(10);   // incremental; the warmer does the bulk
    var al = {};
    for (var i = 0; i < WB_ALERT_IDS.length; i++) al[WB_ALERT_IDS[i]] = getSavedSearchCount(WB_ALERT_IDS[i]);
    var ctHtml = prevCt || '', ctAt = prevCtAt || 0;
    if (withCt) {
      try { ctHtml = wbCt(); ctAt = new Date().getTime(); } catch (eC) { }
    }
    // Stats deliberately absent: they live under their own 45s key now
    // (see statsCached). Caching the rendered grid here is what froze all
    // four columns together and left the "as of" stamp sitting still
    // (Michael, 2026-08-28: "why is not refreshing every 60sec? its still
    // 1:15"), and a 15-minute warmer cannot keep a 45s entry warm anyway.
    var bundle = { at: new Date().getTime(), projects: getUpcomingProjects(), al_ss: al,
                   alAt: new Date().getTime(),
                   ct: ctHtml, ctAt: ctAt };
    if (WB_DEGRADED) bundle.deg = true;
    return bundle;
  }
  function wbBundle() {
    if (WB_BUNDLE) return WB_BUNDLE;
    try {
      if (!WB_CACHE) WB_CACHE = cache.getCache({ name: 'wb_board_v1', scope: cache.Scope.PROTECTED });
      if (WB_FRESH) {
        WB_BUNDLE = buildWbBundle(true);
        wbPut(WB_BUNDLE);
      } else {
        WB_BUNDLE = JSON.parse(WB_CACHE.get({ key: 'bundle', ttl: 900,
          loader: function () { return JSON.stringify(buildWbBundle(true)); } }));
        // The loader's result is cached by N/cache itself, degraded or not;
        // evict it so a bad compute only ever affects the request that made it.
        if (WB_BUNDLE && WB_BUNDLE.deg) { try { WB_CACHE.remove({ key: 'bundle' }); } catch (eD) { } }
        if (!WB_BUNDLE.ct || (new Date().getTime() - (WB_BUNDLE.ctAt || 0)) > WB_CT_MAX_AGE) {
          try { WB_BUNDLE.ct = wbCt(); WB_BUNDLE.ctAt = new Date().getTime(); wbPut(WB_BUNDLE); } catch (eR) { }
        }
        // Alerts must not ride the full 15-minute bundle window (Michael,
        // 2026-08-28: 'alerts ... not reading the counts from the searches')
        // -- the five saved-search counts refresh in place at 5 minutes.
        // A failed count (-1) keeps the previous value instead.
        if ((new Date().getTime() - (WB_BUNDLE.alAt || WB_BUNDLE.at || 0)) > 300000) {
          try {
            var alNew = WB_BUNDLE.al_ss || {};
            for (var aiR = 0; aiR < WB_ALERT_IDS.length; aiR++) {
              var cR = getSavedSearchCount(WB_ALERT_IDS[aiR]);
              if (cR >= 0) alNew[WB_ALERT_IDS[aiR]] = cR;
            }
            WB_BUNDLE.al_ss = alNew;
            WB_BUNDLE.alAt = new Date().getTime();
            if (!WB_DEGRADED) wbPut(WB_BUNDLE);
          } catch (eAl) { }
        }
      }
    } catch (e) {
      WB_BUNDLE = buildWbBundle(true);
    }
    return WB_BUNDLE;
  }
  // Scheduled-warmer entry: no Connecteam creds in that context, so the
  // previous panel rides along and the board refreshes it in place.
  function warmWarehouseBundle() {
    stampContainerReceipts(400);   // scheduled context: 10k units available
    var prev = null;
    try {
      if (!WB_CACHE) WB_CACHE = cache.getCache({ name: 'wb_board_v1', scope: cache.Scope.PROTECTED });
      prev = JSON.parse(WB_CACHE.get({ key: 'bundle', loader: function () { return 'null'; } }));
    } catch (e) { }
    wbPut(buildWbBundle(false, prev && prev.ct, prev && prev.ctAt));
    return true;
  }

  var WB_TIME = {};
  function tmark(k, t0) { try { WB_TIME[k] = (WB_TIME[k] || 0) + (Date.now() - t0); } catch (e) { } }
  function timed(k, fn) { var t0 = Date.now(); var v = fn(); tmark(k, t0); return v; }

  function getPopularLinks() {
    return [
      // NEW BOARDS, 2026-08-22/23. These are the editable queues and the search
      // tools built for the switch-over. They were live but unreachable from
      // this dashboard, which is where the warehouse actually starts its day —
      // so they sit first, above the legacy trackers they are meant to replace.
      {
        category: 'New Boards',
        links: [
          // 2026-08-23, departmental: Warehouse sees warehouse work, Sales sees
          // sales work, Accounting sees only its own, and the Operations Board
          // carries everything. Accounting links appear on no other board.
          { label: 'Routing Grid', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_routing_grid&deploy=customdeploy1' },
          { label: 'EDI Queue', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_edi_queue&deploy=customdeploy1' },
          { label: 'Pack & Ship', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_pack_ship&deploy=customdeploy1' },
          { label: 'Item Data Quality', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_item_dq&deploy=customdeploy1' },
          // Find / Ask / Item Catalog removed 2026-08-28 (Michael) -- all three
          // live in the nav bar's Tools menu on every board.
          { label: 'Container Tracking', href: '/app/site/hosting/scriptlet.nl?script=9146&deploy=customdeploy_kt_container' }
        ]
      },
      {
        category: 'Orders',
        links: [
          { label: 'Open Sales Orders', href: '/app/site/hosting/scriptlet.nl?script=7581&deploy=1' },
          { label: 'Backorders Report', href: '/app/site/hosting/scriptlet.nl?script=7579&deploy=1' },
          { label: 'Label Printing', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_print_pallet_label&deploy=customdeploy1' },
          { label: 'Ship Sheet', href: '/app/site/hosting/scriptlet.nl?script=4485&deploy=1' }
        ]
      },
      {
        category: 'Trackers',
        links: [
          // The per-container card built 2026-08-22. Container Tracking above is
          // the LIST; this is the single-container view it should link into.
          { label: 'Inbound Shipment Card', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_inb_card&deploy=customdeploy1' },
          { label: 'Shipment Tracking', href: '/app/site/hosting/scriptlet.nl?script=9119&deploy=1'},
          { label: 'EDI Tracking', href: '/app/site/hosting/scriptlet.nl?script=7842&deploy=1&compid=4854895&page=dashboard'},
          { label: 'Routing Tracker', href: '/app/site/hosting/scriptlet.nl?script=7738&deploy=1' }
        ]
      },
            {
        category: 'Inventory',
        links: [
          { label: 'Smart Count Dashboard', href: '/spa-app/com.netsuite.smartcount/sc-dashboard' },
          { label: 'Smart Count Review', href: '/spa-app/com.netsuite.smartcount/sc-count-review' },
          { label: 'RF Smart Inventory Reporting', href: '/app/site/hosting/scriptlet.nl?script=1804&deploy=1' }
        ]
      },
      {
        category: 'Mobile',
        links: [
          { label: 'WMS Scanner', href: '/core/media/media.nl?id=7618291&c=4854895&h=6gwehWX8V2lJQwIEsqOujuzF3m5dO2bA8uuEND76UubQB4EP&mv=mf5n2qm0&_xt=.html' },
          { label: 'Dims Mobile', href: '/app/site/hosting/scriptlet.nl?script=7947&deploy=2' },
          { label: 'RFSmart Scanner', href: '/app/site/hosting/scriptlet.nl?script=177&deploy=1' }
        ]
      } ,   
      {
        category: 'Work In Progress',
        links: [
          { label: 'Dispute Tracker', href: '/app/site/hosting/scriptlet.nl?script=7637&deploy=1&category=Dispute' },
          { label: 'SO Approval Queue', href: '/app/site/hosting/scriptlet.nl?script=7948&deploy=1' },
          { label: 'Operations Board', href: '/app/site/hosting/scriptlet.nl?script=9108&deploy=1' },
          { label: 'Picker Functions', href: '/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_print_pallet_label&deploy=customdeploy1' },
          { label: 'Project Tracking', href: '/app/site/hosting/scriptlet.nl?script=7637&deploy=1&category=Project' }
        ]
      },
    ];
  }

  function getAlertLinks() {
    return [
      { category: 'EDI', label: 'Labels to Print', searchId: '3123', href: '/app/common/search/searchresults.nl?searchid=3123' },
      { category: 'EDI', label: 'ASN to Send', searchId: '3118', href: '/app/common/search/searchresults.nl?searchid=3118' },
      { category: 'EDI', label: 'PO ACK to Send', searchId: '3121', href: '/app/common/search/searchresults.nl?searchid=3121' },
      { category: 'Missing Data', label: 'Pacejet Data', searchId: '4556', href: '/app/common/search/searchresults.nl?searchid=4556' },
      { category: 'Missing Data', label: 'RF Smart Multi UPC', searchId: '5158', href: '/app/common/search/searchresults.nl?searchid=5158' },
      // TODO: Re-enable once "Routing Due Today" saved search is created (old ID 5180 was deleted)
      // { category: 'Orders', label: 'Routing Due Today', searchId: 'XXXX', href: '/app/common/search/searchresults.nl?searchid=XXXX' },
      { category: 'Orders', label: 'Shippable Past Due Orders', countKey: 'shippablePastDue', href: '/app/site/hosting/scriptlet.nl?script=7584&deploy=1' }
    ];
  }

  function getSavedSearchCount(savedSearchId) {
    try {
      var s = search.load({ id: savedSearchId });
      // 2026-10-02 (Michael): Promier Products only, pinned here. The EDI
      // alert searches (Labels 3123 / ASN 3118 / PO Ack 3121) were counting
      // OzCut dropship transactions (customer 84362, SOOZ- orders) that the
      // Promier-scoped drill-through never shows, so the tile read 2 and 4
      // while the search behind it read 0. Filtering in the saved search
      // alone leaves the count one careless edit away from drifting again,
      // so the board adds the subsidiary itself. Transaction searches only:
      // the Missing Data alerts (4556, 5158) are item searches.
      if (String(s.searchType) === 'transaction') {
        s.filters.push(search.createFilter({
          name: 'subsidiary', operator: search.Operator.ANYOF, values: [PROMIER_SUBSIDIARY_ID]
        }));
      }
      var count = 0;
      s.run().each(function() {
        count++;
        return count < 1000;
      });
      return count;
    } catch (e) {
      WB_DEGRADED = true;   // never cache a bundle whose alert counts failed
      log.error({ title: 'getSavedSearchCount', details: e });
      return -1;
    }
  }

  function getShippablePastDueCount() {
    // Count of distinct Sales Orders with truly shippable committed lines past ship date.
    // Excludes kit component lines where the kit is not fully committed
    // (i.e. some sibling components are backordered or unallocated).
    try {
      // Step 1: Get all committed lines on past-due open SOs
      // Excludes lines assigned to the "Direct Ship" location (id 4) — those
      // ship from the vendor, not from our warehouse, so they're not shippable
      // from a warehouse-floor perspective.
      var sql = 'SELECT t.id AS tranId, tl.item AS itemId, tl.lineSequenceNumber AS lineSeq, tl.kitComponent'
        + ' FROM transaction t'
        + ' JOIN transactionLine tl ON tl.transaction = t.id'
        + ' WHERE t.type = \'SalesOrd\''
        + ' AND t.billingStatus = \'T\''
        + ' AND tl.mainLine = \'F\''
        + ' AND tl.taxLine = \'F\''
        + ' AND tl.quantityCommitted > 0'
        + ' AND t.shipDate IS NOT NULL'
        + ' AND TRUNC(t.shipDate) < TRUNC(CURRENT_DATE)'
        + ' AND (TRUNC(CURRENT_DATE) - TRUNC(t.shipDate)) >= 1'
        + ' AND tl.subsidiary = 1'
        + ' AND (tl.location != 4 OR tl.location IS NULL)';

      var results = query.runSuiteQL({ query: sql });
      var rows = results.asMappedResults();
      if (!rows || rows.length === 0) return 0;

      // Step 2: Identify SOs that have kit component lines in results
      var kitSOIds = {};
      rows.forEach(function(row) {
        if (row.kitcomponent === 'T') {
          kitSOIds[row.tranid] = true;
        }
      });
      var kitSOIdList = Object.keys(kitSOIds);

      // Step 3: For those SOs, find which ones have incomplete kits
      // (any kit component line that is backordered or unallocated).
      // Then walk lines in lineSequenceNumber order to group components
      // under their parent kit, and build a set of "tranId_lineSeq" for
      // committed kit components belonging to incomplete kits.
      // Keyed by line sequence (not item id) so two kits on the same SO that
      // share a component item don't cross-contaminate each other's exclusion.
      var excludeKitLines = {}; // "tranId_lineSeq" => true (kit component lines to exclude)

      if (kitSOIdList.length > 0) {
        var chunkSize = 500;
        for (var ck = 0; ck < kitSOIdList.length; ck += chunkSize) {
          var chunk = kitSOIdList.slice(ck, ck + chunkSize);

          // Pull all lines for these SOs ordered by lineSequenceNumber
          var allLinesSql = 'SELECT tl.transaction AS tranId,'
            + ' tl.lineSequenceNumber AS lineSeq,'
            + ' tl.item AS itemId,'
            + ' tl.kitComponent,'
            + ' tl.isClosed,'
            + ' tl.quantityCommitted AS committedQty,'
            + ' tl.quantityBackOrdered AS boQty,'
            + ' tl.quantity AS orderedQty'
            + ' FROM transactionLine tl'
            + ' WHERE tl.transaction IN (' + chunk.join(',') + ')'
            + ' AND tl.mainLine = \'F\''
            + ' AND tl.taxLine = \'F\''
            + ' ORDER BY tl.transaction, tl.lineSequenceNumber';

          var allLineResults = query.runSuiteQL({ query: allLinesSql }).asMappedResults();

          // Group by transaction
          var linesByTran = {};
          allLineResults.forEach(function(row) {
            if (!linesByTran[row.tranid]) linesByTran[row.tranid] = [];
            linesByTran[row.tranid].push(row);
          });

          // Walk each transaction to group kit components and check completeness
          Object.keys(linesByTran).forEach(function(tranId) {
            var lines = linesByTran[tranId];
            var currentGroupMembers = [];
            var currentGroupIncomplete = false;

            function finalizeGroup() {
              if (currentGroupIncomplete && currentGroupMembers.length > 0) {
                currentGroupMembers.forEach(function(m) {
                  excludeKitLines[m.tranid + '_' + m.lineseq] = true;
                });
              }
              currentGroupMembers = [];
              currentGroupIncomplete = false;
            }

            lines.forEach(function(line) {
              if (line.kitcomponent !== 'T') {
                // Non-component line — finalize any prior kit group, start a new potential group
                finalizeGroup();
              } else {
                // Kit component line. Closed component lines (intentionally
                // cancelled remainder) don't block the kit and can't be
                // shippable themselves — skip them entirely.
                if (line.isclosed === 'T') return;
                currentGroupMembers.push({ tranid: tranId, lineseq: line.lineseq });
                var bo = parseFloat(line.boqty) || 0;
                var committed = parseFloat(line.committedqty) || 0;
                var ordered = Math.abs(parseFloat(line.orderedqty) || 0);
                if (bo > 0 || (ordered > 0 && committed === 0)) {
                  currentGroupIncomplete = true;
                }
              }
            });
            finalizeGroup(); // finalize last group
          });
        }
      }

      // Step 4: Count distinct SOs from rows, excluding incomplete kit component lines
      var validSOs = {};
      rows.forEach(function(row) {
        if (row.kitcomponent === 'T' && excludeKitLines[row.tranid + '_' + row.lineseq]) {
          return; // skip — kit is incomplete
        }
        validSOs[row.tranid] = true;
      });

      return Object.keys(validSOs).length;
    } catch (e) {
      log.error({ title: 'getShippablePastDueCount', details: e });
      return -1;
    }
  }

  function findTransactionsByTranId(options) {
    var tranType = options.tranType;
    var termRaw = normalizeTerm(options.term);
    var termDigits = digitsOnly(termRaw);
    if (!termRaw) return [];

    var filters = [
      ['type', 'anyof', tranType],
      'AND',
      ['mainline', 'is', 'T'],
      'AND',
      [
        ['tranid', 'is', termRaw],
        'OR',
        ['tranid', 'is', termDigits || termRaw],
        'OR',
        ['tranid', 'contains', termRaw],
        'OR',
        ['tranid', 'contains', termDigits || termRaw]
      ]
    ];

    var cols = [
      search.createColumn({ name: 'internalid' }),
      search.createColumn({ name: 'tranid' }),
      search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
      search.createColumn({ name: 'entity' }),
      search.createColumn({ name: 'statusref' })
    ];

    var s = search.create({ type: search.Type.TRANSACTION, filters: filters, columns: cols });
    var out = [];
    s.run().each(function(r) {
      out.push({
        internalid: r.getValue({ name: 'internalid' }),
        tranid: r.getValue({ name: 'tranid' }),
        trandate: r.getValue({ name: 'trandate' }),
        entity: r.getText({ name: 'entity' }) || r.getValue({ name: 'entity' }) || '',
        status: r.getText({ name: 'statusref' }) || r.getValue({ name: 'statusref' }) || ''
      });
      return out.length < TRAN_RESULT_LIMIT;
    });
    return out;
  }

  function resolveTransactionUrl(tranType, internalid) {
    var map = { SalesOrd: 'salesorder', ItemShip: 'itemfulfillment', TrnfrOrd: 'transferorder' };
    var recordType = map[tranType];
    if (!recordType) return null;
    return url.resolveRecord({ recordType: recordType, recordId: internalid, isEditMode: false });
  }

  function findItems(term) {
    var t = normalizeTerm(term);
    if (!t) return [];

    var filters = [
      ['isinactive', 'is', 'F'],
      'AND',
      [
        ['itemid', 'contains', t],
        'OR',
        ['displayname', 'contains', t],
        'OR',
        ['salesdescription', 'contains', t]
      ]
    ];

    var cols = [
      search.createColumn({ name: 'internalid' }),
      search.createColumn({ name: 'itemid' }),
      search.createColumn({ name: 'displayname' }),
      search.createColumn({ name: 'type' })
    ];

    var s = search.create({ type: search.Type.ITEM, filters: filters, columns: cols });
    var out = [];
    s.run().each(function(r) {
      out.push({
        internalid: r.getValue({ name: 'internalid' }),
        itemid: r.getValue({ name: 'itemid' }) || '',
        displayname: r.getValue({ name: 'displayname' }) || '',
        itemtype: r.getValue({ name: 'type' }) || ''
      });
      return out.length < ITEM_RESULT_LIMIT;
    });
    return out;
  }

  function resolveItemUrl(itemInternalId) {
    return '/app/common/item/item.nl?id=' + encodeURIComponent(itemInternalId);
  }

  // ---- UI rendering (all string concatenation) ----

  function searchCardHtml(title, key, placeholder, lastVal) {
    var inputId = 'wb_in_' + key;
    var safeVal = escapeAttr(lastVal || '');
    return '<div class="searchBox">'
      + '<div class="searchLabel">' + escapeHtml(title) + '</div>'
      + '<div class="searchInputRow">'
      + '<input id="' + escapeAttr(inputId) + '" class="searchInput" type="text" value="' + safeVal + '" placeholder="' + escapeAttr(placeholder) + '" />'
      + '<button type="button" class="searchBtn" onclick="WB_go(\'' + escapeAttr(key) + '\',\'' + escapeAttr(inputId) + '\')">Go</button>'
      + '</div>'
      + '</div>';
  }

  function renderResultsHtml(results) {
    if (!results || !results.length) return '';
    var rows = '';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var link = r.href ? '<a target="_blank" rel="noopener" href="' + escapeAttr(r.href) + '">' + escapeHtml(r.linkText || r.href) + '</a>' : '';
      rows += '<tr>'
        + '<td>' + escapeHtml(r.kind || '') + '</td>'
        + '<td>' + escapeHtml(r.primary || '') + '</td>'
        + '<td>' + escapeHtml(r.secondary || '') + '</td>'
        + '<td>' + link + '</td>'
        + '</tr>';
    }
    return '<div class="section searchResults">'
      + '<div class="sectionTitle"><div>Results</div>'
      + '<div class="sectionSub">Multiple matches found - pick the right one (opens in new tab)</div></div>'
      + '<div style="overflow:auto;"><table class="resTable"><thead><tr>'
      + '<th>Type</th><th>Primary</th><th>Details</th><th>Open</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  }

  function getStyleBlock() {
    return kodiakLink() + (function(){try{return cardnav.bar({});}catch(e){return '';}})()
      + '<script>(function(){var h=document.documentElement;'
      + 'h.className+=" kDash";'
      + 'var t="light";try{t=localStorage.getItem("sb_theme")||"light";}catch(e){}'
      + 'if(t==="kodiak")h.className+=" kodiak";'
      + '})();<' + '/script>';
  }

  // ── Reusable HTML builders for AJAX-refreshable sections ──

  function buildMonitorHtml(rfUsers) {
    var monitorHtml = '';
    if (rfUsers.length === 0) {
      monitorHtml = '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">No active RF Smart sessions found today.</div>';
    } else {
      monitorHtml = '<div style="overflow:auto;"><table class="pausedTable"><thead><tr>'
        + '<th>User</th><th>Current Function</th><th>Detail</th><th>Last Active</th>'
        + '</tr></thead><tbody>';
      for (var ru = 0; ru < rfUsers.length; ru++) {
        var rfr = rfUsers[ru];
        monitorHtml += '<tr>'
          + '<td style="font-weight:600;">' + escapeHtml(rfr.user) + '</td>'
          + '<td>' + escapeHtml(rfr.func) + '</td>'
          + '<td>' + escapeHtml(rfr.detail || '') + '</td>'
          + '<td>' + escapeHtml(rfr.lastActive) + '</td>'
          + '</tr>';
      }
      monitorHtml += '</tbody></table></div>';
    }
    return monitorHtml;
  }

  function buildRfBdHtml(rfBreakdown) {
    var rfBdHtml = '';
    if (rfBreakdown.length === 0) {
      rfBdHtml = '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">No RF Smart transactions logged in this period.</div>';
    } else {
      rfBdHtml = '<div class="rfBdGrid">';
      for (var bd = 0; bd < rfBreakdown.length; bd++) {
        var usr = rfBreakdown[bd];
        var timeStr = '';
        if (usr.totalSec > 0) {
          var mins = Math.round(usr.totalSec / 60);
          timeStr = mins >= 60
            ? (Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm')
            : (mins + 'm');
          timeStr = ' <span style="font-weight:500;color:var(--rw-muted);font-size:12px;">&middot; ' + escapeHtml(timeStr) + ' scan time</span>';
        }
        rfBdHtml += '<div class="rfBdCard">';
        rfBdHtml += '<div class="rfBdName">' + escapeHtml(usr.name) + timeStr + '</div>';
        rfBdHtml += '<div class="rfBdActions">';
        for (var ba = 0; ba < usr.actions.length; ba++) {
          var act = usr.actions[ba];
          // Clickable: opens a drill-down listing each transaction for this
          // operator + function in the selected period
          rfBdHtml += '<a href="#" class="rfBdPill rfBdPillClick" onclick="WB_rfDrill(\''
            + escapeAttr(escapeJs(usr.name)) + '\',\'' + escapeAttr(escapeJs(act.label)) + '\');return false;">'
            + escapeHtml(act.label)
            + ' <span class="rfBdCount">&times; ' + act.count + '</span>'
            + '</a>';
        }
        rfBdHtml += '</div></div>';
      }
      rfBdHtml += '</div>';
    }
    return rfBdHtml;
  }

  function buildClockedInHtml(ctApiKey, ctClockId) {
    var clockedInHtml = '';
    if (!ctApiKey) return clockedInHtml;
    try {
      var ctUsers = getConnecteamStatus(ctApiKey, ctClockId);
      var inCount = 0;
      for (var cx = 0; cx < ctUsers.length; cx++) {
        if (ctUsers[cx].status === 'in') { inCount++; }
      }

      var allSorted = ctUsers.slice().sort(function(a, b) {
        var an = a.name.toLowerCase();
        var bn = b.name.toLowerCase();
        return an < bn ? -1 : (an > bn ? 1 : 0);
      });

      var ciItemsHtml = '';
      for (var ci = 0; ci < allSorted.length; ci++) {
        var p = allSorted[ci];
        var icon = '\u26AA';
        var offClass = ' ciItemOff';
        var timeStr = '';
        if (p.status === 'in') {
          icon = '\uD83D\uDFE2';
          offClass = '';
          timeStr = '<span class="ciItemTime">' + escapeHtml(formatClockIn(p.statusTime)) + '</span>';
        } else if (p.status === 'lunch') {
          icon = '\uD83C\uDF4E';
          offClass = '';
          timeStr = '<span class="ciItemTime">' + escapeHtml(formatClockIn(p.statusTime)) + '</span>';
        } else if (p.status === 'break') {
          icon = '\u2615';
          offClass = '';
          timeStr = '<span class="ciItemTime">' + escapeHtml(formatClockIn(p.statusTime)) + '</span>';
        }
        ciItemsHtml += '<div class="ciItem' + offClass + '">'
          + '<span class="ciItemIcon">' + icon + '</span>'
          + '<span class="ciItemName">' + escapeHtml(p.name) + '</span>'
          + timeStr + '</div>';
      }

      if (ctUsers.length === 0) {
        ciItemsHtml = '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">No Warehouse team members found in Connecteam.</div>';
      }

      clockedInHtml = '<div class="ciWrap">'
        + '<div class="ciHeader">&#128994; Who\'s Clocked In'
        + '<span class="ciCount">' + ctUsers.length + ' team \u2022 ' + inCount + ' on the clock</span></div>'
        + '<div class="ciLegend">'
        + '<span class="ciLegendItem">\uD83D\uDFE2 Clocked In</span>'
        + '<span class="ciLegendItem">\uD83C\uDF4E On Lunch</span>'
        + '<span class="ciLegendItem">\u2615 On Break</span>'
        + '<span class="ciLegendItem">\u26AA Clocked Out</span>'
        + '</div>'
        + '<div class="ciList">' + ciItemsHtml + '</div>'
        + '</div>';
    } catch (e) {
      log.error({ title: 'Connecteam panel error', details: e });
      clockedInHtml = '<div class="ciWrap">'
        + '<div class="ciHeader">&#128994; Who\'s Clocked In</div>'
        + '<div style="color:var(--k-danger,#C74634);font-size:13px;padding:8px 0;">Error loading Connecteam data</div>'
        + '</div>';
    }
    return clockedInHtml;
  }

  function getScriptBlock(refreshUrl) {
    var js = '<' + 'script>'
      + 'function WB_go(typeKey, inputId) {'
      + '  try {'
      + '    var val = (document.getElementById(inputId).value || "").trim();'
      + '    document.getElementById("custpage_action").value = typeKey;'
      + '    document.getElementById("custpage_search_value").value = val;'
      + '    var forms = document.getElementsByTagName("form");'
      + '    if (forms && forms.length) forms[0].submit();'
      + '  } catch (e) { console.log("WB_go error", e); }'
      + '}'
      + 'function WB_bindEnter(inputId, typeKey) {'
      + '  var el = document.getElementById(inputId);'
      + '  if (!el) return;'
      + '  el.addEventListener("keydown", function(ev) {'
      + '    if (ev.key === "Enter") { ev.preventDefault(); WB_go(typeKey, inputId); }'
      + '  });'
      + '}'
      + '(function(){'
      + '  WB_bindEnter("wb_in_so","so");'
      + '  WB_bindEnter("wb_in_if","if");'
      + '  WB_bindEnter("wb_in_to","to");'
      + '  WB_bindEnter("wb_in_item","item");'
      + '})();';

    // Activity period switching + drill-down + auto-refresh polling.
    // The base URL is required for all three; buttons/pills no-op without it.
    js += 'var wbBaseUrl = "' + (refreshUrl || '') + '";'
      + 'var wbActivityPeriod = "today";'
      + 'function wbGetJson(qs, cb) {'
      + '  if (!wbBaseUrl) return;'
      + '  try {'
      + '    var xhr = new XMLHttpRequest();'
      + '    xhr.open("GET", wbBaseUrl + "&json=1" + qs, true);'
      + '    xhr.onreadystatechange = function() {'
      + '      if (xhr.readyState === 4 && xhr.status === 200) {'
      + '        try { cb(JSON.parse(xhr.responseText)); }'
      + '        catch (pe) { console.log("WB json parse error", pe); }'
      + '      }'
      + '    };'
      + '    xhr.send();'
      + '  } catch (re) { console.log("WB json error", re); }'
      + '}'
      + 'function WB_rfPeriod(p) {'
      + '  wbActivityPeriod = p;'
      + '  var keys = ["today","yesterday","thisweek","lastweek","last30"];'
      + '  for (var i = 0; i < keys.length; i++) {'
      + '    var b = document.getElementById("wb_rfp_" + keys[i]);'
      + '    if (b) b.className = "rfPeriodBtn" + (keys[i] === p ? " rfPeriodBtnActive" : "");'
      + '  }'
      + '  WB_rfDrillClose();'
      + '  var act = document.getElementById("wb_activity");'
      + '  if (act) act.style.opacity = "0.5";'
      + '  wbGetJson("&activityonly=1&period=" + encodeURIComponent(p), function(data) {'
      + '    var el = document.getElementById("wb_activity");'
      + '    if (el && data.activity) { el.innerHTML = data.activity; el.style.opacity = "1"; }'
      + '  });'
      + '}'
      + 'function WB_rfDrill(user, func) {'
      + '  var dr = document.getElementById("wb_rfdrill");'
      + '  if (dr) { dr.style.display = "block"; dr.innerHTML = \'<div class="rfDrillBox" style="color:var(--rw-muted);font-size:13px;">Loading&hellip;</div>\'; }'
      + '  wbGetJson("&rfdrill=1&period=" + encodeURIComponent(wbActivityPeriod)'
      + '    + "&rfuser=" + encodeURIComponent(user) + "&rffunc=" + encodeURIComponent(func), function(data) {'
      + '    var el = document.getElementById("wb_rfdrill");'
      + '    if (el && data.drill) { el.innerHTML = data.drill; el.style.display = "block"; }'
      + '  });'
      + '}'
      + 'function WB_rfDrillClose() {'
      + '  var el = document.getElementById("wb_rfdrill");'
      + '  if (el) { el.style.display = "none"; el.innerHTML = ""; }'
      + '}'
      + 'var wbLastStat = null;'
      + 'function WB_exemptToggle(ifId, chk) {'
      + '  chk.disabled = true;'
      + '  wbGetJson("&exemptset=1&exemptif=" + encodeURIComponent(ifId) + "&exemptval=" + (chk.checked ? "T" : "F"), function(data) {'
      + '    if (data && data.ok) {'
      + '      if (wbLastStat) WB_statDrill(wbLastStat.k, wbLastStat.p);'
      + '    } else {'
      + '      alert("Could not save exempt flag" + (data && data.error ? ": " + data.error : ""));'
      + '      chk.checked = !chk.checked;'
      + '      chk.disabled = false;'
      + '    }'
      + '  });'
      + '}'
      + 'function WB_reasonSave(ifId, inp) {'
      + '  var val = (inp.value || "").trim();'
      + '  if (val === (inp.getAttribute("data-orig") || "")) return;'
      + '  inp.disabled = true;'
      + '  wbGetJson("&reasonset=1&reasonif=" + encodeURIComponent(ifId) + "&reasontext=" + encodeURIComponent(val), function(data) {'
      + '    if (data && data.ok) {'
      + '      if (wbLastStat) WB_statDrill(wbLastStat.k, wbLastStat.p);'
      + '    } else {'
      + '      alert("Could not save reason" + (data && data.error ? ": " + data.error : ""));'
      + '      inp.disabled = false;'
      + '    }'
      + '  });'
      + '}'
      + 'function WB_statDrill(statKey, periodKey) {'
      + '  wbLastStat = { k: statKey, p: periodKey };'
      + '  var dr = document.getElementById("wb_statdrill");'
      + '  if (dr) { dr.style.display = "block"; dr.innerHTML = \'<div class="rfDrillBox" style="color:var(--rw-muted);font-size:13px;">Loading&hellip;</div>\'; }'
      + '  wbGetJson("&statdrill=" + encodeURIComponent(statKey) + "&speriod=" + encodeURIComponent(periodKey), function(data) {'
      + '    var el = document.getElementById("wb_statdrill");'
      + '    if (el && data.drill) { el.innerHTML = data.drill; el.style.display = "block"; }'
      + '  });'
      + '}'
      + 'function WB_statDrillClose() {'
      + '  var el = document.getElementById("wb_statdrill");'
      + '  if (el) { el.style.display = "none"; el.innerHTML = ""; }'
      + '}'
      + 'function WB_ordersDueDrill(bucket) {'
      + '  var dr = document.getElementById("wb_projdrill");'
      + '  if (dr) { dr.style.display = "block"; dr.innerHTML = \'<div class="rfDrillBox" style="color:var(--rw-muted);font-size:13px;">Loading&hellip;</div>\'; }'
      + '  wbGetJson("&oddrill=1&odbucket=" + encodeURIComponent(bucket), function(data) {'
      + '    var el = document.getElementById("wb_projdrill");'
      + '    if (el && data.drill) { el.innerHTML = data.drill; el.style.display = "block"; }'
      + '  });'
      + '}'
      + 'function WB_projDrillClose() {'
      + '  var el = document.getElementById("wb_projdrill");'
      + '  if (el) { el.style.display = "none"; el.innerHTML = ""; }'
      + '}';

    // Auto-refresh polling for dynamic sections (every 60 seconds).
    // Respects the currently selected activity period.
    if (refreshUrl) {
      /* Statistics used to be fetched ONCE, on page load, and never again
         (2026-08-28, Michael: "The statistics are showing 0 but clearly the
         backup data is there"). A board opened at 6am -- the warehouse TV, or
         anyone's parked tab -- kept showing 6am's grid all day, while every
         drill-down is computed live at click time. So the grid said 0 orders
         packed and the drill under it listed nine fulfillments. Both were
         honest; they were just hours apart. The grid now rides the same 60s
         poll as the rest, and stamps the age it is actually showing.
         Cost: statsonly=1 is a read of the cache bundle the scheduled warmer
         (customscript_mw_ss_board_warm) rebuilds every 15 min -- ~1ms warm --
         so polling it costs no more compute than loading the page did. */
      js += 'function WB_refreshStats() {'
        + '  wbGetJson("&statsonly=1", function(data) {'
        + '    var el = document.getElementById("wb_stats");'
        + '    if (el && data.stats) el.innerHTML = data.stats;'
        + '    var st = document.getElementById("wb_statsat");'
        + '    if (st && data.statsAt) {'
        + '      var d = new Date(data.statsAt);'
        + '      st.textContent = " (as of " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ")";'
        + '    }'
        + '  });'
        + '}'
        + '(function(){'
        + '  function wbRefresh() {'
        + '    wbGetJson("&period=" + encodeURIComponent(wbActivityPeriod), function(data) {'
        + '      var el;'
        + '      el = document.getElementById("wb_clockedin");'
        + '      if (el && data.clockedIn) el.innerHTML = data.clockedIn;'
        + '      el = document.getElementById("wb_monitor");'
        + '      if (el && data.monitor) el.innerHTML = data.monitor;'
        + '      el = document.getElementById("wb_activity");'
        + '      if (el && data.activity) el.innerHTML = data.activity;'
        + '    });'
        + '  }'
        + '  setInterval(wbRefresh, 60000);'
        + '  wbRefresh();'
        // Deliberately NOT refreshing an open drill alongside the grid: the
        // on-time drill carries editable Reason inputs and Exempt boxes, and
        // redrawing under someone's cursor loses what they were typing.
        + '  setInterval(WB_refreshStats, 60000);'
        + '  WB_refreshStats();'
        + '})();';
    }

    // Theme switcher. This board had none until the shared stylesheet landed;
    // Light and Kodiak only, sharing the sb_theme key with the other six boards.
    js += 'function MW_setTheme(t) {'
      + '  if (t !== "kodiak") t = "light";'
      + '  var h = document.documentElement;'
      + '  h.className = h.className.replace(/\\bkodiak\\b/g, "").trim();'
      + '  if (t === "kodiak") h.className += " kodiak";'
      + '  try { localStorage.setItem("sb_theme", t); } catch (e) {}'
      + '  var ps = document.querySelectorAll(".themePill");'
      + '  for (var pi = 0; pi < ps.length; pi++) {'
      + '    if (ps[pi].getAttribute("data-mwtheme") === t) ps[pi].classList.add("themePillActive");'
      + '    else ps[pi].classList.remove("themePillActive");'
      + '  }'
      + '}'
      + 'function MW_initTheme() {'
      + '  var t = "light";'
      + '  try { t = localStorage.getItem("sb_theme") || "light"; } catch (le) {}'
      + '  MW_setTheme(t);'
      + '}'
      + 'if (document.readyState !== "loading") MW_initTheme();'
      + 'else document.addEventListener("DOMContentLoaded", MW_initTheme);';

    js += '<' + '/script>';
    return js;
  }

  // Friendly labels for the most common RF-SMART API commands shown in the
  // User Monitor "Current Function" column. Anything unmapped falls back to
  // a humanized version of the command's first segment.
  var RF_CMD_LABELS = {
    'SalesOrders_FulfillAdvanced': 'Fulfilling SO',
    'SalesOrder_UpdateOrderLineAsync': 'Picking SO Line',
    'SalesOrders_ByScan': 'Scanning SO',
    'SalesOrders_ItemIdByScan': 'Scanning SO Item',
    'SalesOrders_GetItemBinQuantities': 'Picking (bin lookup)',
    'SalesOrders_FindPausedPickState': 'Resuming Pick',
    'SalesOrders_ResumePickState': 'Resuming Pick',
    'SalesOrders_PausePickStateAsync': 'Pausing Pick',
    'SalesOrders_Filters': 'Browsing SOs',
    'BinTransfer_GetBinnumberAndSubmitTransfers': 'Bin Transfer / Putaway',
    'BinTransfer_ItemSearch': 'Bin Transfer (item search)',
    'InventoryTransfer_SubmitTransfer': 'Inventory Transfer',
    'InventoryTransfer_LoadItemsFromScan': 'Inventory Transfer (scan)',
    'Item_InventoryBalance': 'Item Lookup',
    'Item_LoadItems': 'Item Lookup',
    'Item_QuickSearch': 'Item Lookup',
    'Item_SimpleBinDetailsByItemBin': 'Item Lookup (bins)',
    'Menu_Load': 'Logging In / Menu',
    'Menu_GetVersion': 'Logging In / Menu',
    'Menu_ClearLicense': 'Logging Out',
    'Config_Consolidated': 'Logging In / Menu',
    'Locations_LoadLocationsAndUserInfo': 'Logging In / Menu',
    'Employees_RequirePin': 'Logging In / Menu'
  };

  function rfCommandLabel(cmd) {
    if (RF_CMD_LABELS[cmd]) return RF_CMD_LABELS[cmd];
    var funcName = cmd.split('_')[0] || cmd;
    return funcName.replace(/([A-Z])/g, ' $1').trim();
  }

  function getRfSmartActiveUsers() {
    // Show users active today from RF-SMART Logged Request records
    // Identifies users by parsing externalUser email from the JSON request payload
    // then looks up employee names by email (same logic as User Activity breakdown)
    // Also extracts transaction detail: SO internal ID for fulfillments, bin info for transfers
    try {
      var s = search.create({
        type: 'customrecord_rfs_logged_request',
        filters: [
          ['created', 'on', 'today']
        ],
        columns: [
          search.createColumn({ name: 'custrecord_rfs_logged_request_command' }),
          search.createColumn({ name: 'custrecord_rfs_logged_request_req1' }),
          search.createColumn({ name: 'lastmodified', sort: search.Sort.DESC })
        ]
      });

      var userMap = {}; // email -> { cmd, lastActive, detail, soId }
      s.run().each(function(r) {
        var req1 = r.getValue({ name: 'custrecord_rfs_logged_request_req1' }) || '';
        var extUser = '';
        var parsed = null;
        try {
          parsed = JSON.parse(req1);
          extUser = parsed.externalUser || '';
        } catch (ex) {
          var m = req1.match(/"externalUser"\s*:\s*"([^"]+)"/);
          if (m) extUser = m[1];
        }
        if (!extUser) return true;
        extUser = extUser.toLowerCase(); // case-insensitive key so John@ and john@ don't split

        // Only keep the first (most recent) entry per user since sorted DESC
        if (!userMap[extUser]) {
          var cmd = r.getValue({ name: 'custrecord_rfs_logged_request_command' }) || '';
          var funcName = rfCommandLabel(cmd);

          // Extract transaction detail from request payload
          var detail = '';
          var soId = '';
          if (parsed && parsed.record) {
            var rec = parsed.record;
            if (cmd === 'SalesOrders_FulfillAdvanced' && rec.id) {
              // SO internal ID — will be resolved to tranid below
              soId = rec.id;
              detail = 'SO #' + rec.id; // placeholder until lookup
            } else if (cmd === 'BinTransfer_GetBinnumberAndSubmitTransfers' && rec.transfers && rec.transfers.length > 0) {
              var t = rec.transfers[0];
              var fromBin = (t.frombin && t.frombin.binnumber) ? t.frombin.binnumber : '';
              var toBin = (t.tobin && t.tobin.binnumber) ? t.tobin.binnumber : (rec.binnumber || '');
              if (fromBin && toBin) detail = fromBin + ' \u2192 ' + toBin;
              else if (fromBin) detail = 'From ' + fromBin;
              else if (toBin) detail = 'To ' + toBin;
            } else if (cmd === 'InventoryTransfer_SubmitTransfer' && rec.transfers && rec.transfers.length > 0) {
              var it = rec.transfers[0];
              var itFrom = (it.frombin && it.frombin.binnumber) ? it.frombin.binnumber : '';
              var itTo = (it.tobin && it.tobin.binnumber) ? it.tobin.binnumber : '';
              if (itFrom && itTo) detail = itFrom + ' \u2192 ' + itTo;
              else if (itFrom) detail = 'From ' + itFrom;
              else if (itTo) detail = 'To ' + itTo;
            }
          }

          userMap[extUser] = {
            func: funcName,
            lastActive: r.getValue({ name: 'lastmodified' }) || '',
            detail: detail,
            soId: soId
          };
        }
        return Object.keys(userMap).length < 50;
      });

      // Collect SO internal IDs to look up tranid (SO number)
      var soIds = [];
      for (var uk in userMap) {
        if (userMap.hasOwnProperty(uk) && userMap[uk].soId) {
          soIds.push(userMap[uk].soId);
        }
      }
      var soTranMap = {}; // internal id -> tranid (e.g. "SO12345")
      if (soIds.length > 0) {
        try {
          var soFilters = [];
          for (var si = 0; si < soIds.length; si++) {
            if (si > 0) soFilters.push('OR');
            soFilters.push(['internalid', 'anyof', soIds[si]]);
          }
          var soSearch = search.create({
            type: 'salesorder',
            filters: soFilters,
            columns: [
              search.createColumn({ name: 'tranid' }),
              search.createColumn({ name: 'internalid' })
            ]
          });
          soSearch.run().each(function(sr) {
            var soIntId = sr.getValue({ name: 'internalid' }) || '';
            var soTranId = sr.getValue({ name: 'tranid' }) || '';
            if (soIntId && soTranId) soTranMap[soIntId] = soTranId;
            return true;
          });
        } catch (soErr) {
          log.error({ title: 'getRfSmartActiveUsers-soLookup', details: soErr });
        }
      }

      // Look up employee names by email
      var emailList = [];
      for (var e in userMap) {
        if (userMap.hasOwnProperty(e)) emailList.push(e);
      }
      var nameMap = {};
      if (emailList.length > 0) {
        var empFilters = [];
        for (var ei = 0; ei < emailList.length; ei++) {
          if (ei > 0) empFilters.push('OR');
          empFilters.push(['email', 'is', emailList[ei]]);
        }
        try {
          var empSearch = search.create({
            type: 'employee',
            filters: empFilters,
            columns: [
              search.createColumn({ name: 'entityid' }),
              search.createColumn({ name: 'email' })
            ]
          });
          empSearch.run().each(function(er) {
            var empEmail = (er.getValue({ name: 'email' }) || '').toLowerCase();
            var empName = er.getValue({ name: 'entityid' }) || '';
            if (empEmail && empName) nameMap[empEmail] = empName;
            return true;
          });
        } catch (empErr) {
          log.error({ title: 'getRfSmartActiveUsers-empLookup', details: empErr });
        }
      }

      // Build result array — resolve SO numbers
      var out = [];
      for (var email in userMap) {
        if (userMap.hasOwnProperty(email)) {
          var displayName = nameMap[email.toLowerCase()] || email;
          var detail = userMap[email].detail;
          // Replace placeholder SO internal ID with actual SO number
          if (userMap[email].soId && soTranMap[userMap[email].soId]) {
            detail = soTranMap[userMap[email].soId];
          }
          out.push({
            user: displayName,
            func: userMap[email].func,
            lastActive: userMap[email].lastActive,
            detail: detail
          });
        }
      }
      out.sort(function(a, b) { return a.user.localeCompare(b.user); });
      return out;
    } catch (e) {
      log.error({ title: 'getRfSmartActiveUsers', details: e });
      return [];
    }
  }

  // Friendly names for RF-SMART function list values (customrecord_rfs_tx)
  var RF_FUNC_MAP = {
    'Promier Sales Order Picking': 'SO Picking',
    'Intercompany Sales Order Picking': 'SO Picking (IC)',
    'Bin Putaway': 'Putaway',
    'Bin Transfer': 'Bin Transfer',
    'Inventory Transfer': 'Inv Transfer',
    'Item Look-Up': 'Item Look-Up'
  };

  var RF_PERIOD_LABELS = {
    today: 'Today',
    yesterday: 'Yesterday',
    thisweek: 'This Week',
    lastweek: 'Last Week',
    last30: 'Last 30 Days'
  };

  function normalizeRfPeriod(p) {
    return RF_PERIOD_LABELS.hasOwnProperty(p) ? p : 'today';
  }

  function rfPeriodFilter(periodKey) {
    switch (periodKey) {
      case 'yesterday': return ['created', 'on', 'yesterday'];
      case 'thisweek': return ['created', 'within', 'thisweek'];
      case 'lastweek': return ['created', 'within', 'lastweek'];
      case 'last30':
        var d = new Date();
        d.setDate(d.getDate() - 30);
        return ['created', 'onorafter', format.format({ value: d, type: format.Type.DATE })];
      default: return ['created', 'on', 'today'];
    }
  }

  function runRfTxSearch(periodKey, columns, perRow) {
    // Paged read of customrecord_rfs_tx for a period — Last 30 Days can exceed
    // the 4,000-row each() window, so always page.
    var s = search.create({
      type: 'customrecord_rfs_tx',
      filters: [rfPeriodFilter(periodKey), 'AND', ['isinactive', 'is', 'F']],
      columns: columns
    });
    var paged = s.runPaged({ pageSize: 1000 });
    paged.pageRanges.forEach(function(pr) {
      paged.fetch({ index: pr.index }).data.forEach(perRow);
    });
  }

  function getRfSmartUserBreakdown(periodKey) {
    // RF Smart work for the period grouped by operator, from customrecord_rfs_tx
    // (one record per COMPLETED inventory transaction, with duration in seconds).
    // This replaces the old logged-request approach, which only counted 3 API
    // commands (~10-15% of traffic), lumped Bin Putaway in with Bin Transfer,
    // and could not see durations. All scanner guns share one NetSuite login,
    // so the real operator is the free-text custrecord_rfs_external_user.
    periodKey = normalizeRfPeriod(periodKey);
    try {
      // key = lowercased operator name; value = { name, counts, totalSec }
      var userMap = {};
      runRfTxSearch(periodKey, [
        search.createColumn({ name: 'custrecord_rfs_external_user' }),
        search.createColumn({ name: 'custrecord_rfs_transaction_user' }),
        search.createColumn({ name: 'custrecord_rfs_execfunc' }),
        search.createColumn({ name: 'custrecord_rfs_txduration' })
      ], function(r) {
        var opName = (r.getValue({ name: 'custrecord_rfs_external_user' }) || '').trim();
        if (!opName) {
          // fall back to the NetSuite login (shared gun account) if no operator
          opName = r.getText({ name: 'custrecord_rfs_transaction_user' }) || 'Unknown';
        }
        var key = opName.toLowerCase();
        if (!userMap[key]) userMap[key] = { name: opName, counts: {}, totalSec: 0 };

        var funcText = r.getText({ name: 'custrecord_rfs_execfunc' }) || 'Other';
        var friendly = RF_FUNC_MAP[funcText] || funcText;
        userMap[key].counts[friendly] = (userMap[key].counts[friendly] || 0) + 1;
        userMap[key].totalSec += parseFloat(r.getValue({ name: 'custrecord_rfs_txduration' })) || 0;
      });

      var result = [];
      for (var k in userMap) {
        if (userMap.hasOwnProperty(k)) {
          var u = userMap[k];
          var actions = [];
          for (var lbl in u.counts) {
            if (u.counts.hasOwnProperty(lbl)) {
              actions.push({ label: lbl, count: u.counts[lbl] });
            }
          }
          actions.sort(function(a, b) { return b.count - a.count; });
          result.push({ name: u.name, actions: actions, totalSec: u.totalSec });
        }
      }
      result.sort(function(a, b) {
        return a.name.localeCompare(b.name);
      });
      return result;
    } catch (e) {
      log.error({ title: 'getRfSmartUserBreakdown', details: e });
      return [];
    }
  }

  function buildRfDrillHtml(periodKey, userName, funcLabel) {
    // Drill-down for one operator + function in the User Activity panel:
    // lists each RF-SMART transaction with its linked NetSuite transaction
    // (e.g. the SOs Sean picked) and duration.
    periodKey = normalizeRfPeriod(periodKey);
    var wantUser = String(userName || '').trim().toLowerCase();
    var wantFunc = String(funcLabel || '').trim();
    try {
      var rows = [];
      runRfTxSearch(periodKey, [
        search.createColumn({ name: 'custrecord_rfs_external_user' }),
        search.createColumn({ name: 'custrecord_rfs_transaction_user' }),
        search.createColumn({ name: 'custrecord_rfs_execfunc' }),
        search.createColumn({ name: 'custrecord_rfs_txduration' }),
        search.createColumn({ name: 'custrecord_transaction' }),
        search.createColumn({ name: 'created', sort: search.Sort.DESC })
      ], function(r) {
        if (rows.length >= 200) return;
        var opName = (r.getValue({ name: 'custrecord_rfs_external_user' }) || '').trim();
        if (!opName) {
          opName = r.getText({ name: 'custrecord_rfs_transaction_user' }) || 'Unknown';
        }
        if (opName.toLowerCase() !== wantUser) return;
        var funcText = r.getText({ name: 'custrecord_rfs_execfunc' }) || 'Other';
        if ((RF_FUNC_MAP[funcText] || funcText) !== wantFunc) return;
        rows.push({
          when: r.getValue({ name: 'created' }) || '',
          tranId: r.getValue({ name: 'custrecord_transaction' }) || '',
          sec: parseFloat(r.getValue({ name: 'custrecord_rfs_txduration' })) || 0
        });
      });

      // Resolve linked transaction numbers (SO/IF/etc.)
      var tranMap = {}; // internal id -> { tranid, type }
      var tranIds = [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].tranId && tranIds.indexOf(rows[i].tranId) === -1) tranIds.push(rows[i].tranId);
      }
      if (tranIds.length > 0) {
        try {
          var ts = search.create({
            type: search.Type.TRANSACTION,
            filters: [['internalid', 'anyof', tranIds], 'AND', ['mainline', 'is', 'T']],
            columns: [
              search.createColumn({ name: 'tranid' }),
              search.createColumn({ name: 'type' })
            ]
          });
          var tPaged = ts.runPaged({ pageSize: 1000 });
          tPaged.pageRanges.forEach(function(pr) {
            tPaged.fetch({ index: pr.index }).data.forEach(function(tr) {
              tranMap[tr.id] = {
                tranid: tr.getValue({ name: 'tranid' }) || ('#' + tr.id),
                type: tr.getText({ name: 'type' }) || ''
              };
            });
          });
        } catch (te) {
          log.error({ title: 'buildRfDrillHtml-tranLookup', details: te });
        }
      }

      function fmtDur(sec) {
        var m = Math.floor(sec / 60);
        var s = Math.round(sec % 60);
        return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
      }

      var header = '<div class="rfDrillHead">'
        + '<div><b>' + escapeHtml(userName) + '</b> &mdash; ' + escapeHtml(wantFunc)
        + ' &middot; ' + escapeHtml(RF_PERIOD_LABELS[periodKey])
        + ' &middot; ' + rows.length + (rows.length === 200 ? '+' : '') + ' transaction' + (rows.length === 1 ? '' : 's')
        + '</div>'
        + '<button type="button" class="rfDrillClose" onclick="WB_rfDrillClose()">&times;</button>'
        + '</div>';

      if (rows.length === 0) {
        return '<div class="rfDrillBox">' + header
          + '<div style="color:var(--rw-muted);font-size:13px;padding:6px 0;">No matching RF Smart transactions in this period.</div></div>';
      }

      var body = '<div style="overflow:auto;max-height:320px;"><table class="pausedTable"><thead><tr>'
        + '<th>Time</th><th>Transaction</th><th>Duration</th>'
        + '</tr></thead><tbody>';
      for (var x = 0; x < rows.length; x++) {
        var rw = rows[x];
        var tranCell = '&mdash;';
        if (rw.tranId) {
          var tinfo = tranMap[rw.tranId];
          var tLabel = tinfo ? ((tinfo.type ? tinfo.type + ' ' : '') + tinfo.tranid) : ('#' + rw.tranId);
          tranCell = '<a href="/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(rw.tranId)
            + '" target="_blank" rel="noopener">' + escapeHtml(tLabel) + '</a>';
        }
        body += '<tr>'
          + '<td>' + escapeHtml(rw.when) + '</td>'
          + '<td>' + tranCell + '</td>'
          + '<td>' + escapeHtml(fmtDur(rw.sec)) + '</td>'
          + '</tr>';
      }
      body += '</tbody></table></div>';

      return '<div class="rfDrillBox">' + header + body + '</div>';
    } catch (e) {
      log.error({ title: 'buildRfDrillHtml', details: e });
      return '<div class="rfDrillBox"><div class="rfDrillHead"><div>Drill-down error</div>'
        + '<button type="button" class="rfDrillClose" onclick="WB_rfDrillClose()">&times;</button></div>'
        + '<div style="color:var(--k-danger,#C74634);font-size:13px;">Could not load detail - check script log.</div></div>';
    }
  }

  function getPausedRecords() {
    // Uses saved search 5177 (custom search on RF-SMART Record Lock, rectype 91)
    // Reorders columns so User appears first
    try {
      var s = search.load({ id: '5177' });
      var columns = s.columns;
      var rawHeaders = [];
      var userIdx = -1;
      for (var h = 0; h < columns.length; h++) {
        var lbl = columns[h].label || columns[h].name || '';
        rawHeaders.push(lbl);
        var chk = (lbl + ' ' + (columns[h].name || '')).toLowerCase();
        if (chk.indexOf('user') > -1 && userIdx === -1) {
          userIdx = h;
        }
      }
      // Build column order: user first, then remaining in original order
      var order = [];
      if (userIdx > 0) {
        order.push(userIdx);
        for (var k = 0; k < columns.length; k++) {
          if (k !== userIdx) order.push(k);
        }
      } else {
        for (var m = 0; m < columns.length; m++) order.push(m);
      }
      var headers = [];
      for (var oh = 0; oh < order.length; oh++) {
        headers.push(rawHeaders[order[oh]]);
      }
      var rows = [];
      s.run().each(function(r) {
        var raw = [];
        for (var c = 0; c < columns.length; c++) {
          raw.push(r.getText(columns[c]) || r.getValue(columns[c]) || '');
        }
        var row = [];
        for (var ri = 0; ri < order.length; ri++) {
          row.push(raw[order[ri]]);
        }
        rows.push(row);
        return rows.length < 100;
      });
      return { headers: headers, rows: rows };
    } catch (e) {
      log.error({ title: 'getPausedRecords', details: e });
      return { headers: [], rows: [] };
    }
  }

  var PROMIER_SUBSIDIARY_ID = '1';

  // On-time benchmark: the source Sales Order's Ship Date (shipdate).
  // Per Michael 2026-08-13: grade against ship date, NOT promise date.
  // Customers excluded from on-time grading entirely (Michael, 2026-08-28:
  // "I thought O'Reilly was exempt from the on time" -- it never was, now it
  // is). O'Reilly's dropship POs arrive with a ship date already in the past,
  // so every line graded as late says nothing about the warehouse. The same
  // exclusion is written into saved search customsearch_wb_stat_ontime (via
  // &fixontime=1), so the search stays the visible source of truth; this list
  // keeps the drill-down in lockstep.
  var ONTIME_EXEMPT_CUSTOMERS = ['37279'];   // 6099 O'Reilly Auto Parts

  var ONTIME_BENCH = '{createdfrom.shipdate}';

  // Adjusted on-time: a line also counts as on time when (a) its order was
  // ROUTED (SO custbody_routed_on) on or before the SO Ship Date — a carrier
  // picking up late is not the warehouse's miss — or (b) the fulfillment has
  // a Late Shipment Reason recorded (custbody_wb_late_reason, free text:
  // Carrier No Show / Building Power Outage / Employee Shortage), set from
  // the on-time drill-down. Unrouted, unexempted orders grade strictly.
  // NOTE: the custom late-reason field must NOT be referenced through
  // N/search (columns OR formulas) — the SEARCH channel rejects fresh custom
  // body fields with SSS_INVALID_SRCH_COL, and an invalid field inside a
  // formula silently blanks the whole formula column. Reasons are merged in
  // via SuiteQL (getLateReasonMap) after the search runs.
  var ONTIME_STRICT_FORMULA = 'CASE WHEN {trandate} <= ' + ONTIME_BENCH + ' THEN 1 ELSE 0 END';
  var ONTIME_ADJ_FORMULA = 'CASE WHEN {trandate} <= ' + ONTIME_BENCH
    + ' OR TRUNC({createdfrom.custbody_routed_on}) <= ' + ONTIME_BENCH + ' THEN 1 ELSE 0 END';

  function getLateInfoMap(ifIds) {
    // Map of IF internal id -> { reason: text, exempt: bool }, read via
    // SuiteQL (the analytics channel exposes these fields; N/search does not).
    // The Exempt CHECKBOX is what removes an IF from the adjusted score;
    // the Reason text is documentation only.
    var map = {};
    if (!ifIds || ifIds.length === 0) return map;
    try {
      for (var c = 0; c < ifIds.length; c += 900) {
        var chunk = ifIds.slice(c, c + 900);
        var rows = query.runSuiteQL({
          query: 'SELECT id, custbody_wb_late_reason AS rsn, custbody_wb_late_exempt AS ex FROM transaction'
            + ' WHERE id IN (' + chunk.join(',') + ')'
            + " AND (custbody_wb_late_reason IS NOT NULL OR custbody_wb_late_exempt = 'T')"
        }).asMappedResults();
        for (var i = 0; i < rows.length; i++) {
          map[String(rows[i].id)] = {
            reason: rows[i].rsn ? String(rows[i].rsn) : '',
            exempt: rows[i].ex === 'T'
          };
        }
      }
    } catch (e) {
      log.error({ title: 'getLateInfoMap', details: e });
    }
    return map;
  }

  function setLateReason(ifId, reasonText) {
    // Writes the late reason text onto the Item Fulfillment (empty = clear)
    record.submitFields({
      type: record.Type.ITEM_FULFILLMENT,
      id: parseInt(ifId, 10),
      values: { custbody_wb_late_reason: reasonText || '' },
      options: { enableSourcing: false, ignoreMandatoryFields: true }
    });
  }

  function setLateExempt(ifId, isExempt) {
    // Sets/clears the Late Shipment Exempt checkbox on the Item Fulfillment
    record.submitFields({
      type: record.Type.ITEM_FULFILLMENT,
      id: parseInt(ifId, 10),
      values: { custbody_wb_late_exempt: isExempt === true },
      options: { enableSourcing: false, ignoreMandatoryFields: true }
    });
  }

  function computePeriodStats(dateFilter) {
    // Query ItemFulfillments for a given date period
    // Promier Products subsidiary ONLY (id 1) — Accubow/Tectonic/other-sub
    // fulfillments (e.g. bulk sessions under other subsidiaries) are excluded.
    // Also excludes automated/system fulfillments (createdby = -4).
    // Orders Packed = all IFs in period (any status)
    // Orders Shipped = IFs with status Shipped
    // Pallets Shipped = SUM of custbody_pallets_loading on shipped IFs
    // Cartons Shipped = SUM of custbody_total_cartons on shipped IFs
    // % On Time = LINE-WEIGHTED: each item line on a shipped IF counts once;
    // on time when IF trandate <= the source SO's Ship Date.
    // Formulas run server-side so results don't depend on viewer date format.
    var result = {
      ordersPacked: 0,
      ordersShipped: 0,
      palletsShipped: 0,
      cartonsShipped: 0,
      pctOntime: 'N/A',
      pctOntimeAdj: 'N/A',
      hoursLogged: '0.0' // overwritten by getStatistics from RF-SMART tx durations
    };

    // The criteria now LIVE in real saved searches (Michael, 2026-08-28: "I
    // want this data pulled from solid NS searches") -- open and audit them
    // in the UI; this code only adds the period date filter and aggregates
    // the rows the searches return.
    function withDate(loaded, fld, df) {
      loaded.filters.push(search.createFilter({ name: fld, operator: df[1], values: df[2] }));
      return loaded;
    }
    try {
      var sp = withDate(search.load({ id: WB_STAT_SEARCHES.packed }), 'trandate', dateFilter);
      sp.run().each(function (r) {
        result.ordersPacked++;
        return result.ordersPacked < 4000;
      });
    } catch (e) {
      WB_DEGRADED = true;
      log.error({ title: 'computePeriodStats-packed', details: e });
    }
    try {
      var sh = withDate(search.load({ id: WB_STAT_SEARCHES.shipped }), 'trandate', dateFilter);
      var shCols = sh.columns;
      var palCol = null, carCol = null;
      for (var ci = 0; ci < shCols.length; ci++) {
        if (shCols[ci].name === 'custbody_pallets_loading') palCol = shCols[ci];
        if (shCols[ci].name === 'custbody_total_cartons') carCol = shCols[ci];
      }
      sh.run().each(function (r) {
        result.ordersShipped++;
        if (palCol) result.palletsShipped += parseFloat(r.getValue(palCol)) || 0;
        if (carCol) result.cartonsShipped += parseFloat(r.getValue(carCol)) || 0;
        return result.ordersShipped < 4000;
      });
      result.cartonsShipped = Math.round(result.cartonsShipped);
    } catch (e2) {
      WB_DEGRADED = true;
      log.error({ title: 'computePeriodStats-shipped', details: e2 });
    }

    try {
      // Line-level pass for % On Time (shipped IFs only)
      var benchCol = search.createColumn({
        name: 'formulanumeric',
        formula: 'CASE WHEN ' + ONTIME_BENCH + ' IS NOT NULL THEN 1 ELSE 0 END'
      });
      var onTimeCol = search.createColumn({
        name: 'formulanumeric_ontime',
        formula: ONTIME_STRICT_FORMULA
      });
      var onTimeAdjCol = search.createColumn({
        name: 'formulanumeric_adj',
        formula: ONTIME_ADJ_FORMULA
      });
      // Saved search customsearch_wb_stat_ontime carries these same formula
      // columns; loading it keeps criteria auditable in the UI. The three
      // createColumn objects above are retained for value access by position.
      var ls = search.load({ id: WB_STAT_SEARCHES.ontime });
      ls.filters.push(search.createFilter({ name: 'trandate', operator: dateFilter[1], values: dateFilter[2] }));
      var lsCols = ls.columns;
      benchCol = lsCols[2]; onTimeCol = lsCols[3]; onTimeAdjCol = lsCols[4];

      // Aggregate per IF so exemptions (fetched via SuiteQL afterwards) can
      // credit all of an exempted fulfillment's lines as on time
      var perIf = {}; // ifId -> { graded, ontime, adjOn }
      var lPaged = ls.runPaged({ pageSize: 1000 });
      lPaged.pageRanges.forEach(function(pr) {
        lPaged.fetch({ index: pr.index }).data.forEach(function(lr) {
          var hasBench = parseInt(lr.getValue(benchCol), 10) || 0;
          if (!hasBench) return;
          var key = String(lr.id);
          if (!perIf[key]) perIf[key] = { graded: 0, ontime: 0, adjOn: 0 };
          perIf[key].graded++;
          if (parseInt(lr.getValue(onTimeCol), 10)) perIf[key].ontime++;
          if (parseInt(lr.getValue(onTimeAdjCol), 10)) perIf[key].adjOn++;
        });
      });

      var ifIds = Object.keys(perIf);
      var infoMap = getLateInfoMap(ifIds);
      var linesGraded = 0;
      var linesOnTime = 0;
      var linesOnTimeAdj = 0;
      for (var ii = 0; ii < ifIds.length; ii++) {
        var p = perIf[ifIds[ii]];
        var info = infoMap[ifIds[ii]];
        linesGraded += p.graded;
        linesOnTime += p.ontime;
        linesOnTimeAdj += (info && info.exempt) ? p.graded : p.adjOn;
      }

      if (linesGraded > 0) {
        result.pctOntime = Math.round((linesOnTime / linesGraded) * 100) + '%';
        result.pctOntimeAdj = Math.round((linesOnTimeAdj / linesGraded) * 100) + '%';
      }
    } catch (e) {
      WB_DEGRADED = true;
      log.error({ title: 'computePeriodStats-ontime', details: e });
    }

    return result;
  }

  function statPeriodSqlDates(periodKey) {
    // SQL date literals matching the named search periods (weeks = Sun..Sat)
    function iso(d) {
      return "TO_DATE('" + d.getFullYear() + '-'
        + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
        + ('0' + d.getDate()).slice(-2) + "','YYYY-MM-DD')";
    }
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    var weekStart = new Date(today); weekStart.setDate(today.getDate() - now.getDay());
    var weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 6);
    var lastWeekStart = new Date(weekStart); lastWeekStart.setDate(weekStart.getDate() - 7);
    var lastWeekEnd = new Date(weekStart); lastWeekEnd.setDate(weekStart.getDate() - 1);
    switch (periodKey) {
      case 'yesterday': return { start: iso(yesterday), end: iso(yesterday) };
      case 'thisweek': return { start: iso(weekStart), end: iso(weekEnd) };
      case 'lastweek': return { start: iso(lastWeekStart), end: iso(lastWeekEnd) };
      default: return { start: iso(today), end: iso(today) };
    }
  }

  /* ── Container stamping (2026-08-28) ──────────────────────────────────────
     Michael: container stats "should be coming from a search". The receipt-to
     -container link lives through inboundShipmentItem joins no saved search
     can express, so each container-linked Item Receipt gets its container id
     stamped into custbody_wb_inb_container. From then on a PLAIN saved search
     (customsearch_wb_stat_containers) owns the rows: open it, audit it, group
     it. The stamper is incremental -- only unstamped receipts, newest first,
     capped per run -- and runs on bundle warm plus the scheduled warmer. */
  function stampContainerReceipts(maxRows) {
    // Governance-aware: submitFields on an Item Receipt is not cheap, and the
    // first run inside a 1,000-unit suitelet died at 48 stamps with
    // "Script Execution Usage Limit Exceeded" (measured). The board stamps a
    // handful per load; the scheduled warmer, with its 10,000-unit budget,
    // clears the backlog in bulk.
    var stamped = 0;
    try {
      var rows = query.runSuiteQL({
        query: "SELECT DISTINCT t.id AS ir, isi.inboundShipment AS inb"
          + ' FROM inboundShipmentItem isi'
          + " JOIN transactionLine tl ON tl.createdFrom = isi.purchaseOrderTransaction AND tl.mainLine = 'T'"
          + ' JOIN transaction t ON t.id = tl.transaction'
          + " WHERE t.type = 'ItemRcpt' AND t.custbody_wb_inb_container IS NULL"
          + ' AND t.tranDate >= SYSDATE - 120'
          + ' ORDER BY t.id DESC FETCH FIRST ' + (maxRows || 10) + ' ROWS ONLY'
      }).asMappedResults();
      for (var i = 0; i < rows.length; i++) {
        if (runtime.getCurrentScript().getRemainingUsage() < 400) break;
        try {
          record.submitFields({ type: record.Type.ITEM_RECEIPT, id: rows[i].ir,
            values: { custbody_wb_inb_container: String(rows[i].inb) },
            options: { enableSourcing: false, ignoreMandatoryFields: true } });
          stamped++;
        } catch (eS) { log.error({ title: 'stamp IR ' + rows[i].ir, details: (eS && eS.message) || eS }); }
      }
    } catch (e) { log.error({ title: 'stampContainerReceipts', details: (e && e.message) || e }); }
    return stamped;
  }

  // Containers Unloaded, first-receipt definition: a container counts in the
  // period its FIRST stamped receipt posts -- the same event Cartons Received
  // watches, no dependence on anyone flipping the shipment status. Both runs
  // load the saved search; this code only adds date filters and compares.
  // Period start as M/D/YYYY for search 'before' filters -- relative keywords
  // like 'thisweek' are not valid values for the before operator.
  function statPeriodStartStr(periodKey) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var d = new Date(today);
    if (periodKey === 'yesterday') d.setDate(today.getDate() - 1);
    else if (periodKey === 'thisweek') d.setDate(today.getDate() - now.getDay());
    else if (periodKey === 'lastweek') d.setDate(today.getDate() - now.getDay() - 7);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  function getContainersFirstReceipt(periodKey) {
    var range = statPeriodByKey(periodKey);
    function loadS() { return search.load({ id: 'customsearch_wb_stat_containers' }); }
    var inPeriod = {};             // container -> receipt ids seen this period
    var s1 = loadS();
    s1.filters.push(search.createFilter({ name: 'trandate', operator: range.dateFilter[1], values: range.dateFilter[2] }));
    var cCol = null, cols = s1.columns;
    for (var ci = 0; ci < cols.length; ci++) if (cols[ci].name === 'custbody_wb_inb_container') cCol = cols[ci];
    var dates = {};
    s1.run().each(function (r) {
      var c = cCol ? r.getValue(cCol) : '';
      if (c) {
        if (!inPeriod[c]) inPeriod[c] = [];
        inPeriod[c].push(String(r.id));
        var d = r.getValue({ name: 'trandate' });
        if (d && (!dates[c] || d < dates[c])) dates[c] = d;
      }
      return true;
    });
    var candidates = Object.keys(inPeriod);
    if (!candidates.length) return { containers: [], receiptsByContainer: inPeriod, firstDates: dates };
    // drop containers that already had a stamped receipt BEFORE this period
    var s2 = loadS();
    s2.filters.push(search.createFilter({ name: 'trandate', operator: 'before', values: statPeriodStartStr(periodKey) }));
    var seenBefore = {};
    s2.run().each(function (r) {
      var c = cCol ? r.getValue(cCol) : '';
      if (c) seenBefore[c] = true;
      return true;
    });
    var firsts = [];
    for (var k = 0; k < candidates.length; k++) if (!seenBefore[candidates[k]]) firsts.push(candidates[k]);
    return { containers: firsts, receiptsByContainer: inPeriod, firstDates: dates };
  }

  function getInboundReceiptLinks(periodKey) {
    // Item Receipts in the period that belong to an INBOUND SHIPMENT
    // (container), linked via inboundshipmentitem.shipmentitemtransaction.
    // Transfer-order and other non-container receipts are excluded by
    // construction. One container can produce several IRs — Containers
    // Unloaded counts DISTINCT inbound shipments, never raw IRs.
    // Linkage is via the PO: the warehouse receives POs directly (the inbound
    // shipment's own receive flow is not used, so shipmentItemTransaction is
    // stale). A container counts when a receipt against one of its POs posts.
    var range = statPeriodSqlDates(periodKey);
    var sql = 'SELECT DISTINCT isi.inboundShipment AS inb, t.id AS ir,'
      + ' ins.shipmentNumber AS shipnum, ins.billOfLading AS bol,'
      + ' BUILTIN.DF(isi.vendorId) AS vendor, t.tranDate AS rdate'
      + ' FROM inboundShipmentItem isi'
      + ' JOIN transactionLine tl ON tl.createdFrom = isi.purchaseOrderTransaction AND tl.mainLine = \'T\''
      + ' JOIN transaction t ON t.id = tl.transaction'
      + ' JOIN inboundShipment ins ON ins.id = isi.inboundShipment'
      + ' WHERE t.type = \'ItemRcpt\''
      + ' AND t.tranDate >= ' + range.start + ' AND t.tranDate <= ' + range.end
      + ' AND NVL(t.createdBy, 0) <> -4';
    return query.runSuiteQL({ query: sql }).asMappedResults();
  }

  function cartonsForReceipts(irIds) {
    // cartons = received qty ÷ item's master-carton qty (custitem_cartonqty),
    // via a line-level receipt search (UI lines, no system rows).
    // Returns { total, byIr: {irId: cartons}, uncounted: {irId: lineCount} }
    var out = { total: 0, byIr: {}, uncounted: {} };
    if (!irIds || irIds.length === 0) return out;
    var ls = search.create({
      type: search.Type.ITEM_RECEIPT,
      filters: [
        ['mainline', 'is', 'F'],
        'AND',
        ['taxline', 'is', 'F'],
        'AND',
        ['internalid', 'anyof', irIds]
      ],
      columns: [
        search.createColumn({ name: 'quantity' }),
        search.createColumn({ name: 'custitem_cartonqty', join: 'item' })
      ]
    });
    var paged = ls.runPaged({ pageSize: 1000 });
    paged.pageRanges.forEach(function(pr) {
      paged.fetch({ index: pr.index }).data.forEach(function(r) {
        var key = String(r.id);
        var qty = Math.abs(parseFloat(r.getValue({ name: 'quantity' }))) || 0;
        var perCtn = parseFloat(r.getValue({ name: 'custitem_cartonqty', join: 'item' })) || 0;
        if (qty > 0 && perCtn > 0) {
          var c = qty / perCtn;
          out.total += c;
          out.byIr[key] = (out.byIr[key] || 0) + c;
        } else if (qty > 0) {
          out.uncounted[key] = (out.uncounted[key] || 0) + 1;
        }
      });
    });
    return out;
  }

  // ── Containers Unloaded: saved-search-backed, status-transition based ──
  // A container counts ONLY when the Inbound Shipment's status transitions to
  // "received". That moment is stamped into custrecord_wb_received_date by
  // MW - UE - Inbound Shipment Received Date (mw_ue_inbship_received.js) -
  // system notes hold the same fact but are not searchable on this record
  // type (SSS_INVALID_SRCH_COLUMN_JOIN) and lag weeks behind in SuiteQL.
  // Item Receipts and POs play no part: a PO can sit on several containers,
  // so receipt-based counting attributed one receipt to every container
  // sharing the PO and counted containers still on the water. The saved
  // search below IS the number on the board - open it in the UI to audit.
  var CONTAINERS_SEARCH_ID = 'customsearch_wb_containers_received';
  var CONTAINERS_DATE_FIELD = 'custrecord_wb_received_date';

  function ensureContainersReceivedSearch() {
    try {
      return search.load({ id: CONTAINERS_SEARCH_ID });
    } catch (loadErr) {
      // First run: create it, then load fresh so filters/columns are canonical.
    }
    search.create({
      type: 'inboundshipment',
      id: CONTAINERS_SEARCH_ID,
      title: 'Warehouse Board - Containers Received',
      isPublic: true,
      filters: [[CONTAINERS_DATE_FIELD, 'isnotempty', '']],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'shipmentnumber' }),
        search.createColumn({ name: 'billoflading' }),
        search.createColumn({ name: CONTAINERS_DATE_FIELD, sort: search.Sort.DESC })
      ]
    }).save();
    return search.load({ id: CONTAINERS_SEARCH_ID });
  }

  function getContainersReceived(periodKey) {
    // Runs the saved search with the period window applied to the Container
    // Received Date stamp. One entry per container.
    var period = statPeriodByKey(periodKey);
    var s = ensureContainersReceivedSearch();
    s.filters.push(search.createFilter({
      name: CONTAINERS_DATE_FIELD,
      operator: period.snDateOp,
      values: period.snDateVal
    }));
    var byId = {};
    var order = [];
    function safeVal(r, col) {
      try { return String(r.getValue(col) || ''); } catch (e) { return ''; }
    }
    s.run().each(function (r) {
      var id = String(safeVal(r, { name: 'internalid' }) || r.id);
      if (!byId[id]) {
        byId[id] = {
          id: id,
          shipnum: safeVal(r, { name: 'shipmentnumber' }) || ('#' + id),
          bol: safeVal(r, { name: 'billoflading' }),
          receivedAt: safeVal(r, { name: CONTAINERS_DATE_FIELD })
        };
        order.push(id);
      }
      return order.length < 500;
    });
    return order.map(function (id) { return byId[id]; });
  }

  function computePeriodInbound(periodKey) {
    // Containers Unloaded: DISTINCT inbound shipments whose Status flipped to
    // "received" in the period (saved search customsearch_wb_containers_received).
    // Cartons Received stays receipt-based: carton math over container-linked
    // Item Receipts posted in the period.
    // Both figures now watch the SAME event, from the SAME saved search
    // (customsearch_wb_stat_containers): a container counts in the period its
    // first stamped receipt posts, and cartons are the carton math over that
    // period's stamped receipts. 2026-08-28, after 4,554 cartons / 0
    // containers exposed the status-flip definition as a manual step nobody
    // performs on the day.
    var out = { inboundsReceived: 0, cartonsReceived: 0 };
    try {
      var fr = getContainersFirstReceipt(periodKey);
      out.inboundsReceived = fr.containers.length;
      var irIds = [];
      for (var c in fr.receiptsByContainer) {
        var list = fr.receiptsByContainer[c];
        for (var i = 0; i < list.length; i++) {
          if (irIds.indexOf(list[i]) === -1) irIds.push(list[i]);
        }
      }
      out.cartonsReceived = Math.round(cartonsForReceipts(irIds).total);
    } catch (e) {
      WB_DEGRADED = true;
      log.error({ title: 'computePeriodInbound', details: e });
      out.inboundsReceived = '—';
    }
    return out;
  }

  function computePeriodRfHours(rfDateFilter) {
    // RF Scan Hours = SUM of RF-SMART transaction durations (seconds) for the
    // period, from customrecord_rfs_tx. Replaces custbody_pick_time, which
    // stopped populating on IFs after 2026-03-02 and always summed to 0.
    try {
      var totalSec = 0;
      var rows = 0;
      var s = search.load({ id: WB_STAT_SEARCHES.rfhours });
      s.filters.push(search.createFilter({ name: rfDateFilter[0], operator: rfDateFilter[1], values: rfDateFilter[2] }));
      s.run().each(function(r) {
        totalSec += parseFloat(r.getValue({ name: 'custrecord_rfs_txduration' })) || 0;
        rows++;
        return rows < 4000;
      });
      return (totalSec / 3600).toFixed(1);
    } catch (e) {
      WB_DEGRADED = true;
      log.error({ title: 'computePeriodRfHours', details: e });
      return '0.0';
    }
  }

  var STAT_PERIODS = [
    { key: 'today', title: 'Today', cssClass: 'statsColToday', dateFilter: ['trandate', 'on', 'today'], rfFilter: ['created', 'on', 'today'], snDateOp: search.Operator.ON, snDateVal: 'today' },
    { key: 'yesterday', title: 'Yesterday', cssClass: 'statsColYesterday', dateFilter: ['trandate', 'on', 'yesterday'], rfFilter: ['created', 'on', 'yesterday'], snDateOp: search.Operator.ON, snDateVal: 'yesterday' },
    { key: 'thisweek', title: 'This Week', cssClass: 'statsColWeek', dateFilter: ['trandate', 'within', 'thisweek'], rfFilter: ['created', 'within', 'thisweek'], snDateOp: search.Operator.WITHIN, snDateVal: 'thisweek' },
    { key: 'lastweek', title: 'Last Week', cssClass: 'statsColLastWeek', dateFilter: ['trandate', 'within', 'lastweek'], rfFilter: ['created', 'within', 'lastweek'], snDateOp: search.Operator.WITHIN, snDateVal: 'lastweek' }
  ];

  function statPeriodByKey(k) {
    for (var i = 0; i < STAT_PERIODS.length; i++) {
      if (STAT_PERIODS[i].key === k) return STAT_PERIODS[i];
    }
    return STAT_PERIODS[0];
  }

  /* onlyKeys (2026-08-28): compute just the columns asked for. Today and This
     Week are the only ones that move during a shift, and Today is one day of
     rows -- cheap. Yesterday and Last Week are closed periods that change only
     on a void, so they stay on the 15-minute warmer and never cost a viewer
     anything. See buildStatsPayload. */
  function getStatistics(onlyKeys) {
    var result = {};
    for (var p = 0; p < STAT_PERIODS.length; p++) {
      if (onlyKeys && onlyKeys.indexOf(STAT_PERIODS[p].key) === -1) continue;
      result[STAT_PERIODS[p].key] = computePeriodStats(STAT_PERIODS[p].dateFilter);
      result[STAT_PERIODS[p].key].hoursLogged = computePeriodRfHours(STAT_PERIODS[p].rfFilter);
      var inb = computePeriodInbound(STAT_PERIODS[p].key);
      result[STAT_PERIODS[p].key].inboundsReceived = inb.inboundsReceived;
      result[STAT_PERIODS[p].key].cartonsReceived = inb.cartonsReceived;
    }
    return result;
  }

  /* Statistics freshness (2026-08-28) ─────────────────────────────────────
     Measured on production: computing ONE column costs 3.7s and computing all
     four costs 3.7s. The time is not in the row counts, it is fixed overhead
     -- four search.load() calls -- so partial-freshness schemes buy nothing.
     All four columns are therefore always live.

     What the 60s poll needs instead is for that 3.7s to be paid ONCE for
     everyone rather than once per open board. This key is its own short-TTL
     entry, separate from the 15-minute page bundle: whoever polls into an
     expired window runs the loader, every other board that minute reads the
     result. N boards cost one compute per WB_STATS_TTL, not N.

     A degraded compute (a stats search that failed to load reads as all
     zeros) is evicted rather than served -- the same guard the page bundle
     carries, and the reason the 08-28 all-zero grid stuck. */
  /* Measured on production, 2026-08-28: all four columns cost ~7.5-8s, and
     the cost barely moves when you compute fewer of them -- it is dominated by
     four search.load() calls, not by row counts. So there is no partial
     freshness worth having: compute all four, and make the cost shared.

     TTL 120s: one compute every two minutes serves every open board, however
     many there are. With the 60s poll a number is at worst ~3 minutes old and
     the header says which minute it is from -- against a grid that used to sit
     unchanged from 6am to close.

     Written with an explicit put(), NOT by letting get()'s loader persist it.
     The loader path does not stick in this account -- measured: seven polls in
     a row each re-ran an 8s compute with a 45s ttl set. wbPut() has always
     done it this way; matching it is what makes the entry survive. Its own
     cache NAME, too -- sibling keys inside wb_board_v1 thrash (see header). */
  /* Statistics freshness (2026-08-28) ─────────────────────────────────────
     Measured on production: all four columns cost ~4s, and computing fewer of
     them costs the same -- the time is four search.load() calls, not row
     counts. So there is no partial-freshness scheme worth building; compute
     all four and share the cost.

     TTL is 300 because 300 is the FLOOR. N/cache rejects anything lower with
     "Input value ttl must be greater than or equal to 300", and put() throws
     rather than clamping. Earlier attempts at 45s and 120s therefore cached
     nothing at all: every poll silently fell through to a fresh 4-8s compute,
     with the rejection sitting unread in the execution log. If you want these
     numbers fresher than five minutes, the lever is dropping the cache and
     letting each board compute live -- not a smaller ttl.

     Its own cache NAME, not a second key in wb_board_v1: sibling keys thrash
     in this account (see the header). Written with an explicit put(), the way
     wbPut() does it. */
  var WB_STATS_TTL = 300;
  var WB_STATS_CACHE = null;

  function statsCache() {
    if (!WB_STATS_CACHE) WB_STATS_CACHE = cache.getCache({ name: 'wb_stats_v1', scope: cache.Scope.PROTECTED });
    return WB_STATS_CACHE;
  }

  function statsCached() {
    if (!WB_FRESH) {
      try {
        var raw = statsCache().get({ key: 'stats_live', ttl: WB_STATS_TTL });
        if (raw) {
          var o = JSON.parse(raw);
          // Age re-checked rather than trusted to the ttl: serving a stale
          // grid is the exact failure this whole change exists to fix.
          if (o && o.data && !o.deg && (new Date().getTime() - o.at) < WB_STATS_TTL * 1000) return o;
        }
      } catch (e) {
        log.error({ title: 'statsCached-read', details: e });
      }
    }
    var fresh = { at: new Date().getTime(), data: getStatistics(), deg: WB_DEGRADED ? 1 : 0 };
    // A degraded compute reads as an all-zero grid. Never hand that to the
    // next viewer -- that is how 08-28's zeros stuck for everyone.
    if (!fresh.deg) {
      try { statsCache().put({ key: 'stats_live', value: JSON.stringify(fresh), ttl: WB_STATS_TTL }); }
      catch (eP) { log.error({ title: 'statsCached-put', details: eP }); }
    }
    return fresh;
  }

  function buildStatsPayload() {
    var o = statsCached();
    // deg rides along: an all-zero grid and a stale clock look identical from
    // the outside, and this is the flag that tells them apart.
    return { stats: buildStatsGridHtml(o && o.data), statsAt: (o && o.at) || new Date().getTime(),
             deg: (o && o.deg) ? 1 : 0 };
  }

  // ── Statistics drill-downs ──

  var STAT_DRILL_TITLES = {
    ordersPacked: 'Orders Packed',
    ordersShipped: 'Orders Shipped',
    palletsShipped: 'Pallets Shipped',
    cartonsShipped: 'Cartons Shipped',
    pctOntime: '% On Time (by line)',
    pctOntimeAdj: '% On Time (Routed/Exempt)',
    inboundsReceived: 'Containers Unloaded',
    cartonsReceived: 'Cartons Received'
  };

  function statDrillErrorBox(title) {
    return '<div class="rfDrillBox"><div class="rfDrillHead"><div>' + escapeHtml(title) + '</div>'
      + '<button type="button" class="rfDrillClose" onclick="WB_statDrillClose()">&times;</button></div>'
      + '<div style="color:var(--k-danger,#C74634);font-size:13px;">Could not load detail - check script log.</div></div>';
  }

  // Which saved search each stat drill is the face of. The strip below links
  // to the NATIVE search-results page (Michael, 2026-08-28: "even if it is 0
  // I need to pull the report up ... not an sql based report").
  // String literals on purpose: WB_STAT_SEARCHES is declared ~1,300 lines
  // below, so referencing it in this module-scope initializer would read the
  // hoisted-but-unassigned var and kill the module at load.
  var STAT_SRC_SEARCH = {
    ordersPacked: 'customsearch_wb_stat_packed',
    ordersShipped: 'customsearch_wb_stat_shipped',
    palletsShipped: 'customsearch_wb_stat_shipped',
    cartonsShipped: 'customsearch_wb_stat_shipped',
    pctOntime: 'customsearch_wb_stat_ontime',
    pctOntimeAdj: 'customsearch_wb_stat_ontime',
    inboundsReceived: 'customsearch_wb_stat_containers',
    cartonsReceived: 'customsearch_wb_stat_containers'
  };
  function statSourceStrip(statKey) {
    var sid = STAT_SRC_SEARCH[statKey];
    if (!sid) return '';
    var href = '';
    try {
      // Search.searchId is the numeric internal id the native results page needs.
      href = '/app/common/search/searchresults.nl?searchid=' + search.load({ id: sid }).searchId;
    } catch (e) { }
    var label = escapeHtml(sid);
    return '<div style="font-size:11px;opacity:.8;text-align:right;margin:2px 0 6px;">Source: '
      + (href
        ? '<a href="' + href + '" target="_blank" rel="noopener">' + label + ' — open the saved search &#8599;</a>'
        : label)
      + '</div>';
  }

  function buildStatDrillHtml(statKey, periodKey) {
    if (!STAT_DRILL_TITLES[statKey]) statKey = 'ordersPacked';
    var period = statPeriodByKey(periodKey);
    var title = STAT_DRILL_TITLES[statKey] + ' — ' + period.title;
    var html;
    try {
      if (statKey === 'pctOntime' || statKey === 'pctOntimeAdj') html = buildOntimeDrillHtml(period, title);
      else if (statKey === 'inboundsReceived') html = buildContainersDrillHtml(period, title);
      else if (statKey === 'cartonsReceived') html = buildReceiptDrillHtml(period, title);
      else html = buildIfListDrillHtml(statKey, period, title);
    } catch (e) {
      log.error({ title: 'buildStatDrillHtml', details: e });
      html = statDrillErrorBox(title);
    }
    // Every builder (zero rows and the error box included) opens with the same
    // box div, so the source link rides in on all of them from this one spot.
    return html.replace('<div class="rfDrillBox">', '<div class="rfDrillBox">' + statSourceStrip(statKey));
  }

  function buildIfListDrillHtml(statKey, period, title) {
    // Lists the Item Fulfillments behind Orders Packed / Shipped / Pallets / Cartons
    var filters = [
      ['mainline', 'is', 'T'],
      'AND',
      period.dateFilter,
      'AND',
      ['createdby', 'noneof', '-4'],
      'AND',
      ['subsidiary', 'anyof', PROMIER_SUBSIDIARY_ID]
    ];
    if (statKey !== 'ordersPacked') {
      filters.push('AND');
      filters.push(['status', 'anyof', 'ItemShip:C']);
    }
    // NOTE: no search-side numeric filter on the pallet/carton fields —
    // custbody_total_cartons stores numbers as text and a greaterthan filter
    // throws UNEXPECTED_ERROR. Rows are filtered in code below instead.

    var s = search.create({
      type: search.Type.ITEM_FULFILLMENT,
      filters: filters,
      columns: [
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        search.createColumn({ name: 'tranid' }),
        search.createColumn({ name: 'statusref' }),
        search.createColumn({ name: 'entity' }),
        search.createColumn({ name: 'createdfrom' }),
        search.createColumn({ name: 'custbody_pallets_loading' }),
        search.createColumn({ name: 'custbody_total_cartons' })
      ]
    });

    var paged = s.runPaged({ pageSize: 1000 });
    var total = 0;
    var rows = [];
    paged.pageRanges.forEach(function(pr) {
      paged.fetch({ index: pr.index }).data.forEach(function(r) {
        var pallets = parseFloat(r.getValue({ name: 'custbody_pallets_loading' })) || 0;
        var cartons = parseFloat(r.getValue({ name: 'custbody_total_cartons' })) || 0;
        if (statKey === 'palletsShipped' && pallets <= 0) return;
        if (statKey === 'cartonsShipped' && cartons <= 0) return;
        total++;
        if (rows.length >= 200) return;
        rows.push({
          id: r.id,
          tranid: r.getValue({ name: 'tranid' }) || ('#' + r.id),
          date: r.getValue({ name: 'trandate' }) || '',
          status: r.getText({ name: 'statusref' }) || '',
          entity: r.getText({ name: 'entity' }) || '',
          fromSo: r.getText({ name: 'createdfrom' }) || '',
          pallets: pallets,
          cartons: cartons
        });
      });
    });

    var header = '<div class="rfDrillHead">'
      + '<div><b>' + escapeHtml(title) + '</b> &middot; ' + total + ' fulfillment' + (total === 1 ? '' : 's')
      + (total > 200 ? ' (showing first 200)' : '')
      + '</div>'
      + '<button type="button" class="rfDrillClose" onclick="WB_statDrillClose()">&times;</button>'
      + '</div>';

    if (rows.length === 0) {
      return '<div class="rfDrillBox">' + header
        + '<div style="color:var(--rw-muted);font-size:13px;padding:6px 0;">No fulfillments in this period.</div></div>';
    }

    var body = '<div style="overflow:auto;max-height:380px;"><table class="pausedTable"><thead><tr>'
      + '<th>Fulfillment</th><th>Date</th><th>Customer</th><th>Status</th><th>From</th><th>Pallets</th><th>Cartons</th>'
      + '</tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var rw = rows[i];
      body += '<tr>'
        + '<td><a href="/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(rw.id)
        + '" target="_blank" rel="noopener">' + escapeHtml(rw.tranid) + '</a></td>'
        + '<td>' + escapeHtml(rw.date) + '</td>'
        + '<td>' + escapeHtml(rw.entity) + '</td>'
        + '<td>' + escapeHtml(rw.status) + '</td>'
        + '<td>' + escapeHtml(rw.fromSo) + '</td>'
        + '<td>' + (rw.pallets || '') + '</td>'
        + '<td>' + (rw.cartons || '') + '</td>'
        + '</tr>';
    }
    body += '</tbody></table></div>';
    return '<div class="rfDrillBox">' + header + body + '</div>';
  }

  /* ── Container drills (2026-08-28) ────────────────────────────────────────
     Both read the SAME stamped saved search the grid numbers come from
     (customsearch_wb_stat_containers, via getContainersFirstReceipt), so a
     drill is always the stat's receipt. Michael, after the drill said "no
     containers marked Received" under a grid showing 3: "These screenshots
     are not true." They were both right -- and reading different sources. */
  function containerDrillData(periodKey) {
    var fr = getContainersFirstReceipt(periodKey);
    var byInbIr = fr.receiptsByContainer;
    var allInb = Object.keys(byInbIr);
    var irIds = [];
    for (var c in byInbIr) {
      for (var i = 0; i < byInbIr[c].length; i++) {
        if (irIds.indexOf(byInbIr[c][i]) === -1) irIds.push(byInbIr[c][i]);
      }
    }
    var cart = cartonsForReceipts(irIds);
    var cartByInb = {};
    for (var c2 in byInbIr) {
      var s = 0;
      for (var j = 0; j < byInbIr[c2].length; j++) s += cart.byIr[byInbIr[c2][j]] || 0;
      cartByInb[c2] = Math.round(s);
    }
    var meta = {};
    if (allInb.length) {
      try {
        var mrows = query.runSuiteQL({ query:
          'SELECT ins.id AS id, ins.shipmentNumber AS shipnum, ins.billOfLading AS bol,'
          + ' (SELECT MIN(e.entitytitle) FROM inboundShipmentItem isi JOIN entity e ON e.id = isi.vendorId'
          + '  WHERE isi.inboundShipment = ins.id) AS vendor'
          + ' FROM inboundShipment ins WHERE ins.id IN (' + allInb.join(',') + ')' }).asMappedResults();
        for (var m = 0; m < mrows.length; m++) meta[String(mrows[m].id)] = mrows[m];
      } catch (eM) { log.error({ title: 'containerDrillData meta', details: (eM && eM.message) || eM }); }
    }
    return { firsts: fr.containers, all: allInb, byInbIr: byInbIr, cartByInb: cartByInb,
             firstDates: fr.firstDates || {}, meta: meta, cartTotal: Math.round(cart.total) };
  }

  function containerDrillRows(data, inbList, showCounted) {
    var list = inbList.slice().sort(function (x, y) { return (data.cartByInb[y] || 0) - (data.cartByInb[x] || 0); });
    var h = '';
    for (var i = 0; i < list.length; i++) {
      var inb = list[i];
      var md = data.meta[inb] || {};
      var counted = data.firsts.indexOf(inb) >= 0;
      h += '<tr>'
        + '<td><a href="/app/site/hosting/scriptlet.nl?script=customscript_mw_sl_inb_card&deploy=customdeploy1&inb=' + escapeAttr(inb) + '" target="_blank" rel="noopener">'
        + escapeHtml(md.shipnum || ('INB' + inb)) + '</a></td>'
        + '<td>' + escapeHtml(md.bol || '') + '</td>'
        + '<td>' + escapeHtml(md.vendor || '') + '</td>'
        + '<td>' + escapeHtml(data.firstDates[inb] || '') + '</td>'
        + '<td style="text-align:right;">' + (data.byInbIr[inb] || []).length + '</td>'
        + '<td style="text-align:right;">' + (data.cartByInb[inb] || 0) + '</td>'
        + (showCounted ? '<td style="text-align:center;">' + (counted ? '&#10003;' : '') + '</td>' : '')
        + '</tr>';
    }
    return h;
  }

  function containerDrillTable(headExtra, rows) {
    return '<div style="overflow:auto;"><table class="pausedTable"><thead><tr>'
      + '<th>Inbound</th><th>Container</th><th>Vendor</th><th>First Receipt</th>'
      + '<th style="text-align:right;">Receipts</th><th style="text-align:right;">Cartons</th>' + headExtra
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function buildContainersDrillHtml(period, title) {
    // Containers Unloaded: exactly the containers the stat counted -- first
    // stamped receipt in the period.
    var data = containerDrillData(period.key);
    var header = '<div class="rfDrillHead">'
      + '<div><b>' + escapeHtml(title) + '</b> &middot; ' + data.firsts.length + ' container' + (data.firsts.length === 1 ? '' : 's')
      + ' &middot; first receipt in period &middot; source: customsearch_wb_stat_containers</div>'
      + '<button type="button" class="rfDrillClose" onclick="WB_statDrillClose()">&times;</button>'
      + '</div>';
    var body = data.firsts.length
      ? containerDrillTable('', containerDrillRows(data, data.firsts, false))
      : '<div style="font-size:13px;color:var(--rw-muted);">No containers had their first receipt in this period.</div>';
    return '<div class="rfDrillBox">' + header + body + '</div>';
  }

  function buildReceiptDrillHtml(period, title) {
    // Cartons Received: every container with a stamped receipt in the period;
    // the check column marks which of them counted as Unloaded (first receipt).
    var data = containerDrillData(period.key);
    var header = '<div class="rfDrillHead">'
      + '<div><b>' + escapeHtml(title) + '</b> &middot; ' + data.all.length + ' container' + (data.all.length === 1 ? '' : 's')
      + ' &middot; ' + data.cartTotal + ' cartons &middot; ' + data.firsts.length + ' counted as Unloaded'
      + ' &middot; source: customsearch_wb_stat_containers</div>'
      + '<button type="button" class="rfDrillClose" onclick="WB_statDrillClose()">&times;</button>'
      + '</div>';
    var body = data.all.length
      ? containerDrillTable('<th style="text-align:center;">Counted as Unloaded</th>', containerDrillRows(data, data.all, true))
      : '<div style="font-size:13px;color:var(--rw-muted);">No container-linked receipts in this period.</div>';
    return '<div class="rfDrillBox">' + header + body + '</div>';
  }

  function buildOntimeDrillHtml(period, title) {
    // Per-fulfillment breakdown of the line-weighted on-time %s, showing BOTH
    // gradings side by side: strict (shipped by SO Ship Date) and adjusted
    // (also on time if the order was ROUTED by the SO Ship Date). Worst
    // offenders first, by adjusted late lines then strict.
    var benchCol = search.createColumn({
      name: 'formulanumeric',
      formula: 'CASE WHEN ' + ONTIME_BENCH + ' IS NOT NULL THEN 1 ELSE 0 END'
    });
    var onTimeCol = search.createColumn({
      name: 'formulanumeric_ontime',
      formula: ONTIME_STRICT_FORMULA
    });
    var onTimeAdjCol = search.createColumn({
      name: 'formulanumeric_adj',
      formula: ONTIME_ADJ_FORMULA
    });
    var benchDateCol = search.createColumn({ name: 'formuladate', formula: ONTIME_BENCH });
    var routedDateCol = search.createColumn({ name: 'formuladate_routed', formula: 'TRUNC({createdfrom.custbody_routed_on})' });

    var s = search.create({
      type: search.Type.ITEM_FULFILLMENT,
      filters: [
        ['mainline', 'is', 'F'],
        'AND',
        ['taxline', 'is', 'F'],
        'AND',
        period.dateFilter,
        'AND',
        ['entity', 'noneof', ONTIME_EXEMPT_CUSTOMERS],
        'AND',
        ['createdby', 'noneof', '-4'],
        'AND',
        ['subsidiary', 'anyof', PROMIER_SUBSIDIARY_ID],
        'AND',
        ['status', 'anyof', 'ItemShip:C']
      ],
      columns: [
        search.createColumn({ name: 'tranid' }),
        search.createColumn({ name: 'entity' }),
        search.createColumn({ name: 'trandate' }),
        benchDateCol,
        routedDateCol,
        benchCol,
        onTimeCol,
        onTimeAdjCol
      ]
    });

    var byIf = {};
    var order = [];
    var paged = s.runPaged({ pageSize: 1000 });
    paged.pageRanges.forEach(function(pr) {
      paged.fetch({ index: pr.index }).data.forEach(function(r) {
        var id = r.id;
        if (!byIf[id]) {
          byIf[id] = {
            id: id,
            tranid: r.getValue({ name: 'tranid' }) || ('#' + id),
            entity: r.getText({ name: 'entity' }) || '',
            date: r.getValue({ name: 'trandate' }) || '',
            bench: r.getValue(benchDateCol) || '',
            routed: r.getValue(routedDateCol) || '',
            reason: '',
            graded: 0,
            ontime: 0,
            ontimeAdj: 0
          };
          order.push(id);
        }
        if (!byIf[id].bench) byIf[id].bench = r.getValue(benchDateCol) || '';
        if (!byIf[id].routed) byIf[id].routed = r.getValue(routedDateCol) || '';
        var hasBench = parseInt(r.getValue(benchCol), 10) || 0;
        if (!hasBench) return;
        byIf[id].graded++;
        if (parseInt(r.getValue(onTimeCol), 10)) byIf[id].ontime++;
        if (parseInt(r.getValue(onTimeAdjCol), 10)) byIf[id].ontimeAdj++;
      });
    });

    // Merge exempt flag + reasons (SuiteQL — fields not N/search-exposed):
    // only the Exempt CHECKBOX credits a fulfillment's lines in the adjusted %
    var infoMap = getLateInfoMap(Object.keys(byIf));

    var list = [];
    var totGraded = 0;
    var totOnTime = 0;
    var totOnTimeAdj = 0;
    for (var oi = 0; oi < order.length; oi++) {
      var e = byIf[order[oi]];
      var einfo = infoMap[String(e.id)];
      e.reason = einfo ? einfo.reason : '';
      e.exempt = !!(einfo && einfo.exempt);
      if (e.exempt) e.ontimeAdj = e.graded;
      e.late = e.graded - e.ontime;
      e.lateAdj = e.graded - e.ontimeAdj;
      totGraded += e.graded;
      totOnTime += e.ontime;
      totOnTimeAdj += e.ontimeAdj;
      list.push(e);
    }
    // Worst offenders first: adjusted late lines, then strict late, then recency
    list.sort(function(a, b) {
      if (b.lateAdj !== a.lateAdj) return b.lateAdj - a.lateAdj;
      if (b.late !== a.late) return b.late - a.late;
      return String(b.date).localeCompare(String(a.date));
    });

    var pctS = totGraded > 0 ? Math.round((totOnTime / totGraded) * 100) : null;
    var pctA = totGraded > 0 ? Math.round((totOnTimeAdj / totGraded) * 100) : null;
    var header = '<div class="rfDrillHead">'
      + '<div><b>' + escapeHtml(title) + '</b> &middot; '
      + (pctS === null
        ? 'no graded lines'
        : (totGraded + ' lines &middot; by ship date: ' + totOnTime + ' on time = ' + pctS + '%'
          + ' &middot; incl. routed: ' + totOnTimeAdj + ' on time = ' + pctA + '%'))
      + ' &middot; ' + list.length + ' shipped fulfillment' + (list.length === 1 ? '' : 's')
      + (list.length > 200 ? ' (showing first 200)' : '')
      + '</div>'
      + '<button type="button" class="rfDrillClose" onclick="WB_statDrillClose()">&times;</button>'
      + '</div>';

    if (list.length === 0) {
      return '<div class="rfDrillBox">' + header
        + '<div style="color:var(--rw-muted);font-size:13px;padding:6px 0;">No shipped fulfillments in this period.</div></div>';
    }

    var body = '<div style="overflow:auto;max-height:380px;"><table class="pausedTable"><thead><tr>'
      + '<th>Fulfillment</th><th>Customer</th><th>Shipped</th><th>Due</th><th>Routed On</th><th>Lines</th>'
      + '<th>Late (ship date)</th><th>Late (incl. routed)</th><th>Exempt</th><th>Reason</th>'
      + '</tr></thead><tbody>';
    var shown = Math.min(list.length, 200);
    for (var x = 0; x < shown; x++) {
      var rw = list[x];
      var lateCell = rw.late > 0
        ? '<span style="color:var(--rw-danger);font-weight:700;">' + rw.late + '</span>'
        : '0';
      var lateAdjCell = rw.lateAdj > 0
        ? '<span style="color:var(--rw-danger);font-weight:700;">' + rw.lateAdj + '</span>'
        : (rw.late > 0
          ? '<span style="color:var(--rw-green);font-weight:700;">0 &#10003;</span>'
          : '0');

      // Exempt checkbox: removes this fulfillment from the adjusted score.
      // Reason entry: free-text documentation. Both only on late rows.
      var exemptCell = '—';
      var reasonCell = '—';
      if (rw.late > 0) {
        exemptCell = '<input type="checkbox" class="wbExemptChk"' + (rw.exempt ? ' checked' : '')
          + ' title="Exempt from % On Time (Routed/Exempt)"'
          + ' onchange="WB_exemptToggle(\'' + rw.id + '\', this)" />';
        reasonCell = '<input type="text" class="wbReasonInput" maxlength="300"'
          + ' value="' + escapeAttr(rw.reason) + '" data-orig="' + escapeAttr(rw.reason) + '"'
          + ' placeholder="Reason it was late..."'
          + ' onkeydown="if(event.key===&quot;Enter&quot;)this.blur();"'
          + ' onblur="WB_reasonSave(\'' + rw.id + '\', this)" />';
      }

      body += '<tr>'
        + '<td><a href="/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(rw.id)
        + '" target="_blank" rel="noopener">' + escapeHtml(rw.tranid) + '</a></td>'
        + '<td>' + escapeHtml(rw.entity) + '</td>'
        + '<td>' + escapeHtml(rw.date) + '</td>'
        + '<td>' + escapeHtml(rw.bench) + '</td>'
        + '<td>' + escapeHtml(rw.routed || '—') + '</td>'
        + '<td>' + rw.graded + '</td>'
        + '<td>' + lateCell + '</td>'
        + '<td>' + lateAdjCell + '</td>'
        + '<td style="text-align:center;">' + exemptCell + '</td>'
        + '<td>' + reasonCell + '</td>'
        + '</tr>';
    }
    body += '</tbody></table></div>';
    return '<div class="rfDrillBox">' + header + body + '</div>';
  }

  var ORDERS_DUE_BUCKETS = {
    pastDue: 'Past Due',
    today: 'Today',
    thisWeek: 'This Week',
    nextWeek: 'Next Week',
    thisMonth: 'This Month',
    thisYear: 'This Year',
    noDueDate: 'No Ship Date'
  };

  // Same bucket boundaries as getUpcomingProjects — kept in one place so the
  // Orders Due pills and their drill-down always agree.
  function projDateBounds() {
    function midnightOf(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    var now = new Date();
    var today = midnightOf(now);
    var endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (6 - now.getDay()));
    var endOfNextWeek = new Date(endOfWeek);
    endOfNextWeek.setDate(endOfWeek.getDate() + 7);
    return {
      today: today,
      endOfWeek: endOfWeek,
      endOfNextWeek: endOfNextWeek,
      endOfMonth: new Date(now.getFullYear(), now.getMonth() + 1, 0),
      endOfYear: new Date(now.getFullYear(), 11, 31)
    };
  }

  function isoDateStr(d) {
    return d.getFullYear() + '-'
      + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
      + ('0' + d.getDate()).slice(-2);
  }

  function buildOrdersDueDrillHtml(bucketKey) {
    // Lists the open sales orders behind an "Orders Due" pill in Upcoming Projects
    if (!ORDERS_DUE_BUCKETS[bucketKey]) bucketKey = 'today';
    var title = 'Orders Due — ' + ORDERS_DUE_BUCKETS[bucketKey];
    try {
      var b = projDateBounds();
      function dlit(d) { return "TO_DATE('" + isoDateStr(d) + "','YYYY-MM-DD')"; }
      var pred;
      switch (bucketKey) {
        case 'pastDue': pred = 't.shipdate < ' + dlit(b.today); break;
        case 'thisWeek': pred = 't.shipdate > ' + dlit(b.today) + ' AND t.shipdate <= ' + dlit(b.endOfWeek); break;
        case 'nextWeek': pred = 't.shipdate > ' + dlit(b.endOfWeek) + ' AND t.shipdate <= ' + dlit(b.endOfNextWeek); break;
        case 'thisMonth': pred = 't.shipdate > ' + dlit(b.endOfNextWeek) + ' AND t.shipdate <= ' + dlit(b.endOfMonth); break;
        case 'thisYear': pred = 't.shipdate > ' + dlit(b.endOfMonth) + ' AND t.shipdate <= ' + dlit(b.endOfYear); break;
        case 'noDueDate': pred = 't.shipdate IS NULL'; break;
        default: pred = 't.shipdate = ' + dlit(b.today);
      }

      var sql = 'SELECT t.id, t.tranid, BUILTIN.DF(t.entity) AS customer, t.shipdate,'
        + ' BUILTIN.DF(t.status) AS status_text, t.foreignTotal AS total'
        + ' FROM transaction t'
        + ' JOIN transactionline tl ON tl.transaction = t.id AND tl.mainLine = \'T\''
        + ' WHERE t.type = \'SalesOrd\''
        + ' AND tl.subsidiary = ' + PROMIER_SUBSIDIARY_ID
        // Status format differs by channel — match both raw and prefixed forms
        + " AND t.status IN ('A','B','D','E','SalesOrd:A','SalesOrd:B','SalesOrd:D','SalesOrd:E')"
        + ' AND ' + pred
        + ' ORDER BY t.shipdate ASC, t.tranid ASC';
      var rows = query.runSuiteQL({ query: sql }).asMappedResults();

      var header = '<div class="rfDrillHead">'
        + '<div><b>' + escapeHtml(title) + '</b> &middot; ' + rows.length + ' order' + (rows.length === 1 ? '' : 's')
        + (rows.length > 200 ? ' (showing first 200)' : '')
        + '</div>'
        + '<button type="button" class="rfDrillClose" onclick="WB_projDrillClose()">&times;</button>'
        + '</div>';

      if (rows.length === 0) {
        return '<div class="rfDrillBox">' + header
          + '<div style="color:var(--rw-muted);font-size:13px;padding:6px 0;">No open orders in this bucket.</div></div>';
      }

      function fmtMoney(v) {
        var n = Math.round(parseFloat(v) || 0);
        return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      }

      // SOs that already have an unshipped fulfillment picked/packed: show
      // that instead of the raw SO status — the order is filled and just
      // waiting on carrier pickup to flip to Shipped.
      var pkMap = {}; // so id -> 'Packed' | 'Picked'
      try {
        var soIds = [];
        for (var si2 = 0; si2 < rows.length; si2++) soIds.push(rows[si2].id);
        for (var pc = 0; pc < soIds.length; pc += 900) {
          var pchunk = soIds.slice(pc, pc + 900);
          var ifRows = query.runSuiteQL({
            query: 'SELECT DISTINCT tl.createdfrom AS soid, t.status AS ifstatus'
              + ' FROM transaction t'
              + ' JOIN transactionline tl ON tl.transaction = t.id AND tl.mainLine = \'T\''
              + " WHERE t.type = 'ItemShip'"
              // Picked (A) / Packed (B) only — match both channel status forms
              + " AND t.status IN ('A','B','ItemShip:A','ItemShip:B')"
              + ' AND tl.createdfrom IN (' + pchunk.join(',') + ')'
          }).asMappedResults();
          for (var pf = 0; pf < ifRows.length; pf++) {
            var ifSt = String(ifRows[pf].ifstatus);
            var isPacked = ifSt === 'B' || ifSt === 'ItemShip:B';
            var soKey = String(ifRows[pf].soid);
            // Packed outranks Picked when an SO has both
            if (isPacked || !pkMap[soKey]) pkMap[soKey] = isPacked ? 'Packed' : 'Picked';
          }
        }
      } catch (pkErr) {
        log.error({ title: 'buildOrdersDueDrillHtml-packed', details: pkErr });
      }

      var body = '<div style="overflow:auto;max-height:380px;"><table class="pausedTable"><thead><tr>'
        + '<th>Order</th><th>Customer</th><th>Ship Date</th><th>Status</th><th>Amount</th>'
        + '</tr></thead><tbody>';
      var shown = Math.min(rows.length, 200);
      for (var x = 0; x < shown; x++) {
        var rw = rows[x];
        var soUrl = '';
        try {
          soUrl = url.resolveRecord({ recordType: 'salesorder', recordId: rw.id, isEditMode: false });
        } catch (ue) {
          soUrl = '/app/accounting/transactions/transaction.nl?id=' + rw.id;
        }
        var statusCell = escapeHtml(rw.status_text || '');
        var pk = pkMap[String(rw.id)];
        if (pk === 'Packed') {
          statusCell = '<span style="color:var(--rw-green);font-weight:700;">Packed</span>'
            + ' <span style="color:var(--rw-muted);font-size:11px;">(awaiting pickup)</span>';
        } else if (pk === 'Picked') {
          statusCell = '<span style="color:#9A6700;font-weight:700;">Picked</span>'
            + ' <span style="color:var(--rw-muted);font-size:11px;">(in packing)</span>';
        }
        body += '<tr>'
          + '<td><a href="' + escapeAttr(soUrl) + '" target="_blank" rel="noopener">' + escapeHtml(rw.tranid || ('#' + rw.id)) + '</a></td>'
          + '<td>' + escapeHtml(rw.customer || '') + '</td>'
          + '<td>' + escapeHtml(rw.shipdate || '—') + '</td>'
          + '<td>' + statusCell + '</td>'
          + '<td>' + fmtMoney(rw.total) + '</td>'
          + '</tr>';
      }
      body += '</tbody></table></div>';
      return '<div class="rfDrillBox">' + header + body + '</div>';
    } catch (e) {
      log.error({ title: 'buildOrdersDueDrillHtml', details: e });
      return '<div class="rfDrillBox"><div class="rfDrillHead"><div>' + escapeHtml(title) + '</div>'
        + '<button type="button" class="rfDrillClose" onclick="WB_projDrillClose()">&times;</button></div>'
        + '<div style="color:var(--k-danger,#C74634);font-size:13px;">Could not load detail - check script log.</div></div>';
    }
  }

  function getUpcomingProjects() {
    var buckets = { pastDue: [], today: [], thisWeek: [], nextWeek: [], thisMonth: [], thisYear: [], noDueDate: [] };

    // Helper: parse NetSuite date string (M/D/YYYY) into a Date at midnight
    function parseDue(str) {
      if (!str) return null;
      var parts = str.split('/');
      if (parts.length !== 3) return null;
      return new Date(+parts[2], +parts[0] - 1, +parts[1]);
    }

    // Helper: strip time from a Date for clean comparison
    function midnightOf(d) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    var now = new Date();
    var today = midnightOf(now);

    // End of this week (Saturday)
    var dayOfWeek = now.getDay(); // 0=Sun
    var endOfWeek = new Date(today);
    endOfWeek.setDate(today.getDate() + (6 - dayOfWeek));

    // End of next week (the following Saturday)
    var endOfNextWeek = new Date(endOfWeek);
    endOfNextWeek.setDate(endOfWeek.getDate() + 7);

    // End of this month
    var endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // End of this year
    var endOfYear = new Date(now.getFullYear(), 11, 31);

    // Each entry lands in exactly ONE bucket — the most specific one.
    function pushByDue(entry, dueDate) {
      if (!dueDate) buckets.noDueDate.push(entry);
      else if (dueDate < today) buckets.pastDue.push(entry);
      else if (dueDate.getTime() === today.getTime()) buckets.today.push(entry);
      else if (dueDate <= endOfWeek) buckets.thisWeek.push(entry);
      else if (dueDate <= endOfNextWeek) buckets.nextWeek.push(entry);
      else if (dueDate <= endOfMonth) buckets.thisMonth.push(entry);
      else if (dueDate <= endOfYear) buckets.thisYear.push(entry);
      // Beyond this year — skip for now
    }

    try {
      var sql = "SELECT it.id AS ticket_id, it.name AS ticket_number, it.altname AS title,"
        + " BUILTIN.DF(it.custrecord_priority_level) AS priority,"
        + " BUILTIN.DF(it.custrecord_current_status) AS current_status,"
        + " BUILTIN.DF(it.custrecord_assigned_to) AS assigned_to,"
        + " it.custrecord_due_date AS due_date"
        + " FROM customrecord_internal_ticket_record it"
        + " WHERE it.custrecord_category = 5"
        + " AND BUILTIN.DF(it.custrecord_department) = 'Warehouse'"
        + " AND (it.custrecord_current_status != 4 OR it.custrecord_current_status IS NULL)"
        + " ORDER BY it.custrecord_due_date ASC";
      var rows = query.runSuiteQL({ query: sql }).asMappedResults();

      for (var ri = 0; ri < rows.length; ri++) {
        var r = rows[ri];
        var label = escapeHtml(r.ticket_number || '') + ' \u2014 ' + escapeHtml(r.title || '');
        if (r.priority) label += '  [' + escapeHtml(r.priority) + ']';
        if (r.assigned_to) label += '  (' + escapeHtml(r.assigned_to) + ')';

        var dueDate = parseDue(r.due_date);
        var dueDateDisplay = r.due_date || '';
        pushByDue({ label: label, id: r.ticket_id, due: dueDateDisplay }, dueDate);
      }
    } catch (e) {
      log.error({ title: 'getUpcomingProjects', details: e });
    }

    // Inbound shipments (containers) by expected arrival date — so the floor
    // can see what's landing today / this week / this month. Container number
    // lives in billoflading on this account's inbound shipment records.
    try {
      var inbSql = "SELECT id, shipmentnumber, billoflading, expecteddeliverydate,"
        + " custrecord_current_location AS current_location"
        + " FROM inboundshipment"
        + " WHERE shipmentstatus IN ('toBeShipped', 'inTransit', 'partiallyReceived')"
        // Bookings with no ETA yet (toBeShipped, blank expected date) carry no
        // arrival info and would bury the No Due Date column — skip them.
        + " AND NOT (expecteddeliverydate IS NULL AND shipmentstatus = 'toBeShipped')"
        + " ORDER BY expecteddeliverydate ASC";
      var inbRows = query.runSuiteQL({ query: inbSql }).asMappedResults();

      var dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      for (var ib = 0; ib < inbRows.length; ib++) {
        var inb = inbRows[ib];
        var shipNum = String(inb.shipmentnumber || ('#' + inb.id)).replace(/^INBSHIP/i, '');
        var inbDue = parseDue(inb.expecteddeliverydate);

        // Format: "Monday - 8/10/26 INB1769 - CNRT: DRYU9849824 (On Water)"
        var inbLabel = '';
        if (inbDue) {
          inbLabel += escapeHtml(dayNames[inbDue.getDay()]) + ' - '
            + (inbDue.getMonth() + 1) + '/' + inbDue.getDate() + '/'
            + String(inbDue.getFullYear()).slice(-2) + ' ';
        }
        inbLabel += 'INB' + escapeHtml(shipNum) + ' - CNRT: ' + escapeHtml(inb.billoflading || 'n/a');
        if (inb.current_location) {
          var inbLoc = String(inb.current_location);
          if (inbLoc.toLowerCase() === 'on water') inbLoc = 'OW';
          inbLabel += ' (' + escapeHtml(inbLoc) + ')';
        }

        var inbUrl = '';
        try {
          inbUrl = url.resolveRecord({ recordType: 'inboundshipment', recordId: inb.id, isEditMode: false });
        } catch (ue) {
          inbUrl = '';
        }
        // due left blank — the date already leads the label
        pushByDue({ label: inbLabel, id: inb.id, due: '', url: inbUrl }, inbDue);
      }
    } catch (inbErr) {
      log.error({ title: 'getUpcomingProjects-inbounds', details: inbErr });
    }

    // Orders Due per bucket: open Promier sales orders still to fill
    // (Pending Approval / Pending Fulfillment / Partially Fulfilled /
    // PendBilling-PartFulfilled), bucketed by SO Ship Date with the same
    // exclusive boundaries as the project items.
    try {
      function isoDate(d) {
        return d.getFullYear() + '-'
          + ('0' + (d.getMonth() + 1)).slice(-2) + '-'
          + ('0' + d.getDate()).slice(-2);
      }
      var dToday = "TO_DATE('" + isoDate(today) + "','YYYY-MM-DD')";
      var dWeek = "TO_DATE('" + isoDate(endOfWeek) + "','YYYY-MM-DD')";
      var dNextWeek = "TO_DATE('" + isoDate(endOfNextWeek) + "','YYYY-MM-DD')";
      var dMonth = "TO_DATE('" + isoDate(endOfMonth) + "','YYYY-MM-DD')";
      var dYear = "TO_DATE('" + isoDate(endOfYear) + "','YYYY-MM-DD')";

      var odSql = 'SELECT'
        + ' SUM(CASE WHEN t.shipdate < ' + dToday + ' THEN 1 ELSE 0 END) AS pastdue,'
        + ' SUM(CASE WHEN t.shipdate = ' + dToday + ' THEN 1 ELSE 0 END) AS due_today,'
        + ' SUM(CASE WHEN t.shipdate > ' + dToday + ' AND t.shipdate <= ' + dWeek + ' THEN 1 ELSE 0 END) AS thisweek,'
        + ' SUM(CASE WHEN t.shipdate > ' + dWeek + ' AND t.shipdate <= ' + dNextWeek + ' THEN 1 ELSE 0 END) AS nextweek,'
        + ' SUM(CASE WHEN t.shipdate > ' + dNextWeek + ' AND t.shipdate <= ' + dMonth + ' THEN 1 ELSE 0 END) AS thismonth,'
        + ' SUM(CASE WHEN t.shipdate > ' + dMonth + ' AND t.shipdate <= ' + dYear + ' THEN 1 ELSE 0 END) AS thisyear,'
        + ' SUM(CASE WHEN t.shipdate IS NULL THEN 1 ELSE 0 END) AS nodue'
        + ' FROM transaction t'
        + ' JOIN transactionline tl ON tl.transaction = t.id AND tl.mainLine = \'T\''
        + ' WHERE t.type = \'SalesOrd\''
        + ' AND tl.subsidiary = ' + PROMIER_SUBSIDIARY_ID
        // In-script N/query returns status as 'SalesOrd:B'; the REST/analytics
        // channel returns the raw letter — match both forms.
        + " AND t.status IN ('A','B','D','E','SalesOrd:A','SalesOrd:B','SalesOrd:D','SalesOrd:E')";
      var odRows = query.runSuiteQL({ query: odSql }).asMappedResults();
      if (odRows && odRows.length > 0) {
        var od = odRows[0];
        buckets.ordersDue = {
          pastDue: parseInt(od.pastdue, 10) || 0,
          today: parseInt(od.due_today, 10) || 0,
          thisWeek: parseInt(od.thisweek, 10) || 0,
          nextWeek: parseInt(od.nextweek, 10) || 0,
          thisMonth: parseInt(od.thismonth, 10) || 0,
          thisYear: parseInt(od.thisyear, 10) || 0,
          noDueDate: parseInt(od.nodue, 10) || 0
        };
      }
    } catch (odErr) {
      log.error({ title: 'getUpcomingProjects-ordersdue', details: odErr });
    }

    return buckets;
  }

  // ---- Connecteam Time Clock integration ----

  var CT_API_BASE = 'https://api.connecteam.com';

  function ctGet(apiKey, path) {
    try {
      var resp = https.get({
        url: CT_API_BASE + path,
        headers: {
          'X-API-KEY': apiKey,
          'Accept': 'application/json'
        }
      });
      if (resp.code === 200) return JSON.parse(resp.body);
      log.error({ title: 'ctGet ' + path, details: 'HTTP ' + resp.code + ': ' + resp.body });
      return null;
    } catch (e) {
      // Connecteam responding slowly is transient — the next dashboard
      // refresh recovers, so don't error-log timeouts
      if (e && e.name === 'SSS_REQUEST_TIME_EXCEEDED') {
        log.debug({ title: 'ctGet timeout ' + path, details: e.message });
      } else {
        log.error({ title: 'ctGet ' + path, details: e });
      }
      return null;
    }
  }

  function ctExtractArray(resp, propName) {
    // Connecteam API returns data in nested format (e.g. data.timeClocks, data.users)
    // or sometimes as a flat array (data = [...]).  Handle both.
    if (!resp || !resp.data) return null;
    if (Object.prototype.toString.call(resp.data) === '[object Array]') return resp.data;
    if (propName && resp.data[propName] && Object.prototype.toString.call(resp.data[propName]) === '[object Array]') {
      return resp.data[propName];
    }
    return null;
  }

  function ctGetTimeClocks(apiKey) {
    // Discover all active (non-archived) time clocks from the account
    var resp = ctGet(apiKey, '/time-clock/v1/time-clocks');
    var arr = ctExtractArray(resp, 'timeClocks');
    if (!arr) return [];
    var active = [];
    for (var i = 0; i < arr.length; i++) {
      if (!arr[i].isArchived) active.push(arr[i].id);
    }
    return active;
  }

  function ctHasDepartment(user, deptName) {
    var cf = user.customFields;
    if (!cf) return false;
    for (var fi = 0; fi < cf.length; fi++) {
      if (cf[fi].name === 'Department' && cf[fi].value) {
        var vals = cf[fi].value;
        if (Object.prototype.toString.call(vals) !== '[object Array]') vals = [vals];
        for (var vi = 0; vi < vals.length; vi++) {
          if (vals[vi] && vals[vi].value && vals[vi].value.toLowerCase() === deptName.toLowerCase()) return true;
        }
      }
    }
    return false;
  }

  function ctGetUserMap(apiKey) {
    var map = {};
    var offset = 0;
    var safety = 0;
    do {
      var path = '/users/v1/users?limit=200';
      if (offset > 0) path += '&offset=' + offset;
      var resp = ctGet(apiKey, path);
      var arr = ctExtractArray(resp, 'users');
      if (!arr || arr.length === 0) break;
      for (var ui = 0; ui < arr.length; ui++) {
        var u = arr[ui];
        if (u.isArchived) continue;
        if (!ctHasDepartment(u, 'Warehouse')) continue;
        var name = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
        map[u.userId] = name || ('User ' + u.userId);
      }
      if (arr.length < 200) break;
      // Full page: keep going even if the API omits paging.offset
      var nextOffset = (resp && resp.paging && resp.paging.offset) ? resp.paging.offset : 0;
      offset = nextOffset > offset ? nextOffset : offset + arr.length;
      safety++;
    } while (safety < 10);
    return map;
  }

  // Connecteam break type IDs
  var CT_LUNCH_BREAK_ID = '8c074014-c48a-4b28-a0f1-ba3d663db87b';

  function getConnecteamStatus(apiKey, timeClockId) {
    // Returns alphabetical list of Warehouse users with status:
    //   'in' = clocked in working, 'lunch' = on lunch, 'break' = on break, 'out' = not clocked in
    // API returns data.timeActivitiesByUsers: [{ userId, shifts:[{start,end?}], manualBreaks:[{start,end?,manualBreakId}] }]
    if (!apiKey) return [];
    try {
      var now = new Date();
      var today = now.getFullYear() + '-'
        + ('0' + (now.getMonth() + 1)).slice(-2) + '-'
        + ('0' + now.getDate()).slice(-2);

      var userMap = ctGetUserMap(apiKey);

      // Gather today's activities grouped by user
      var clockedInMap = {};  // userId -> clockInTimestamp
      var onBreakMap = {};    // userId -> { type: 'lunch'|'break', timestamp }
      if (timeClockId) {
        var actOffset = 0;
        var safety = 0;
        do {
          var path = '/time-clock/v1/time-clocks/'
            + encodeURIComponent(timeClockId)
            + '/time-activities?startDate=' + today
            + '&endDate=' + today + '&limit=200';
          if (actOffset > 0) path += '&offset=' + actOffset;
          var resp = ctGet(apiKey, path);
          var byUsers = ctExtractArray(resp, 'timeActivitiesByUsers');
          if (!byUsers || byUsers.length === 0) break;
          for (var bi = 0; bi < byUsers.length; bi++) {
            var entry = byUsers[bi];
            var uid = entry.userId;

            // Check shifts — no end = currently clocked in
            var shifts = entry.shifts || [];
            for (var si = 0; si < shifts.length; si++) {
              var shift = shifts[si];
              if (shift.start && shift.start.timestamp && !shift.end) {
                var ts = shift.start.timestamp;
                if (!clockedInMap[uid] || ts > clockedInMap[uid]) {
                  clockedInMap[uid] = ts;
                }
              }
            }

            // Check manual breaks — no end = currently on break
            var breaks = entry.manualBreaks || [];
            for (var bri = 0; bri < breaks.length; bri++) {
              var brk = breaks[bri];
              if (brk.start && brk.start.timestamp && !brk.end) {
                var bType = (brk.manualBreakId === CT_LUNCH_BREAK_ID) ? 'lunch' : 'break';
                var bTs = brk.start.timestamp;
                if (!onBreakMap[uid] || bTs > onBreakMap[uid].timestamp) {
                  onBreakMap[uid] = { type: bType, timestamp: bTs };
                }
              }
            }
          }
          if (byUsers.length < 200) break;
          // Full page: keep going even if the API omits paging.offset
          var nextActOffset = (resp && resp.paging && resp.paging.offset) ? resp.paging.offset : 0;
          actOffset = nextActOffset > actOffset ? nextActOffset : actOffset + byUsers.length;
          safety++;
        } while (safety < 10);
      }

      // Build list — break status overrides clocked-in (you're clocked in but on break)
      var list = [];
      for (var userId in userMap) {
        if (userMap.hasOwnProperty(userId)) {
          var status = 'out';
          var statusTime = 0;
          if (onBreakMap.hasOwnProperty(userId)) {
            status = onBreakMap[userId].type; // 'lunch' or 'break'
            statusTime = onBreakMap[userId].timestamp;
          } else if (clockedInMap.hasOwnProperty(userId)) {
            status = 'in';
            statusTime = clockedInMap[userId];
          }
          list.push({
            name: userMap[userId],
            status: status,
            statusTime: statusTime
          });
        }
      }
      list.sort(function(a, b) { return a.name.localeCompare(b.name); });
      return list;
    } catch (e) {
      log.error({ title: 'getConnecteamStatus', details: e });
      return [];
    }
  }

  function centralOffsetHours(unixTs) {
    // US Central offset from UTC for a given unix timestamp: 5 during CDT
    // (2nd Sunday of March 2:00 CST -> 1st Sunday of November 2:00 CDT), else 6.
    var d = new Date(unixTs * 1000);
    var year = d.getUTCFullYear();
    function nthSundayUtcMs(y, monthIdx, n, utcHour) {
      var first = new Date(Date.UTC(y, monthIdx, 1));
      var firstSundayDate = 1 + ((7 - first.getUTCDay()) % 7);
      return Date.UTC(y, monthIdx, firstSundayDate + (n - 1) * 7, utcHour, 0, 0);
    }
    var dstStart = nthSundayUtcMs(year, 2, 2, 8);  // 2nd Sun March, 2:00 CST = 08:00 UTC
    var dstEnd = nthSundayUtcMs(year, 10, 1, 7);   // 1st Sun Nov, 2:00 CDT = 07:00 UTC
    var t = unixTs * 1000;
    return (t >= dstStart && t < dstEnd) ? 5 : 6;
  }

  function formatClockIn(unixTs) {
    if (!unixTs) return '';
    var d = new Date((unixTs - centralOffsetHours(unixTs) * 3600) * 1000);
    var h = d.getUTCHours();
    var m = d.getUTCMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    if (h === 0) h = 12;
    else if (h > 12) h -= 12;
    return h + ':' + ('0' + m).slice(-2) + ' ' + ampm;
  }

  function buildStatsGridHtml(stats) {
    // Statistics grid columns — heavy (~16 searches), only built on the
    // deferred statsonly=1 AJAX call, never on the initial page render.
    // Renders whatever stats object it is handed; the caller decides which
    // columns came from cache and which were just computed live.
    if (!stats) stats = getStatistics();
    var statPeriods = STAT_PERIODS;
    var statDefs = [
      {
        key: 'ordersPacked',
        label: 'Orders Packed',
        info: 'Item Fulfillments dated in this period, any status (Picked, Packed, or Shipped). Promier Products subsidiary only; system-generated fulfillments excluded.'
      },
      {
        key: 'ordersShipped',
        label: 'Orders Shipped',
        info: 'Of those fulfillments, the ones with status Shipped.'
      },
      {
        key: 'palletsShipped',
        label: 'Pallets Shipped',
        info: 'Sum of the "Pallets Loading" field on Shipped fulfillments. Only LTL / truckload loads get a pallet count - parcel shipments do not add to this number.'
      },
      {
        key: 'cartonsShipped',
        label: 'Cartons Shipped',
        info: 'Sum of the "Total Cartons" field on Shipped fulfillments in the period.'
      },
      {
        key: 'inboundsReceived',
        label: 'Containers Unloaded',
        info: 'Containers whose Inbound Shipment STATUS transitioned to Received in this period - the transition stamps the Container Received Date field, and this stat counts that field via saved search "Warehouse Board - Containers Received". Item Receipts and POs are ignored: a container on the water never counts, and a PO shared across containers can’t double-count.'
      },
      {
        key: 'cartonsReceived',
        label: 'Cartons Received',
        info: 'Master cartons unloaded from inbound containers: received quantity divided by each item’s carton quantity on the item record, counted only on container-linked receipts. Lines for items with no carton quantity on file add 0 - keep item carton quantities current.'
      },
      {
        key: 'pctOntime',
        label: '% On Time (by line)',
        info: 'Line-weighted: every item line on a Shipped fulfillment counts once. A line is on time when the fulfillment date is on or before the Sales Order’s Ship Date. 19 of 20 lines on time = 95%. Orders not yet shipped are not graded here - see the Shippable Past Due alert.'
      },
      {
        key: 'pctOntimeAdj',
        label: '% On Time (Routed/Exempt)',
        info: 'Same line-weighted calc, but a line ALSO counts on time when its order was routed (Routed On date on the Sales Order) on or before the SO Ship Date, OR the fulfillment’s Exempt box is checked in the drill-down (with the Reason field documenting why, e.g. Carrier No Show, Building Power Outage, Employee Shortage). Unrouted, unexempted orders are graded on ship date alone.'
      },
      {
        key: 'hoursLogged',
        label: 'RF Scan Hours',
        info: 'Total time operators spent in RF-SMART transactions this period (SO picking, putaway, bin and inventory transfers) - summed from each scan’s open-to-complete duration.'
      }
    ];
    var statsColsHtml = '';
    for (var sc = 0; sc < statPeriods.length; sc++) {
      var sp = statPeriods[sc];
      var sd = stats[sp.key];
      statsColsHtml += '<div class="statsCol ' + sp.cssClass + '">';
      statsColsHtml += '<div class="statsColHeader">' + escapeHtml(sp.title) + '</div>';
      for (var sl = 0; sl < statDefs.length; sl++) {
        var def = statDefs[sl];
        var valueHtml;
        if (STAT_DRILL_TITLES[def.key]) {
          // Clickable: opens the drill-down panel below the stats grid
          valueHtml = '<a href="#" class="statsValue statsValueLink" onclick="WB_statDrill(\''
            + def.key + '\',\'' + sp.key + '\');return false;">'
            + escapeHtml(String(sd[def.key])) + '</a>';
        } else {
          valueHtml = '<span class="statsValue">' + escapeHtml(String(sd[def.key])) + '</span>';
        }
        // The tooltip is per-metric, not per-period, so it only needs to appear
        // once per row. Rendering it in every period column repeated the same
        // icon four times across the grid for no extra information.
        var infoHtml = (sp.key === 'today')
          ? '<span class="statsInfo" title="' + escapeAttr(def.info) + '">&#9432;</span>'
          : '';
        statsColsHtml += '<div class="statsRow">'
          + '<span class="statsLabel">' + escapeHtml(def.label) + infoHtml + '</span>'
          + valueHtml
          + '</div>';
      }
      statsColsHtml += '</div>';
    }
    return statsColsHtml;
  }

  function buildInlineHtml(params, results, alertData, clockedInHtml, refreshUrl) {
    // Quote of the Day
    var quotes = [
      { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
      { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
      { text: 'Hard work beats talent when talent does not work hard.', author: 'Tim Notke' },
      { text: 'The difference between ordinary and extraordinary is that little extra.', author: 'Jimmy Johnson' },
      { text: 'Teamwork makes the dream work.', author: 'John C. Maxwell' },
      { text: 'Quality means doing it right when no one is looking.', author: 'Henry Ford' },
      { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
      { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
      { text: 'What you do today can improve all your tomorrows.', author: 'Ralph Marston' },
      { text: 'Excellence is not a skill. It is an attitude.', author: 'Ralph Marston' },
      { text: 'Efficiency is doing things right; effectiveness is doing the right things.', author: 'Peter Drucker' },
      { text: 'Coming together is a beginning, staying together is progress, and working together is success.', author: 'Henry Ford' },
      { text: 'The strength of the team is each individual member. The strength of each member is the team.', author: 'Phil Jackson' },
      { text: 'Motivation is what gets you started. Habit is what keeps you going.', author: 'Jim Ryun' },
      { text: 'The warehouse is the backbone of every great supply chain.', author: 'Unknown' },
      { text: 'Safety is not a gadget but a state of mind.', author: 'Eleanor Everet' },
      { text: 'Continuous improvement is better than delayed perfection.', author: 'Mark Twain' },
      { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
      { text: 'Great things in business are never done by one person. They are done by a team.', author: 'Steve Jobs' },
      { text: 'The best preparation for tomorrow is doing your best today.', author: 'H. Jackson Brown Jr.' }
    ];
    var qotd = quotes[Math.floor(Math.random() * quotes.length)];

    var linkCategories = getPopularLinks();

    // Tile links grouped by category
    var tilesHtml = '';
    for (var ci = 0; ci < linkCategories.length; ci++) {
      var lcat = linkCategories[ci];
      tilesHtml += '<div class="tileCatRow">';
      tilesHtml += '<div class="tileCatLabel">' + escapeHtml(lcat.category) + '</div>';
      tilesHtml += '<div class="tileCatLinks">';
      for (var li = 0; li < lcat.links.length; li++) {
        var lnk = lcat.links[li];
        if (lnk.disabled) {
          tilesHtml += '<div class="tile tileDisabled">'
            + '<div class="tileInner"><div class="tileLabel">' + escapeHtml(lnk.label)
            + '<div class="tileComingSoon">Coming Soon</div></div></div></div>';
        } else {
          tilesHtml += '<a class="tile" href="' + escapeAttr(lnk.href) + '" target="_blank" rel="noopener">'
            + '<div class="tileInner"><div class="tileLabel">' + escapeHtml(lnk.label) + '</div></div></a>';
        }
      }
      tilesHtml += '</div></div>';
    }

    // Alert tiles grouped by category
    var alertCats = {};
    var alertCatOrder = [];
    for (var j = 0; j < (alertData || []).length; j++) {
      var a = alertData[j];
      var aCat = a.category || 'Other';
      if (!alertCats[aCat]) { alertCats[aCat] = []; alertCatOrder.push(aCat); }
      var tileHtml = '';
      if (a.count < 0) {
        // Count query failed (-1 sentinel) — show an amber error tile, never a green 0
        tileHtml = '<a class="alertTile alertTileErr" href="' + escapeAttr(a.href) + '" target="_blank" rel="noopener">'
          + '<div class="alertInner">'
          + '<div class="alertIcon">&#10067;</div>'
          + '<div class="alertLabel">' + escapeHtml(a.label) + ' (count unavailable)</div>'
          + '<span class="alertBadgeErr">&mdash;</span>'
          + '</div></a>';
      } else if (a.count > 0) {
        tileHtml = '<a class="alertTile alertTileRed" href="' + escapeAttr(a.href) + '" target="_blank" rel="noopener">'
          + '<div class="alertInner">'
          + '<div class="alertIcon">&#9888;</div>'
          + '<div class="alertLabel">' + escapeHtml(a.label) + '</div>'
          + '<span class="alertBadge">' + a.count + '</span>'
          + '</div></a>';
      } else {
        // A clear alert is still a link (Michael, 2026-08-28: "the alerts even
        // if 0 should take you to the backup report that is showing it"). This
        // tile used to be a bare div, so a green 0 was a dead end -- exactly
        // when you most want to open the search and confirm the 0 is real
        // rather than a criteria change. Same href as the red tile; .alertTile
        // already carries the anchor styling the other two branches use.
        tileHtml = '<a class="alertTile alertTileOk" href="' + escapeAttr(a.href) + '" target="_blank" rel="noopener"'
          + ' title="' + escapeAttr('Nothing outstanding \u2014 open ' + a.label + ' to confirm') + '">'
          + '<div class="alertInner">'
          + '<div class="alertIcon">&#10003;</div>'
          + '<div class="alertLabel">' + escapeHtml(a.label) + '</div>'
          + '<span class="alertBadgeOk">0</span>'
          + '</div></a>';
      }
      alertCats[aCat].push(tileHtml);
    }
    var alertsHtml = '';
    for (var aci = 0; aci < alertCatOrder.length; aci++) {
      var catName = alertCatOrder[aci];
      alertsHtml += '<div class="alertCatRow">'
        + '<div class="alertCatLabel">' + escapeHtml(catName) + '</div>'
        + '<div class="alertCatTiles">' + alertCats[catName].join('') + '</div>'
        + '</div>';
    }

    // RF Smart Active Users table (from logged requests today)
    // Deferred: filled by the first wbRefresh() AJAX call after page load
    var monitorHtml = '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">Loading\u2026</div>';

    // Paused Records (from saved search 5177 - RF-SMART Record Lock)
    var pausedData = timed('paused', function () { return getPausedRecords(); });
    var pausedHtml = '';
    if (pausedData.rows.length === 0) {
      pausedHtml = '<div style="color:var(--rw-green);font-size:13px;font-weight:600;padding:8px 0;">&#10003; No paused records.</div>';
    } else {
      pausedHtml = '<div style="overflow:auto;"><table class="pausedTable"><thead><tr>';
      for (var ph = 0; ph < pausedData.headers.length; ph++) {
        pausedHtml += '<th>' + escapeHtml(pausedData.headers[ph]) + '</th>';
      }
      pausedHtml += '</tr></thead><tbody>';
      for (var pr = 0; pr < pausedData.rows.length; pr++) {
        pausedHtml += '<tr>';
        for (var prc = 0; prc < pausedData.rows[pr].length; prc++) {
          pausedHtml += '<td>' + escapeHtml(pausedData.rows[pr][prc]) + '</td>';
        }
        pausedHtml += '</tr>';
      }
      pausedHtml += '</tbody></table></div>';
    }


    // Upcoming Projects
    var projData = timed('projects', function () { return wbBundle().projects; });
    var projCategories = [
      { key: 'pastDue', title: '\u26A0 Past Due', cssClass: 'projColToday' },
      { key: 'today', title: 'Due Today', cssClass: 'projColToday' },
      { key: 'thisWeek', title: 'Due This Week', cssClass: 'projColWeek' },
      { key: 'nextWeek', title: 'Due Next Week', cssClass: 'projColNextWeek' },
      { key: 'thisMonth', title: 'Due This Month', cssClass: 'projColMonth' },
      { key: 'thisYear', title: 'Due This Year', cssClass: 'projColYear' },
      { key: 'noDueDate', title: 'No Due Date', cssClass: 'projColYear' }
    ];
    var projColsHtml = '';
    for (var pc = 0; pc < projCategories.length; pc++) {
      var cat = projCategories[pc];
      var items = projData[cat.key] || [];
      projColsHtml += '<div class="projCol ' + cat.cssClass + '">';
      projColsHtml += '<div class="projColHeader">' + escapeHtml(cat.title) + ' (' + items.length + ')</div>';
      if (projData.ordersDue && typeof projData.ordersDue[cat.key] === 'number') {
        projColsHtml += '<a href="#" class="projOrdersDue projOrdersDueClick"'
          + ' onclick="WB_ordersDueDrill(\'' + cat.key + '\');return false;">'
          + 'Orders Due: <b>' + projData.ordersDue[cat.key] + '</b></a>';
      }
      if (items.length === 0) {
        projColsHtml += '<div style="color:var(--rw-muted);font-size:12px;padding:4px 0;font-style:italic;">None</div>';
      }
      for (var pi = 0; pi < items.length; pi++) {
        var entry = items[pi];
        // Inbound entries carry their own record URL; tickets use the custom record page
        var ticketUrl = entry.url || ('/app/common/custom/custrecordentry.nl?rectype=3917&id=' + entry.id);
        var dueLabel = entry.due ? ' &middot; ' + escapeHtml(entry.due) : '';
        projColsHtml += '<div class="projItem">'
          + '<span class="projBullet">&#9656;</span>'
          + '<a href="' + escapeAttr(ticketUrl) + '" target="_blank" rel="noopener" style="color:var(--rw-text);text-decoration:none;font-size:12px;line-height:1.4;">'
          + entry.label + dueLabel + '</a>'
          + '</div>';
      }
      projColsHtml += '</div>';
    }

    // RF Smart User Breakdown (initial page load always shows Today)
    // Deferred: filled by the first wbRefresh() AJAX call after page load
    var rfBdHtml = '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">Loading\u2026</div>';

    var resultsHtml = renderResultsHtml(results);

    var html = getStyleBlock();

    html += '<div class="wbWrap bWh">';

    // Quote of the Day banner
    html += '<div class="qotdBanner">'
      + '<div class="qotdIcon">&#128161;</div>'
      + '<div><div class="qotdText">&ldquo;' + escapeHtml(qotd.text) + '&rdquo;</div>'
      + '<div class="qotdAuthor">&mdash; ' + escapeHtml(qotd.author) + '</div></div>'
      + '<div class="themePills">'
      + '<a class="themePill" data-mwtheme="light" onclick="MW_setTheme(\'light\')">Light</a>'
      + '<a class="themePill" data-mwtheme="kodiak" onclick="MW_setTheme(\'kodiak\')">Kodiak</a>'
      + '</div>'
      + '</div>';

    // Row 1: Search (1/3) + Alerts (1/3) + Who's Clocked In (1/3)
    html += '<div class="pairRow">';
    html += '<div class="pairThird">';
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>Search</div></div>'
      + '<div class="searchGrid">'
      + searchCardHtml('Sales Order', 'so', 'SO12345 or 12345', params.so)
      + searchCardHtml('Item Fulfillment', 'if', 'IF12345 or 12345', params['if'])
      + searchCardHtml('Transfer Order', 'to', 'TO12345 or 12345', params.to)
      + searchCardHtml('Item', 'item', 'SKU, Name, or Description', params.item)
      + '</div></div>';
    html += '</div>';
    html += '<div class="pairThird">';
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>&#9888; Alerts</div>'
      + '<div class="sectionSub">Red items need attention \u2014 click to view</div></div>'
      + alertsHtml + '</div>';
    html += '</div>';
    html += '<div class="pairThird">';
    html += '<div id="wb_clockedin">' + clockedInHtml + '</div>';
    html += '</div>';
    html += '</div>';

    // Results (full width, below Search + Alerts + Clocked In row)
    html += resultsHtml;

    // Row 2: Popular Pages (full width)
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>Popular Pages</div>'
      + '<div class="sectionSub">Opens in a new tab</div></div>'
      + tilesHtml + '</div>';

    // Row 3: RF Smart User Monitor (50%) + RF Smart User Activity (50%)
    html += '<div class="pairRow">';
    html += '<div class="pairHalf">';
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>&#128225; RF Smart User Monitor</div></div>'
      + '<div id="wb_monitor">' + monitorHtml + '</div></div>';
    html += '</div>';
    var periodBtnsHtml = '<div class="rfPeriodBtns">';
    var periodOrder = ['today', 'yesterday', 'thisweek', 'lastweek', 'last30'];
    for (var pb = 0; pb < periodOrder.length; pb++) {
      var pKey = periodOrder[pb];
      periodBtnsHtml += '<button type="button" id="wb_rfp_' + pKey + '" class="rfPeriodBtn'
        + (pKey === 'today' ? ' rfPeriodBtnActive' : '')
        + '" onclick="WB_rfPeriod(\'' + pKey + '\')">'
        + escapeHtml(RF_PERIOD_LABELS[pKey]) + '</button>';
    }
    periodBtnsHtml += '</div>';

    html += '<div class="pairHalf">';
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>&#128100; RF Smart User Activity</div>'
      + '<div class="sectionSub">RF-SMART transactions by user &mdash; click a function for detail</div></div>'
      + periodBtnsHtml
      + '<div id="wb_activity">' + rfBdHtml + '</div>'
      + '<div id="wb_rfdrill" style="display:none;"></div>'
      + '</div>';
    html += '</div>';
    html += '</div>';


    // Paused Records section (only shown when records exist)
    if (pausedData.rows.length > 0) {
      html += '<div class="section">'
        + '<div class="sectionTitle"><div>&#9208; Paused Records</div>'
        + '<div class="sectionSub">'
        + '<a href="/app/common/custom/custrecordentrylist.nl?rectype=91&amp;searchtype=Custom&amp;searchid=5177" target="_blank" rel="noopener" style="color:var(--rw-accent);text-decoration:none;font-weight:600;">View All</a>'
        + '</div></div>'
        + pausedHtml + '</div>';
    }

    // Statistics
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>&#128202; Statistics</div>'
      + '<div class="sectionSub">Performance overview &mdash; click a number for detail'
      + '<span id="wb_statsat"></span></div></div>'
      + '<div class="statsGrid" id="wb_stats"><div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">Loading statistics\u2026</div></div>'
      + '<div id="wb_statdrill" style="display:none;"></div>'
      + '</div>';

    // Upcoming Projects
    html += '<div class="section">'
      + '<div class="sectionTitle"><div>&#128197; Upcoming Projects</div>'
      + '<div class="sectionSub">'
      + '<a href="/app/site/hosting/scriptlet.nl?script=7637&deploy=1&category=Project" target="_blank" rel="noopener" style="color:var(--rw-accent);text-decoration:none;font-weight:600;">View All Projects</a>'
      + '</div></div>'
      + '<div class="projGrid">' + projColsHtml + '</div>'
      + '<div id="wb_projdrill" style="display:none;"></div>'
      + '</div>';

    html += '</div>'; // close wbWrap

    html += getScriptBlock(refreshUrl);

    return html;
  }

  // ---- Main handler ----

  /* ── One-time saved-search bootstrap (2026-08-28) ─────────────────────────
     Michael: "I dont want you calculations I want this data pulled from solid
     NS searches." These create the REAL saved searches the statistics grid
     now loads by id -- open them, audit them, edit them in the UI; the board
     only adds the period date filter at run time. Admin-gated, idempotent
     (existing searches are never overwritten, so UI edits stick).
     Run: &mksearches=1 */
  var WB_STAT_SEARCHES = {
    packed:  'customsearch_wb_stat_packed',
    shipped: 'customsearch_wb_stat_shipped',
    ontime:  'customsearch_wb_stat_ontime',
    rfhours: 'customsearch_wb_stat_rfhours'
  };
  function makeStatSearches() {
    var out = {};
    // The five hand-built alert searches are numeric-id loads; if any is
    // private it is INVALID_SEARCH for every other user, and their compute
    // caches -1 counts for everyone (the stats grid failed the same way
    // this morning). Repair them to public here too.
    for (var ai = 0; ai < WB_ALERT_IDS.length; ai++) {
      (function (aid) {
        try {
          var al = search.load({ id: aid });
          if (al.isPublic) { out['alert_' + aid] = 'already public'; return; }
          al.isPublic = true;
          al.save();
          out['alert_' + aid] = 'made PUBLIC (was private)';
        } catch (eA) { out['alert_' + aid] = 'FAILED: ' + ((eA && eA.message) || eA); }
      })(WB_ALERT_IDS[ai]);
    }
    function ensure(id, title, builder) {
      // PUBLIC or bust (2026-08-28). These were created private, so every
      // other user's search.load threw INVALID_SEARCH — and the first user
      // whose page load recomputed an expired bundle cached all-zero stats
      // for everyone. Existing private searches are repaired, not skipped.
      try {
        var have = search.load({ id: id });
        if (have.isPublic) { out[id] = 'already exists (public)'; return; }
        have.isPublic = true;
        have.save();
        out[id] = 'made PUBLIC (was private — INVALID_SEARCH for every other user)';
        return;
      }
      catch (eL) { /* not there yet */ }
      try {
        var s = builder();
        s.title = title;
        s.id = id;
        s.isPublic = true;
        s.save();
        out[id] = 'created (public)';
      } catch (eC) { out[id] = 'FAILED: ' + ((eC && eC.message) || eC); }
    }
    ensure(WB_STAT_SEARCHES.packed, 'Warehouse Stats - Orders Packed', function () {
      return search.create({
        type: search.Type.ITEM_FULFILLMENT,
        filters: [
          ['mainline', 'is', 'T'], 'AND',
          ['subsidiary', 'anyof', PROMIER_SUBSIDIARY_ID], 'AND',
          ['createdby', 'noneof', '-4']
        ],
        columns: [
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'tranid' }),
          search.createColumn({ name: 'statusref' }),
          search.createColumn({ name: 'entity' }),
          search.createColumn({ name: 'custbody_pallets_loading' }),
          search.createColumn({ name: 'custbody_total_cartons' })
        ]
      });
    });
    ensure(WB_STAT_SEARCHES.shipped, 'Warehouse Stats - Orders Shipped (Pallets and Cartons)', function () {
      return search.create({
        type: search.Type.ITEM_FULFILLMENT,
        filters: [
          ['mainline', 'is', 'T'], 'AND',
          ['subsidiary', 'anyof', PROMIER_SUBSIDIARY_ID], 'AND',
          ['createdby', 'noneof', '-4'], 'AND',
          ['status', 'anyof', 'ItemShip:C']
        ],
        columns: [
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'tranid' }),
          search.createColumn({ name: 'entity' }),
          search.createColumn({ name: 'custbody_pallets_loading' }),
          search.createColumn({ name: 'custbody_total_cartons' })
        ]
      });
    });
    ensure(WB_STAT_SEARCHES.ontime, 'Warehouse Stats - On Time Lines', function () {
      return search.create({
        type: search.Type.ITEM_FULFILLMENT,
        filters: [
          ['mainline', 'is', 'F'], 'AND',
          ['taxline', 'is', 'F'], 'AND',
          ['subsidiary', 'anyof', PROMIER_SUBSIDIARY_ID], 'AND',
          ['createdby', 'noneof', '-4'], 'AND',
          ['status', 'anyof', 'ItemShip:C']
        ],
        columns: [
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'tranid' }),
          search.createColumn({ name: 'formulanumeric', formula: 'CASE WHEN ' + ONTIME_BENCH + ' IS NOT NULL THEN 1 ELSE 0 END', label: 'Graded (has SO ship date)' }),
          search.createColumn({ name: 'formulanumeric', formula: ONTIME_STRICT_FORMULA, label: 'On Time (strict)' }),
          search.createColumn({ name: 'formulanumeric', formula: ONTIME_ADJ_FORMULA, label: 'On Time (routed credit)' })
        ]
      });
    });
    ensure('customsearch_wb_stat_containers', 'Warehouse Stats - Container Receipts', function () {
      return search.create({
        type: search.Type.ITEM_RECEIPT,
        filters: [
          ['mainline', 'is', 'T'], 'AND',
          ['custbody_wb_inb_container', 'isnotempty', ''], 'AND',
          ['createdby', 'noneof', '-4']
        ],
        columns: [
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'tranid' }),
          search.createColumn({ name: 'custbody_wb_inb_container', label: 'Container' }),
          search.createColumn({ name: 'entity' })
        ]
      });
    });
    ensure(WB_STAT_SEARCHES.rfhours, 'Warehouse Stats - RF Scan Time', function () {
      return search.create({
        type: 'customrecord_rfs_tx',
        filters: [['isinactive', 'is', 'F']],
        columns: [
          search.createColumn({ name: 'created', sort: search.Sort.DESC }),
          search.createColumn({ name: 'custrecord_rfs_txduration', label: 'Duration (seconds)' })
        ]
      });
    });
    return out;
  }

  function onRequest(context) {
    WB_TIME = {};
    WB_BUNDLE = null;
    // Per-request, not per-context: NetSuite reuses module scope across
    // requests, so a single failed search.load used to latch this true for
    // the life of the context -- after which every compute was flagged
    // degraded and evicted, and nothing could stay cached again.
    WB_DEGRADED = false;
    WB_FRESH = context.request.parameters.fresh === '1';
    if (context.request.parameters.fixontime === '1') {
      context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
      if (runtime.getCurrentUser().role !== 3) { context.response.write(JSON.stringify({ error: 'admin only' })); return; }
      try {
        var os = search.load({ id: WB_STAT_SEARCHES.ontime });
        var already = false;
        for (var fi = 0; fi < os.filters.length; fi++) {
          if (os.filters[fi].name === 'entity') { already = true; break; }
        }
        if (!already) {
          os.filters.push(search.createFilter({ name: 'entity', operator: 'noneof', values: ONTIME_EXEMPT_CUSTOMERS }));
          os.save();
        }
        context.response.write(JSON.stringify({ ok: true, changed: !already }));
      } catch (eF) {
        context.response.write(JSON.stringify({ error: (eF && eF.message) || String(eF) }));
      }
      return;
    }
    if (context.request.parameters.warmnow === '1') {
      var whoW = runtime.getCurrentUser();
      context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
      if (whoW.role !== 3) { context.response.write(JSON.stringify({ error: 'admin only' })); return; }
      try {
        var tW = task.create({ taskType: task.TaskType.SCHEDULED_SCRIPT,
          scriptId: 'customscript_mw_ss_board_warm', deploymentId: 'customdeploy2' }).submit();
        context.response.write(JSON.stringify({ submitted: tW,
          status: String(task.checkStatus({ taskId: tW }).status) }));
      } catch (eW) {
        context.response.write(JSON.stringify({ error: (eW && eW.message) || String(eW) }));
      }
      return;
    }
    if (context.request.parameters.mksearches === '1') {
      var who = runtime.getCurrentUser();
      context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
      if (who.role !== 3) { context.response.write(JSON.stringify({ error: 'admin only' })); return; }
      context.response.write(JSON.stringify(makeStatSearches()));
      return;
    }
      // Reload the stylesheet each request. KODIAK_CSS is module scoped and
      // NetSuite reuses modules across requests, so caching it across calls
      // meant a warm execution context kept serving the stylesheet as it was
      // when that context started — CSS edits appeared not to deploy.
      KODIAK_CSS = null;

    var req = context.request;

    // AJAX mode — dynamic sections / activity period switch / drill-down as JSON
    if (req.parameters.json === '1') {
      var rfPeriod = normalizeRfPeriod(req.parameters.period);
      var payload;

      if (req.parameters.rfdrill === '1') {
        // Drill-down: transactions behind one operator+function pill
        payload = {
          drill: buildRfDrillHtml(rfPeriod, req.parameters.rfuser || '', req.parameters.rffunc || '')
        };
      } else if (req.parameters.statdrill) {
        // Drill-down: fulfillments behind a Statistics number
        payload = {
          drill: buildStatDrillHtml(req.parameters.statdrill, req.parameters.speriod || 'today')
        };
      } else if (req.parameters.oddrill === '1') {
        // Drill-down: open sales orders behind an Orders Due pill
        payload = {
          drill: buildOrdersDueDrillHtml(req.parameters.odbucket || 'today')
        };
      } else if (req.parameters.reasonset === '1') {
        // Save a late-shipment reason (free text) onto an IF ('' clears it)
        try {
          var reasonIfId = String(req.parameters.reasonif || '');
          if (!/^\d+$/.test(reasonIfId)) throw new Error('Invalid fulfillment id');
          var reasonText = String(req.parameters.reasontext || '').substring(0, 300).trim();
          setLateReason(reasonIfId, reasonText);
          payload = { ok: true };
        } catch (rsErr) {
          log.error({ title: 'reasonset', details: rsErr });
          payload = { ok: false, error: (rsErr && rsErr.message) ? rsErr.message : 'save failed' };
        }
      } else if (req.parameters.exemptset === '1') {
        // Set/clear the Late Shipment Exempt checkbox on an IF
        try {
          var exIfId = String(req.parameters.exemptif || '');
          if (!/^\d+$/.test(exIfId)) throw new Error('Invalid fulfillment id');
          setLateExempt(exIfId, req.parameters.exemptval === 'T');
          payload = { ok: true };
        } catch (exErr) {
          log.error({ title: 'exemptset', details: exErr });
          payload = { ok: false, error: (exErr && exErr.message) ? exErr.message : 'save failed' };
        }
      } else if (req.parameters.statsonly === '1') {
        // Deferred statistics grid (the heavy one)
        // Cached history + a freshly computed Today/This Week. statsAt is the
        // live pass's time, so the header clock actually moves.
        payload = timed('ajax_stats', buildStatsPayload);
        payload._t = WB_TIME;
      } else if (req.parameters.activityonly === '1') {
        // Period button switch: only the activity panel is needed
        payload = {
          activity: timed('ajax_activity', function () { return buildRfBdHtml(getRfSmartUserBreakdown(rfPeriod)); }),
          _t: WB_TIME
        };
      } else {
        var script = runtime.getCurrentScript();
        var ctApiKey = script.getParameter({ name: 'custscript_wb_ct_apikey' }) || '';
        var ctClockId = script.getParameter({ name: 'custscript_wb_ct_clockid' }) || '';

        payload = {
          clockedIn: timed('ajax_connecteam', function () { return wbBundle().ct; }),
          monitor: timed('ajax_rfusers', function () { return buildMonitorHtml(getRfSmartActiveUsers()); }),
          activity: timed('ajax_activity', function () { return buildRfBdHtml(getRfSmartUserBreakdown(rfPeriod)); }),
          _t: WB_TIME
        };
      }

      // Header set can fail (SSS_INVALID_HEADER) when a poll fires on an
      // expired session and the response is already committed to a redirect —
      // skip the header rather than erroring; the next poll recovers.
      try {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
      } catch (hdrErr) {
        return;
      }
      context.response.write(JSON.stringify(payload));
      return;
    }

    var params = {
      so: req.parameters.so || '',
      'if': req.parameters['if'] || '',
      to: req.parameters.to || '',
      item: req.parameters.item || ''
    };

    var results = [];

    if (req.method === 'POST') {
      var action = normalizeTerm(req.parameters.custpage_action);
      var term = normalizeTerm(req.parameters.custpage_search_value);

      if (action && term) params[action] = term;

      if (action === 'so') {
        var soMatches = findTransactionsByTranId({ tranType: 'SalesOrd', term: term });
        if (soMatches.length === 1) {
          redirect.redirect({ url: resolveTransactionUrl('SalesOrd', soMatches[0].internalid) });
          return;
        }
        for (var si = 0; si < soMatches.length; si++) {
          var sm = soMatches[si];
          results.push({
            kind: 'Sales Order', primary: sm.tranid,
            secondary: (sm.trandate || '') + ' \u2022 ' + (sm.entity || '') + ' \u2022 ' + (sm.status || ''),
            href: resolveTransactionUrl('SalesOrd', sm.internalid), linkText: 'Open'
          });
        }
      }

      if (action === 'if') {
        var ifMatches = findTransactionsByTranId({ tranType: 'ItemShip', term: term });
        if (ifMatches.length === 1) {
          redirect.redirect({ url: resolveTransactionUrl('ItemShip', ifMatches[0].internalid) });
          return;
        }
        for (var ii = 0; ii < ifMatches.length; ii++) {
          var im = ifMatches[ii];
          results.push({
            kind: 'Item Fulfillment', primary: im.tranid,
            secondary: (im.trandate || '') + ' \u2022 ' + (im.entity || '') + ' \u2022 ' + (im.status || ''),
            href: resolveTransactionUrl('ItemShip', im.internalid), linkText: 'Open'
          });
        }
      }

      if (action === 'to') {
        var toMatches = findTransactionsByTranId({ tranType: 'TrnfrOrd', term: term });
        if (toMatches.length === 1) {
          redirect.redirect({ url: resolveTransactionUrl('TrnfrOrd', toMatches[0].internalid) });
          return;
        }
        for (var ti = 0; ti < toMatches.length; ti++) {
          var tm = toMatches[ti];
          results.push({
            kind: 'Transfer Order', primary: tm.tranid,
            secondary: (tm.trandate || '') + ' \u2022 ' + (tm.entity || '') + ' \u2022 ' + (tm.status || ''),
            href: resolveTransactionUrl('TrnfrOrd', tm.internalid), linkText: 'Open'
          });
        }
      }

      if (action === 'item') {
        var items = findItems(term);
        for (var xi = 0; xi < items.length; xi++) {
          var itm = items[xi];
          results.push({
            kind: 'Item', primary: itm.itemid || '(no itemid)',
            secondary: (itm.displayname || '') + (itm.itemtype ? ' \u2022 ' + itm.itemtype : ''),
            href: resolveItemUrl(itm.internalid), linkText: 'Open'
          });
        }
      }

      if (!results.length && action && term) {
        results.push({
          kind: 'No matches', primary: term,
          secondary: 'Nothing found with that search term. Try a broader term.',
          href: '', linkText: ''
        });
      }
    }

    var form = serverWidget.createForm({ title: SUITELET_TITLE });

    var fldAction = form.addField({ id: 'custpage_action', label: 'Action', type: serverWidget.FieldType.TEXT });
    fldAction.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    var fldSearchValue = form.addField({ id: 'custpage_search_value', label: 'Search Value', type: serverWidget.FieldType.TEXT });
    fldSearchValue.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    var alerts = getAlertLinks();
    var alertData = [];
    for (var ai = 0; ai < alerts.length; ai++) {
      var alertCount;
      if (alerts[ai].countKey === 'shippablePastDue') {
        alertCount = timed('alert_pastdue', function () { return getShippablePastDueCount(); });
      } else {
        alertCount = (function (sid2) { var b = wbBundle(); return (b.al_ss && b.al_ss[sid2] != null) ? b.al_ss[sid2] : timed('alert_search', function () { return getSavedSearchCount(sid2); }); })(alerts[ai].searchId);
      }
      alertData.push({
        category: alerts[ai].category || '',
        label: alerts[ai].label,
        href: alerts[ai].href,
        count: alertCount
      });
    }

    // Connecteam clocked-in panel
    var script = runtime.getCurrentScript();
    var ctApiKey = script.getParameter({ name: 'custscript_wb_ct_apikey' }) || '';
    var ctClockId = script.getParameter({ name: 'custscript_wb_ct_clockid' }) || '';
    // Deferred: Connecteam HTTP happens on the first wbRefresh() AJAX call
    var clockedInHtml = '<div class="ciWrap"><div class="ciHeader">&#128994; Who\'s Clocked In</div>'
      + '<div style="color:var(--rw-muted);font-size:13px;padding:8px 0;">Loading\u2026</div></div>';

    // Generate Suitelet URL for AJAX refresh polling
    var refreshUrl = '';
    try {
      refreshUrl = url.resolveScript({
        scriptId: script.id,
        deploymentId: script.deploymentId
      });
    } catch (urlErr) {
      log.error({ title: 'resolveScript for refresh', details: urlErr });
    }

    var inline = form.addField({ id: 'custpage_inlinehtml', label: 'Warehouse Board', type: serverWidget.FieldType.INLINEHTML });
    inline.defaultValue = buildInlineHtml(params, results, alertData, clockedInHtml, refreshUrl);
    if (context.request.parameters.sbtime === '1') {
      inline.defaultValue += '<div id="sbTimeDump" style="display:none">' + escapeHtml(JSON.stringify(WB_TIME)) + '</div>';
    }

    context.response.writePage(form);
  }

  return { onRequest: onRequest, warmWarehouseBundle: warmWarehouseBundle };
});