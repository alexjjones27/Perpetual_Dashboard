# Equity Perps Monitor

A live, single-page dashboard for equity perpetuals, built to sit on a monitor all day. It uses
Hyperliquid's public API (HIP-3 builder-deployed markets such as `xyz`, the largest equity-perp
venue, plus any other active HIP-3 venue) and turns raw perp activity into normalized flow,
positioning, funding, basis and liquidity metrics. It has no backtest; everything is computed
from live and recent data.

No build step, no API key, no server. Plain HTML, CSS and JavaScript.

## Run it

Either:

- **Open `index.html` directly** in Chrome, Edge, Firefox or Safari (double-click works), or
- **Serve the folder** (recommended for a monitor that stays up):
  `python3 -m http.server 8000` and open <http://localhost:8000>.

Or host it at a permanent URL with **GitHub Pages** (free for this public repo):

1. Open the repo's **Settings → Pages**.
2. Under *Build and deployment*, set Source to **Deploy from a branch**, pick branch
   `claude/serene-cray-218h6t` and folder `/ (root)`, then **Save**.
3. After a minute the dashboard is live at
   <https://alexjjones27.github.io/Perpetual_Dashboard/>. Every push to that branch redeploys it.

The `.nojekyll` file tells Pages to serve the files as they are, without a Jekyll build.

Press F11 for full screen. The layout targets 1920×1080 and stacks on narrow screens.

First load takes about 5 minutes to pull candle and funding history for the 40 tracked
markets (biggest first; the "Warm-up" pill counts progress). History is cached in the browser,
so later reloads are near-instant. OI and price-change windows build from live snapshots: the
5m view is ready after about 5 minutes, 15m after 15, 1h after an hour. Snapshots persist
across reloads for up to 4 hours.

Run **one tab per network** (per IP address): Hyperliquid rate-limits by IP, and the dashboard
budgets its requests (about 1,050 of the allowed 1,200 weight per minute) assuming it is the
only client.

## What is on screen

| Area | Contents |
|---|---|
| Header | US cash-session state (regular / pre / after-hours / overnight / weekend, countdown, monthly OPEX flag), WebSocket and REST health, request budget, warm-up progress |
| KPI strip | 24h notional, total OI and 1h change, OI-weighted funding, abnormal-volume breadth, net taker flow, median basis, index-perp move, BTC/ETH as the crypto common-shock control |
| Scorecard | One row per tracked market: price moves, notional volume, abnormal-volume z, taker-flow imbalance and z, ΔOI, price×OI regime, funding APR / percentile / surprise z, basis, impact spread, composite score and quintile. Click a column to sort; click a row for detail |
| Positioning map | ΔPrice vs ΔOI over the selected window, quadrants labelled (new longs, new shorts, short covering, long liquidation), bubble size = OI notional, color = composite score |
| Detail panel | Full stat grid, score breakdown, 5m volume vs model-expected volume, cumulative taker flow (CVD), basis history, 20-day funding history with 5th–95th percentile band, perp-vs-oracle lead-lag correlogram, cross-venue table when the same ticker lists on several venues |
| Alerts | Event-conditioned triggers with a 20-minute cooldown per market |

Filters (window 5m / 15m / 1h, asset class, ticker search, include untracked listings) sit above
everything and scope the table and the map together.

## Methodology

All metrics are notional (USD), never contract counts.

**Abnormal volume (conditional residual).** For each tracked market, 4 days of 5-minute candles
fit `log(1 + notional) = a[bucket] + b1·log(1 + |r| bps) + b2·log(1 + lagged 1h RV bps) + e`,
where `bucket` is a 30-minute ET time-of-day slot (weekday/weekend), pooled to the coarse
session when a slot has fewer than 8 bars. AbnVol z is the residual over its robust scale
(1.4826·MAD). The table shows the mean z of the last three completed bars (15m). Because
volatility is a regressor, a bar that is busy only because price moved does not read as unusual.
*Idiosyncratic* AbnVol subtracts the cross-sectional median z (common-shock control), and
*breadth* is the share of tracked markets at z ≥ 2.

