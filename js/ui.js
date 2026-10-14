/* Rendering: header, KPI strip, filters, scorecard, positioning map, detail panel, alerts, settings. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const S = EPM.state;
  const C = EPM.charts;
  const f = EPM.fmt;
  const esc = EPM.esc;
  const isNum = EPM.isNum;
  const $ = (id) => document.getElementById(id);
  const UI = (EPM.ui = {});

  // Charts are not redrawn under the pointer, so a hovered tooltip stays put.
  let hoverCount = 0;
  document.addEventListener('pointerover', (e) => { if (e.target.closest && e.target.closest('.chart')) hoverCount = 1; });
  document.addEventListener('pointerout', (e) => {
    if (e.target.closest && e.target.closest('.chart') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.chart'))) hoverCount = 0;
  });
  const hovering = () => hoverCount > 0;

  const dirCls = (x, eps) => (!isNum(x) || Math.abs(x) <= (eps || 0) ? '' : x > 0 ? 'dir-up' : 'dir-dn');
  const zCls = (z, thr) => (isNum(z) && Math.abs(z) >= (thr || 2) ? 'zhi' : '');
  const na = (s) => (s === '—' ? '<span class="na">—</span>' : s);

  // ---------- header ----------
  UI.header = function () {
    const now = Date.now();
    const si = EPM.sessionInfo(now);
    $('session').innerHTML =
      `<span>US cash</span><span class="badge">${esc(si.name)}</span><span>${esc(si.next)}</span>` +
      (si.opex ? '<span class="pill warn" title="Third-Friday monthly options expiry">OPEX</span>' : '');
    $('clock').textContent = si.etClock + ' · ' + f.timeSec(now);

    const ws = $('wsStatus');
    const tracked = S.tracked.size;
    if (EPM.ws.healthy()) { ws.className = 'pill ok'; ws.textContent = `WS: live · ${tracked} markets`; }
    else if (EPM.ws.state === 'connecting') { ws.className = 'pill warn'; ws.textContent = 'WS: connecting'; }
    else { ws.className = 'pill bad'; ws.textContent = 'WS: down · REST fallback'; }

    const rs = $('restStatus');
    const last = S.lastCtxAt[EPM.config.primaryDex] || 0;
    const age = (now - last) / 1000;
    rs.className = 'pill ' + (!last ? '' : age < 30 ? 'ok' : age < 90 ? 'warn' : 'bad');
    rs.textContent = last ? `REST: ${f.ago(last)} · ${EPM.rest.used()}/${EPM.rest.budget} wt/min` : 'REST: waiting';
    if (EPM.rest.lastErr && now - EPM.rest.lastErr.t < 30000) rs.title = 'Last error: ' + EPM.rest.lastErr.msg;

    const ws2 = $('warmStatus');
    const tr = [...S.tracked];
    const ready = tr.filter(EPM.isWarm).length;
    ws2.className = 'pill ' + (ready >= tr.length && tr.length ? 'ok' : 'warn');
    ws2.textContent = ready >= tr.length && tr.length ? `History ${ready}/${tr.length}` : `Warm-up ${ready}/${tr.length}`;
    ws2.title = 'Markets with candle and funding history loaded. OI and price windows build from live snapshots; flow builds from the trade stream.';
    $('venueLabel').textContent = 'Hyperliquid HIP-3 · ' + (S.dexes.join(', ') || '…');
  };

  // ---------- KPI strip ----------
  function series(key) { return (S.kpiHist[key] || []).slice(-120).map((p) => p[1]); }
  UI.kpis = function () {
    const c = S.cross;
    const W = S.settings.windowMin + 'm';
    const n = S.metrics.size;
    const tiles = [
      { label: '24h notional volume', value: f.usd(c.vol24), foot: `${n} markets · ${S.dexes.length} venues` },
      { label: 'Open interest', value: f.usd(c.oiNtl), foot: `1h ${f.pct(c.dOI1h)}`, spark: 'oi' },
      { label: 'OI-weighted funding', value: f.pct(c.fundAprOiW, 2), foot: 'APR, all markets', spark: 'fund' },
      { label: 'Abnormal-volume breadth', value: isNum(c.breadth) ? c.breadth.toFixed(0) + '%' : '—', foot: `z≥2 of ${c.breadthN || 0} · med z ${f.num(c.medAbn, 2)}`, spark: 'breadth' },
      { label: `Net taker flow (${W})`, value: isNum(c.netImb) ? f.pct(c.netImb * 100, 1) : '—', foot: `net ${f.usd(c.netFlow)}`, spark: 'netImb' },
      { label: 'Median basis vs oracle', value: isNum(c.medBasis) ? f.bps(c.medBasis) + ' bps' : '—', foot: 'tracked markets', spark: 'basis' },
      { label: `${c.idxName || 'Index'} perp 24h`, value: f.pct(c.idxChg), foot: 'equity index perp' },
      { label: 'BTC 24h (crypto control)', value: f.pct(c.ctlBTC), foot: `ETH ${f.pct(c.ctlETH)}` },
    ];
    $('kpis').innerHTML = tiles.map((t) => {
      const sp = t.spark ? C.sparkline(series(t.spark), 64, 16) : '';
      return `<div class="kpi"><div class="label" title="${esc(t.label)}">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="foot"><span>${esc(t.foot)}</span>${sp}</div></div>`;
    }).join('');
  };

  // ---------- filters ----------
  UI.filters = function (onChange) {
    const set = S.settings;
    const winSeg = $('windowSeg');
    winSeg.innerHTML = [5, 15, 60].map((w) => `<button type="button" role="radio" data-w="${w}" aria-checked="${set.windowMin === w}">${w === 60 ? '1h' : w + 'm'}</button>`).join('');
    winSeg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      set.windowMin = +b.dataset.w; S.saveSettings(); UI.filters(onChange); onChange();
    };
    const present = new Set([...S.markets.values()].map((m) => m.cls));
    const classes = EPM.classOrder.filter((c) => c === 'All' || present.has(c));
    const clsSeg = $('classSeg');
    clsSeg.innerHTML = classes.map((c) => `<button type="button" role="radio" data-c="${esc(c)}" aria-checked="${set.classFilter === c}">${esc(c)}</button>`).join('');
    clsSeg.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      set.classFilter = b.dataset.c; S.saveSettings(); UI.filters(onChange); onChange();
    };
    const all = $('showAll');
    all.checked = !!set.showAll;
    all.onchange = () => { set.showAll = all.checked; S.saveSettings(); onChange(); };
    $('search').oninput = onChange;
    $('filterHint').textContent = `Window ${set.windowMin === 60 ? '1h' : set.windowMin + 'm'} drives price, OI and flow changes; deep metrics on the top ${set.trackedN} markets by 24h volume.`;
  };

  // ---------- scorecard ----------
  const COLS = [
    { key: 'ticker', label: 'Market', grp: '', cell: (o) => `<span class="tkr">${esc(o.ticker)}<span class="dex">${esc(o.dex)}</span></span>` },
    { key: 'mark', label: 'Last', grp: 'perp', cell: (o) => f.px(o.mark) },
    { key: 'chg24', label: '24h', grp: '%', cell: (o) => `<span class="${dirCls(o.chg24)}">${na(f.pct(o.chg24))}</span>` },
    { key: 'dPx', label: 'ΔPx', grp: 'W', cell: (o) => `<span class="${dirCls(o.dPx)}">${na(f.pct(o.dPx))}</span>` },
    { key: 'vol24', label: 'Vol 24h', grp: 'notional', cell: (o) => f.usd(o.vol24) },
    { key: 'abnVol15', label: 'AbnVol', grp: 'z, 15m', cell: (o) => `<span class="${zCls(o.abnVol15)}">${na(f.num(o.abnVol15, 1))}</span>` },
    { key: 'imb', label: 'Taker flow', grp: 'imbalance, W', cell: (o) => `<span class="flowbar">${C.imbBar(o.imb, 40)}<span>${na(isNum(o.imb) ? f.pct(o.imb * 100, 0) : '—')}</span></span>` },
    { key: 'flowZ', label: 'Flow', grp: 'z, W', cell: (o) => `<span class="${zCls(o.flowZ, 2.5)}">${na(f.num(o.flowZ, 1))}</span>` },
    { key: 'dOI', label: 'ΔOI', grp: 'W', cell: (o) => `<span class="${dirCls(o.dOI)}">${na(f.pct(o.dOI))}</span>` },
    { key: 'regime', label: 'Regime', grp: 'px × OI', sortVal: (o) => (o.regime ? o.regime.dir * 10 + (o.regime.k === 'NL' || o.regime.k === 'NS' ? 1 : 0) : NaN), cell: (o) => regimeChip(o.regime, true) },
    { key: 'fundApr', label: 'Funding', grp: 'APR', cell: (o) => na(f.pct(o.fundApr, 1)) },
    { key: 'fundPctl', label: 'Pctl', grp: '20d', cell: (o) => na(isNum(o.fundPctl) ? o.fundPctl.toFixed(0) : '—') },
    { key: 'fundZ', label: 'Fund', grp: 'surprise z', cell: (o) => `<span class="${zCls(o.fundZ)}">${na(f.num(o.fundZ, 1))}</span>` },
    { key: 'basisBps', label: 'Basis', grp: 'bps', cell: (o) => `<span class="${zCls(o.basisZ, 3)}">${na(f.bps(o.basisBps))}</span>` },
    { key: 'illiqBps', label: 'Impact', grp: 'spread bps', cell: (o) => na(f.plain(o.illiqBps, 1)) },
    { key: 'score', label: 'Score', grp: 'composite · Q', sortVal: (o) => o.score, cell: (o) => isNum(o.score) ? `<span class="scorecell">${C.scoreBar(o.score, 36)}<span class="${Math.abs(o.score) >= 3 ? 'zhi' : ''}">${f.num(o.score, 2)}</span><span class="na">Q${o.quintile}</span></span>` : '<span class="na">—</span>' },
  ];
  function regimeChip(r, short) {
    if (!r) return '<span class="na">—</span>';
    if (r.k === 'FL') return '<span class="chip">Flat</span>';
    const cls = r.dir > 0 ? 'up' : 'dn';
    const label = short ? { NL: 'New longs', SC: 'Short cover', NS: 'New shorts', LL: 'Long liq.' }[r.k] : r.label;
    return `<span class="chip ${cls}" title="${esc(r.label)}"><i>${r.dir > 0 ? '▲' : '▼'}</i>${esc(label)}</span>`;
  }

  UI.head = function (onSort) {
    const set = S.settings;
    $('gridHead').innerHTML = '<tr>' + COLS.map((c) => {
      const sorted = set.sortKey === c.key || (c.key === 'score' && set.sortKey === 'absScore');
      const aria = sorted ? (set.sortDir < 0 ? 'descending' : 'ascending') : 'none';
      const lbl = c.key === 'score' && set.sortKey === 'absScore' ? 'Score |·|' : c.label;
      return `<th data-k="${c.key}" aria-sort="${aria}" scope="col">${esc(lbl)}<span class="grp">${esc(c.grp === 'W' ? set.windowMin + 'm' : c.grp.replace(', W', ', ' + set.windowMin + 'm'))}</span></th>`;
    }).join('') + '</tr>';
    $('gridHead').onclick = (e) => {
      const th = e.target.closest('th'); if (!th) return;
      const k = th.dataset.k;
      // Score cycles |score| desc -> score desc -> score asc.
      if (k === 'score') {
        if (set.sortKey === 'absScore') { set.sortKey = 'score'; set.sortDir = -1; }
        else if (set.sortKey === 'score' && set.sortDir < 0) set.sortDir = 1;
        else { set.sortKey = 'absScore'; set.sortDir = -1; }
      } else if (set.sortKey === k) set.sortDir *= -1;
      else { set.sortKey = k; set.sortDir = k === 'ticker' ? 1 : -1; }
      S.saveSettings(); onSort();
    };
  };

  UI.visibleRows = function () {
    const set = S.settings;
    const q = ($('search').value || '').trim().toUpperCase();
    let rows = [...S.metrics.values()];
    if (!set.showAll) rows = rows.filter((o) => o.tracked);
    if (set.classFilter !== 'All') rows = rows.filter((o) => o.cls === set.classFilter);
    if (q) rows = rows.filter((o) => o.ticker.includes(q) || o.coin.toUpperCase().includes(q));
    const col = COLS.find((c) => c.key === set.sortKey);
    const val = set.sortKey === 'absScore' ? (o) => o.absScore : col && col.sortVal ? col.sortVal : (o) => o[set.sortKey];
    rows.sort((a, b) => {
      if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
      const va = val(a), vb = val(b);
      if (set.sortKey === 'ticker') return set.sortDir * String(va).localeCompare(String(vb));
      const na1 = !isNum(va), nb1 = !isNum(vb);
      if (na1 || nb1) return na1 && nb1 ? (b.vol24 || 0) - (a.vol24 || 0) : na1 ? 1 : -1;
      return set.sortDir * (va - vb);
    });
    return rows;
  };

  UI.table = function (flashSet, onPick) {
    const rows = UI.visibleRows();
    const sel = S.selected;
    $('gridBody').innerHTML = rows.map((o) => {
      const cls = [o.tracked ? '' : 'untracked', o.coin === sel ? 'selected' : '', flashSet && flashSet.has(o.coin) ? 'flash' : ''].join(' ').trim();
      return `<tr data-c="${esc(o.coin)}" class="${cls}" tabindex="0">` + COLS.map((c) => `<td>${c.cell(o)}</td>`).join('') + '</tr>';
    }).join('') || `<tr><td colspan="${COLS.length}" class="na">No markets match the filters.</td></tr>`;
    const tracked = rows.filter((o) => o.tracked).length;
    $('tableSub').textContent = `${rows.length} shown · ${tracked} tracked · sorted by ${S.settings.sortKey === 'absScore' ? '|score|' : S.settings.sortKey}. Untracked rows show snapshot metrics only.`;
    const body = $('gridBody');
    body.onclick = (e) => { const tr = e.target.closest('tr[data-c]'); if (tr) onPick(tr.dataset.c); };
    body.onkeydown = (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-c]'); if (tr) onPick(tr.dataset.c); } };
  };

  // ---------- positioning map ----------
  function snapSpanMin() {
    let span = 0;
    const now = Date.now();
    for (const c of S.tracked) {
      const mn = S.minute.get(c), fine = S.fine.get(c);
      const t0 = Math.min(mn && mn.length ? mn[0][0] : now, fine && fine.length ? fine[0][0] : now);
      span = Math.max(span, (now - t0) / 60000);
    }
    return span;
  }
  UI.scatter = function (onPick, force) {
    if (hovering() && !force) return;
    const W = S.settings.windowMin;
    const pts = [...S.metrics.values()]
      .filter((o) => o.tracked && isNum(o.dPx) && isNum(o.dOI))
      .filter((o) => S.settings.classFilter === 'All' || o.cls === S.settings.classFilter)
      .map((o) => ({ coin: o.coin, label: o.ticker, x: o.dPx, y: o.dOI, size: o.oiNtl, score: o.score, regime: o.regime && o.regime.label }));
    $('scatterSub').textContent = `ΔPrice (x) vs ΔOI (y) over ${W}m · size = OI notional · color = composite score (blue +, red −)`;
    C.scatter($('scatter'), pts, {
      selected: S.selected, window: W + 'm', onPick,
      empty: `Building ${W}m OI history from live snapshots: ready in about ${f.dur(Math.max(1, W - snapSpanMin()))}. Switch to 5m for a faster read.`,
    });
  };

  // ---------- detail panel ----------
  const PART_LABELS = { flow: 'Signed flow', oi: 'ΔOI × sign(r)', funding: 'Funding surprise', basis: 'Basis (premium z)', illiq: 'Illiquidity' };
  let lastDetailCharts = 0, lastDetailCoin = null;

  UI.detail = function (force) {
    const el = $('detail');
    const coin = S.selected;
    const o = coin && S.metrics.get(coin);
    if (!o) { el.innerHTML = '<p class="note">Select a market in the scorecard or the map.</p>'; return; }
    const now = Date.now();
    const W = S.settings.windowMin;
    const m = S.markets.get(coin);
    const stat = (k, v, title) => `<div title="${esc(title || k)}"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
    const redrawCharts = force || coin !== lastDetailCoin || (now - lastDetailCharts > 10000 && !hovering());

    const head = `<div class="d-head"><span class="big">${esc(o.ticker)}</span>
      <span class="meta">${esc(o.dex)} · ${esc(o.cls)} · up to ${m.maxLev}x${m.isolated ? ' · isolated only' : ''}${o.tracked ? '' : ' · untracked (snapshot metrics only)'}</span>
      ${regimeChip(o.regime)}</div>
      <div class="d-head"><span class="big">${f.px(o.mark)}</span><span class="${dirCls(o.chg24)}">${f.pct(o.chg24)} 24h</span>
      <span class="meta">oracle ${f.px(o.oracle)} · basis ${f.bps(o.basisBps)} bps · perp − oracle ${W}m ${f.bps(o.relRetBps)} bps</span></div>`;

    const stats = `<div class="d-stats">
      ${stat('OI notional', f.usd(o.oiNtl))}
      ${stat('ΔOI ' + W + 'm / 1h', `${f.pct(o.dOI)} / ${f.pct(o.dOI1h)}`)}
      ${stat('Turnover 24h', isNum(o.turnover) ? o.turnover.toFixed(2) + '× OI' : '—', '24h notional volume / OI notional')}
      ${stat('Funding APR', `${f.pct(o.fundApr, 1)}`, 'Current hourly funding × 8760')}
      ${stat('Funding 20d median', f.pct(o.fundMedApr, 1))}
      ${stat('ΔFunding 1h / 8h / 24h', `${f.num(o.fundD1, 1)} / ${f.num(o.fundD8, 1)} / ${f.num(o.fundD24, 1)}`, 'Change in APR points vs settled funding')}
      ${stat('Funding pctl / z', `${isNum(o.fundPctl) ? o.fundPctl.toFixed(0) : '—'} / ${f.num(o.fundZ, 1)}`)}
      ${stat('Premium z', f.num(o.basisZ, 1), 'Current premium vs 20d hourly premium history (robust z)')}
      ${stat('Taker buy / sell ' + W + 'm', `${f.usd(o.buy)} / ${f.usd(o.sell)}`)}
      ${stat('Net flow vs typical', isNum(o.netFlowRel) ? f.pct(o.netFlowRel * 100, 0) : '—', 'Net taker notional / median volume for the same window')}
      ${stat('Flow z / trades', `${f.num(o.flowZ, 1)} / ${o.trades ?? '—'}`, 'Signed notional / sqrt(sum of squared trade notionals)')}
      ${stat('AbnVol 5m / idio', `${f.num(o.abnVol5, 1)} / ${f.num(o.idioAbn, 1)}`, 'Idiosyncratic = 15m z minus cross-sectional median z')}
      ${stat('Spread / impact', `${f.plain(o.spreadBps, 1)} / ${f.plain(o.impactBps, 1)} bps`)}
      ${stat('Depth ±10 / ±50 bps', `${f.usd(o.depth10)} / ${f.usd(o.depth50)}`)}
      ${stat('Book imbalance ±50bps', isNum(o.imb50) ? f.pct(o.imb50 * 100, 0) : '—')}
      ${stat('Amihud / RV 1h', `${f.plain(o.amihud, 2)} / ${f.plain(o.rv1hBps, 0)} bps`, 'Amihud: mean |5m return| bps per $1M traded, last 24h')}
    </div>`;

    if (!redrawCharts && el.querySelector('#d-charts')) {
      el.querySelector('#d-top').innerHTML = head + stats;
      return;
    }
    lastDetailCharts = now; lastDetailCoin = coin;
    el.innerHTML = `<div id="d-top">${head}${stats}</div>
      <div id="d-charts">
        <div class="panel"><h3>Score breakdown <span>${isNum(o.score) ? `${f.num(o.score, 2)} · Q${o.quintile} · ${o.agree}/4 agree` : 'needs ≥2 components'}</span></h3><div class="chart" id="c-parts"></div></div>
        <div class="panel"><h3>5m notional vs expected <span>conditional on time of day + volatility</span></h3><div class="chart" id="c-vol"></div>
          <div class="legend"><span class="key box" style="--kc: var(--mid)">5m notional</span><span class="key box" style="--kc: var(--accent)">abnormal (z ≥ 2)</span><span class="key" style="--kc: var(--ink-2)">expected</span></div></div>
        <div class="panel"><h3>Cumulative taker flow <span>CVD since tracking, $</span></h3><div class="chart" id="c-cvd"></div></div>
        <div class="panel"><h3>Basis vs oracle <span>bps, minute snapshots</span></h3><div class="chart" id="c-basis"></div></div>
        <div class="panel"><h3>Funding history <span>APR %, hourly, band = 5th–95th pctl</span></h3><div class="chart" id="c-fund"></div></div>
        <div class="panel"><h3>Lead-lag: perp vs oracle <span id="ll-sum"></span></h3><div class="chart" id="c-ll"></div></div>
        <div class="panel" id="p-venues"></div>
      </div>`;

    if (o.tracked && o.parts) C.parts($('c-parts'), o.parts, PART_LABELS);
    else $('c-parts').innerHTML = '<div class="empty-chart">Untracked market: pin it by selecting it, history loads in the background.</div>';

    const vs = o.tracked ? EPM.metrics.volSeries(coin, 144, now) : null;
    C.volBars($('c-vol'), { bars: vs, height: 110, yFmt: (v) => f.usd(v, 0) });

    const fl = S.flow.get(coin);
    if (fl && fl.b.size) {
      const keys = [...fl.b.keys()].sort((a, b) => a - b);
      let cum = 0;
      const pts = [];
      for (const k of keys) { const v = fl.b.get(k); cum += v[0] - v[1]; pts.push([k + 60000, cum]); }
      if (pts.length) pts.unshift([keys[0], 0]);
      C.line($('c-cvd'), { height: 100, series: [{ name: 'CVD', color: 'var(--accent)', pts }], yFmt: (v) => f.usd(v), zero: true, label: 'Cumulative volume delta' });
    } else $('c-cvd').innerHTML = '<div class="empty-chart">Waiting for trades on the stream…</div>';

    const mn = S.minute.get(coin) || [];
    const bpts = mn.filter((r) => r[1] > 0 && r[2] > 0).map((r) => [r[0], ((r[1] - r[2]) / r[2]) * 1e4]);
    C.line($('c-basis'), {
      height: 100, series: [{ name: 'basis', color: 'var(--accent)', pts: bpts }], yFmt: (v) => f.bps(v, 1), zero: true, gapMs: 5 * 60000,
      refs: isNum(o.premMedBps) ? [{ v: o.premMedBps, label: '20d median premium' }] : [], label: 'Basis versus oracle',
      empty: 'Collecting minute snapshots…',
    });

    const fd = S.funding.get(coin);
    if (fd && fd.f.length > 2) {
      const apr = fd.f.map((x) => x * 876000);
      const pts = fd.t.map((t, i) => [t, apr[i]]);
      pts.push([now, o.fundApr]);
      C.line($('c-fund'), {
        height: 100, series: [{ name: 'funding APR', color: 'var(--accent)', pts }], yFmt: (v) => f.plain(v, 1) + '%', zero: true,
        band: { lo: EPM.stats.quantile(apr, 0.05), hi: EPM.stats.quantile(apr, 0.95) }, label: 'Funding history',
      });
    } else $('c-fund').innerHTML = `<div class="empty-chart">${o.tracked ? 'Loading funding history…' : 'Funding history loads for tracked markets.'}</div>`;

    const ll = EPM.metrics.leadLag(coin, now);
    C.lagBars($('c-ll'), ll, 100);
    if (ll) {
      const unit = ll.step >= 60000 ? 'm' : '0s';
      const b = ll.best;
      $('ll-sum').textContent = `peak ρ ${f.plain(b.rho, 2)} at ${b.k > 0 ? 'perp leads ' + b.k + unit : b.k < 0 ? 'oracle leads ' + -b.k + unit : 'lag 0'} · lead share ${isNum(ll.leadShare) ? (ll.leadShare * 100).toFixed(0) + '%' : '—'} · n=${ll.n}`;
    } else $('ll-sum').textContent = EPM.sessionOf(now) === 0 ? '' : 'oracle is the venue price outside US hours';

    // Same ticker on other venues: OI-weighted funding across venues.
    const peers = [...S.metrics.values()].filter((p) => p.ticker === o.ticker);
    if (peers.length > 1) {
      let w = 0, s = 0;
      for (const p of peers) if (p.oiNtl > 0 && isNum(p.fundApr)) { w += p.oiNtl; s += p.oiNtl * p.fundApr; }
      $('p-venues').innerHTML = `<h3>Cross-venue <span>OI-weighted funding ${f.pct(w ? s / w : NaN, 1)} APR</span></h3>
        <table class="venues"><thead><tr><th>Venue</th><th>Mark</th><th>Basis bps</th><th>Funding APR</th><th>OI</th><th>Vol 24h</th></tr></thead><tbody>
        ${peers.sort((a, b) => (b.oiNtl || 0) - (a.oiNtl || 0)).map((p) => `<tr><td>${esc(p.dex)}</td><td>${f.px(p.mark)}</td><td>${f.bps(p.basisBps)}</td><td>${f.pct(p.fundApr, 1)}</td><td>${f.usd(p.oiNtl)}</td><td>${f.usd(p.vol24)}</td></tr>`).join('')}
        </tbody></table>`;
    }
  };

  // ---------- alerts ----------
  UI.alerts = function (onPick) {
    const el = $('alerts');
    if (!S.alerts.length) {
      el.innerHTML = '<li class="empty">No triggers yet. Alerts fire on flow + OI + funding confluence, abnormal volume, funding extremes, basis dislocations, large OI shifts and market-wide volume shocks.</li>';
      return;
    }
    const sevLabel = { critical: 'Confluence', serious: 'Notable', warning: 'Stretch', info: 'Volume only' };
    el.innerHTML = S.alerts.slice(0, 80).map((a) =>
      `<li data-c="${esc(a.coin || '')}"><time>${esc(f.time(a.t))}</time><span class="sev ${esc(a.sev)}">${esc(sevLabel[a.sev] || a.sev)}</span><span class="msg" title="${esc(a.msg)}">${esc(a.msg)}</span></li>`).join('');
    el.onclick = (e) => { const li = e.target.closest('li[data-c]'); if (li && li.dataset.c) onPick(li.dataset.c); };
  };

  // ---------- settings drawer ----------
  UI.settings = function (onApply) {
    const set = S.settings;
    const btn = $('settingsBtn'), pane = $('settings');
    const open = (v) => { pane.hidden = !v; btn.setAttribute('aria-expanded', String(v)); };
    btn.onclick = () => open(pane.hidden);
    $('settingsClose').onclick = () => open(false);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
    const wIn = (k, label) => `<label>${esc(label)}<input type="number" step="0.25" min="0" max="5" name="w_${k}" value="${set.weights[k]}"></label>`;
    $('settingsForm').innerHTML = `
      <fieldset><legend>Universe</legend>
        <label>Tracked markets (top N by 24h volume)<input type="number" name="trackedN" min="5" max="80" step="5" value="${set.trackedN}"></label>
      </fieldset>
      <fieldset><legend>Composite score weights</legend>
        ${wIn('flow', 'w1 · signed taker flow')}${wIn('oi', 'w2 · ΔOI × sign(return)')}${wIn('funding', 'w3 · funding surprise')}${wIn('basis', 'w4 · basis')}${wIn('illiq', 'w5 · illiquidity')}
        <label>Illiquidity term<select name="illiqMode"><option value="shrink">shrink toward 0 (default)</option><option value="spec">subtract w5·Z (literal spec)</option></select></label>
      </fieldset>
      <fieldset><legend>Data</legend>
        <label>Clear stored history<button class="btn small" type="button" id="clearHist">Clear</button></label>
      </fieldset>
      <button class="btn" type="submit">Apply</button>`;
    $('settingsForm').illiqMode.value = set.illiqMode;
    $('settingsForm').onsubmit = (e) => {
      e.preventDefault();
      const fm = e.target;
      set.trackedN = Math.max(5, Math.min(80, parseInt(fm.trackedN.value, 10) || EPM.defaults.trackedN));
      for (const k of Object.keys(set.weights)) {
        const v = parseFloat(fm['w_' + k].value);
        set.weights[k] = isNum(v) ? Math.max(0, Math.min(5, v)) : 1;
      }
      set.illiqMode = fm.illiqMode.value === 'shrink' ? 'shrink' : 'spec';
      S.saveSettings();
      onApply();
      open(false);
    };
    $('clearHist').onclick = () => {
      S.clearHistory();
      location.reload();
    };
  };

  // ---------- theme ----------
  UI.theme = function () {
    const set = S.settings;
    const apply = () => {
      if (set.theme) document.documentElement.setAttribute('data-theme', set.theme);
      else document.documentElement.removeAttribute('data-theme');
    };
    apply();
    $('themeBtn').onclick = () => {
      const dark = set.theme ? set.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      set.theme = dark ? 'light' : 'dark';
      S.saveSettings(); apply();
      UI.redrawAll && UI.redrawAll();
    };
  };
})();
