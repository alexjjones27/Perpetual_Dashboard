/* Orchestration: discovery, tracked universe, polling schedules, warm-up, render loop. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const S = EPM.state;
  const UI = EPM.ui;
  const api = EPM.api;
  const cfg = EPM.config;
  const MIN = 60000;

  EPM.isWarm = (coin) => {
    const cd = S.candles.get(coin), fd = S.funding.get(coin);
    return !!(cd && cd.at > 0 && fd && fd.at > 0);
  };

  // ---------- discovery ----------
  async function discover() {
    let names = [cfg.primaryDex];
    try {
      const dexs = await api.perpDexs();
      names = dexs.filter(Boolean).map((d) => d.name);
    } catch (e) { /* fall back to the primary dex only */ }
    const active = [];
    await Promise.all(names.map(async (dex) => {
      try {
        const [meta, ctxs] = await api.metaAndAssetCtxs(dex, 0);
        const live = meta.universe.some((u, i) => !u.isDelisted && parseFloat(ctxs[i].dayNtlVlm) > 0);
        if (live || dex === cfg.primaryDex) {
          active.push(dex);
          S.ingestCtxs(dex, meta, ctxs, Date.now());
        }
      } catch (e) { /* skip unreachable dex this round */ }
    }));
    S.dexes = active.sort((a, b) => (a === cfg.primaryDex ? -1 : b === cfg.primaryDex ? 1 : a.localeCompare(b)));
  }

  async function pollDex(dex) {
    if (EPM.rest.pending('ctx:' + (dex || 'main'))) return;
    try {
      const [meta, ctxs] = await api.metaAndAssetCtxs(dex, 0);
      S.ingestCtxs(dex, meta, ctxs, Date.now());
    } catch (e) { /* surfaced through the REST status pill */ }
  }

  // ---------- tracked universe ----------
  function chooseTracked() {
    const N = S.settings.trackedN;
    const ranked = [...S.markets.values()].filter((m) => m.ctx).sort((a, b) => (b.ctx.dayNtl || 0) - (a.ctx.dayNtl || 0));
    const next = new Set(ranked.slice(0, N).map((m) => m.coin));
    for (const c of S.pinned) if (S.markets.has(c)) next.add(c);
    if (S.selected && S.markets.has(S.selected)) next.add(S.selected);
    for (const c of S.tracked) {
      if (!next.has(c)) {
        EPM.ws.unsubscribe({ type: 'trades', coin: c });
        EPM.ws.unsubscribe({ type: 'candle', coin: c, interval: '5m' });
        S.flow.delete(c);
      }
    }
    for (const c of next) {
      if (!S.tracked.has(c)) {
        S.flowFor(c);
        EPM.ws.subscribe({ type: 'trades', coin: c });
        EPM.ws.subscribe({ type: 'candle', coin: c, interval: '5m' });
      }
    }
    S.tracked = next;
  }

  // ---------- warm-up and background history ----------
  const byVolume = () => [...S.tracked].sort((a, b) => ((S.markets.get(b) || {}).ctx?.dayNtl || 0) - ((S.markets.get(a) || {}).ctx?.dayNtl || 0));

  async function loadCandles(coin, prio) {
    const now = Date.now();
    const cd = S.candles.get(coin);
    const start = cd && cd.t.length ? cd.t[cd.t.length - 1] - 5 * MIN : now - cfg.candleDays * 86400000;
    try {
      const rows = await api.candles(coin, '5m', start, now, prio);
      S.setCandles(coin, rows || []);
    } catch (e) { /* retried on the next pass */ }
  }
  async function loadFunding(coin, prio) {
    const now = Date.now();
    const fd = S.funding.get(coin);
    const start = fd && fd.t.length ? fd.t[fd.t.length - 1] + 1 : now - cfg.fundingDays * 86400000;
    try {
      const rows = await api.funding(coin, start, prio);
      S.setFunding(coin, rows || []);
    } catch (e) { /* retried on the next pass */ }
  }

  function warmTick() {
    const order = byVolume();
    if (S.selected && S.tracked.has(S.selected)) order.unshift(S.selected);
    let queued = EPM.rest.queue.filter((q) => q.prio >= 1 && q.prio <= 2).length;
    for (const coin of order) {
      if (queued >= 3) break;
      const prio = coin === S.selected ? 1 : 2;
      const cd = S.candles.get(coin), fd = S.funding.get(coin);
      if (!(cd && cd.at > 0) && !EPM.rest.pending('candles:' + coin)) { loadCandles(coin, prio); queued++; }
      if (!(fd && fd.at > 0) && !EPM.rest.pending('funding:' + coin)) { loadFunding(coin, prio); queued++; }
    }
  }

  // Funding settles hourly: top up each tracked market once per hour, a few minutes after.
  let fundIdx = 0;
  function fundingRefreshTick() {
    const list = byVolume();
    if (!list.length) return;
    for (let n = 0; n < list.length; n++) {
      const coin = list[(fundIdx++) % list.length];
      const fd = S.funding.get(coin);
      if (!fd || !(fd.at > 0)) continue;
      const lastT = fd.t.length ? fd.t[fd.t.length - 1] : 0;
      if (Date.now() - lastT > 65 * MIN && Date.now() - fd.at > 10 * MIN && !EPM.rest.pending('funding:' + coin)) {
        loadFunding(coin, 3);
        return;
      }
    }
  }

  // Candles: the WS keeps bars live; REST fills gaps (WS down, or a market's stream went quiet).
  let candIdx = 0;
  function candleRefreshTick() {
    const list = byVolume();
    if (!list.length) return;
    const wsOk = EPM.ws.healthy();
    for (let n = 0; n < list.length; n++) {
      const coin = list[(candIdx++) % list.length];
      const cd = S.candles.get(coin);
      if (!cd || !(cd.at > 0)) continue;
      const stale = Date.now() - Math.max(cd.at, cd.liveAt || 0) > (wsOk ? 10 * MIN : 90000);
      if (stale && !EPM.rest.pending('candles:' + coin)) { loadCandles(coin, 3); return; }
    }
  }

  // Trades fallback while the WS is down. recentTrades returns only the latest few prints,
  // so flow is undercounted in this mode (the WS pill says so).
  let trIdx = 0;
  async function tradesFallbackTick() {
    if (EPM.ws.healthy()) return;
    const list = byVolume().slice(0, 12);
    if (!list.length) return;
    const coin = list[(trIdx++) % list.length];
    if (EPM.rest.pending('trades:' + coin)) return;
    try { S.ingestTrades(await api.recentTrades(coin, 3), 'rest'); } catch (e) { /* ignore */ }
  }

  // Order books: one request per tick, rotating; the selected market more often.
  let bookIdx = 0, bookTick = 0;
  async function bookTickFn() {
    const list = byVolume();
    if (!list.length) return;
    bookTick++;
    const coin = S.selected && bookTick % 3 === 0 ? S.selected : list[(bookIdx++) % list.length];
    if (EPM.rest.pending('book:' + coin)) return;
    // Do not pile up book requests while history loads; they are cheap but not urgent.
    if (coin !== S.selected && EPM.rest.queue.filter((q) => q.prio === 3).length > 6) return;
    try { S.setBook(coin, await api.l2Book(coin, coin === S.selected ? 1 : 3)); } catch (e) { /* ignore */ }
  }

  // ---------- render loop ----------
  function pick(coin) {
    if (!S.markets.has(coin)) return;
    S.selected = coin;
    if (!S.tracked.has(coin)) { S.pinned.add(coin); chooseTracked(); }
    EPM.metrics.computeAll(Date.now());
    UI.table(null, pick);
    UI.scatter(pick, true);
    UI.detail(true);
  }

  function frame() {
    const now = Date.now();
    S.trimFlow();
    EPM.metrics.computeAll(now);
    const fired = new Set(EPM.metrics.checkAlerts(now));
    const c = S.cross;
    S.pushKpi('oi', c.oiNtl, now);
    S.pushKpi('fund', c.fundAprOiW, now);
    S.pushKpi('breadth', c.breadth, now);
    S.pushKpi('netImb', c.netImb, now);
    S.pushKpi('basis', c.medBasis, now);
    if (!S.selected || !S.metrics.has(S.selected)) {
      const best = [...S.metrics.values()].filter((o) => o.tracked).sort((a, b) => (b.absScore || 0) - (a.absScore || 0) || (b.vol24 || 0) - (a.vol24 || 0))[0];
      if (best) S.selected = best.coin;
    }
    UI.header();
    UI.kpis();
    UI.table(fired, pick);
    UI.alerts(pick);
    UI.detail(false);
  }

  function applySettings() {
    chooseTracked();
    UI.filters(redraw);
    UI.head(redraw);
    redraw();
  }
  function redraw() {
    EPM.metrics.computeAll(Date.now());
    UI.head(redraw);
    UI.table(null, pick);
    UI.scatter(pick, true);
    UI.detail(true);
    UI.kpis();
  }
  UI.redrawAll = redraw;

  // ---------- boot ----------
  async function boot() {
    S.loadSettings();
    S.load();
    EPM.metrics.seedCooldowns();
    UI.theme();
    UI.settings(applySettings);
    UI.head(redraw);
    UI.header();

    EPM.ws.on('trades', (d) => S.ingestTrades(d, 'ws'));
    EPM.ws.on('candle', (d) => S.ingestCandle(d));
    EPM.ws.connect();

    await discover();
    pollDex(''); // main dex: crypto controls
    chooseTracked();
    UI.filters(redraw);
    frame();
    UI.scatter(pick, true);

    setInterval(() => pollDex(cfg.primaryDex), cfg.primaryPollMs);
    setInterval(() => {
      for (const d of S.dexes) if (d !== cfg.primaryDex) pollDex(d);
      pollDex('');
    }, cfg.secondaryPollMs);
    setInterval(discover, 30 * MIN);
    setInterval(chooseTracked, 15 * MIN);
    setInterval(warmTick, 1000);
    setInterval(fundingRefreshTick, 20000);
    setInterval(candleRefreshTick, 6000);
    setInterval(tradesFallbackTick, 4000);
    setInterval(bookTickFn, cfg.bookCycleMs);
    setInterval(frame, 2000);
    setInterval(() => UI.scatter(pick, false), 5000);
    setInterval(S.save, MIN);
    window.addEventListener('pagehide', S.save);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') S.save(); });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(redraw, 200); });
  }

  boot();
})();
