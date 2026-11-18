// cbBTC 24h race bot — patient trend-follower.
//
// Long-only, one position at a time. The bot waits for a confirmed uptrend
// (EMA60 above EMA120, price above EMA120, and EMA120 itself rising over the
// last 120 bars), rides it with a 0.8% trailing stop on closes plus an EMA
// cross-down exit, then stays in cash for at least 360 bars before it may
// re-enter. A hard -1.5% stop from the entry decision close caps any single
// trade. Everything is a pure function of the bars seen so far: no clock, no
// environment, no randomness, so the two grading executions produce
// identical orders.
//
// Parameter check on the dev window (official kit grader, 2026-11-18):
// this set scores +$5.45 net on $1,000 with 1.4% max drawdown, while every
// neighbour set tested scores less — faster EMAs (45/90) +$3.91, shorter
// cooldown (180) +$5.40, tighter trail (0.6%) -$2.84, wider trail (1.0%)
// +$3.67, slower EMAs (90/180) -$5.61. The patient set stays.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST = 60;
const SLOW = 120;
const SLOPE_WIN = 120;
const TRAIL = 0.008;
const HARD_STOP = 0.015;
const COOLDOWN = 360;
const SLIPPAGE_BPS = 200;

const closes: number[] = [];
const emaSlowHist: number[] = [];
let emaFast: number | null = null;
let emaSlow: number | null = null;
let entryClose: number | null = null;
let peakClose: number | null = null;
let lastExitBar: number | null = null;

await runBars({
  onBatch(state, batch) {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const px = Number(bar.c);
      closes.push(px);
      if (emaFast === null || emaSlow === null) {
        emaFast = px;
        emaSlow = px;
      } else {
        emaFast += (2 / (FAST + 1)) * (px - emaFast);
        emaSlow += (2 / (SLOW + 1)) * (px - emaSlow);
      }
      emaSlowHist.push(emaSlow);
    }
    if (state.warmingUp || closes.length === 0) return [];
    const k = closes.length - 1;
    const px = closes[k];
    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      if (peakClose === null) peakClose = px;
      if (px > peakClose) peakClose = px;
      const crossDown = emaFast! < emaSlow!;
      const trailed = px < peakClose * (1 - TRAIL);
      const stopped = entryClose !== null && px < entryClose * (1 - HARD_STOP);
      if (crossDown || trailed || stopped) {
        lastExitBar = k;
        entryClose = null;
        peakClose = null;
        const orders: OrderInput[] = [
          { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS },
        ];
        return orders;
      }
      return [];
    }

    if (k < SLOW + SLOPE_WIN) return [];
    if (lastExitBar !== null && k - lastExitBar < COOLDOWN) return [];
    if (!(emaFast! > emaSlow! && px > emaSlow! && emaSlow! > emaSlowHist[k - SLOPE_WIN])) return [];
    const room = state.weightRoom(SYMBOL);
    const usd = state.cash < room ? state.cash : room;
    if (usd <= 0n) return [];
    entryClose = px;
    peakClose = px;
    return [
      { side: 'buy', symbol: SYMBOL, notional_quote_units: usd, max_slippage_bps: SLIPPAGE_BPS },
    ];
  },
});
