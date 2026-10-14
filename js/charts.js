/* Small dependency-free SVG charts with hover tooltips. One y-axis per chart, always. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const isNum = EPM.isNum;
  const esc = EPM.esc;
  const C = (EPM.charts = {});

  // ---------- tooltip (labels go in via textContent: tickers are API data) ----------
  const tipEl = () => document.getElementById('tooltip');
  C.tip = function (evt, title, rows) {
    const el = tipEl();
    el.replaceChildren();
    if (title) {
      const t = document.createElement('div');
      t.className = 't'; t.textContent = title; el.appendChild(t);
    }
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'r';
      const lab = document.createElement('span');
      if (r.color) {
        const sw = document.createElement('i');
        sw.className = 'sw'; sw.style.setProperty('--kc', r.color); lab.appendChild(sw);
      }
      lab.appendChild(document.createTextNode(r.label));
      const val = document.createElement('b');
      val.textContent = r.value;
      row.append(val, lab);
      el.appendChild(row);
    }
    el.hidden = false;
    const pad = 14;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 4) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 4) y = evt.clientY - h - pad;
    el.style.left = Math.max(4, x) + 'px';
    el.style.top = Math.max(4, y) + 'px';
  };
  C.untip = () => { tipEl().hidden = true; };

  // ---------- scales and ticks ----------
  function lin(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    const f = (x) => r0 + (x - d0) * k;
    f.inv = (y) => (k ? d0 + (y - r0) / k : d0);
    return f;
  }
  function niceTicks(lo, hi, n) {
    if (!(hi > lo)) { const p = Math.abs(lo) || 1; lo -= p * 0.1; hi += p * 0.1; }
    const raw = (hi - lo) / (n || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return { ticks: out, lo: Math.min(lo, out[0] ?? lo), hi: Math.max(hi, out[out.length - 1] ?? hi) };
  }
  const STEPS = [5, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 7200].map((m) => m * 60000);
  function timeTicks(t0, t1, maxN) {
    const span = t1 - t0;
    const step = STEPS.find((s) => span / s <= (maxN || 5)) || STEPS[STEPS.length - 1];
    const tz = new Date().getTimezoneOffset() * 60000;
    const out = [];
    for (let t = Math.ceil((t0 - tz) / step) * step + tz; t <= t1; t += step) out.push(t);
    const fmt = step >= 1440 * 60000
      ? (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : (t) => EPM.fmt.time(t);
    return { ticks: out, fmt };
  }

  // Shared frame: gridlines + y labels + time axis. Returns geometry and the svg prefix.
  function frame(w, h, x, y, yt, xt, yFmt, m) {
    let s = '';
    for (const v of yt) {
      const yy = y(v);
      s += `<line class="gridline" x1="${m.l}" x2="${w - m.r}" y1="${yy}" y2="${yy}"/>`;
      s += `<text x="${m.l - 6}" y="${yy + 3}" text-anchor="end">${esc(yFmt(v))}</text>`;
    }
    if (xt) for (const t of xt.ticks) s += `<text x="${x(t)}" y="${h - 4}" text-anchor="middle">${esc(xt.fmt(t))}</text>`;
    return s;
  }

  // ---------- sparkline (KPI tiles) ----------
  C.sparkline = function (vals, w, h, color) {
    const v = vals.filter(isNum);
    if (v.length < 2) return `<svg width="${w}" height="${h}" aria-hidden="true"></svg>`;
    let lo = Math.min(...v), hi = Math.max(...v);
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = lin(0, vals.length - 1, 1, w - 3), y = lin(lo, hi, h - 2, 2);
    let d = '', pen = false;
    vals.forEach((p, i) => {
      if (!isNum(p)) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p).toFixed(1);
      pen = true;
    });
    const lx = x(vals.length - 1), ly = y(v[v.length - 1]);
    return `<svg width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color || 'var(--ink-2)'}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="2.5" fill="${color || 'var(--ink-2)'}"/></svg>`;
  };

  // ---------- line chart with crosshair ----------
  // opts: {height, series:[{name,color,pts:[[t,v]]}], yFmt, band:{lo,hi,label}, refs:[{v,label}], zero}
  C.line = function (el, opts) {
    const w = Math.max(200, el.clientWidth), h = opts.height || 120;
    const m = { l: 44, r: 10, t: 8, b: 18 };
    const all = opts.series.flatMap((s) => s.pts);
    if (all.length < 2) { el.innerHTML = `<div class="empty-chart">${esc(opts.empty || 'Collecting data…')}</div>`; return; }
    const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
    let vals = all.map((p) => p[1]).filter(isNum);
    if (opts.band) vals = vals.concat([opts.band.lo, opts.band.hi].filter(isNum));
    if (opts.refs) vals = vals.concat(opts.refs.map((r) => r.v).filter(isNum));
    if (opts.zero) vals.push(0);
    const nt = niceTicks(Math.min(...vals), Math.max(...vals), 4);
    const x = lin(t0, t1, m.l, w - m.r), y = lin(nt.lo, nt.hi, h - m.b, m.t);
    const xt = timeTicks(t0, t1, Math.max(2, Math.floor((w - m.l) / 90)));
    let s = frame(w, h, x, y, nt.ticks, xt, opts.yFmt, m);
    if (opts.band && isNum(opts.band.lo) && isNum(opts.band.hi)) {
      s += `<rect x="${m.l}" width="${w - m.r - m.l}" y="${y(opts.band.hi)}" height="${Math.max(1, y(opts.band.lo) - y(opts.band.hi))}" fill="var(--accent-wash)"/>`;
    }
    if (opts.zero && nt.lo < 0 && nt.hi > 0) s += `<line class="baseline" x1="${m.l}" x2="${w - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    for (const r of opts.refs || []) {
      if (!isNum(r.v)) continue;
      s += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="var(--muted)" stroke-width="1"/>`;
      s += `<text class="lbl" x="${w - m.r}" y="${y(r.v) - 3}" text-anchor="end">${esc(r.label)}</text>`;
    }
    for (const se of opts.series) {
      let d = '', pen = false, prevT = null;
      for (const [t, v] of se.pts) {
        const gap = prevT !== null && opts.gapMs && t - prevT > opts.gapMs;
        if (!isNum(v) || gap) pen = false;
        if (isNum(v)) { d += (pen ? 'L' : 'M') + x(t).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; }
        prevT = t;
      }
      s += `<path d="${d}" fill="none" stroke="${se.color}" stroke-width="${se.width || 2}" stroke-linejoin="round" stroke-linecap="round"/>`;
      const last = [...se.pts].reverse().find((p) => isNum(p[1]));
      if (last) s += `<circle cx="${x(last[0])}" cy="${y(last[1])}" r="3" fill="${se.color}" stroke="var(--surface)" stroke-width="2"/>`;
    }
    s += `<line class="xh" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>`;
    s += `<rect class="hit" x="${m.l}" y="0" width="${w - m.l - m.r}" height="${h}" fill="transparent"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="${esc(opts.label || 'chart')}">${s}</svg>`;
    const svg = el.firstChild, xh = svg.querySelector('.xh'), hit = svg.querySelector('.hit');
    hit.addEventListener('pointermove', (evt) => {
      const r = svg.getBoundingClientRect();
      const tt = x.inv(evt.clientX - r.left);
      const rows = [];
      let snapT = null;
      for (const se of opts.series) {
        let best = null;
        for (const p of se.pts) if (!best || Math.abs(p[0] - tt) < Math.abs(best[0] - tt)) best = p;
        if (best) { snapT = snapT ?? best[0]; rows.push({ label: se.name, value: opts.yFmt(best[1]), color: se.color }); }
      }
      if (snapT === null) return;
      xh.setAttribute('x1', x(snapT)); xh.setAttribute('x2', x(snapT)); xh.setAttribute('visibility', 'visible');
      C.tip(evt, (opts.tFmt || EPM.fmt.dateTime)(snapT), rows);
    });
    hit.addEventListener('pointerleave', () => { xh.setAttribute('visibility', 'hidden'); C.untip(); });
  };

  // ---------- time bars + expected line (abnormal volume) ----------
  // opts: {height, bars:[{t,v,exp,z,done}], yFmt}
  C.volBars = function (el, opts) {
    const w = Math.max(200, el.clientWidth), h = opts.height || 120;
    const m = { l: 44, r: 10, t: 8, b: 18 };
    const bars = opts.bars;
    if (!bars || bars.length < 3) { el.innerHTML = '<div class="empty-chart">Loading candle history…</div>'; return; }
    const step = 5 * 60000;
    const t0 = bars[0].t, t1 = bars[bars.length - 1].t + step;
    const vmax = Math.max(...bars.map((b) => Math.max(b.v || 0, isNum(b.exp) ? b.exp : 0)));
    const nt = niceTicks(0, vmax, 3);
    const x = lin(t0, t1, m.l, w - m.r), y = lin(0, nt.hi, h - m.b, m.t);
    const xt = timeTicks(t0, t1, Math.max(2, Math.floor((w - m.l) / 90)));
    let s = frame(w, h, x, y, nt.ticks, xt, opts.yFmt, m);
    const bw = Math.max(1, x(t0 + step) - x(t0) - (x(t0 + step) - x(t0) > 4 ? 1 : 0));
    for (const b of bars) {
      const hi = b.z >= 2;
      const yy = y(b.v || 0);
      const fill = hi ? 'var(--accent)' : b.done ? 'var(--mid)' : 'var(--axis)';
      s += `<rect x="${x(b.t).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - m.b - yy).toFixed(1)}" fill="${fill}"/>`;
    }
    let d = '', pen = false;
    for (const b of bars) {
      if (!isNum(b.exp)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + (x(b.t) + bw / 2).toFixed(1) + ' ' + y(b.exp).toFixed(1); pen = true;
    }
    s += `<path d="${d}" fill="none" stroke="var(--ink-2)" stroke-width="1.5" stroke-linejoin="round"/>`;
    s += `<line class="baseline" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>`;
    s += `<rect class="hl" x="0" y="${m.t}" width="${bw}" height="${h - m.b - m.t}" fill="none" stroke="var(--ink-2)" stroke-width="1" visibility="hidden"/>`;
    s += `<rect class="hit" x="${m.l}" y="0" width="${w - m.l - m.r}" height="${h}" fill="transparent"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="5-minute notional volume versus model-expected volume">${s}</svg>`;
    const svg = el.firstChild, hit = svg.querySelector('.hit'), hl = svg.querySelector('.hl');
    hit.addEventListener('pointermove', (evt) => {
      const r = svg.getBoundingClientRect();
      const tt = x.inv(evt.clientX - r.left);
      const i = Math.max(0, Math.min(bars.length - 1, Math.floor((tt - t0) / step)));
      const b = bars.reduce((p, q) => (Math.abs(q.t - tt + step / 2) < Math.abs(p.t - tt + step / 2) ? q : p), bars[i]);
      hl.setAttribute('x', x(b.t)); hl.setAttribute('visibility', 'visible');
      C.tip(evt, EPM.fmt.dateTime(b.t) + (b.done ? '' : ' (in progress)'), [
        { label: 'Notional', value: EPM.fmt.usd(b.v) },
        { label: 'Expected', value: EPM.fmt.usd(b.exp), color: 'var(--ink-2)' },
        { label: 'Abnormal z', value: EPM.fmt.num(b.z, 2) },
      ]);
    });
    hit.addEventListener('pointerleave', () => { hl.setAttribute('visibility', 'hidden'); C.untip(); });
  };

  // ---------- lead-lag correlogram ----------
  C.lagBars = function (el, ll, height) {
    const w = Math.max(200, el.clientWidth), h = height || 110;
    const m = { l: 44, r: 10, t: 8, b: 18 };
    if (!ll) { el.innerHTML = '<div class="empty-chart">Needs about 7 minutes of 10s snapshots (or 1h of minute snapshots).</div>'; return; }
    const lags = ll.lags;
    const mx = Math.max(0.2, ...lags.map((l) => Math.abs(l.rho || 0)));
    const nt = niceTicks(-mx, mx, 4);
    const x = lin(-0.5, lags.length - 0.5, m.l, w - m.r), y = lin(nt.lo, nt.hi, h - m.b, m.t);
    let s = frame(w, h, x, y, nt.ticks, null, (v) => v.toFixed(1), m);
    const unit = ll.step >= 60000 ? 'm' : 's';
    const mult = ll.step >= 60000 ? 1 : 10;
    const bw = Math.max(2, x(1) - x(0) - 2);
    lags.forEach((l, i) => {
      if (!isNum(l.rho)) return;
      const y0 = y(0), y1 = y(l.rho);
      const isBest = l.k === ll.best.k;
      const fill = isBest ? 'var(--accent)' : 'var(--mid)';
      const top = Math.min(y0, y1), hh = Math.max(1, Math.abs(y1 - y0));
      s += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="1" fill="${fill}"/>`;
      if (l.k % 5 === 0 || lags.length <= 13) s += `<text x="${x(i)}" y="${h - 4}" text-anchor="middle">${l.k * mult}${l.k ? unit : ''}</text>`;
    });
    s += `<line class="baseline" x1="${m.l}" x2="${w - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
    s += `<rect class="hit" x="${m.l}" y="0" width="${w - m.l - m.r}" height="${h}" fill="transparent"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="Lead-lag correlation between perp and oracle returns">${s}</svg>`;
    const svg = el.firstChild;
    svg.querySelector('.hit').addEventListener('pointermove', (evt) => {
      const r = svg.getBoundingClientRect();
      const i = Math.round(x.inv(evt.clientX - r.left));
      const l = lags[Math.max(0, Math.min(lags.length - 1, i))];
      const what = l.k > 0 ? 'perp leads oracle by ' : l.k < 0 ? 'oracle leads perp by ' : 'contemporaneous';
      C.tip(evt, l.k ? what + Math.abs(l.k * mult) + unit : what, [{ label: 'correlation', value: EPM.fmt.plain(l.rho, 3) }]);
    });
    svg.querySelector('.hit').addEventListener('pointerleave', C.untip);
  };

  // ---------- score breakdown: diverging horizontal bars ----------
  C.parts = function (el, parts, labels) {
    const w = Math.max(200, el.clientWidth);
    const keys = Object.keys(labels);
    const rowH = 18, h = keys.length * rowH + 6;
    const lw = 120;
    const mx = Math.max(1.5, ...keys.map((k) => Math.abs(parts[k] || 0)));
    const x = lin(-mx, mx, lw, w - 48);
    let s = `<line class="baseline" x1="${x(0)}" x2="${x(0)}" y1="0" y2="${h}"/>`;
    keys.forEach((k, i) => {
      const v = parts[k];
      const yy = i * rowH + 3;
      s += `<text class="lbl" x="0" y="${yy + 11}">${esc(labels[k])}</text>`;
      if (!isNum(v)) { s += `<text x="${x(0) + 4}" y="${yy + 11}">n/a</text>`; return; }
      const x0 = x(0), x1 = x(v);
      const color = v >= 0 ? 'var(--up)' : 'var(--down)';
      s += `<rect x="${Math.min(x0, x1).toFixed(1)}" y="${yy + 2}" width="${Math.max(1, Math.abs(x1 - x0)).toFixed(1)}" height="${rowH - 6}" rx="2" fill="${color}"/>`;
      s += `<text class="lbl" x="${w - 2}" y="${yy + 11}" text-anchor="end">${esc(EPM.fmt.num(v, 2))}</text>`;
    });
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="Composite score contributions">${s}</svg>`;
  };

  // ---------- positioning map: dPrice vs dOI, size = OI notional, color = score ----------
  C.scoreColor = function (z) {
    if (!isNum(z)) return 'var(--muted)';
    const a = Math.min(1, Math.abs(z) / 3);
    const pole = z >= 0 ? 'var(--up)' : 'var(--down)';
    return `color-mix(in oklab, ${pole} ${Math.round(25 + 75 * a)}%, var(--mid))`;
  };
  C.scatter = function (el, pts, opts) {
    const w = Math.max(240, el.clientWidth), h = Math.max(200, el.clientHeight - 4);
    const m = { l: 44, r: 12, t: 10, b: 22 };
    if (pts.length < 3) {
      el.innerHTML = `<div class="empty-chart">${esc(opts.empty)}</div>`;
      return;
    }
    // Robust symmetric range: one outlier must not squash the rest. Points beyond it are pinned
    // to the edge and drawn hollow; the tooltip keeps their true values.
    const rng = (vals) => {
      const a = vals.map(Math.abs).sort((p, q) => p - q);
      const q85 = a[Math.floor(0.85 * (a.length - 1))];
      return Math.max(0.1, Math.min(a[a.length - 1], q85 * 1.8)) * 1.12;
    };
    const mxX = rng(pts.map((p) => p.x));
    const mxY = rng(pts.map((p) => p.y));
    const ntx = niceTicks(-mxX, mxX, 4), nty = niceTicks(-mxY, mxY, 4);
    const xr = lin(ntx.lo, ntx.hi, m.l, w - m.r), yr = lin(nty.lo, nty.hi, h - m.b, m.t);
    const maxR = 14;
    const x = (v) => EPM.stats.clip(xr(v), m.l + maxR, w - m.r - maxR);
    const y = (v) => EPM.stats.clip(yr(v), m.t + maxR, h - m.b - maxR);
    const off = (p) => p.x < ntx.lo || p.x > ntx.hi || p.y < nty.lo || p.y > nty.hi;
    let s = '';
    for (const v of nty.ticks) s += `<line class="gridline" x1="${m.l}" x2="${w - m.r}" y1="${yr(v)}" y2="${yr(v)}"/><text x="${m.l - 6}" y="${yr(v) + 3}" text-anchor="end">${esc(EPM.fmt.pct(v, 1))}</text>`;
    for (const v of ntx.ticks) s += `<line class="gridline" y1="${m.t}" y2="${h - m.b}" x1="${xr(v)}" x2="${xr(v)}"/><text x="${xr(v)}" y="${h - 6}" text-anchor="middle">${esc(EPM.fmt.pct(v, 1))}</text>`;
    s += `<line class="baseline" x1="${m.l}" x2="${w - m.r}" y1="${yr(0)}" y2="${yr(0)}"/><line class="baseline" y1="${m.t}" y2="${h - m.b}" x1="${xr(0)}" x2="${xr(0)}"/>`;
    s += `<text class="qlbl" x="${w - m.r - 4}" y="${m.t + 12}" text-anchor="end">New longs ▲OI ▲px</text>`;
    s += `<text class="qlbl" x="${m.l + 4}" y="${m.t + 12}">New shorts ▲OI ▼px</text>`;
    s += `<text class="qlbl" x="${w - m.r - 4}" y="${h - m.b - 6}" text-anchor="end">Short covering ▼OI ▲px</text>`;
    s += `<text class="qlbl" x="${m.l + 4}" y="${h - m.b - 6}">Long liquidation ▼OI ▼px</text>`;
    const maxOi = Math.max(...pts.map((p) => p.size || 0));
    const rad = (p) => 4 + 10 * Math.sqrt((p.size || 0) / (maxOi || 1));
    const sorted = [...pts].sort((a, b) => (b.size || 0) - (a.size || 0));
    for (const p of sorted) {
      const sel = p.coin === opts.selected;
      const col = C.scoreColor(p.score);
      s += off(p)
        ? `<circle cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${rad(p).toFixed(1)}" fill="var(--surface)" stroke="${sel ? 'var(--ink)' : col}" stroke-width="2"/>`
        : `<circle cx="${x(p.x).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${rad(p).toFixed(1)}" fill="${col}" fill-opacity="0.85" stroke="${sel ? 'var(--ink)' : 'var(--surface)'}" stroke-width="${sel ? 2 : 1.5}"/>`;
    }
    const lab = [...pts].filter((p) => isNum(p.score)).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 6);
    if (opts.selected && !lab.some((p) => p.coin === opts.selected)) {
      const sp = pts.find((p) => p.coin === opts.selected);
      if (sp) lab.push(sp);
    }
    // Selected first, then by |score|; a label that would collide with one already placed is
    // dropped (the tooltip and the table still carry it).
    lab.sort((a, b) => (b.coin === opts.selected) - (a.coin === opts.selected));
    // Quadrant captions are reserved space too.
    const capW = 150;
    const boxes = [[w - m.r - capW, m.t, w - m.r, m.t + 16], [m.l, m.t, m.l + capW, m.t + 16],
      [w - m.r - capW, h - m.b - 18, w - m.r, h - m.b], [m.l, h - m.b - 18, m.l + capW, h - m.b]];
    for (const p of lab) {
      const tw = p.label.length * 6.6 + 2;
      for (const right of [x(p.x) < w - 70, x(p.x) >= w - 70]) {
        const lx = right ? x(p.x) + rad(p) + 3 : x(p.x) - rad(p) - 3 - tw;
        const box = [lx, y(p.y) - 8, lx + tw, y(p.y) + 5];
        if (boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        boxes.push(box);
        s += `<text class="lbl" x="${lx.toFixed(1)}" y="${(y(p.y) + 3).toFixed(1)}">${esc(p.label)}</text>`;
        break;
      }
    }
    s += `<rect class="hit" x="${m.l}" y="${m.t}" width="${w - m.l - m.r}" height="${h - m.t - m.b}" fill="transparent"/>`;
    el.innerHTML = `<svg width="${w}" height="${h}" role="img" aria-label="Price change versus open-interest change by market">${s}</svg>`;
    const svg = el.firstChild, hit = svg.querySelector('.hit');
    const nearestPt = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = evt.clientX - r.left, py = evt.clientY - r.top;
      let best = null, bd = Infinity;
      for (const p of pts) {
        const d = Math.hypot(x(p.x) - px, y(p.y) - py) - rad(p);
        if (d < bd) { bd = d; best = p; }
      }
      return bd <= 24 ? best : null;
    };
    hit.addEventListener('pointermove', (evt) => {
      const p = nearestPt(evt);
      hit.style.cursor = p ? 'pointer' : 'default';
      if (!p) { C.untip(); return; }
      C.tip(evt, p.label + (p.regime ? ' · ' + p.regime : ''), [
        { label: 'price ' + opts.window, value: EPM.fmt.pct(p.x) },
        { label: 'OI ' + opts.window, value: EPM.fmt.pct(p.y) },
        { label: 'OI notional', value: EPM.fmt.usd(p.size) },
        { label: 'score', value: EPM.fmt.num(p.score, 2) },
      ]);
    });
    hit.addEventListener('pointerleave', C.untip);
    hit.addEventListener('click', (evt) => { const p = nearestPt(evt); if (p && opts.onPick) opts.onPick(p.coin); });
  };

  // ---------- inline table glyphs ----------
  C.imbBar = function (imb, w) {
    w = w || 56;
    const h = 10, mid = w / 2;
    if (!isNum(imb)) return `<svg width="${w}" height="${h}" aria-hidden="true"><line x1="${mid}" x2="${mid}" y1="0" y2="${h}" stroke="var(--axis)"/></svg>`;
    const len = Math.max(1, Math.abs(imb) * mid);
    const x0 = imb >= 0 ? mid : mid - len;
    const color = imb >= 0 ? 'var(--up)' : 'var(--down)';
    return `<svg width="${w}" height="${h}" aria-hidden="true"><rect x="0" y="4" width="${w}" height="2" fill="var(--grid)"/><rect x="${x0.toFixed(1)}" y="1" width="${len.toFixed(1)}" height="8" rx="2" fill="${color}"/><line x1="${mid}" x2="${mid}" y1="0" y2="${h}" stroke="var(--axis)"/></svg>`;
  };
  C.scoreBar = function (z, w) {
    w = w || 44;
    const h = 10, mid = w / 2;
    if (!isNum(z)) return '';
    const len = Math.max(1, Math.min(1, Math.abs(z) / 5) * mid);
    const x0 = z >= 0 ? mid : mid - len;
    return `<svg width="${w}" height="${h}" aria-hidden="true"><rect x="${x0.toFixed(1)}" y="1" width="${len.toFixed(1)}" height="8" rx="2" fill="${C.scoreColor(z)}"/><line x1="${mid}" x2="${mid}" y1="0" y2="${h}" stroke="var(--axis)"/></svg>`;
  };
})();
