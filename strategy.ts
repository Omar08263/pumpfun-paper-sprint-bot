// Broad launch sniper + early-surge rider for the pump.fun bonding-curve replay
// (agent-fun/replay/v2). Written from scratch for the boothlord sprint.
//
// Why this shape (from the dev window: 1222 coins, 126,801 trades):
// - The final window is only 6 hours, so the bot must trade BROADLY: the guardrail needs
//   round trips >= 0.01 SOL on >= 20 distinct coins, and a selective 2x-cross bot only
//   reached ~21 coins in the whole 24h+ dev window (~5 in 6h: a guardrail fail). The
//   launch flip reaches ~90 coins in dev (~22 in 6h) at a small known cost (~-0.12 SOL),
//   which buys the guardrail.
// - Two entry families share one exit machine:
//   (A) Launch flip: buy in the first few slots after CreateEvent when the launch passes
//       a rug filter (small creator buy, creator has not sold, at most 1 distinct buyer so
//       it is not a bundle waiting to dump, at least 2 SOL real in the curve). Most of
//       these die fast, so the stake is small (0.05 SOL) and the flip is 10 slots with a
//       +15% take-profit and a -12% stop.
//   (B) Migration ride: buy when a coin's real SOL reserve first reaches 40 SOL (76 coins
//       in dev, 35 of them completed = 46%). One ride at a time, 0.5 SOL, +100%
//       take-profit, -15% stop, trailing stop armed at +50% / -30% drop, up to 5000 slots
//       (completion closes it). This is the profit engine: dev net +0.41 SOL with the
//       launch flip included (ride-only +0.12, launch-only -0.12).
// - The surge family (buy the first 2x cross) is OFF by design: sweeps showed every
//   surge config loses money — buying the cross is buying the top (40 of the 47 coins
//   that later reach a 5x peak dip below -25% first, median 540 slots cross-to-peak).
// - Deterministic by construction: no clock, no randomness, no I/O; every decision is a
//   pure function of the batches. All price comparisons are cross-multiplied BigInts.
//   Candidates are visited in a fixed order (flow desc, then mint asc).

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/agentfun-bot.ts';

