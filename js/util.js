/* Shared helpers: config, formatting, robust statistics, session clock, storage. */
(function () {
  'use strict';
  const EPM = (window.EPM = window.EPM || {});

  EPM.config = {
    infoUrl: 'https://api.hyperliquid.xyz/info',
    wsUrl: 'wss://api.hyperliquid.xyz/ws',
    weightBudgetPerMin: 1050,       // Hyperliquid allows 1200/min per IP; keep headroom
    primaryDex: 'xyz',
    primaryPollMs: 10000,           // metaAndAssetCtxs for the primary dex
    secondaryPollMs: 60000,         // other active HIP-3 dexes and the main crypto dex
    bookCycleMs: 1500,              // one l2Book per tick, rotating through tracked markets
    candleDays: 4,                  // 5m candle history for the abnormal-volume model
    fundingDays: 20,                // hourly funding/premium history (API returns <= 500 rows)
    snapMinutesKept: 240,           // minute snapshots retained (and persisted)
    fineSnapMinutesKept: 65,        // 10s snapshots retained in memory
    flowMinutesKept: 240,
    alertCooldownMs: 20 * 60 * 1000,
    maxAlerts: 200,
    regimeOiPct: 0.15,              // |dOI| below this (in %) is "flat"
    regimePxPct: 0.05,              // |dPrice| below this (in %) is "flat"
    // Crypto majors on the main dex act as the common-shock control.
    controls: ['BTC', 'ETH'],
  };

  EPM.defaults = {
    trackedN: 40,
    windowMin: 15,
    classFilter: 'All',
    showAll: false,
    weights: { flow: 1, oi: 1, funding: 1, basis: 1, illiq: 1 },
    illiqMode: 'shrink',            // 'shrink' damps |score| for thin books; 'spec' subtracts w5*Z(illiq)
    sortKey: 'absScore',
    sortDir: -1,
    theme: null,
  };

  // ---------- asset classes (no metadata in the API, so a curated map) ----------
  const CLASS = {
    Index: 'XYZ100 SP500 USA500 US500 USTECH SMALL2000 JP225 KR200 NIFTY IBOV MAG7 SEMIS ROBOT',
    ETF: 'EWJ EWT EWY EWZ SMH SOXL TLT XBI XLE URNM KORU MAGS',
    Commodity: 'GOLD SILVER CL BRENTOIL NATGAS COPPER PLATINUM PALLADIUM ALUMINIUM CORN WHEAT HO URANIUM TTF',
    FX: 'EUR GBP JPY KRW DXY',
    'Rates/Vol': 'VIX VOL BVIV USBOND 10Y',
    'Pre-IPO': 'OAI ANTH OPENAI ANTHROPIC SPACEX CXMT YMTC SHEIN UNITREE',
    Other: 'H100 DRAM PURRDAT',
  };
  const classMap = {};
  Object.keys(CLASS).forEach((k) => CLASS[k].split(' ').forEach((t) => (classMap[t] = k)));
  EPM.assetClass = (ticker) => classMap[ticker] || 'Equity';
  EPM.classOrder = ['All', 'Equity', 'Index', 'ETF', 'Commodity', 'FX', 'Rates/Vol', 'Pre-IPO', 'Other'];

  // ---------- number formatting ----------
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  EPM.isNum = isNum;
  EPM.fmt = {
    usd(x, dp) {
      if (!isNum(x)) return '—';
      const a = Math.abs(x);
      const s = x < 0 ? '-' : '';
      if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(dp ?? 2) + 'B';
      if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(dp ?? 1) + 'M';
      if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(dp ?? 0) + 'k';
      return s + '$' + a.toFixed(dp ?? 0);
    },
    px(x) {
      if (!isNum(x)) return '—';
      const a = Math.abs(x);
      const dp = a >= 10000 ? 0 : a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
      return x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    },
    pct(x, dp) {
      if (!isNum(x)) return '—';
      return (x > 0 ? '+' : '') + x.toFixed(dp ?? 2) + '%';
    },
    num(x, dp) {
      if (!isNum(x)) return '—';
      return (x > 0 ? '+' : '') + x.toFixed(dp ?? 1);
    },
    plain(x, dp) {
      if (!isNum(x)) return '—';
      return x.toFixed(dp ?? 1);
    },
    bps(x, dp) {
      if (!isNum(x)) return '—';
      return (x > 0 ? '+' : '') + x.toFixed(dp ?? 1);
    },
    time(ms) {
      return new Date(ms).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    },
    timeSec(ms) {
      return new Date(ms).toLocaleTimeString('en-US', { hour12: false });
    },
    dateTime(ms) {
      return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    },
    ago(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return (s / 3600).toFixed(1) + 'h ago';
    },
    dur(min) {
      if (min < 60) return Math.round(min) + 'm';
      const h = Math.floor(min / 60);
      const m = Math.round(min % 60);
      return h + 'h' + (m ? String(m).padStart(2, '0') + 'm' : '');
    },
  };

  // ---------- robust statistics ----------
  const S = (EPM.stats = {});
  S.median = function (arr) {
    const a = arr.filter(isNum).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  S.mad = function (arr, med) {
    const m = med ?? S.median(arr);
    return S.median(arr.map((x) => Math.abs(x - m)));
  };
  S.mean = function (arr) {
    let s = 0, n = 0;
    for (const x of arr) if (isNum(x)) { s += x; n++; }
    return n ? s / n : NaN;
  };
  S.std = function (arr) {
    const m = S.mean(arr);
    let s = 0, n = 0;
    for (const x of arr) if (isNum(x)) { s += (x - m) * (x - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
  };
  // Robust scale: 1.4826*MAD, falling back to the std when the MAD collapses (pinned series).
  S.robustScale = function (arr, floor) {
    const med = S.median(arr);
    let sc = 1.4826 * S.mad(arr, med);
    if (!(sc > 0)) sc = S.std(arr);
    if (!(sc > 0)) sc = 0;
    return { med, sc: Math.max(sc, floor || 0) };
  };
  S.clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  // Percentile rank of x within arr (0..100), ties count half.
  S.pctRank = function (arr, x) {
    let below = 0, eq = 0, n = 0;
    for (const v of arr) {
      if (!isNum(v)) continue;
      n++;
      if (v < x) below++;
      else if (v === x) eq++;
    }
    return n ? (100 * (below + 0.5 * eq)) / n : NaN;
  };
  S.quantile = function (arr, q) {
    const a = arr.filter(isNum).sort((x, y) => x - y);
    if (!a.length) return NaN;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  };
  // Cross-sectional robust z with winsorizing; returns a map key -> z.
  S.crossZ = function (entries, cap) {
    const vals = entries.map((e) => e[1]).filter(isNum);
    const out = {};
    if (vals.length < 5) return out;
    const { med, sc } = S.robustScale(vals);
    if (!(sc > 0)) return out;
    for (const [k, v] of entries) if (isNum(v)) out[k] = S.clip((v - med) / sc, -(cap || 3), cap || 3);
    return out;
  };
  S.corr = function (a, b) {
    const n = Math.min(a.length, b.length);
    let sa = 0, sb = 0, k = 0;
    for (let i = 0; i < n; i++) if (isNum(a[i]) && isNum(b[i])) { sa += a[i]; sb += b[i]; k++; }
    if (k < 8) return NaN;
    const ma = sa / k, mb = sb / k;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) {
      if (!(isNum(a[i]) && isNum(b[i]))) continue;
      const da = a[i] - ma, db = b[i] - mb;
      cov += da * db; va += da * da; vb += db * db;
    }
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
  };

  // ---------- US cash-equity session clock (America/New_York; exchange holidays not modelled) ----------
  const etFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  EPM.et = function (ms) {
    const parts = {};
    for (const p of etFmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
    const hour = parseInt(parts.hour, 10) % 24;
    const minute = parseInt(parts.minute, 10);
    return {
      wd: WD[parts.weekday], day: parseInt(parts.day, 10), month: parseInt(parts.month, 10), year: parseInt(parts.year, 10),
      mod: hour * 60 + minute, hh: hour, mm: minute,
    };
  };
  // Coarse session: 0 regular, 1 pre, 2 post, 3 overnight, 4 weekend.
  EPM.sessionOf = function (ms) {
    const e = EPM.et(ms);
    if (e.wd === 0 || e.wd === 6) return 4;
    if (e.mod >= 570 && e.mod < 960) return 0;
    if (e.mod >= 240 && e.mod < 570) return 1;
    if (e.mod >= 960 && e.mod < 1200) return 2;
    return 3;
  };
  EPM.sessionNames = ['US regular', 'Pre-market', 'After-hours', 'Overnight', 'Weekend'];
  // Fine bucket for time-of-day seasonality: 30-minute slot x weekday/weekend.
  EPM.bucketOf = function (ms) {
    const e = EPM.et(ms);
    const wk = e.wd === 0 || e.wd === 6 ? 1 : 0;
    return wk * 48 + Math.floor(e.mod / 30);
  };
  EPM.sessionInfo = function (now) {
    const e = EPM.et(now);
    const s = EPM.sessionOf(now);
    let next = '';
    if (s === 0) next = 'closes in ' + EPM.fmt.dur(960 - e.mod);
    else if (s === 1) next = 'opens in ' + EPM.fmt.dur(570 - e.mod);
    else if (s === 2 || s === 3) {
      const toOpen = e.mod < 570 ? 570 - e.mod : 1440 - e.mod + 570;
      next = e.wd === 5 && e.mod >= 960 ? 'next open Mon' : 'opens in ' + EPM.fmt.dur(toOpen);
    } else next = 'next open Mon';
    // Monthly options expiry: third Friday of the month.
    const opex = e.wd === 5 && e.day >= 15 && e.day <= 21;
    const etClock = String(e.hh).padStart(2, '0') + ':' + String(e.mm).padStart(2, '0') + ' ET';
    return { s, name: EPM.sessionNames[s], next, opex, etClock };
  };

  // ---------- storage (every access guarded: private windows and quotas can throw) ----------
  EPM.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('epm.' + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('epm.' + key, JSON.stringify(val)); return true; }
      catch (e) { return false; }
    },
    del(key) {
      try { localStorage.removeItem('epm.' + key); } catch (e) { /* ignore */ }
    },
  };

  EPM.esc = function (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };
  EPM.tickerOf = (coin) => (coin.includes(':') ? coin.split(':')[1] : coin);
  EPM.dexOf = (coin) => (coin.includes(':') ? coin.split(':')[0] : '');
})();
