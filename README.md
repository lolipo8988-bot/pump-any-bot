![make.fun competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)
![pump-any-bot rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lolipo8988-bot/pump-any-bot/rank.svg)
![pump-any-bot reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/lolipo8988-bot/pump-any-bot/reward.svg)

# pump-any-bot

A paper-trading bot for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun.

Paper trading only — the bot runs inside the `agent-fun/replay/v2` replay harness on recorded pump.fun market data. It never touches a real wallet and never sends a real transaction.

## Strategy

Diversified short-window momentum: a coin becomes a buy when, over the last 40 slots, it shows net SOL inflow (≥ 0.5 SOL), at least 3 buys from at least 3 distinct buyers, a price up 2%–200% and sitting near its window high, on a curve with 1.5–80 SOL of real reserves and at least 500 slots of age, net inflow of at least 4 SOL over the last 30 slots from at least 8 buys and 8 distinct buyers, and a price up 8%–60% sitting at 97% of its window high. Entries start at 0.05 SOL (capped by the harness's 1%-of-real-reserve order cap) with pyramid adds into continued strength, up to 0.2 SOL per position and 3 momentum positions at once. A realized-loss circuit breaker halts new momentum entries after ~1.2 SOL of losses.

Exits sell the whole position on the first of: +18% hard take-profit, −10% stop loss against cost, a 12% trailing stop armed after +3%, net outflow over the last 15 slots (momentum fade), or 300 slots held.

Guardrail rotation: while fewer than 24 distinct coins have completed a round trip, the bot periodically buys a small lot (0.02 SOL, never below the 0.01 SOL round-trip minimum) of the most liquid traded coin it has not round-tripped yet and sells it on the next batch — keeping the run above the competition's 20-coin round-trip guardrail without chasing it.

Everything is deterministic: no clock, no randomness, no network. The same batch stream always produces the same orders.

## Layout

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts` on Node 22)
- `vendor/makefun-bot.ts` — the kit's `agent-fun/replay/v2` SDK shim, vendored byte for byte

## Run locally

With the competition kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver docker --bundle <transcripts.tar.gz>
```

## License

MIT — see [LICENSE](LICENSE).
