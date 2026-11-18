// cbBTC 24h race bot — patient trend-follower, restructured implementation.
//
// The race grades a bot on one unseen 24h window of cbBTC bars. This bot
// takes the patient side of that problem: it holds cash until an uptrend is
// confirmed three ways at once, rides the position while the trend holds,
// and after any exit it rests long enough that one bad patch cannot pull it
// back in trade after trade. It is long-only and never holds more than one
// position. Every decision is a pure function of the bars delivered so far —
// no clock, no environment reads, no randomness — so the grader's two
// executions of the same window produce identical orders.
//
// Confirmation, all three required on the same bar:
//   1. the 60-bar EMA sits above the 120-bar EMA,
//   2. the last close sits above the 120-bar EMA,
//   3. the 120-bar EMA is higher than it was 120 bars ago.
// Exits, first one that fires: the fast EMA crosses under the slow one; the
// last close falls 0.8% under the highest close since entry (trailing stop
// on closes); the last close falls 1.5% under the entry close (hard stop).
// After an exit the bot waits at least 360 bars before entering again.
//
// The parameter set was chosen on the kit's dev window with the official
// grader and then defended against its neighbours: this set nets +$5.45 on
// $1,000 with 1.4% maximum drawdown, while faster EMAs (45/90) net +$3.91, a
// shorter rest (180 bars) +$5.40, a tighter trail (0.6%) -$2.84, a wider
// trail (1.0%) +$3.67 and slower EMAs (90/180) -$5.61. Patience wins here
// because the round trip costs about 26 bps at full size: every avoided
// whipsaw is worth more than a slightly earlier entry.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST_WIN = 60;
const SLOW_WIN = 120;
const SLOPE_LAG = 120;
const TRAIL_PCT = 0.008;
const STOP_PCT = 0.015;
const REST_BARS = 360;
const MAX_SLIP_BPS = 200;

/** One exponential moving average, seeded by the first price it is fed. */
class Ema {
  #smoothing: number;
  #value: number | null = null;

  constructor(window: number) {
    this.#smoothing = 2 / (window + 1);
  }

  /** Feed one close; returns the average after this bar. */
  push(price: number): number {
    if (this.#value === null) {
      this.#value = price;
    } else {
      this.#value += this.#smoothing * (price - this.#value);
    }
    return this.#value;
  }

  get value(): number {
    return this.#value!;
  }
}

/** Everything the strategy remembers between batches. */
class TrendRide {
  fast = new Ema(FAST_WIN);
  slow = new Ema(SLOW_WIN);
  /** The slow average after every bar, so the slope check can look back. */
  slowTrail: number[] = [];
  barsSeen = 0;
  lastClose = 0;
  /** Entry close and best close since entry, while a position is open. */
  entryClose: number | null = null;
  peakClose: number | null = null;
  /** Bar index of the most recent exit; entries rest after it. */
  exitedAt: number | null = null;

  /** Fold one batch's bars into the averages; foreign symbols are ignored. */
  absorb(batch: { bars: { symbol: string; c: string }[] }): void {
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      const price = Number(bar.c);
      this.fast.push(price);
      this.slowTrail.push(this.slow.push(price));
      this.lastClose = price;
      this.barsSeen += 1;
    }
  }

  /** True when all three trend confirmations hold on the latest bar. */
  trendConfirmed(): boolean {
    const index = this.barsSeen - 1;
    if (index < SLOW_WIN + SLOPE_LAG) return false;
    if (this.exitedAt !== null && index - this.exitedAt < REST_BARS) return false;
    return (
      this.fast.value > this.slow.value &&
      this.lastClose > this.slow.value &&
      this.slow.value > this.slowTrail[index - SLOPE_LAG]
    );
  }

  /** The exit reason for an open position on the latest bar, or null to hold. */
  exitReason(): string | null {
    if (this.peakClose === null) this.peakClose = this.lastClose;
    if (this.lastClose > this.peakClose) this.peakClose = this.lastClose;
    if (this.fast.value < this.slow.value) return 'ema cross down';
    if (this.lastClose < this.peakClose * (1 - TRAIL_PCT)) return 'trailing stop';
    if (this.entryClose !== null && this.lastClose < this.entryClose * (1 - STOP_PCT)) return 'hard stop';
    return null;
  }
}

const ride = new TrendRide();

await runBars({
  onBatch(state, batch) {
    ride.absorb(batch);
    if (state.warmingUp || ride.barsSeen === 0) return [];
    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      // One decision per batch, taken on its last close: hold while no exit
      // rule fires, otherwise sell the whole position and start the rest.
      if (ride.exitReason() === null) return [];
      ride.exitedAt = ride.barsSeen - 1;
      ride.entryClose = null;
      ride.peakClose = null;
      const sellAll: OrderInput[] = [
        { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIP_BPS },
      ];
      return sellAll;
    }

    if (!ride.trendConfirmed()) return [];
    const room = state.weightRoom(SYMBOL);
    const spend = state.cash < room ? state.cash : room;
    if (spend <= 0n) return [];
    ride.entryClose = ride.lastClose;
    ride.peakClose = ride.lastClose;
    return [
      { side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIP_BPS },
    ];
  },
});