export interface Params {
  // --- launch entry (family A) ---
  /** Oldest age (slots since CreateEvent) at which a launch buy may be decided. */
  launchMaxAge: number;
  /** SOL to put into one launch position. */
  launchStakeSol: number;
  /** Real SOL reserve window at decision time. */
  launchMinRealSol: number;
  launchMaxRealSol: number;
  /** Creator's own buys in the create slot must be at most this (SOL). */
  launchMaxDevBuySol: number;
  /** Distinct non-creator buyers seen before entry, at most (anti-bundle). */
  launchMaxBuyers: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  launchMinBuyers: number;
  /** Skip the coin when the creator sold before entry. */
  launchSkipDevSold: boolean;
  /** Lamports sold by others / lamports bought, at most (bps). */
  launchMaxSellRatioBps: number;
  // --- surge entry (family B) ---
  /** First crossing of create price x surgeMultBps/10000, in slots [surgeMinAge, surgeMaxAge]. */
  surgeMultBps: number;
  surgeMinAge: number;
  surgeMaxAge: number;
  /** Cumulative buy SOL since create required at decision time. */
  surgeMinBuySol: number;
  /** Distinct buyers since create required. */
  surgeMinBuyers: number;
  /** SOL to put into one surge position. */
  surgeStakeSol: number;
  /** Real SOL reserve cap at surge entry. */
  surgeMaxRealSol: number;
  // --- sizing ---
  /** Most SOL at cost in one position (launch + adds). */
  maxPositionSol: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldownSlots: number;
  /** Most entries per coin over the run. */
  maxEntriesPerCoin: number;
  // --- exits ---
  /** Sell half the position once it is worth this much over its cost (bps); 0 = off. */
  partialTpBps: number;
  /** Share of the position the partial take-profit sells (bps). */
  partialTpPartBps: number;
  /** Exit the whole position when it is worth this much over its cost (bps); 0 = off. */
  takeProfitBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  stopLossBps: number;
  /** Trailing stop arms once value reaches cost x (1 + trailArmBps/10000). */
  trailArmBps: number;
  /** Trailing stop exits on a fall of trailBps from the best value. */
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHoldSlots: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots; 0 = off. */
  staleSlots: number;
  /** Exit when net recorded flow over exitFlowWindow slots is below -exitFlowSol. */
  exitFlowWindow: number;
  exitFlowSol: number;
  // --- migration-ride entry (family C) ---
  /** Buy when a coin's real SOL reserve first reaches this (SOL): it is close to the
   *  ~85 SOL migration. On dev, R>=40: 76 coins, 35 completed (46%); R>=60: 47 coins,
   *  35 completed (74%). The ride is the edge; the exits below are wide on purpose. */
  rideRqSol: number;
  /** SOL to put into one ride position (capped by the 1%-of-reserve rule). */
  rideStakeSol: number;
  /** Most ride positions open at once (the rest of caps.max_open_positions stays for
   *  launch/surge, so a slow ride never crowds the broad families out). */
  maxRidePositions: number;
  /** Ride exits: stop loss, trailing arm/drop, max hold, full take-profit (0 = off). */
  rideSlBps: number;
  rideTrailArmBps: number;
  rideTrailBps: number;
  rideMaxHoldSlots: number;
  rideTpBps: number;
  // --- guardrail pacing ---
  /** Target distinct coins over paceSeconds of block time; loosen the surge trigger after paceLoosenAfterSec when behind. */
  targetCoins: number;
  paceSeconds: number;
  paceLoosenAfterSec: number;
  /** Loosened surge multiplier (bps) when behind pace. */
  looseMultBps: number;
  /** Loosened launch max-buyers when behind pace. */
  looseLaunchMaxBuyers: number;
}

export const DEFAULT_PARAMS: Params = {
  launchMaxAge: 5,
  launchStakeSol: 0.05,
  launchMinRealSol: 2,
  launchMaxRealSol: 30,
  launchMaxDevBuySol: 2.5,
  launchMaxBuyers: 1,
  launchMinBuyers: 0,
  launchSkipDevSold: true,
  launchMaxSellRatioBps: 10_000,
  surgeMultBps: 20_000,
  surgeMinAge: 10,
  surgeMaxAge: 200,
  // Surge family OFF (sweeps: every surge config lost money on dev; buying the 2x cross
  // is buying the top — 40/47 of the 5x-winners dip below -25% first).
  surgeMinBuySol: 1_000_000,
  surgeMinBuyers: 8,
  surgeStakeSol: 0.12,
  surgeMaxRealSol: 60,
  maxPositionSol: 0.6,
  maxExposureSol: 6,
  buySlippageBps: 5000,
  cooldownSlots: 150,
  maxEntriesPerCoin: 2,
  // Launch exits: a 10-slot flip, +15% take-profit, -12% stop, no trail, no partial.
  partialTpBps: 0,
  partialTpPartBps: 5000,
  takeProfitBps: 1500,
  stopLossBps: 1200,
  trailArmBps: 1_000_000,
  trailBps: 1000,
  maxHoldSlots: 10,
  exitOnDevSell: true,
  staleSlots: 0,
  exitFlowWindow: 30,
  exitFlowSol: 1_000_000,
  // Migration ride: R>=40 SOL, one at a time, +100% take-profit, -15% stop,
  // trailing arm +50% / drop -30%, hold up to 5000 slots (completion closes it).
  rideRqSol: 40,
  rideStakeSol: 0.5,
  maxRidePositions: 1,
  rideSlBps: 1500,
  rideTrailArmBps: 5000,
  rideTrailBps: 3000,
  rideMaxHoldSlots: 5000,
  rideTpBps: 10_000,
  targetCoins: 40,
  paceSeconds: 21_600,
  paceLoosenAfterSec: 7200,
  looseMultBps: 15_000,
  looseLaunchMaxBuyers: 8,
};

