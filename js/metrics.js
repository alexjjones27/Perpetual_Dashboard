/* Metric engine: everything on the dashboard is computed here from the live state. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const S = EPM.state;
  const cfg = EPM.config;
  const st = EPM.stats;
  const isNum = EPM.isNum;
  const BAR = 5 * 60000;
  const MIN = 60000;
  const M = (EPM.metrics = {});

  // ---------- abnormal volume: conditional residual model ----------
  // log(1+notional) = a[time-of-day bucket] + b1*log(1+|r| bps) + b2*log(1+lagged 1h RV bps) + e
  // Bucket fixed effects are 30-min ET slots (weekday/weekend), pooled to the coarse session
  // (regular/pre/post/overnight/weekend) when a slot has fewer than 8 bars of history.
  // AbnVol z = e / robust sd(e). Volatility enters as a control, so a bar that is busy only
  // because price moved a lot does not register as unusual.
  const models = new Map();

  function features(cd, i) {
    if (i < 13) return null;
    const r = Math.log(cd.c[i] / cd.c[i - 1]);
    let ss = 0;
    for (let k = i - 12; k < i; k++) { const rk = Math.log(cd.c[k] / cd.c[k - 1]); ss += rk * rk; }
    const rv = Math.sqrt(ss / 12);
    if (!isNum(r) || !isNum(rv)) return null;
    return [Math.log1p(Math.abs(r) * 1e4), Math.log1p(rv * 1e4)];
  }

  function fitModel(coin, cd, now) {
    const n = cd.t.length;
    const rows = [];
    for (let i = 13; i < n; i++) {
      if (cd.t[i] + BAR > now) break;        // completed bars only
      const x = features(cd, i);
      if (!x || !(cd.v[i] >= 0)) continue;
      rows.push({ i, y: Math.log1p(cd.v[i]), x1: x[0], x2: x[1], fb: EPM.bucketOf(cd.t[i]), cb: 100 + EPM.sessionOf(cd.t[i]) });
    }
    if (rows.length < 150) return null;
    const fineCount = {};
    for (const r of rows) fineCount[r.fb] = (fineCount[r.fb] || 0) + 1;
    const keyOf = (fb, cb) => ((fineCount[fb] || 0) >= 8 ? fb : cb);
    const g = {};
    for (const r of rows) {
      r.k = keyOf(r.fb, r.cb);
      const a = g[r.k] || (g[r.k] = { n: 0, y: 0, x1: 0, x2: 0 });
      a.n++; a.y += r.y; a.x1 += r.x1; a.x2 += r.x2;
    }
    for (const k in g) { const a = g[k]; a.y /= a.n; a.x1 /= a.n; a.x2 /= a.n; }
    // Within-bucket OLS on two regressors (tiny ridge for stability).
    let s11 = 1e-6, s12 = 0, s22 = 1e-6, s1y = 0, s2y = 0;
    for (const r of rows) {
      const a = g[r.k];
      const d1 = r.x1 - a.x1, d2 = r.x2 - a.x2, dy = r.y - a.y;
      s11 += d1 * d1; s12 += d1 * d2; s22 += d2 * d2; s1y += d1 * dy; s2y += d2 * dy;
    }
    const det = s11 * s22 - s12 * s12;
    const b1 = det ? (s22 * s1y - s12 * s2y) / det : 0;
    const b2 = det ? (s11 * s2y - s12 * s1y) / det : 0;
    const a = {};
    for (const k in g) a[k] = g[k].y - b1 * g[k].x1 - b2 * g[k].x2;
    const res = rows.map((r) => r.y - (a[r.k] + b1 * r.x1 + b2 * r.x2));
    const sc = st.robustScale(res, 0.05).sc;
    const allMean = st.mean(rows.map((r) => r.y - b1 * r.x1 - b2 * r.x2));
    return { b1, b2, a, fineCount, sigma: sc, aAll: allMean, n: rows.length, fitAt: now, bars: n };
  }

  function predict(model, t, x) {
    const fb = EPM.bucketOf(t), cb = 100 + EPM.sessionOf(t);
    const k = (model.fineCount[fb] || 0) >= 8 ? fb : cb;
    const a = isNum(model.a[k]) ? model.a[k] : model.aAll;
    return a + model.b1 * x[0] + model.b2 * x[1];
  }

  M.volModel = function (coin, now) {
    const cd = S.candles.get(coin);
    if (!cd || cd.t.length < 160) return null;
    let mdl = models.get(coin);
    if (!mdl || now - mdl.fitAt > 15 * MIN || cd.t.length - mdl.bars > 6) {
      mdl = fitModel(coin, cd, now);
      if (mdl) models.set(coin, mdl);
    }
    return mdl;
  };

  // Per-bar expected notional and z for the last `count` bars (used by the detail chart).
  M.volSeries = function (coin, count, now) {
    const cd = S.candles.get(coin);
    const mdl = M.volModel(coin, now);
    if (!cd || !mdl) return null;
    const out = [];
    const start = Math.max(13, cd.t.length - count);
    for (let i = start; i < cd.t.length; i++) {
      const x = features(cd, i);
      const done = cd.t[i] + BAR <= now;
      let exp = NaN, z = NaN;
      if (x) {
        const yhat = predict(mdl, cd.t[i], x);
        exp = Math.expm1(yhat);
        if (done) z = (Math.log1p(cd.v[i]) - yhat) / mdl.sigma;
      }
      out.push({ t: cd.t[i], v: cd.v[i], exp, z, done });
    }
    return out;
  };

  // ---------- per-market metrics ----------
  function lastAtOrBefore(fd, tt) {
    let v = null;
    for (let i = fd.t.length - 1; i >= 0; i--) if (fd.t[i] <= tt) { v = fd.f[i]; break; }
    return v;
  }

  M.compute = function (m, now, W) {
    const c = m.ctx;
    const o = { coin: m.coin, ticker: m.ticker, dex: m.dex, cls: m.cls, tracked: S.tracked.has(m.coin) };
    o.mark = c.mark; o.oracle = c.oracle;
    o.chg24 = c.prevDay > 0 ? (c.mark / c.prevDay - 1) * 100 : NaN;
    o.vol24 = c.dayNtl;
    o.oiNtl = c.oi * c.mark;
    o.turnover = o.oiNtl > 0 ? c.dayNtl / o.oiNtl : NaN;
    o.basisBps = c.oracle > 0 ? ((c.mark - c.oracle) / c.oracle) * 1e4 : NaN;
    o.premiumBps = c.premium * 1e4;
    o.funding = c.funding;
    o.fundApr = c.funding * 24 * 365 * 100;
    const mid = isNum(c.mid) ? c.mid : c.mark;
    o.impactBps = c.impAsk > 0 && c.impBid > 0 ? ((c.impAsk - c.impBid) / mid) * 1e4 : NaN;

    // Window changes: price, oracle (the equity/index reference) and open interest.
    const tW = now - W * MIN;
    const pxThen = S.snapAt(m.coin, tW, 1);
    const orThen = S.snapAt(m.coin, tW, 2);
    const oiThen = S.snapAt(m.coin, tW, 3);
    o.dPx = pxThen ? (c.mark / pxThen - 1) * 100 : NaN;
    o.dOracle = orThen ? (c.oracle / orThen - 1) * 100 : NaN;
    o.dOI = oiThen ? (c.oi / oiThen - 1) * 100 : NaN;     // base units: price-neutral
    o.relRetBps = isNum(o.dPx) && isNum(o.dOracle) ? (o.dPx - o.dOracle) * 100 : NaN;
    const oi1h = S.snapAt(m.coin, now - 60 * MIN, 3);
    o.dOI1h = oi1h ? (c.oi / oi1h - 1) * 100 : NaN;
    o.oiNtl1h = oi1h ? oi1h * c.mark : NaN;
    o.regime = regimeOf(o.dPx, o.dOI);

    // Funding: percentile and robust surprise vs trailing hourly history.
    const fd = S.funding.get(m.coin);
    if (fd && fd.f.length >= 48) {
      o.fundPctl = st.pctRank(fd.f, c.funding);
      const fs = st.robustScale(fd.f, 1e-6);
      o.fundZ = fs.sc > 0 ? st.clip((c.funding - fs.med) / fs.sc, -10, 10) : NaN;
      o.fundMedApr = fs.med * 24 * 365 * 100;
      for (const h of [1, 8, 24]) {
        const v = lastAtOrBefore(fd, now - h * 3600000);
        o['fundD' + h] = isNum(v) ? (c.funding - v) * 24 * 365 * 100 : NaN;
      }
      const ps = st.robustScale(fd.p, 2e-5);
      o.basisZ = ps.sc > 0 ? st.clip((c.premium - ps.med) / ps.sc, -10, 10) : NaN;
      o.premMedBps = ps.med * 1e4;
    } else {
      o.fundPctl = o.fundZ = o.basisZ = NaN;
    }

    // Abnormal volume, Amihud illiquidity, realized vol, typical bar size.
    const vs = o.tracked ? M.volSeries(m.coin, 300, now) : null;
    if (vs && vs.length) {
      const done = vs.filter((b) => b.done && isNum(b.z));
      const last3 = done.slice(-3);
      o.abnVol5 = done.length ? done[done.length - 1].z : NaN;
      o.abnVol15 = last3.length === 3 ? st.mean(last3.map((b) => b.z)) : NaN;
      o.typical5m = st.median(done.slice(-288).map((b) => b.v));
      const cd = S.candles.get(m.coin);
      let am = 0, an = 0, ss = 0, sn = 0;
      for (let i = Math.max(1, cd.t.length - 288); i < cd.t.length; i++) {
        const r = Math.log(cd.c[i] / cd.c[i - 1]);
        if (!isNum(r)) continue;
        if (cd.v[i] > 0) { am += Math.abs(r) * 1e4 / (cd.v[i] / 1e6); an++; }
        if (i >= cd.t.length - 12) { ss += r * r; sn++; }
      }
      o.amihud = an ? am / an : NaN;            // bps of |return| per $1M traded (5m bars, 24h)
      o.rv1hBps = sn ? Math.sqrt(ss) * 1e4 : NaN;
    } else {
      o.abnVol5 = o.abnVol15 = o.typical5m = o.amihud = o.rv1hBps = NaN;
    }

    // Signed taker flow over the window (from the trade stream).
    const fl = S.flow.get(m.coin);
    if (o.tracked && fl) {
      let b = 0, s = 0, q = 0, n = 0;
      const from = Math.floor(tW / MIN) * MIN;
      for (const [k, v] of fl.b) if (k >= from) { b += v[0]; s += v[1]; q += v[2]; n += v[3]; }
      o.flowCoverage = st.clip((now - Math.max(fl.start, tW)) / (W * MIN), 0, 1);
      o.buy = b; o.sell = s; o.trades = n;
      o.imb = b + s > 0 ? (b - s) / (b + s) : NaN;
      // z of signed notional under a random-sign null: (B - S) / sqrt(sum of squared trade sizes).
      // Large trades and order splitting inflate it, so read it as a ranking, not a p-value.
      o.flowZ = q > 0 ? (b - s) / Math.sqrt(q) : NaN;
      o.netFlowRel = o.typical5m > 0 ? (b - s) / (o.typical5m * (W / 5)) : NaN;
      if (o.flowCoverage < 0.6) o.flowZ = NaN;
    } else {
      o.flowCoverage = 0; o.imb = o.flowZ = o.netFlowRel = NaN;
    }

    const bk = S.book.get(m.coin);
    if (bk && now - bk.t < 5 * MIN) {
      o.spreadBps = bk.spreadBps; o.depth10 = bk.depth10; o.depth50 = bk.depth50; o.imb50 = bk.imb50; o.touch = bk.touch;
    }
    o.illiqBps = isNum(o.impactBps) ? o.impactBps : o.spreadBps;
    return o;
  };

  function regimeOf(dPx, dOI) {
    if (!isNum(dPx) || !isNum(dOI)) return null;
    const up = dPx >= cfg.regimePxPct, dn = dPx <= -cfg.regimePxPct;
    const oiUp = dOI >= cfg.regimeOiPct, oiDn = dOI <= -cfg.regimeOiPct;
    if (up && oiUp) return { k: 'NL', label: 'New longs', dir: 1 };
    if (up && oiDn) return { k: 'SC', label: 'Short covering', dir: 1 };
    if (dn && oiUp) return { k: 'NS', label: 'New shorts', dir: -1 };
    if (dn && oiDn) return { k: 'LL', label: 'Long liquidation', dir: -1 };
    return { k: 'FL', label: 'Flat', dir: 0 };
  }
  M.regimeOf = regimeOf;

  // ---------- cross-section: composite score, quintiles, market aggregates ----------
  // PerpSignalScore = w1 Z(signed flow) + w2 Z(dOI x sign r) + w3 Z(funding surprise)
  //                 + w4 Z(basis) - w5 Z(illiquidity)
  // Each input is first normalized per market (flow z, % OI change, time-series z of funding and
  // premium vs own history), then robust-z'd across tracked markets (median/MAD, capped at +/-3).
  M.computeAll = function (now) {
    const W = S.settings.windowMin;
    const out = new Map();
    for (const m of S.markets.values()) if (m.ctx) out.set(m.coin, M.compute(m, now, W));
    const tr = [...out.values()].filter((o) => o.tracked);

    const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
    const zF = st.crossZ(tr.map((o) => [o.coin, o.flowZ]));
    const zO = st.crossZ(tr.map((o) => [o.coin, isNum(o.dOI) && isNum(o.dPx) ? o.dOI * sgn(o.dPx) : NaN]));
    const zU = st.crossZ(tr.map((o) => [o.coin, o.fundZ]));
    const zB = st.crossZ(tr.map((o) => [o.coin, o.basisZ]));
    const zL = st.crossZ(tr.map((o) => [o.coin, o.illiqBps > 0 ? Math.log(o.illiqBps) : NaN]));
    const w = S.settings.weights;
    const shrink = S.settings.illiqMode === 'shrink';
    for (const o of tr) {
      const parts = {
        flow: isNum(zF[o.coin]) ? w.flow * zF[o.coin] : null,
        oi: isNum(zO[o.coin]) ? w.oi * zO[o.coin] : null,
        funding: isNum(zU[o.coin]) ? w.funding * zU[o.coin] : null,
        basis: isNum(zB[o.coin]) ? w.basis * zB[o.coin] : null,
        illiq: isNum(zL[o.coin]) ? -w.illiq * zL[o.coin] : null,
      };
      const dirKeys = ['flow', 'oi', 'funding', 'basis'];
      const have = dirKeys.filter((k) => parts[k] !== null);
      o.parts = parts;
      o.partsAvail = have.length;
      if (have.length >= 2) {
        const dir = have.reduce((s, k) => s + parts[k], 0);
        if (shrink) {
          const damp = isNum(zL[o.coin]) ? Math.exp(-0.35 * w.illiq * Math.max(0, zL[o.coin])) : 1;
          o.score = dir * damp;
          parts.illiq = isNum(zL[o.coin]) ? o.score - dir : null;
        } else {
          o.score = dir + (parts.illiq || 0);
        }
        o.absScore = Math.abs(o.score);
      } else {
        o.score = o.absScore = NaN;
      }
      // Agreement: how many directional components share the score's sign.
      o.agree = have.filter((k) => sgn(parts[k]) === sgn(o.score) && Math.abs(parts[k]) > 0.5).length;
    }
    // Quintiles on the composite (Q5 = highest).
    const scored = tr.filter((o) => isNum(o.score)).sort((a, b) => a.score - b.score);
    scored.forEach((o, i) => (o.quintile = 1 + Math.floor((5 * i) / scored.length)));

    // Common-shock context: idiosyncratic abnormal volume nets out the cross-sectional median.
    const medAbn = st.median(tr.map((o) => o.abnVol15));
    for (const o of tr) o.idioAbn = isNum(o.abnVol15) && isNum(medAbn) ? o.abnVol15 - medAbn : NaN;

    S.metrics = out;
    S.cross = aggregates([...out.values()], tr, medAbn, now);
    return out;
  };

  function aggregates(all, tr, medAbn, now) {
    const a = { now };
    a.vol24 = all.reduce((s, o) => s + (o.vol24 || 0), 0);
    a.oiNtl = all.reduce((s, o) => s + (o.oiNtl || 0), 0);
    let oiNow = 0, oiThen = 0;
    for (const o of all) if (isNum(o.oiNtl1h) && o.oiNtl > 0) { oiNow += o.oiNtl; oiThen += o.oiNtl1h; }
    a.dOI1h = oiThen > 0 ? (oiNow / oiThen - 1) * 100 : NaN;
    let fw = 0, fs = 0;
    for (const o of all) if (o.oiNtl > 0 && isNum(o.fundApr)) { fw += o.oiNtl; fs += o.oiNtl * o.fundApr; }
    a.fundAprOiW = fw > 0 ? fs / fw : NaN;
    a.medBasis = st.median(tr.map((o) => o.basisBps));
    const abn = tr.map((o) => o.abnVol15).filter(isNum);
    a.breadth = abn.length >= 5 ? (100 * abn.filter((z) => z >= 2).length) / abn.length : NaN;
    a.breadthN = abn.length;
    a.medAbn = medAbn;
    let b = 0, s = 0;
    for (const o of tr) if (o.flowCoverage >= 0.6) { b += o.buy || 0; s += o.sell || 0; }
    a.netImb = b + s > 0 ? (b - s) / (b + s) : NaN;
    a.netFlow = b - s;
    for (const k of cfg.controls) {
      const cm = S.controls.get(k);
      a['ctl' + k] = cm && cm.ctx.prevDay > 0 ? (cm.ctx.mark / cm.ctx.prevDay - 1) * 100 : NaN;
    }
    const idx = S.metrics.get('xyz:SP500') || S.metrics.get('xyz:XYZ100');
    a.idxName = idx ? idx.ticker : null;
    a.idxChg = idx ? idx.chg24 : NaN;
    a.trackedN = tr.length;
    return a;
  }

  // ---------- lead-lag between perp mark and the oracle reference ----------
  // corr(r_perp(t), r_oracle(t + k)), perp = order-book mid. Positive k with high correlation =
  // perp moves first. Oracle updates are discrete, so treat it as a descriptive read.
  M.leadLag = function (coin, now) {
    const mn = S.minute.get(coin) || [];
    let step, series, maxLag;
    if (mn.length >= 60) {
      step = MIN; maxLag = 10;
      series = grid(mn, step, now, Math.min(mn.length, 240));
    } else {
      const fine = S.fine.get(coin) || [];
      if (fine.length < 40) return null;
      step = 10000; maxLag = 9;
      series = grid(fine, step, now, Math.min(360, Math.floor((now - fine[0][0]) / step)));
    }
    const rp = [], ro = [];
    for (let i = 1; i < series.length; i++) {
      const a = series[i], b = series[i - 1];
      // Order-book mid when recorded: the mark price is partly oracle-derived by construction.
      const pa = a && (a[5] > 0 ? a[5] : a[1]), pb = b && (b[5] > 0 ? b[5] : b[1]);
      rp.push(a && b ? Math.log(pa / pb) : NaN);
      ro.push(a && b ? Math.log(a[2] / b[2]) : NaN);
    }
    const lags = [];
    for (let k = -maxLag; k <= maxLag; k++) {
      const x = [], y = [];
      for (let i = 0; i < rp.length; i++) {
        const j = i + k;
        if (j < 0 || j >= ro.length) continue;
        x.push(rp[i]); y.push(ro[j]);
      }
      lags.push({ k, rho: st.corr(x, y) });
    }
    const valid = lags.filter((l) => isNum(l.rho));
    if (valid.length < maxLag) return null;
    const best = valid.reduce((p, q) => (Math.abs(q.rho) > Math.abs(p.rho) ? q : p));
    let lead = 0, lagS = 0;
    for (const l of valid) { if (l.k > 0) lead += l.rho * l.rho; if (l.k < 0) lagS += l.rho * l.rho; }
    return { lags, best, step, n: rp.filter(isNum).length, leadShare: lead + lagS > 0 ? lead / (lead + lagS) : NaN };
  };
  function grid(arr, step, now, n) {
    const out = [];
    const end = Math.floor(now / step) * step;
    let j = 0;
    for (let i = n - 1; i >= 0; i--) {
      const tt = end - i * step;   // oldest to newest
      while (j < arr.length - 1 && arr[j + 1][0] <= tt + step / 2) j++;
      const r = arr[j];
      out.push(r && Math.abs(r[0] - tt) <= step && r[1] > 0 && r[2] > 0 ? r : null);
    }
    return out;
  }

  // ---------- alerts ----------
  function ordinal(x) {
    const n = Math.round(x);
    const t = n % 100;
    return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  }
  const lastFired = new Map();
  function fire(key, sev, coin, msg, now) {
    const k = key + ':' + (coin || '*');
    if (now - (lastFired.get(k) || 0) < cfg.alertCooldownMs) return false;
    lastFired.set(k, now);
    S.alerts.unshift({ t: now, sev, coin, type: key, msg });
    if (S.alerts.length > cfg.maxAlerts) S.alerts.length = cfg.maxAlerts;
    return true;
  }
  M.seedCooldowns = function () {
    for (const a of S.alerts) {
      const k = a.type + ':' + (a.coin || '*');
      if (!lastFired.has(k) || lastFired.get(k) < a.t) lastFired.set(k, a.t);
    }
  };

  M.checkAlerts = function (now) {
    const fired = [];
    const W = S.settings.windowMin;
    const arrow = (x) => (x > 0 ? '▲' : '▼');
    const f = EPM.fmt;
    for (const o of S.metrics.values()) {
      if (!o.tracked) continue;
      const t = o.ticker;
      // The working hypothesis: abnormal taker flow + rising OI + funding surprise together.
      if (Math.abs(o.flowZ) >= 2.5 && o.dOI >= 0.5 && Math.abs(o.fundZ) >= 1.5) {
        if (fire('confluence', 'critical', o.coin,
          `${t} ${arrow(o.flowZ)} confluence: flow z ${f.num(o.flowZ)}, OI ${f.pct(o.dOI)}, funding z ${f.num(o.fundZ)} (${W}m)`, now)) fired.push(o.coin);
      } else if (o.abnVol15 >= 3) {
        const conf = Math.abs(o.flowZ) >= 2 || Math.abs(o.dOI) >= 0.5;
        if (fire('abnvol', conf ? 'serious' : 'info', o.coin,
          `${t} abnormal volume z ${f.plain(o.abnVol15)} (15m)` + (conf ? `, flow z ${f.num(o.flowZ)}, OI ${f.pct(o.dOI)}` : ', no flow/OI confirmation'), now)) fired.push(o.coin);
      }
      if ((o.fundPctl >= 98 || o.fundPctl <= 2) && Math.abs(o.fundZ) >= 2) {
        if (fire('funding', 'warning', o.coin,
          `${t} funding ${f.pct(o.fundApr, 1)} APR at ${ordinal(o.fundPctl)} pctl of ${cfg.fundingDays}d (z ${f.num(o.fundZ)})`, now)) fired.push(o.coin);
      }
      if (Math.abs(o.basisBps) >= 20 && Math.abs(o.basisZ) >= 3) {
        if (fire('basis', 'warning', o.coin,
          `${t} basis ${f.bps(o.basisBps)} bps vs oracle (premium z ${f.num(o.basisZ)})`, now)) fired.push(o.coin);
      }
      if (Math.abs(o.dOI) >= 2 && o.regime && o.regime.k !== 'FL') {
        if (fire('oi', 'serious', o.coin,
          `${t} ${o.regime.label}: OI ${f.pct(o.dOI)}, price ${f.pct(o.dPx)} (${W}m)`, now)) fired.push(o.coin);
      }
    }
    const c = S.cross;
    if (c.breadth >= 30 && c.breadthN >= 10) {
      fire('shock', 'serious', null,
        `Market-wide volume: ${f.plain(c.breadth, 0)}% of tracked markets at abnormal-volume z >= 2. Treat single-name signals as common-shock driven.`, now);
    }
    return fired;
  };
})();
