# pumpfun-paper-sprint-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Omar08263/pumpfun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Omar08263/pumpfun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2). It buys new launches in their first slots through a rug filter and flips them in 10 slots, and rides coins whose real SOL reserve first reaches 40 SOL toward migration with a wide trailing stop. On the dev window it nets +0.41 SOL over 133 round trips on 130 coins (max drawdown 13.8%).

## Strategy

- **Launch flip** (breadth + guardrail): buy at age ≤ 5 slots when the creator bought ≤ 2.5 SOL, has not sold, at most 1 other buyer has shown up, and the curve holds ≥ 2 SOL real. Stake 0.05 SOL, exit at +15% / −12% or after 10 slots.
- **Migration ride** (profit engine): buy when real SOL first reaches 40 SOL — on dev, 76 coins got there and 35 of them completed (46%). One ride at a time, 0.5 SOL, +100% take-profit, −15% stop, trailing stop armed at +50% with a −30% drop, up to 5000 slots (completion closes the position).
- **No surge chasing**: buying the first 2x cross loses money in every sweep — the cross is the top (40 of the 47 coins that later reach a 5x peak dip below −25% first).

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22); the strategy is in `strategy.ts` and the protocol shim is the kit's `vendor/agentfun-bot.ts`. Fully deterministic: no clock, no randomness, no I/O — every decision is a pure function of the batches.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