**Signed taker flow.** From the live trade stream (Hyperliquid's trade `side` is the aggressor).
Imbalance = (taker buy − taker sell) / total over the window. Flow z = (buy − sell) /
√(Σ trade notional²), the z of signed notional under a random-sign null; order splitting
inflates it, so read it as a ranking rather than a p-value. Net flow vs typical divides net
notional by the median volume for the same window length.

**Open interest × price.** ΔOI uses OI in base units (price-neutral). Regimes: price up + OI up
= new longs, price up + OI down = short covering, price down + OI up = new shorts, price down +
OI down = long liquidation; moves under 0.05% (price) or 0.15% (OI) are flat.

**Funding.** Current hourly funding (APR = rate × 8760), its percentile and robust z against
20 days of hourly settlements (the "funding surprise"), and its change vs 1h, 8h and 24h ago.
Cross-venue OI-weighted funding appears in the detail panel when a ticker lists on more than
one venue.

**Basis and price discovery.** Basis = (mark − oracle) / oracle. The oracle is the venue's
reference price, which tracks the underlying equity or index during its trading hours; outside
them it can follow the venue itself, so basis then reflects oracle methodology rather than
informed trading. Premium z compares the current premium with 20 days of hourly premium
samples. The lead-lag panel correlates order-book-mid returns at t with oracle returns at t + k
(10-second steps for the first hour, then 1-minute steps); positive k with high correlation
means the perp moved first. Oracle updates are discrete, so treat it as descriptive.

**Liquidity.** Quoted spread and depth within ±10 / ±50 bps from the order book (rotating
polls), impact spread from the venue's impact prices, and Amihud illiquidity (mean |5m return|
in bps per $1M traded over 24h).

**Composite score.**

```
PerpSignalScore = w1·Z(signed flow) + w2·Z(ΔOI × sign(r)) + w3·Z(funding surprise)
                + w4·Z(basis) − w5·Z(illiquidity)
```

Each input is first normalized per market (flow z, % OI change, time-series z of funding and
premium against the market's own history, log impact spread), then robust-z'd across the
tracked markets (median/MAD, capped at ±3). Scores need at least two of the four directional
components. Quintiles (Q1 lowest, Q5 highest) rank the tracked set.

The illiquidity term defaults to **shrink**: thin books scale the score toward zero rather than
subtracting a constant. The literal formula (subtract `w5·Z(illiquidity)`) is one setting
away, but with it liquid index perps score high simply for being liquid and thin names score
low regardless of direction. Weights, the illiquidity mode and the tracked-market count are in
Settings.

**Alerts.**

| Label | Trigger (within the selected window) |
|---|---|
| Confluence | \|flow z\| ≥ 2.5 and OI up ≥ 0.5% and \|funding z\| ≥ 1.5: the working hypothesis |
| Volume only / Notable | AbnVol z ≥ 3, tagged by whether flow or OI confirms it |
| Stretch | Funding at the 98th/2nd percentile with \|z\| ≥ 2, or \|basis\| ≥ 20 bps with premium z ≥ 3 |
| Notable | \|ΔOI\| ≥ 2% with a non-flat regime |
| Market-wide | ≥ 30% of tracked markets at AbnVol z ≥ 2: treat single-name signals as common-shock driven |

## Limits

- No cash-equity feed: the venue oracle stands in for the underlying. There is no equity volume,
  short interest, borrow cost or options skew; those need a market-data vendor.
- No earnings or macro calendar; the session clock does not model exchange holidays.
- Flow history starts when the dashboard starts (or resumes within 3 minutes of a reload). Flow
  z needs at least 60% of the window covered.
- Asset classes come from a curated ticker map in `js/util.js` (the API has no class field).
- If the WebSocket is down, flow falls back to polling recent trades, which undercounts.

## Files

```
index.html         page shell
css/styles.css     theme tokens (light and dark) and layout
js/util.js         config, formatting, robust statistics, ET session clock, storage
js/api.js          rate-limited REST queue and the WebSocket feed
js/state.js        live state, rolling histories, persistence
js/metrics.js      metric engine, composite score, alerts
js/charts.js       SVG charts with tooltips
js/ui.js           rendering
js/main.js         polling schedules, warm-up, render loop
```