const BPS = 10_000n;
/** Curve fee: protocol 95 bps + creator 30 bps (fallbacks; the value math uses 125 bps). */
const CURVE_FEE_BPS = 125n;
const LAMPORTS = 1_000_000_000n;

const solToLamports = (sol: number): bigint => BigInt(Math.round(sol * 1e9));

interface Tick {
  slot: number;
  buy: boolean;
  lamports: bigint;
  user: string;
}

interface Coin {
  created: number | null;
  creator: string;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<string>;
  buyLamports: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  recent: Tick[];
  entries: number;
  lastExit: number;
  done: boolean;
  complete: boolean;
  /** A migration-ride buy was already taken on this coin. */
  rode: boolean;
}

interface Held {
  opened: number;
  /** Best net value seen (lamports), for the trailing stop. */
  peak: bigint;
  invested: bigint;
  exiting: boolean;
  filled: boolean;
  tookPartial: boolean;
  family: 'launch' | 'surge' | 'ride';
  /** This position's own exit settings (launch/surge share the shared ones; rides are wide). */
  slBps: number;
  trailArmBps: number;
  trailBps: number;
  holdSlots: number;
  tpBps: number;
  partialBps: number;
}

/** Net lamports a sale of `tokens` against (vq, vt) pays after curve fees. */
function saleValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** Net flow (buys minus sells, lamports) over the last `w` slots, pruning older ticks. */
function flowOver(c: Coin, now: number, w: number): bigint {
  const from = now - w;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  for (const t of c.recent) net += t.buy ? t.lamports : -t.lamports;
  return net;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  let myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        created: null, creator: '', vq0: 0n, vt0: 1n, devBuy: 0n, devSold: false,
        buyers: new Set(), buyLamports: 0n, soldByOthers: 0n, lastTradeSlot: -1,
        recent: [], entries: 0, lastExit: -1e12, done: false, complete: false, rode: false,
      };
      coins.set(mint, c);
    }
    return c;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const txFee = state.txFeeLamports();
      const traded = new Set<Pubkey>();

      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (e.block_time > lastTime!) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint);
          c.created = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint);
          const lamports = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, buy: e.is_buy, lamports, user: e.user });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.buyLamports += lamports;
            if (isDev && e.slot === c.created) c.devBuy += lamports;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += lamports;
          }
          traded.add(e.mint);
        } else {
          const c = coinOf(e.mint);
          c.complete = true;
          c.done = true;
        }
      }

      for (const f of batch.fills) {
        if (!f.client_id.startsWith('_') && f.status === 'filled') myCoins.add(f.mint);
      }
      for (const mint of [...selling]) {
        let pending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') { pending = true; break; }
        }
        if (!pending) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint)) {
          let pendingBuy = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'buy') { pendingBuy = true; break; }
          }
          if (!pendingBuy) held.delete(mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }
      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };

      // ---- exits first ----
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { opened: now, peak: 0n, invested: BigInt(pos.cost_lamports), exiting: false, filled: true, tookPartial: false, family: 'launch', slBps: p.stopLossBps, trailArmBps: p.trailArmBps, trailBps: p.trailBps, holdSlots: p.maxHoldSlots, tpBps: p.takeProfitBps, partialBps: p.partialTpBps };
          held.set(mint, h);
        }
        const res = reservesOf(mint);
        if (res === undefined) continue;
        const tokens = BigInt(pos.token_amount);
        const basis = BigInt(pos.cost_lamports);
        const value = saleValue(tokens, res.vq, res.vt) - txFee;
        if (value > h.peak) h.peak = value;
        let exit = h.exiting;
        if (basis > 0n) {
          // Partial take-profit: sell half once the position doubles, then let the rest ride.
          if (!h.tookPartial && h.partialBps > 0 && value * BPS >= basis * (BPS + BigInt(h.partialBps))) {
            const part = (tokens * BigInt(p.partialTpPartBps)) / BPS;
            if (part > 0n && part < tokens) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookPartial = true;
              h.peak = 0n;
              continue;
            }
          }
          if (h.tpBps > 0 && value * BPS >= basis * (BPS + BigInt(h.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(h.slBps))) exit = true;
          if (h.peak * BPS >= basis * (BPS + BigInt(h.trailArmBps)) && value * BPS <= h.peak * (BPS - BigInt(h.trailBps))) exit = true;
        }
        if (now - h.opened >= h.holdSlots) exit = true;
        if (c !== undefined && h.family !== 'ride') {
          if (p.exitOnDevSell && c.devSold) exit = true;
          if (p.staleSlots > 0 && now - c.lastTradeSlot >= p.staleSlots) exit = true;
          if (flowOver(c, now, p.exitFlowWindow) < -solToLamports(p.exitFlowSol)) exit = true;
        }
        if (!exit) continue;
        h.exiting = true;
        orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.lastExit = now;
      }

      // ---- entries ----
      const loosened =
        firstTime !== null && lastTime !== null &&
        lastTime - firstTime >= p.paceLoosenAfterSec &&
        myCoins.size < Math.ceil((p.targetCoins * Math.min(1, (lastTime - firstTime) / p.paceSeconds)) || 0);
      const surgeMult = loosened ? p.looseMultBps : p.surgeMultBps;
      const launchMaxBuyers = loosened ? p.looseLaunchMaxBuyers : p.launchMaxBuyers;
      let free = state.freeCashLamports();
      let open = state.committedPositionCount();
      let exposure = 0n;
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        exposure += pos !== undefined ? BigInt(pos.cost_lamports) : h.invested;
      }
      const maxPosition = solToLamports(p.maxPositionSol);
      const maxExposure = solToLamports(p.maxExposureSol);

      // Candidates, strongest surge flow first, deterministic order.
      const surgeCands: { mint: Pubkey; flow: bigint }[] = [];
      for (const mint of traded) {
        if (orders.length >= cap || open >= state.hello.caps.max_open_positions) break;
        const c = coins.get(mint)!;
        if (c.done || c.complete || c.created === null) continue;
        if (held.has(mint) || selling.has(mint)) continue;
        let pending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint) { pending = true; break; }
        }
        if (pending) continue;
        const age = now - c.created;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rqSol = Number(curve.real_quote_reserves) / 1e9;
        // Family C (migration ride) takes priority: real SOL at/above the ride threshold
        // and no ride taken yet on this coin. It ignores the launch/surge age windows and
        // the per-coin entry count (its own `rode` flag makes it once-only).
        if (!c.rode && rqSol >= p.rideRqSol) {
          let rides = 0;
          for (const h of held.values()) if (h.family === 'ride') rides++;
          if (rides >= p.maxRidePositions) continue;
          const stake = solToLamports(p.rideStakeSol);
          const amount = buyAmount(state, mint, stake, maxPosition, maxExposure, exposure, free, txFee);
          if (amount !== null) {
            orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
            free -= amount + txFee;
            exposure += amount;
            held.set(mint, { opened: now, peak: 0n, invested: amount, exiting: false, filled: false, tookPartial: false, family: 'ride', slBps: p.rideSlBps, trailArmBps: p.rideTrailArmBps, trailBps: p.rideTrailBps, holdSlots: p.rideMaxHoldSlots, tpBps: p.rideTpBps, partialBps: 0 });
            c.rode = true;
            c.entries++;
            open++;
          }
          continue;
        }
        if (c.entries >= p.maxEntriesPerCoin || now - c.lastExit < p.cooldownSlots) continue;
        const isLaunch = age <= p.launchMaxAge;
        const isSurge = age >= p.surgeMinAge && age <= p.surgeMaxAge;
        if (!isLaunch && !isSurge) continue;
        if (isLaunch) {
          // Rug filter for the launch family.
          if (rqSol < p.launchMinRealSol || rqSol > p.launchMaxRealSol) continue;
          if (Number(c.devBuy) / 1e9 > p.launchMaxDevBuySol) continue;
          if (p.launchSkipDevSold && c.devSold) continue;
          if (c.buyers.size < p.launchMinBuyers || c.buyers.size > launchMaxBuyers) continue;
          if (c.buyLamports > 0n && c.soldByOthers * BPS > c.buyLamports * BigInt(p.launchMaxSellRatioBps)) continue;
          const stake = solToLamports(p.launchStakeSol);
          const amount = buyAmount(state, mint, stake, maxPosition, maxExposure, exposure, free, txFee);
          if (amount === null) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          free -= amount + txFee;
          exposure += amount;
          held.set(mint, { opened: now, peak: 0n, invested: amount, exiting: false, filled: false, tookPartial: false, family: 'launch', slBps: p.stopLossBps, trailArmBps: p.trailArmBps, trailBps: p.trailBps, holdSlots: p.maxHoldSlots, tpBps: p.takeProfitBps, partialBps: p.partialTpBps });
          c.entries++;
          open++;
        } else {
          // Surge family: collect candidates, strongest first.
          const lhs = curve.virtual_quote_reserves * c.vt0 * BPS;
          const rhs = BigInt(surgeMult) * c.vq0 * curve.virtual_token_reserves;
          if (lhs < rhs) continue;
          if (rqSol > p.surgeMaxRealSol) continue;
          if (c.buyLamports < solToLamports(p.surgeMinBuySol)) continue;
          if (c.buyers.size < p.surgeMinBuyers) continue;
          surgeCands.push({ mint, flow: c.buyLamports });
        }
      }
      surgeCands.sort((a, b) => (a.flow > b.flow ? -1 : a.flow < b.flow ? 1 : a.mint < b.mint ? -1 : 1));
      for (const cand of surgeCands) {
        if (orders.length >= cap || open >= state.hello.caps.max_open_positions) break;
        const c = coins.get(cand.mint)!;
        const stake = solToLamports(p.surgeStakeSol);
        const amount = buyAmount(state, cand.mint, stake, maxPosition, maxExposure, exposure, free, txFee);
        if (amount === null) continue;
        orders.push({ side: 'buy', mint: cand.mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + txFee;
        exposure += amount;
        held.set(cand.mint, { opened: now, peak: 0n, invested: amount, exiting: false, filled: false, tookPartial: false, family: 'surge', slBps: p.stopLossBps, trailArmBps: p.trailArmBps, trailBps: p.trailBps, holdSlots: p.maxHoldSlots, tpBps: p.takeProfitBps, partialBps: p.partialTpBps });
        c.entries++;
        open++;
      }
      return orders;
    },
  };
}

/** Size a buy: the stake, capped by the 1%-of-real-reserve rule (95% of it, for safety),
 *  the per-position cap, the exposure cap and free cash. Null when too small to send. */
function buyAmount(
  state: BotState, mint: Pubkey, stake: bigint, maxPosition: bigint,
  maxExposure: bigint, exposure: bigint, free: bigint, txFee: bigint,
): bigint | null {
  const reserveCap = (state.maxBuyLamports(mint) * 95n) / 100n;
  let amount = stake;
  if (amount > reserveCap) amount = reserveCap;
  if (amount > maxPosition) amount = maxPosition;
  const room = maxExposure - exposure;
  if (amount > room) amount = room;
  if (amount > free - txFee) amount = free - txFee;
  if (amount < 10_000_000n) return null;
  return amount;
}
