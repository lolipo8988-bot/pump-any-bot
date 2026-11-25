// pump-any-bot: a paper-trading bot for the pump.fun replay (agent-fun/replay/v2).
// Paper trading only: the harness replays market data, no real wallet, no real funds.
//
// Strategy in one line: diversified short-window momentum entries with hard
// stop / trailing exits, plus small rotation round trips so the run trades at
// least 20 distinct coins with a round trip of at least 0.01 SOL each.
//
// How it reads the wire: the hello message gives the caps (max open positions,
// max order size as a share of a curve's real reserve, max orders per batch),
// then every batch carries one slot of events, fills and marks, and the bot
// answers with the orders for that slot. All decisions are deterministic:
// no clock, no randomness, no network — the same batch stream always yields
// the same orders, so the two grading executions agree byte for byte.

import { LAMPORTS_PER_SOL, runBot, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;

// ---- momentum entry tuning (SOL / slots) ----
const WINDOW = 30; // lookback window in slots for the entry tape
const MIN_AGE = 500; // slots after CreateEvent before a coin is eligible
const MIN_NET_SOL = 4; // net inflow over the window
const MIN_BUYS = 8;
const MIN_BUYERS = 8;
const MIN_PRICE_UP = 0.08;
const MAX_PRICE_UP = 0.6;
const NEAR_HIGH = 0.97;
const MIN_RQ_SOL = 3;
const MAX_RQ_SOL = 60;
const INITIAL_SOL = 0.05;
const ADD_SOL = 0.08;
const STAKE_SOL = 0.2;
const MIN_BUY_SOL = 0.02;
const BUY_SLIP_BPS = 1500;

// ---- exits ----
const STOP_LOSS = 0.10;
const TRAIL = 0.12;
const TRAIL_ARM = 0.03;
const MAX_HOLD = 300; // slots
const COOLDOWN = 600;
const MAX_ENTRIES = 1;

// ---- guardrail rotation (round trips on >= 20 distinct coins) ----
const TARGET_COINS = 24;
const PROBE_SOL = 0.02;
const PROBE_EVERY = 400; // slots between rotation probes while below target
const MAX_MAIN = 3; // leave one of the 5 position slots for rotation probes

interface Trade { slot: number; buy: boolean; sol: number; user: string; price: number }
interface Tape { created: number | null; trades: Trade[]; entries: number; lastExit: number }
interface Held { opened: number; peak: number; invested: number; exiting: boolean; filled: boolean }

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Set<Pubkey>();
const roundTripped = new Set<Pubkey>();
let lastProbeSlot = -1_000_000;
let spentSol = 0; // SOL paid out on filled buys (fees included, from fills)
let receivedSol = 0; // SOL received on filled sells

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (!t) { t = { created: null, trades: [], entries: 0, lastExit: -1_000_000 }; tapes.set(mint, t); }
  return t;
}

function entryOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  let buySol = 0, sellSol = 0, buys = 0, start = -1, high = 0, last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) { start = tr.price; continue; }
    if (start < 0) start = tr.price;
    if (tr.buy) { buySol += tr.sol; buys++; buyers.add(tr.user); } else sellSol += tr.sol;
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (start <= 0 || high <= 0) return false;
  const up = last / start - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / LAMPORTS;
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'sell') { roundTripped.add(f.mint); receivedSol += Number(f.quote_lamports) / LAMPORTS; }
      else spentSol += Number(f.quote_lamports) / LAMPORTS;
    }
    // Circuit breaker: once realized+open cost drag passes ~1.2 SOL of losses,
    // stop opening momentum positions (exits and rotation probes continue).
    const realized = receivedSol - spentSol;
    const haltEntries = realized < -1.2;
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') tapeOf(e.mint).created = e.slot;
      else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user, price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves) });
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - WINDOW - 5) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const pendingMint = new Set<Pubkey>();
    const pendingSell = new Set<Pubkey>();
    for (const p of state.pending.values()) { pendingMint.add(p.order.mint); if (p.order.side === 'sell') pendingSell.add(p.order.mint); }

    // 1) Exits first: stop loss, trailing stop, time limit — sell the whole position.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      if (!pos) {
        if (!pendingMint.has(mint)) { held.delete(mint); const t = tapeOf(mint); if (h.filled) t.lastExit = now; else t.entries--; }
        continue;
      }
      h.filled = true;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const tokens = Number(pos.token_amount);
      const value = (tokens * Number(curve.virtual_quote_reserves)) / (Number(curve.virtual_token_reserves) + tokens) / LAMPORTS * (1 - 0.0125) - txSol;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peak) h.peak = value;
      let exit = h.exiting;
      // Fade exit: net SOL flowing out over the last 15 slots means momentum died.
      const tape = tapes.get(mint);
      if (tape) {
        let net15 = 0;
        for (let i = tape.trades.length - 1; i >= 0; i--) {
          const tr = tape.trades[i]!;
          if (tr.slot <= now - 15) break;
          net15 += tr.buy ? tr.sol : -tr.sol;
        }
        if (net15 < -1.0) exit = true;
      }
      if (value >= cost * 1.18) exit = true; // hard take-profit: bank the spike
      if (value < cost * (1 - STOP_LOSS)) exit = true;
      if (h.peak >= cost * (1 + TRAIL_ARM) && value < h.peak * (1 - TRAIL)) exit = true;
      if (now - h.opened > MAX_HOLD) exit = true;
      if (!exit || pendingSell.has(mint) || orders.length >= cap) continue;
      h.exiting = true;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // 2) Rotation probes: sell as soon as the probe buy has landed.
    for (const mint of [...probes]) {
      const pos = state.positions.get(mint);
      if (!pos) { if (!pendingMint.has(mint)) probes.delete(mint); continue; }
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || pendingMint.has(mint) || orders.length >= cap) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // 3) Momentum entries and one pyramid add into strength.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap || slotsLeft <= 0) break;
      if (held.size >= MAX_MAIN && !held.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete || pendingMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (!h && haltEntries) continue;
      if (!h) {
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (!entryOk(t, now, rqSol)) continue;
        want = INITIAL_SOL;
      } else {
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        if (!entryOk(t, now, rqSol)) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + txSol;
      if (!h) { held.set(mint, { opened: now, peak: 0, invested: amount, exiting: false, filled: false }); t.entries++; slotsLeft--; }
      else h.invested += amount;
    }

    // 4) Guardrail rotation: while fewer than TARGET_COINS coins have completed
    // a round trip, periodically buy a small lot of a liquid coin we have not
    // round-tripped yet and sell it on the next batch (step 2 above).
    if (roundTripped.size < TARGET_COINS && now - lastProbeSlot >= PROBE_EVERY && slotsLeft > 0 && probes.size === 0) {
      let best: Pubkey | null = null; let bestRq = 0;
      for (const mint of traded) {
        if (roundTripped.has(mint) || held.has(mint) || pendingMint.has(mint) || state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const rq = Number(curve.real_quote_reserves);
        if (rq > bestRq) { bestRq = rq; best = mint; }
      }
      if (best !== null && orders.length < cap) {
        const capSol = Number(state.maxBuyLamports(best)) / LAMPORTS;
        const amount = Math.min(capSol, PROBE_SOL);
        if (amount >= 0.01 && free >= amount + 2 * txSol) {
          orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.add(best);
          lastProbeSlot = now;
        }
      }
    }
    return orders;
  },
});
