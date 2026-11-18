(function(){
  const R = window.RADAR;
  if(!R){ document.body.textContent='Radar data missing.'; return; }
  const $ = (s)=>document.querySelector(s);
  const fmtUsd = (n)=>'$'+Math.round(n).toLocaleString('en-US');
  const fmtNum = (n,d=2)=> (n==null?'n/a':Number(n).toLocaleString('en-US',{maximumFractionDigits:d,minimumFractionDigits:d}));
  const fmtCompact = (n)=>{
    if(n==null) return 'n/a';
    const a=Math.abs(n);
    if(a>=1e9) return (n/1e9).toFixed(2)+'B';
    if(a>=1e6) return (n/1e6).toFixed(2)+'M';
    if(a>=1e3) return (n/1e3).toFixed(1)+'K';
    return String(Math.round(n));
  };
  const esc = (s)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

  function renderStats(){
    const m = R.model;
    const items = [
      ['Watchlist', `${R.watchlist_covered}/${R.watchlist_total}`],
      ['Board rows', R.board_rows],
      ['Comps n', m.n],
      ['r2', fmtNum(m.r2,4)],
      ['LOO MAPE', fmtNum(m.loo_mape_median*100,2)+'%'],
      ['Fits', m.fits ? m.fits.length : 1],
      ['Implied range', `${fmtCompact(R.implied_min)} - ${fmtCompact(R.implied_max)}`],
      ['As of', R.as_of]
    ];
    $('#stats').innerHTML = items.map(([k,v])=>`<div class="stat"><div>${esc(k)}</div><b>${esc(String(v))}</b></div>`).join('');
  }

  function renderModel(){
    const m = R.model;
    const fitDesc = (m.fits||[]).map(f=>`${f.label}: n=${f.n}, r2=${fmtNum(f.r2,4)}, LOO shown overall, b=${fmtNum(f.b,4)}, a=${fmtNum(f.a,4)}, dropped=${f.dropped}`).join(' | ');
    let formula = m.formula + ` Fits used: ${fitDesc}.`;
    if(m.fallback_note) formula += ' ' + m.fallback_note;
    $('#formula').textContent = formula;
    $('#constants').textContent = m.constants;
    $('#loo').textContent = m.loo_sentence;
    $('#assumption').textContent = m.ev_sentence || `Expected airdrop assumes a ${(m.allocation*100).toFixed(2)}% token allocation of implied fully diluted value; the airdrop itself is a stated 0.50% assumption, not a forecast.`;
    $('#verdict-rule').textContent = m.verdict_rule || `Verdict rule: compute EV per active hour = (expected_airdrop - gas - capital_drag) / hours for each row.`;
  }

  function renderChart(){
    const W=760,H=440,pad={l:55,r:20,t:20,b:45};
    const rows = R.rows;
    const comps = R.comps;
    const ptsB = rows.map(r=>({x:Math.log10(Math.max(1,r.tvl_usd)), y:Math.log10(Math.max(1,r.implied_value_usd))}));
    const ptsC = comps.map(c=>({x:Math.log10(Math.max(1,c.tvl_usd)), y:Math.log10(Math.max(1,c.mcap_usd))}));
    const all = ptsB.concat(ptsC);
    const minX=Math.min(...all.map(p=>p.x)), maxX=Math.max(...all.map(p=>p.x));
    const minY=Math.min(...all.map(p=>p.y)), maxY=Math.max(...all.map(p=>p.y));
    const sx=(x)=>pad.l + (x-minX)/(maxX-minX||1)*(W-pad.l-pad.r);
    const sy=(y)=>H-pad.b - (y-minY)/(maxY-minY||1)*(H-pad.t-pad.b);
    const grid=[];
    for(let i=Math.ceil(minX); i<=Math.floor(maxX); i++){
      const x=sx(i); grid.push(`<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${H-pad.b}" stroke="#0d4a44" stroke-width="1"/>`);
      grid.push(`<text x="${x}" y="${H-pad.b+16}" fill="#7fa9a2" font-size="10" text-anchor="middle">${i}</text>`);
    }
    for(let i=Math.ceil(minY); i<=Math.floor(maxY); i++){
      const y=sy(i); grid.push(`<line x1="${pad.l}" y1="${y}" x2="${W-pad.r}" y2="${y}" stroke="#0d4a44" stroke-width="1"/>`);
      grid.push(`<text x="${pad.l-6}" y="${y+3}" fill="#7fa9a2" font-size="10" text-anchor="end">${i}</text>`);
    }
    const x1=minX, x2=maxX;
    const fits = (R.model && R.model.fits && R.model.fits.length) ? R.model.fits : (R.fit ? [{a:R.fit.a,b:R.fit.b,label:'Fitted line'}] : []);
    const fitLines = fits.map(f=>{
      const y1=(f.a + f.b*(x1*Math.LN10))/Math.LN10;
      const y2=(f.a + f.b*(x2*Math.LN10))/Math.LN10;
      return `<line x1="${sx(x1)}" y1="${sy(y1)}" x2="${sx(x2)}" y2="${sy(y2)}" stroke="#d8efe9" stroke-width="1.2" opacity="0.85"/>`;
    }).join('');
    const dotsB = ptsB.map(p=>`<circle cx="${sx(p.x).toFixed(2)}" cy="${sy(p.y).toFixed(2)}" r="1.8" fill="#3ddc97" opacity="0.28"/>`).join('');
    const dotsC = ptsC.map(p=>`<circle cx="${sx(p.x).toFixed(2)}" cy="${sy(p.y).toFixed(2)}" r="2.4" fill="#f2a33c" opacity="0.85"/>`).join('');
    const lineLabel = fits.length > 1 ? 'Fitted lines' : 'Fitted line';
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter chart">
      ${grid.join('')}
      <line x1="${pad.l}" y1="${H-pad.b}" x2="${W-pad.r}" y2="${H-pad.b}" stroke="#7fa9a2"/>
      <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${H-pad.b}" stroke="#7fa9a2"/>
      ${dotsB}${dotsC}${fitLines}
      <text x="${W/2}" y="${H-8}" fill="#d8efe9" font-size="11" text-anchor="middle">log10 TVL (USD)</text>
      <text x="14" y="${H/2}" fill="#d8efe9" font-size="11" text-anchor="middle" transform="rotate(-90 14 ${H/2})">log10 implied/mcap (USD)</text>
      <circle cx="${W-190}" cy="18" r="3.5" fill="#3ddc97" opacity="0.6"/><text x="${W-180}" y="22" fill="#d8efe9" font-size="11">Board pre-token (all)</text>
      <circle cx="${W-190}" cy="36" r="3.5" fill="#f2a33c"/><text x="${W-180}" y="40" fill="#d8efe9" font-size="11">Live comps</text>
      <line x1="${W-194}" y1="54" x2="${W-186}" y2="54" stroke="#d8efe9" stroke-width="2"/><text x="${W-180}" y="58" fill="#d8efe9" font-size="11">${lineLabel}</text>
    </svg>`;
    $('#chart-wrap').innerHTML = svg;
  }

  function uniqueSorted(values){
    return Array.from(new Set(values.filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  }

  function initFilters(){
    const chains = uniqueSorted(R.rows.flatMap(r=>r.chains||[]));
    const cats = uniqueSorted(R.rows.map(r=>r.category||'Unknown'));
    $('#chain').innerHTML = '<option value="">All chains</option>'+chains.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    $('#category').innerHTML = '<option value="">All categories</option>'+cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  }

  let state = { q:'', chain:'', category:'', verdict:'all', sort:'implied', detail:null };

  function readHash(){
    const h = location.hash.replace(/^#/,'');
    const p = new URLSearchParams(h);
    if(p.get('filter')) state.verdict = p.get('filter');
    if(p.get('chain')) state.chain = p.get('chain');
    if(p.get('category')) state.category = p.get('category');
    if(p.get('q')) state.q = p.get('q');
    if(p.get('sort')) state.sort = p.get('sort');
    if(p.get('detail')) state.detail = p.get('detail');
  }
  function writeHash(){
    const p = new URLSearchParams();
    if(state.verdict && state.verdict!=='all') p.set('filter', state.verdict);
    if(state.chain) p.set('chain', state.chain);
    if(state.category) p.set('category', state.category);
    if(state.q) p.set('q', state.q);
    if(state.sort && state.sort!=='implied') p.set('sort', state.sort);
    if(state.detail) p.set('detail', state.detail);
    const s = p.toString();
    const nh = s ? '#'+s : '';
    if(location.hash !== nh) history.replaceState(null,'', nh || location.pathname+location.search);
  }

  function applyControlsFromState(){
    $('#search').value = state.q;
    $('#chain').value = state.chain;
    $('#category').value = state.category;
    $('#sort').value = state.sort;
    document.querySelectorAll('#verdict-chips .chip').forEach(b=>b.classList.toggle('active', b.dataset.v===state.verdict));
  }

  function filteredRows(){
    let rows = R.rows.slice();
    const q = state.q.trim().toLowerCase();
    if(q) rows = rows.filter(r=>r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q));
    if(state.chain) rows = rows.filter(r=>r.chains && r.chains.includes(state.chain));
    if(state.category) rows = rows.filter(r=>(r.category||'Unknown')===state.category);
    if(state.verdict!=='all') rows = rows.filter(r=>r.verdict===state.verdict);
    const cmp = {
      implied:(a,b)=>b.implied_value_usd-a.implied_value_usd || a.rank-b.rank,
      tvl:(a,b)=>b.tvl_usd-a.tvl_usd,
      growth:(a,b)=>((b.change_7d??-1e9)-(a.change_7d??-1e9)),
      age:(a,b)=>((b.age_days??-1)-(a.age_days??-1)),
      name:(a,b)=>a.name.localeCompare(b.name)
    }[state.sort] || ((a,b)=>a.rank-b.rank);
    rows.sort(cmp);
    return rows;
  }

  function renderTable(){
    const rows = filteredRows();
    const tbody = $('#board-body');
    tbody.innerHTML = rows.map(r=>{
      const chg = r.change_7d==null ? 'n/a' : `<span class="${r.change_7d>=0?'pos':'neg'}">${fmtNum(r.change_7d,2)}%</span>`;
      const age = r.age_days==null ? 'n/a' : r.age_days+'d';
      const chains = (r.chains||[]).slice(0,3).map(esc).join(', ')+(r.chains&&r.chains.length>3?'…':'');
      return `<tr data-slug="${esc(r.slug)}">
        <td class="num">${r.rank}</td>
        <td><div>${esc(r.name)}</div><div class="small">${esc(r.category||'Unknown')}</div></td>
        <td>${chains||'-'}</td>
        <td class="num">${fmtCompact(r.tvl_usd)}</td>
        <td class="num">${chg}</td>
        <td class="num">${age}</td>
        <td class="num">${fmtCompact(r.implied_value_usd)}</td>
        <td class="num">${fmtNum(r.ev_per_hour,2)}</td>
        <td class="v-${r.verdict}">${r.verdict}</td>
      </tr>`;
    }).join('');
    tbody.querySelectorAll('tr').forEach(tr=>tr.addEventListener('click',()=>openDetail(tr.dataset.slug)));
  }

  function openDetail(slug){
    const r = R.rows.find(x=>x.slug===slug);
    if(!r) return;
    state.detail = slug; writeHash();
    const chains = (r.chains||[]).map(c=>`<span class="pill">${esc(c)}</span>`).join('') || '-';
    const steps = r.farm_steps.map(s=>`<li>${esc(s)}</li>`).join('');
    $('#drawer-content').innerHTML = `
      <h2>${esc(r.name)}</h2>
      <p class="small">${esc(r.slug)} · ${esc(r.category||'Unknown')}</p>
      <div style="margin:8px 0">${chains}</div>
      <div class="kv">
        <div>Rank</div><div class="num">${r.rank}</div>
        <div>TVL</div><div class="num">${fmtUsd(r.tvl_usd)}</div>
        <div>7d change</div><div class="num">${r.change_7d==null?'n/a':fmtNum(r.change_7d,2)+'%'}</div>
        <div>Age (days)</div><div class="num">${r.age_days==null?'n/a':r.age_days}</div>
        <div>Base implied</div><div class="num">${fmtUsd(r.base_implied_usd)}</div>
        <div>Growth mult</div><div class="num">${fmtNum(r.growth_mult,4)}</div>
        <div>Age mult</div><div class="num">${fmtNum(r.age_mult,4)}</div>
        <div>Implied value</div><div class="num">${fmtUsd(r.implied_value_usd)}</div>
        <div>Expected airdrop (0.50%)</div><div class="num">${fmtUsd(r.expected_airdrop_usd)}</div>
        <div>Gas estimate</div><div class="num">${fmtUsd(r.gas_usd)}</div>
        <div>Capital drag</div><div class="num">${fmtUsd(r.capital_drag_usd)}</div>
        <div>Farm hours</div><div class="num">${fmtNum(r.farm_hours,2)}</div>
        <div>EV per active hour</div><div class="num">${fmtNum(r.ev_per_hour,2)}</div>
        <div>Verdict</div><div class="v-${r.verdict}">${r.verdict}</div>
      </div>
      <h3 style="margin-top:14px">Farm plan</h3>
      <ol class="steps">${steps}</ol>`;
    $('#drawer').classList.remove('hidden');
    $('#drawer').setAttribute('aria-hidden','false');
  }
  function closeDetail(){
    state.detail = null; writeHash();
    $('#drawer').classList.add('hidden');
    $('#drawer').setAttribute('aria-hidden','true');
  }

  function update(){ writeHash(); renderTable(); }

  $('#search').addEventListener('input', e=>{ state.q=e.target.value; update(); });
  $('#chain').addEventListener('change', e=>{ state.chain=e.target.value; update(); });
  $('#category').addEventListener('change', e=>{ state.category=e.target.value; update(); });
  $('#sort').addEventListener('change', e=>{ state.sort=e.target.value; update(); });
  document.querySelectorAll('#verdict-chips .chip').forEach(b=>b.addEventListener('click',()=>{
    state.verdict=b.dataset.v; applyControlsFromState(); update();
  }));
  $('#drawer-close').addEventListener('click', closeDetail);
  $('#drawer').addEventListener('click', e=>{ if(e.target.id==='drawer') closeDetail(); });
  window.addEventListener('hashchange', ()=>{ readHash(); applyControlsFromState(); renderTable(); if(state.detail) openDetail(state.detail); else closeDetail(); });

  renderStats(); renderModel(); renderChart(); initFilters(); readHash(); applyControlsFromState(); renderTable();
  if(state.detail) openDetail(state.detail);
})();
