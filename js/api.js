/* Hyperliquid transport: a weight-aware REST scheduler and a self-healing WebSocket feed. */
(function () {
  'use strict';
  const EPM = window.EPM;
  const cfg = EPM.config;

  // ---------- REST: weight-aware priority queue over a sliding 60s window ----------
  // Weights follow the published info-endpoint rules: l2Book/allMids 2, most others 20,
  // plus 1 per 60 candles or per 20 funding/trade rows returned.
  const Rest = (EPM.rest = {
    budget: cfg.weightBudgetPerMin,
    spent: [],          // [ts, weight]
    queue: [],          // {weight, prio, body, resolve, reject, key}
    inflight: 0,
    maxInflight: 4,
    backgroundShare: 0.85,
    pausedUntil: 0,
    lastOk: 0,
    lastErr: null,
    errors: 0,
  });

  Rest.used = function () {
    const cut = Date.now() - 60000;
    while (Rest.spent.length && Rest.spent[0][0] < cut) Rest.spent.shift();
    let s = 0;
    for (const x of Rest.spent) s += x[1];
    return s;
  };

  Rest.pending = (key) => Rest.queue.some((q) => q.key === key);

  // prio: 0 = live snapshot, 1 = selected market, 2 = warm-up history, 3 = background refresh
  Rest.info = function (body, weight, prio, key) {
    return new Promise((resolve, reject) => {
      Rest.queue.push({ body, weight: weight || 20, prio: prio ?? 2, resolve, reject, key: key || null, t: Date.now() });
      Rest.queue.sort((a, b) => a.prio - b.prio || a.t - b.t);
      Rest.pump();
    });
  };

  Rest.pump = function () {
    while (Rest.queue.length && Rest.inflight < Rest.maxInflight) {
      const now = Date.now();
      if (now < Rest.pausedUntil) { setTimeout(Rest.pump, Rest.pausedUntil - now + 20); return; }
      const job = Rest.queue[0];
      // History and background jobs may only use part of the budget, so live snapshots never starve.
      const cap = job.prio >= 2 ? Rest.budget * Rest.backgroundShare : Rest.budget;
      if (Rest.used() + job.weight > cap) {
        const wait = Rest.spent.length ? Math.max(200, Rest.spent[0][0] + 60000 - now + 50) : 500;
        clearTimeout(Rest._t);
        Rest._t = setTimeout(Rest.pump, Math.min(wait, 3000));
        return;
      }
      Rest.queue.shift();
      Rest.spent.push([now, job.weight]);
      Rest.inflight++;
      run(job);
    }
  };

  async function run(job) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(cfg.infoUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job.body),
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (res.status === 429) {
        // Back off hard and lower our own budget for the rest of the session.
        Rest.pausedUntil = Date.now() + 15000;
        Rest.budget = Math.max(400, Math.round(Rest.budget * 0.8));
        throw new Error('rate limited (429)');
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      Rest.lastOk = Date.now();
      Rest.errors = 0;
      job.resolve(data);
    } catch (e) {
      Rest.lastErr = { t: Date.now(), msg: String(e.message || e) };
      Rest.errors++;
      job.reject(e);
    } finally {
      Rest.inflight--;
      Rest.pump();
    }
  }

  EPM.api = {
    perpDexs: () => Rest.info({ type: 'perpDexs' }, 20, 0, 'perpDexs'),
    metaAndAssetCtxs: (dex, prio) => Rest.info(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, 20, prio ?? 0, 'ctx:' + (dex || 'main')),
    l2Book: (coin, prio) => Rest.info({ type: 'l2Book', coin }, 2, prio ?? 3, 'book:' + coin),
    candles: (coin, interval, startTime, endTime, prio) => {
      const n = Math.ceil((endTime - startTime) / (5 * 60000));
      return Rest.info({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }, 20 + Math.ceil(n / 60), prio ?? 2, 'candles:' + coin);
    },
    funding: (coin, startTime, prio) => {
      const n = Math.min(500, Math.ceil((Date.now() - startTime) / 3600000));
      return Rest.info({ type: 'fundingHistory', coin, startTime }, 20 + Math.ceil(n / 20), prio ?? 2, 'funding:' + coin);
    },
    recentTrades: (coin, prio) => Rest.info({ type: 'recentTrades', coin }, 21, prio ?? 3, 'trades:' + coin),
  };

  // ---------- WebSocket feed ----------
  const WS = (EPM.ws = {
    sock: null,
    subs: new Map(),     // key -> subscription object
    handlers: {},        // channel -> fn(data)
    state: 'idle',       // idle | connecting | open | down
    lastMsg: 0,
    retries: 0,
    openedAt: 0,
  });
  const subKey = (s) => s.type + ':' + (s.coin || '') + ':' + (s.interval || '');

  WS.on = (channel, fn) => (WS.handlers[channel] = fn);

  WS.connect = function () {
    if (WS.sock && (WS.state === 'open' || WS.state === 'connecting')) return;
    WS.state = 'connecting';
    let sock;
    try { sock = new WebSocket(cfg.wsUrl); } catch (e) { WS.state = 'down'; scheduleReconnect(); return; }
    WS.sock = sock;
    sock.onopen = () => {
      WS.state = 'open';
      WS.openedAt = Date.now();
      WS.lastMsg = Date.now();
      WS.retries = 0;
      for (const s of WS.subs.values()) send({ method: 'subscribe', subscription: s });
    };
    sock.onmessage = (ev) => {
      WS.lastMsg = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      const fn = WS.handlers[msg.channel];
      if (fn) fn(msg.data);
    };
    sock.onclose = () => { if (WS.sock === sock) { WS.state = 'down'; WS.sock = null; scheduleReconnect(); } };
    sock.onerror = () => { try { sock.close(); } catch (e) { /* ignore */ } };
  };

  function scheduleReconnect() {
    WS.retries++;
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(WS.retries, 5)));
    clearTimeout(WS._rt);
    WS._rt = setTimeout(WS.connect, delay);
  }

  function send(obj) {
    if (WS.sock && WS.state === 'open') {
      try { WS.sock.send(JSON.stringify(obj)); } catch (e) { /* reconnect will resubscribe */ }
    }
  }

  WS.subscribe = function (s) {
    const k = subKey(s);
    if (WS.subs.has(k)) return;
    WS.subs.set(k, s);
    send({ method: 'subscribe', subscription: s });
  };
  WS.unsubscribe = function (s) {
    const k = subKey(s);
    if (!WS.subs.has(k)) return;
    WS.subs.delete(k);
    send({ method: 'unsubscribe', subscription: s });
  };

  // Keepalive: the server drops connections silent for 60s. A stale socket is recycled.
  setInterval(() => {
    if (WS.state !== 'open') return;
    send({ method: 'ping' });
    if (Date.now() - WS.lastMsg > 75000 && WS.sock) {
      try { WS.sock.close(); } catch (e) { /* ignore */ }
    }
  }, 25000);

  WS.healthy = () => WS.state === 'open' && Date.now() - WS.lastMsg < 70000;
})();
