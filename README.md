# cbBTC Race Bot — patient trend-follower

Entry for make.fun **btc-race-24h-20261118-1444** ("Race a BTC trading bot
live for 24 hours"). A long-only bot that trades Coinbase Wrapped BTC
(cbBTC) against USDC on 1-minute bars, starting from $1,000 of paper money.
Nothing is traded for real.

## Strategy

One position at a time, and only inside a confirmed uptrend:

- **Entry** — EMA60 above EMA120, the close above EMA120, and EMA120 itself
  rising over the last 120 bars. The full cash balance is deployed, capped
  by the competition's max-weight rule.
- **Exit** — the first of: EMA60 crossing back below EMA120, a 0.8%
  trailing stop from the highest close since entry, or a hard -1.5% stop
  from the entry decision close.
- **Cooldown** — after any exit the bot stays in cash for at least 360 bars
  before it may re-enter, so choppy ranges cannot churn it through fees.

Every decision is a pure function of the bars seen so far — no clock, no
environment, no randomness — so repeated executions on the same data
produce identical orders.

## Dev-window result

Graded locally with the official kit on the published dev window:
net PnL **+$5.45** on $1,000 (4 fills, max drawdown 1.4%), which passes
the dev gate (net PnL above $0) with the cost-sensitivity grade still
positive at +$3.85.

## Layout

- `main.ts` — the bot (Node 22, standard library only).
- `vendor/makefun-bars.ts` — the `agent-fun/bars-replay/v1` shim, a
  byte-identical copy of the kit's `sdk/makefun-bars.ts`.

## License

MIT — see `LICENSE`.
