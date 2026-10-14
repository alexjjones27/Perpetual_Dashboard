/* In-memory model of the market plus rolling histories, with compact localStorage persistence. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const cfg = EPM.config;
  const BAR = 5 * 60000;
  const MIN = 60000;

  const S = (EPM.state = {
    dexes: [],                 // active HIP-3 dex names
    markets: new Map(),        // coin -> market (incl. latest ctx)
    controls: new Map(),       // main-dex control markets (BTC, ETH)
    fine: new Map(),           // coin -> [[t, mark, oracle, oi, funding, mid]] ~10s
    minute: new Map(),         // coin -> [[t, mark, oracle, oi, funding, mid]] 1/min
    candles: new Map(),        // coin -> {t:[], c:[], v:[]} 5m bars, v = notional USD
    funding: new Map(),        // coin -> {t:[], f:[], p:[], at}
    flow: new Map(),           // coin -> {start, b: Map(minTs -> [buy, sell, sumSq, n]), tids: Set}
    book: new Map(),           // coin -> book stats
    tracked: new Set(),
    pinned: new Set(),
    metrics: new Map(),        // coin -> computed metrics
    cross: {},                 // cross-sectional aggregates
    kpiHist: {},               // key -> [[t, v]] per minute
    alerts: [],
    selected: null,
    settings: null,
    startedAt: Date.now(),
    lastCtxAt: {},
  });

  // ---------- settings ----------
  S.loadSettings = function () {
    const saved = EPM.store.get('settings', {});
    S.settings = Object.assign({}, EPM.defaults, saved);
    S.settings.weights = Object.assign({}, EPM.defaults.weights, saved.weights || {});
  };
  S.saveSettings = () => EPM.store.set('settings', S.settings);

  // ---------- market snapshots ----------
  const f = (x) => (x === null || x === undefined ? NaN : parseFloat(x));

  S.ingestCtxs = function (dex, meta, ctxs, t) {
    const uni = meta.universe || [];
    for (let i = 0; i < uni.length; i++) {
      const u = uni[i], c = ctxs[i];
      if (!u || !c) continue;
      const coin = u.name;
      const ctx = {
        mark: f(c.markPx), oracle: f(c.oraclePx), mid: f(c.midPx), funding: f(c.funding),
        premium: f(c.premium), oi: f(c.openInterest), dayNtl: f(c.dayNtlVlm), prevDay: f(c.prevDayPx),
        impBid: c.impactPxs ? f(c.impactPxs[0]) : NaN, impAsk: c.impactPxs ? f(c.impactPxs[1]) : NaN,
      };
      if (!dex) {
        if (cfg.controls.includes(coin)) S.controls.set(coin, { coin, ctx, t });
        continue;
      }
      if (u.isDelisted || !(ctx.mark > 0)) { S.markets.delete(coin); continue; }
      const ticker = EPM.tickerOf(coin);
      let m = S.markets.get(coin);
      if (!m) {
        m = { coin, dex, ticker, cls: EPM.assetClass(ticker), maxLev: u.maxLeverage, isolated: !!u.onlyIsolated };
        S.markets.set(coin, m);
      }
      m.ctx = ctx;
      m.t = t;
      pushSnap(coin, t, ctx);
    }
    S.lastCtxAt[dex || 'main'] = t;
  };

  function pushSnap(coin, t, c) {
    const row = [t, c.mark, c.oracle, c.oi, c.funding, c.mid];
    let fine = S.fine.get(coin);
    if (!fine) S.fine.set(coin, (fine = []));
    fine.push(row);
    const cutF = t - cfg.fineSnapMinutesKept * MIN;
    while (fine.length && fine[0][0] < cutF) fine.shift();

    let mn = S.minute.get(coin);
    if (!mn) S.minute.set(coin, (mn = []));
    const mt = Math.floor(t / MIN) * MIN;
    const last = mn[mn.length - 1];
    if (last && last[0] === mt) mn[mn.length - 1] = [mt, c.mark, c.oracle, c.oi, c.funding, c.mid];
    else mn.push([mt, c.mark, c.oracle, c.oi, c.funding, c.mid]);
    const cutM = t - cfg.snapMinutesKept * MIN;
    while (mn.length && mn[0][0] < cutM) mn.shift();
  }

  // Value of a snapshot field (1 mark, 2 oracle, 3 oi, 4 funding) at about time tt.
  // Uses 10s snapshots inside their span, minute snapshots beyond it. Returns null if the
  // history does not reach back far enough (within a tolerance).
  S.snapAt = function (coin, tt, idx) {
    const fine = S.fine.get(coin);
    if (fine && fine.length && fine[0][0] <= tt + 15000) {
      const v = nearest(fine, tt, idx, 20000);
      if (v !== null) return v;
    }
    const mn = S.minute.get(coin);
    if (mn && mn.length && mn[0][0] <= tt + 60000) return nearest(mn, tt, idx, 90000);
    return null;
  };
  function nearest(arr, tt, idx, tol) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid][0] < tt) lo = mid + 1; else hi = mid;
    }
    let best = arr[lo];
    if (lo > 0 && Math.abs(arr[lo - 1][0] - tt) < Math.abs(best[0] - tt)) best = arr[lo - 1];
    if (Math.abs(best[0] - tt) > tol) return null;
    const v = best[idx];
    return EPM.isNum(v) ? v : null;
  }

  // ---------- candles ----------
  S.setCandles = function (coin, rows) {
    let cd = S.candles.get(coin);
    if (!cd) S.candles.set(coin, (cd = { t: [], c: [], v: [] }));
    for (const r of rows) mergeBar(cd, r);
    trimCandles(cd);
    cd.at = Date.now();
  };
  S.ingestCandle = function (r) {
    if (!r || r.i !== '5m') return;
    const cd = S.candles.get(r.s);
    if (!cd) return; // history not loaded yet: the warm-up fetch will include this bar
    mergeBar(cd, r);
    trimCandles(cd);
    cd.liveAt = Date.now();
  };
  function mergeBar(cd, r) {
    const t = r.t, c = f(r.c), h = f(r.h), l = f(r.l), v = f(r.v);
    const ntl = v * (h + l + c) / 3;   // typical-price notional
    const n = cd.t.length;
    if (n && t === cd.t[n - 1]) { cd.c[n - 1] = c; cd.v[n - 1] = ntl; return; }
    if (n && t < cd.t[n - 1]) {
      const i = cd.t.indexOf(t);
      if (i >= 0) { cd.c[i] = c; cd.v[i] = ntl; }
      return;
    }
    cd.t.push(t); cd.c.push(c); cd.v.push(ntl);
  }
  function trimCandles(cd) {
    const cut = Date.now() - cfg.candleDays * 86400000;
    let k = 0;
    while (k < cd.t.length && cd.t[k] < cut) k++;
    if (k) { cd.t.splice(0, k); cd.c.splice(0, k); cd.v.splice(0, k); }
  }

  // ---------- funding ----------
  S.setFunding = function (coin, rows) {
    let fd = S.funding.get(coin);
    if (!fd) S.funding.set(coin, (fd = { t: [], f: [], p: [] }));
    for (const r of rows) {
      const t = r.time;
      if (fd.t.length && t <= fd.t[fd.t.length - 1]) continue;
      fd.t.push(t); fd.f.push(f(r.fundingRate)); fd.p.push(f(r.premium));
    }
    const cut = Date.now() - cfg.fundingDays * 86400000;
    let k = 0;
    while (k < fd.t.length && fd.t[k] < cut) k++;
    if (k) { fd.t.splice(0, k); fd.f.splice(0, k); fd.p.splice(0, k); }
    fd.at = Date.now();
  };

  // ---------- taker flow ----------
  S.flowFor = function (coin) {
    let fl = S.flow.get(coin);
    if (!fl) S.flow.set(coin, (fl = { start: Date.now(), b: new Map(), tids: new Set(), tidQ: [] }));
    return fl;
  };
  // Hyperliquid trade side is the aggressor: 'B' = taker bought, 'A' = taker sold.
  S.ingestTrades = function (trades, source) {
    for (const tr of trades) {
      if (!S.tracked.has(tr.coin)) continue;
      const fl = S.flowFor(tr.coin);
      if (tr.tid !== undefined) {
        if (fl.tids.has(tr.tid)) continue;
        fl.tids.add(tr.tid); fl.tidQ.push(tr.tid);
        if (fl.tidQ.length > 4000) fl.tids.delete(fl.tidQ.shift());
      }
      // Ignore trades older than this market's flow window start (snapshot replays).
      if (tr.time < fl.start - MIN) continue;
      const ntl = f(tr.px) * f(tr.sz);
      if (!(ntl > 0)) continue;
      const mt = Math.floor(tr.time / MIN) * MIN;
      let bk = fl.b.get(mt);
      if (!bk) fl.b.set(mt, (bk = [0, 0, 0, 0]));
      if (tr.side === 'B') bk[0] += ntl; else bk[1] += ntl;
      bk[2] += ntl * ntl; bk[3] += 1;
      fl.last = Date.now();
      fl.source = source;
    }
  };
  S.trimFlow = function () {
    const cut = Date.now() - cfg.flowMinutesKept * MIN;
    for (const fl of S.flow.values()) {
      for (const k of fl.b.keys()) if (k < cut) fl.b.delete(k);
      if (fl.start < cut) fl.start = cut;
    }
  };

  // ---------- order book ----------
  S.setBook = function (coin, book) {
    if (!book || !book.levels) return;
    const [bids, asks] = book.levels;
    if (!bids.length || !asks.length) return;
    const bid = f(bids[0].px), ask = f(asks[0].px), mid = (bid + ask) / 2;
    const depth = (side, bps, isBid) => {
      let s = 0;
      for (const l of side) {
        const px = f(l.px);
        const dist = isBid ? (mid - px) / mid : (px - mid) / mid;
        if (dist * 1e4 > bps) break;
        s += px * f(l.sz);
      }
      return s;
    };
    const b10 = depth(bids, 10, true), a10 = depth(asks, 10, false);
    const b50 = depth(bids, 50, true), a50 = depth(asks, 50, false);
    S.book.set(coin, {
      t: book.time || Date.now(), bid, ask, mid,
      spreadBps: ((ask - bid) / mid) * 1e4,
      touch: f(bids[0].px) * f(bids[0].sz) + f(asks[0].px) * f(asks[0].sz),
      depth10: b10 + a10, depth50: b50 + a50,
      imb50: b50 + a50 > 0 ? (b50 - a50) / (b50 + a50) : NaN,
    });
  };

  // ---------- KPI history (per-minute series behind the sparklines) ----------
  S.pushKpi = function (key, v, t) {
    if (!EPM.isNum(v)) return;
    const arr = S.kpiHist[key] || (S.kpiHist[key] = []);
    const mt = Math.floor(t / MIN) * MIN;
    if (arr.length && arr[arr.length - 1][0] === mt) arr[arr.length - 1][1] = v;
    else arr.push([mt, v]);
    while (arr.length && arr[0][0] < t - cfg.snapMinutesKept * MIN) arr.shift();
  };

  // ---------- persistence ----------
  const r6 = (x) => (EPM.isNum(x) ? +x.toPrecision(7) : null);
  S.save = function () {
    const keep = new Set([...S.tracked, ...cfg.controls]);
    const minute = {};
    for (const [coin, arr] of S.minute) if (keep.has(coin)) minute[coin] = arr.map((r) => r.map(r6));
    EPM.store.set('minute', { v: 1, at: Date.now(), d: minute });

    const flow = {};
    for (const [coin, fl] of S.flow) flow[coin] = { s: fl.start, b: [...fl.b].map(([k, v]) => [k / MIN, ...v.map((x) => Math.round(x))]) };
    EPM.store.set('flow', { v: 1, at: Date.now(), d: flow });

    const fund = {};
    for (const [coin, fd] of S.funding) fund[coin] = { t: fd.t.map((x) => Math.round(x / 1000)), f: fd.f.map(r6), p: fd.p.map(r6) };
    EPM.store.set('funding', { v: 1, d: fund });

    EPM.store.set('kpi', S.kpiHist);
    EPM.store.set('alerts', S.alerts.slice(0, cfg.maxAlerts));

    const cand = {};
    for (const [coin, cd] of S.candles) {
      if (!cd.t.length) continue;
      const t0 = cd.t[0] / BAR;
      cand[coin] = { t0, dt: cd.t.map((x) => x / BAR - t0), c: cd.c.map(r6), v: cd.v.map((x) => Math.round(x)) };
    }
    // Candles are the largest cache and fully re-fetchable: drop them first under quota pressure.
    if (!EPM.store.set('candles', { v: 1, d: cand })) EPM.store.del('candles');
  };

  S.load = function () {
    const now = Date.now();
    const mn = EPM.store.get('minute', null);
    if (mn && mn.d && now - mn.at < cfg.snapMinutesKept * MIN) {
      for (const coin in mn.d) S.minute.set(coin, mn.d[coin].filter((r) => r[0] > now - cfg.snapMinutesKept * MIN));
    }
    const fl = EPM.store.get('flow', null);
    if (fl && fl.d && now - fl.at < 3 * MIN) {
      // Flow is only resumable across a short gap; a long gap would read as zero flow.
      for (const coin in fl.d) {
        const o = fl.d[coin];
        S.flow.set(coin, { start: o.s, b: new Map(o.b.map((r) => [r[0] * MIN, r.slice(1)])), tids: new Set(), tidQ: [] });
      }
    }
    const fd = EPM.store.get('funding', null);
    if (fd && fd.d) {
      for (const coin in fd.d) {
        const o = fd.d[coin];
        S.funding.set(coin, { t: o.t.map((x) => x * 1000), f: o.f, p: o.p, at: 0 });
      }
    }
    const cd = EPM.store.get('candles', null);
    if (cd && cd.d) {
      for (const coin in cd.d) {
        const o = cd.d[coin];
        const c = { t: o.dt.map((d) => (o.t0 + d) * BAR), c: o.c, v: o.v, at: 0 };
        trimCandles(c);
        if (c.t.length) S.candles.set(coin, c);
      }
    }
    S.kpiHist = EPM.store.get('kpi', {}) || {};
    S.alerts = EPM.store.get('alerts', []) || [];
  };

  S.clearHistory = function () {
    ['minute', 'flow', 'funding', 'candles', 'kpi', 'alerts'].forEach(EPM.store.del);
  };
})();
