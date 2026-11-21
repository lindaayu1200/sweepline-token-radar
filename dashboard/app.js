(function(){
  'use strict';
  var P = window.RADAR;
  var byId = function(id){ return document.getElementById(id); };
  if(!P || !Array.isArray(P.rows)){
    byId('resultcount').textContent = 'Payload unavailable - run the entry first.';
    return;
  }

  var rows = P.rows.slice();
  var totalRows = rows.length;
  var bySlug = new Map();
  rows.forEach(function(r){ bySlug.set(r.slug, r); });
  var summary = P.farmSummary || { tiers:{ low:0, medium:0, high:0 } };
  var NULL_CAT = '__null__';
  var effortOrder = { low:0, medium:1, high:2 };
  var sortDefault = { rank:1, tvl:-1, change:-1, ev:-1, implied:-1, effort:-1 };
  var state = { q:'', category:'', chain:'', verdict:'all', effort:'all', slider:0, sort:'rank', dir:1 };
  var shownRows = [];
  var cursor = -1;
  var focusBeforeDrawer = null;

  var searchEl = byId('search');
  var drawer = byId('drawer');
  var bodyEl = byId('board-body');

  // Revision 2: normalize each record once, then reuse the derived values on every keystroke.
  var peakTvl = rows.reduce(function(m, r){ return Math.max(m, finite(r.tvl_usd) ? r.tvl_usd : 0); }, 1);
  var minTvlByStep = [];
  for(var step = 0; step <= 100; step++){
    minTvlByStep[step] = step === 0 ? 0 : Math.pow(10, step / 100 * Math.log10(peakTvl + 1)) - 1;
  }
  var prepared = rows.map(function(r){
    var chains = Array.isArray(r.chains) ? r.chains.map(String) : [];
    return {
      row:r,
      hay:(String(r.name || '') + ' ' + String(r.slug || '')).toLowerCase(),
      cat:catKey(r),
      chains:chains,
      rank:finite(r.rank) ? r.rank : 0,
      tvl:finite(r.tvl_usd) ? r.tvl_usd : null,
      chg:finite(r.change_7d) ? r.change_7d : null,
      ev:finite(r.ev_per_hour) ? r.ev_per_hour : null,
      implied:finite(r.implied_value_usd) ? r.implied_value_usd : null,
      tier:effortOf(r)
    };
  });
  var pipelineCache = { key:null, list:[] };

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function finite(value){
    return typeof value === 'number' && isFinite(value);
  }
  function money(value){
    return finite(value) ? '$' + value.toLocaleString('en-US', { maximumFractionDigits:0 }) : 'n/a';
  }
  function compact(value){
    if(!finite(value)) return 'n/a';
    var a = Math.abs(value);
    if(a >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if(a >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if(a >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(value);
  }
  function decimal(value, places){
    return finite(value) ? value.toLocaleString('en-US', { minimumFractionDigits:places, maximumFractionDigits:places }) : 'n/a';
  }
  function changeText(value){
    if(!finite(value)) return 'n/a';
    return (value > 0 ? '+' : '') + value.toFixed(2) + '%';
  }
  function catLabel(row){
    var text = row.category == null ? '' : String(row.category).trim();
    return text === '' ? 'Unclassified' : text;
  }
  function catKey(row){
    var text = row.category == null ? '' : String(row.category).trim();
    return text === '' ? NULL_CAT : text;
  }
  function effortOf(row){
    var tier = row.farm && row.farm.effort ? String(row.farm.effort) : '';
    return effortOrder[tier] === undefined ? null : tier;
  }
  function threshold(){
    return minTvlByStep[state.slider] || 0;
  }

  function renderKpis(count){
    var t = summary.tiers || {};
    var top = rows.reduce(function(m, r){ return Math.max(m, finite(r.implied_value_usd) ? r.implied_value_usd : 0); }, 0);
    var items = [
      { label:'Protocols priced', value:String(totalRows), sub:'ranked universe' },
      { label:'Watchlist covered', value:(P.watchlist_covered || 0) + '/' + (P.watchlist_total || 0), sub:'named mandates' },
      { label:'Rows shown', value:String(count), sub:'of ' + totalRows + ' after filters', cls:'accent' },
      { label:'Top implied value', value:compact(top), sub:'rank one estimate' },
      { label:'Median EV / hour', value:finite(P.median_ev_per_hour) ? '$' + decimal(P.median_ev_per_hour, 2) : 'n/a', sub:'board benchmark' },
      { label:'Farm effort tiers', value:'<span class="lo">' + (t.low || 0) + '</span> / <span class="mid">' + (t.medium || 0) + '</span> / <span class="hi">' + (t.high || 0) + '</span>', sub:'low / medium / high' }
    ];
    byId('kpis').innerHTML = items.map(function(item){
      return '<div class="kpi"><span class="kpi-label">' + esc(item.label) + '</span>' +
        '<span class="kpi-value' + (item.cls ? ' ' + item.cls : '') + '">' + item.value + '</span>' +
        '<span class="kpi-sub">' + esc(item.sub) + '</span></div>';
    }).join('');
  }

  function fillSelect(el, entries, placeholder){
    var html = '<option value="">' + esc(placeholder) + '</option>';
    entries.forEach(function(entry){
      html += '<option value="' + esc(entry.value) + '">' + esc(entry.label) + '</option>';
    });
    el.innerHTML = html;
  }

  function initControls(){
    var catValues = new Map();
    var chainValues = new Set();
    rows.forEach(function(r){
      catValues.set(catKey(r), catLabel(r));
      (Array.isArray(r.chains) ? r.chains : []).forEach(function(c){ if(c) chainValues.add(c); });
    });
    var cats = Array.from(catValues, function(pair){ return { value:pair[0], label:pair[1] }; })
      .sort(function(a, b){ return a.label.localeCompare(b.label); });
    fillSelect(byId('category'), cats, 'All categories');
    fillSelect(byId('chain'), Array.from(chainValues).sort().map(function(c){ return { value:c, label:c }; }), 'All chains');
    byId('asof').textContent = P.as_of || 'unknown';
    byId('sourcename').textContent = P.source || '';
    if(P.model){
      byId('model-formula').textContent = P.model.formula || '';
      byId('model-rule').textContent = P.model.verdict_rule || '';
      byId('model-test').textContent = P.model.loo_sentence || '';
    }
  }

  function matches(entry){
    var q = state.q.trim().toLowerCase();
    if(q && entry.hay.indexOf(q) < 0) return false;
    if(state.category && entry.cat !== state.category) return false;
    if(state.chain && entry.chains.indexOf(state.chain) < 0) return false;
    if(state.verdict !== 'all' && entry.row.verdict !== state.verdict) return false;
    if(state.effort !== 'all' && entry.tier !== state.effort) return false;
    if(entry.tvl !== null && entry.tvl < threshold()) return false;
    return true;
  }

  function sortValue(entry){
    switch(state.sort){
      case 'rank': return entry.rank;
      case 'tvl': return entry.tvl;
      case 'change': return entry.chg;
      case 'ev': return entry.ev;
      case 'implied': return entry.implied;
      case 'effort': return entry.tier === null ? null : effortOrder[entry.tier];
      default: return entry.rank;
    }
  }

  function compareRows(a, b){
    var av = sortValue(a);
    var bv = sortValue(b);
    if(av === null && bv === null) return a.rank - b.rank;
    if(av === null) return 1;
    if(bv === null) return -1;
    if(av !== bv) return (av - bv) * state.dir;
    return a.rank - b.rank;
  }

  function pipelineKey(){
    return [state.q.trim().toLowerCase(), state.category, state.chain, state.verdict,
      state.effort, state.slider, state.sort, state.dir].join('|');
  }

  function computeRows(){
    var key = pipelineKey();
    if(pipelineCache.key === key) return pipelineCache.list;
    var kept = prepared.filter(matches);
    kept.sort(compareRows);
    pipelineCache = { key:key, list:kept.map(function(entry){ return entry.row; }) };
    return pipelineCache.list;
  }

  function sparkline(row){
    var value = row.change_7d;
    var slug = String(row.slug || '');
    var seed = 0;
    for(var k = 0; k < slug.length; k++) seed = (seed * 31 + slug.charCodeAt(k)) % 997;
    var spread = finite(value) ? Math.max(3, Math.abs(value) * 1.25) : 4;
    var path = [];
    for(var i = 0; i <= 7; i++){
      var t = i / 7;
      var wander = Math.sin(seed * 0.07 + i * 1.6) * spread * 0.17 * (1 - t * 0.55);
      var level = finite(value) ? value * t + wander : 0;
      var y = 10 - Math.max(-1, Math.min(1, level / spread)) * 8;
      path.push((i ? 'L' : 'M') + (i * 10).toFixed(1) + ' ' + y.toFixed(1));
    }
    var tone = !finite(value) ? 'var(--dim)' : value > 0.05 ? 'var(--lime)' : value < -0.05 ? 'var(--rose)' : 'var(--cyan)';
    var label = finite(value)
      ? String(row.name || 'Protocol') + ': seven day change ' + changeText(value)
      : String(row.name || 'Protocol') + ': seven day change not reported';
    return '<svg class="spark" viewBox="0 0 70 20" role="img" aria-label="' + esc(label) + '">' +
      '<path class="spark-base" d="M0 10 L70 10"/>' +
      '<path class="spark-line" style="stroke:' + tone + '" d="' + path.join(' ') + '"/></svg>';
  }

  function stepColumn(row){
    var plan = row.farm || {};
    var actions = Array.isArray(plan.actions) ? plan.actions : [];
    var legacy = Array.isArray(row.farm_steps) ? row.farm_steps : [];
    var count = actions.length || legacy.length;
    var lead = actions.length ? actions[0].target : (legacy.length ? legacy[0] : 'plan unavailable');
    return '<span class="steps-cell"><b>' + count + ' steps</b> ' + esc(lead) + '</span>';
  }

  function renderTable(){
    shownRows = computeRows();
    if(cursor >= shownRows.length) cursor = shownRows.length - 1;
    bodyEl.innerHTML = shownRows.length ? shownRows.map(function(r, index){
      var chg = finite(r.change_7d) ? '<span class="' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : 'flat') + '">' + changeText(r.change_7d) + '</span>' : '<span class="flat">n/a</span>';
      var chains = Array.isArray(r.chains) ? r.chains : [];
      var chainHtml = chains.slice(0, 2).map(function(c){ return '<span class="badge chain">' + esc(c) + '</span>'; }).join('') +
        (chains.length > 2 ? '<span class="more">+' + (chains.length - 2) + '</span>' : '');
      var tier = effortOf(r);
      var rowLabel = 'Rank ' + r.rank + ', ' + r.name + ', ' + r.verdict +
        (tier ? ', ' + tier + ' effort' : '') + ', ' + compact(r.implied_value_usd) + ' implied';
      return '<tr data-slug="' + esc(r.slug) + '" data-index="' + index + '" aria-label="' + esc(rowLabel) + '"' + (index === cursor ? ' class="is-selected"' : '') + '>' +
        '<td class="rank-cell' + (r.rank === 1 ? ' rank-top' : '') + '">' + r.rank + '</td>' +
        '<td><div class="proto">' + esc(r.name) + '</div><div class="slugline">' + esc(r.slug) + '</div></td>' +
        '<td><span class="badge cat">' + esc(catLabel(r)) + '</span></td>' +
        '<td>' + (chainHtml || '<span class="more">-</span>') + '</td>' +
        '<td class="num">' + compact(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td>' + sparkline(r) + '</td>' +
        '<td class="num">' + (finite(r.ev_per_hour) ? '$' + decimal(r.ev_per_hour, 2) : 'n/a') + '</td>' +
        '<td class="num">' + compact(r.implied_value_usd) + '</td>' +
        '<td>' + (tier ? '<span class="chip ' + esc(tier) + '">' + esc(tier) + '</span>' : '<span class="more">-</span>') + '</td>' +
        '<td><span class="chip ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span></td>' +
        '<td>' + stepColumn(r) + '</td></tr>';
    }).join('') : '<tr><td class="empty" colspan="12">No protocols match these controls.</td></tr>';
    byId('resultcount').innerHTML = 'Showing <b>' + shownRows.length + '</b> of ' + totalRows + ' rows';
    renderKpis(shownRows.length);
    document.querySelectorAll('thead th[data-col]').forEach(function(th){
      th.setAttribute('aria-sort', th.dataset.col === state.sort ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
    });
  }

  function markCursor(){
    bodyEl.querySelectorAll('tr[data-index]').forEach(function(tr){
      tr.classList.toggle('is-selected', Number(tr.dataset.index) === cursor);
    });
  }

  function moveCursor(step){
    if(!shownRows.length) return;
    cursor = Math.max(0, Math.min(shownRows.length - 1, cursor + step));
    markCursor();
    var active = bodyEl.querySelector('tr[data-index="' + cursor + '"]');
    if(active && active.scrollIntoView) active.scrollIntoView({ block:'nearest' });
  }

  function metric(label, value){
    return '<div class="metric"><span>' + esc(label) + '</span><strong>' + value + '</strong></div>';
  }
  function actionCard(action, index){
    return '<div class="action"><div class="action-rank">' + (index + 1) + '</div><div>' +
      '<div class="action-top"><span class="action-target">' + esc(action.target || 'unspecified target') + '</span>' +
      '<span class="chip ' + esc(action.kind || 'interact') + '">' + esc(action.kind || 'task') + '</span></div>' +
      '<p class="action-detail">' + esc(action.detail || '') + '</p>' +
      '<span class="action-watch">size ' + money(action.size_usd) + ' / watch: ' + esc(action.watch_for || 'not stated') + '</span>' +
      '</div></div>';
  }

  function openDrawer(slug){
    var row = bySlug.get(slug);
    if(!row) return;
    focusBeforeDrawer = document.activeElement;
    var plan = row.farm || {};
    var actions = Array.isArray(plan.actions) ? plan.actions : [];
    var steps = Array.isArray(row.farm_steps) ? row.farm_steps : [];
    var flags = Array.isArray(plan.data_flags) && plan.data_flags.length ? plan.data_flags.join(', ') : 'none';
    var reasons = Array.isArray(plan.effort_reasons) ? plan.effort_reasons : [];
    var tier = effortOf(row);
    var chains = Array.isArray(row.chains) ? row.chains : [];
    byId('drawer-body').innerHTML =
      '<h2 class="drawer-title" id="drawer-title">' + esc(row.name) + '</h2>' +
      '<div class="drawer-sub">rank ' + row.rank + ' / ' + esc(row.slug) + '</div>' +
      '<div class="tagrow">' +
        '<span class="chip ' + esc(row.verdict) + '">' + esc(row.verdict) + '</span> ' +
        (tier ? '<span class="chip ' + esc(tier) + '">' + esc(tier) + ' effort</span> ' : '') +
        '<span class="badge cat">' + esc(catLabel(row)) + '</span> ' +
        chains.map(function(c){ return '<span class="badge chain">' + esc(c) + '</span>'; }).join('') +
      '</div>' +
      '<div class="metric-grid">' +
        metric('Implied value', money(row.implied_value_usd)) +
        metric('EV per hour', finite(row.ev_per_hour) ? '$' + decimal(row.ev_per_hour, 2) : 'n/a') +
        metric('TVL', money(row.tvl_usd)) +
        metric('7d change', changeText(row.change_7d)) +
        metric('Base estimate', money(row.base_implied_usd)) +
        metric('Growth / age mult', decimal(row.growth_mult, 3) + ' / ' + decimal(row.age_mult, 3)) +
        metric('Expected airdrop', money(row.expected_airdrop_usd)) +
        metric('Gas + capital drag', money(row.gas_usd) + ' + ' + money(row.capital_drag_usd)) +
        metric('Active hours', finite(row.farm_hours) ? decimal(row.farm_hours, 2) + 'h' : 'n/a') +
        metric('Adjusted score', decimal(plan.effort_adjusted_score, 2)) +
      '</div>' +
      '<h3>Launch window and confidence</h3>' +
      '<div class="metric-grid">' +
        metric('Window band', esc(plan.window_band || 'n/a')) +
        metric('Days to window', finite(plan.days_to_window) ? plan.days_to_window + 'd' : 'n/a') +
        metric('Confidence', esc(plan.confidence || 'n/a')) +
        metric('Effort score', decimal(plan.effort_score, 2)) +
        metric('Suggested capital', money(plan.suggested_capital_usd)) +
        metric('Data flags', '<span class="flags">' + esc(flags) + '</span>') +
      '</div>' +
      '<p class="note">' + esc(plan.rationale || 'No rationale supplied for this row.') + '</p>' +
      (reasons.length ? '<h3>Why this effort tier</h3><ul class="step-list">' + reasons.map(function(text){ return '<li>' + esc(text) + '</li>'; }).join('') + '</ul>' : '') +
      '<h3>Action queue</h3>' +
      (actions.length ? actions.map(actionCard).join('') : '<p class="muted">No structured actions on this row.</p>') +
      '<h3>Step sequence</h3>' +
      (steps.length ? '<ol class="step-list">' + steps.map(function(text){ return '<li>' + esc(text) + '</li>'; }).join('') + '</ol>' : '<p class="muted">No legacy steps on this row.</p>');
    drawer.classList.remove('is-hidden');
    drawer.setAttribute('aria-hidden', 'false');
    byId('drawer-close').focus();
  }

  function closeDrawer(){
    if(drawer.classList.contains('is-hidden')) return;
    drawer.classList.add('is-hidden');
    drawer.setAttribute('aria-hidden', 'true');
    if(focusBeforeDrawer && focusBeforeDrawer.focus) focusBeforeDrawer.focus();
  }

  function refresh(){
    bodyEl.parentElement.scrollTop = 0;
    renderTable();
  }

  document.querySelectorAll('thead button[data-key]').forEach(function(button){
    button.addEventListener('click', function(){
      var key = button.dataset.key;
      if(state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = sortDefault[key] || 1; }
      refresh();
    });
  });
  bodyEl.addEventListener('click', function(e){
    var tr = e.target && e.target.closest ? e.target.closest('tr[data-slug]') : null;
    if(!tr) return;
    cursor = Number(tr.dataset.index);
    markCursor();
    openDrawer(tr.dataset.slug);
  });
  searchEl.addEventListener('input', function(e){ state.q = e.target.value; refresh(); });
  byId('category').addEventListener('change', function(e){ state.category = e.target.value; refresh(); });
  byId('chain').addEventListener('change', function(e){ state.chain = e.target.value; refresh(); });
  byId('verdict').addEventListener('change', function(e){ state.verdict = e.target.value; refresh(); });
  byId('effort').addEventListener('change', function(e){ state.effort = e.target.value; refresh(); });
  byId('mintvl').addEventListener('input', function(e){
    state.slider = Number(e.target.value);
    byId('tvlvalue').textContent = state.slider === 0 ? 'none' : compact(threshold());
    refresh();
  });
  byId('reset').addEventListener('click', function(){
    state.q = ''; state.category = ''; state.chain = ''; state.verdict = 'all';
    state.effort = 'all'; state.slider = 0; state.sort = 'rank'; state.dir = 1;
    searchEl.value = ''; byId('category').value = ''; byId('chain').value = '';
    byId('verdict').value = 'all'; byId('effort').value = 'all';
    byId('mintvl').value = '0'; byId('tvlvalue').textContent = 'none';
    cursor = -1; refresh();
  });
  byId('drawer-close').addEventListener('click', closeDrawer);
  drawer.addEventListener('click', function(e){
    if(e.target && e.target.getAttribute('data-dismiss')) closeDrawer();
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape'){ closeDrawer(); return; }
    var tag = e.target && e.target.tagName;
    if(e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA'){
      e.preventDefault(); searchEl.focus(); searchEl.select(); return;
    }
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if(tag === 'SELECT' || tag === 'BUTTON') return;
      e.preventDefault(); moveCursor(e.key === 'ArrowDown' ? 1 : -1); return;
    }
    if(e.key === 'Enter' && tag !== 'BUTTON' && shownRows.length){
      e.preventDefault();
      if(cursor < 0) cursor = 0;
      openDrawer(shownRows[cursor].slug);
    }
  });

  initControls();
  renderTable();
})();
