import { rankOf, remainingDeck, suitOf, type Card } from './cards';
import { categoryOf, evaluate } from './evaluator';
import { preflopSlices } from './pushfold';
import { handPercentile } from './ranges';
import { SIZE_STATS, sizeBucket, type Read } from './reads';

// --- who the bot is ---------------------------------------------------------------------

// A style is a set of tendencies; the bot never sees anyone's style, only their stats.
export type Style = 'tight' | 'regular' | 'loose-aggressive' | 'calling-station';

export interface Personality {
  style: Style;
  tightness: number; // shifts starting-hand rank: + plays fewer hands
  aggression: number; // 0..1: how often a profitable bet or raise is actually made
  bluff: number; // scales how often a bet that only wins through folds is made
  stickiness: number; // share of the pot a call may lose and still be made
}

export const STYLES: Record<Style, Personality> = {
  tight: { style: 'tight', tightness: 0.06, aggression: 0.45, bluff: 0.35, stickiness: 0 },
  regular: { style: 'regular', tightness: 0, aggression: 0.65, bluff: 0.8, stickiness: 0 },
  'loose-aggressive': { style: 'loose-aggressive', tightness: -0.15, aggression: 0.85, bluff: 1.3, stickiness: 0.04 },
  'calling-station': { style: 'calling-station', tightness: -0.2, aggression: 0.15, bluff: 0.2, stickiness: 0.22 },
};

// How often each style turns up at the table.
const STYLE_MIX: [Style, number][] = [
  ['regular', 0.35], ['tight', 0.2], ['loose-aggressive', 0.2], ['calling-station', 0.25],
];

export function randomPersonality(rng: () => number = Math.random): Personality {
  let r = rng();
  const style = STYLE_MIX.find(([, w]) => (r -= w) < 0)?.[0] ?? 'regular';
  const base = STYLES[style];
  const jitter = (x: number, by: number) => x + (rng() - 0.5) * by;
  return {
    ...base,
    tightness: jitter(base.tightness, 0.04),
    aggression: Math.min(1, Math.max(0, jitter(base.aggression, 0.1))),
    bluff: Math.max(0, jitter(base.bluff, 0.2)),
  };
}

// --- what the bot can see ---------------------------------------------------------------

export interface OpponentView {
  name: string;
  voluntary: boolean; // has called or raised this hand
  acted: boolean;
  allIn: boolean;
  raisesPreflop: number;
  openBehind: number | null; // players still to act when they opened the betting before the flop
  raisesPostflop: number;
  barrels: number; // streets after the flop on which they bet or raised
  raisesOverBet: number; // raises over someone else's bet after the flop
  callsPostflop: number;
  bet: number; // this street
  aggrStreet: boolean; // bet or raised on this street
  committed: number; // this hand
  stack: number; // behind
  read: Read; // their stats so far this session
}

// Everything a bot is allowed to know: its own cards and public information.
export interface BotView {
  hole: Card[];
  board: Card[];
  pot: number;
  toCall: number;
  currentBet: number;
  myBet: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  canRaise: boolean; // false after an all-in too small to reopen the betting
  bigBlind: number;
  opponents: OpponentView[]; // still in the hand
  myCommitted: number; // chips I've put in this hand
  committed: number[]; // chips each other player has put in this hand, folded players included
  me: OpponentView; // how the others see me: my line this hand and my stats
  // Everyone dealt in, clockwise from the button (heads-up the button is the small blind),
  // with their chips at the start of the hand. Absent in hand-built test spots.
  seats?: { name: string; chips: number }[];
  pfAggressor: boolean; // I made the last raise before the flop
  inPosition: boolean; // I act last after the flop among those who can still act
}

export type Decision =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'raise'; to: number };

// --- ranges -----------------------------------------------------------------------------

// What a hand must hold after the flop to be part of a value range, weakest first.
export const NEED = { none: 0, pair: 1, secondPair: 2, topPair: 3, twoPair: 4, trips: 5 } as const;
export type Need = (typeof NEED)[keyof typeof NEED];

export interface RangeModel {
  top: number; // accept starting hands in the top share of all hands
  need: Need; // after the flop: the made hand their betting represents
  draws: boolean; // a flush or open-ended straight draw also fits (bets and calls before the river)
  bluff: number; // share of the range that is air instead: holds nothing that fits
}

// A short all-in is wider than a raise: the shorter the stack, the more hands are
// worth shoving. Assumed, roughly the shape of all-in-or-fold charts.
const shoveRange = (stackBB: number) => Math.min(0.6, 2.5 / Math.max(stackBB, 1));
// Share of callers after the flop who are floating with nothing, not holding a pair or a draw.
// Assumed.
const FLOAT = 0.35;

// Standard opening range by how many players are still to act behind the opener: 1 is the
// small blind, 2 the button, 3 the cutoff, 4 the hijack and so on to under the gun. An open
// from late is wider. The usual full-ring chart, rounded.
export const OPEN_RANGE = [0.45, 0.45, 0.45, 0.28, 0.21, 0.17, 0.14];
const OPEN_FAR = 0.12;
const OPEN_AVERAGE = 0.24; // across the eight seats that can open at a full table
// Heads-up the small blind is the button and acts last after the flop: charts open 65–80%.
// Three-handed the button opens 60–70% at 25 big blinds. Sources vary; assumed, mid-range.
const HEADS_UP_OPEN = 0.72;
const THREE_HANDED_BUTTON_OPEN = 0.62;
// `seated`: players dealt in, when known.
export const openRange = (behind: number, seated?: number) =>
  seated === 2 && behind === 1 ? HEADS_UP_OPEN : seated === 3 && behind === 2 ? THREE_HANDED_BUTTON_OPEN : (OPEN_RANGE[behind] ?? OPEN_FAR);
// A player's raise rate counts every hand they're dealt, the big blind's included, which
// opens nothing: short-handed, the average open across the seats is that much lower.
const openAverage = (seated?: number) => {
  if (seated !== 2 && seated !== 3) return OPEN_AVERAGE;
  let sum = 0;
  for (let b = 1; b < seated; b++) sum += openRange(b, seated);
  return sum / seated;
};

// What each opponent's actions say about their holding, read through their own stats:
// a player who raises 30% of hands has a wider raising range than one who raises 8%.
//
// After the flop, each action represents more (assumed, the usual reading of a line):
// one bet a pair or a draw, a second barrel second pair or better, a third top pair or
// better, a raise over a bet two pair or better (or a draw, before the river), a second
// raise trips or better. The rest of the range is air, at a share taken from their stats:
// the river bluffs they've shown, or for a flop continuation bet, how much more often they
// c-bet than this board hits their range (Bayes: bets beyond the hits are air).
// `pot` (including this street's bets) lets a big bet this street read as stronger: a bet of
// three-quarters of the pot or more represents one step more. Assumed.
export function rangeFor(o: OpponentView, bigBlind: number, board: Card[] = [], pot = 0, seated?: number): RangeModel {
  const r = o.read;
  let top = 1;
  if (o.raisesPreflop >= 2) top = Math.max(0.03, r.pfr.rate * 0.35);
  else if (o.raisesPreflop === 1) {
    // Their raising frequency, scaled for the seat they opened from.
    const seat = o.openBehind === null ? 1 : openRange(o.openBehind, seated) / openAverage(seated);
    top = r.pfr.rate * seat;
  }
  else if (o.voluntary) top = r.vpip.rate; // a blind that checked through can hold anything
  if (o.allIn && o.raisesPreflop > 0) top = Math.max(top, shoveRange(o.committed / bigBlind));
  top = Math.min(1, Math.max(0.02, top));
  const river = board.length >= 5;
  const base = { top, draws: !river };
  if (o.raisesOverBet >= 2) return { ...base, need: NEED.trips, draws: false, bluff: r.bluff.rate * 0.5 };
  if (o.raisesOverBet === 1) return { ...base, need: NEED.twoPair, bluff: r.bluff.rate * 0.5 };
  const big = o.aggrStreet && o.raisesOverBet === 0 && pot > 0 && o.bet >= 0.75 * (pot - o.bet) ? 1 : 0;
  if (o.barrels >= 3) return { ...base, need: big ? NEED.twoPair : NEED.topPair, bluff: r.bluff.rate };
  if (o.barrels === 2) return { ...base, need: big ? NEED.topPair : NEED.secondPair, bluff: r.bluff.rate };
  if (o.barrels === 1 && big) return { ...base, need: NEED.secondPair, bluff: r.bluff.rate };
  if (o.barrels === 1) {
    let bluff = r.bluff.rate;
    if (board.length === 3 && o.raisesPreflop > 0) {
      const c = r.cbet.rate;
      const h = hitRate(top, board);
      if (c > h) bluff = Math.max(bluff, Math.min(0.7, (c - h) / c));
    }
    return { ...base, need: NEED.pair, bluff };
  }
  if (o.callsPostflop > 0) return { ...base, need: NEED.pair, bluff: FLOAT };
  return { top, need: NEED.none, draws: false, bluff: 0 };
}

// Rank of the pair a one-pair hand holds with its hole cards, or -1.
function pairRank(hand: readonly Card[], board: readonly Card[]) {
  const [a, b] = hand.map(rankOf);
  if (a === b) return a;
  const onBoard = new Set(board.map(rankOf));
  return Math.max(onBoard.has(a) ? a : -1, onBoard.has(b) ? b : -1);
}

// Whether a hand belongs to the value part of a range on this board.
export function fits(hand: readonly Card[], board: readonly Card[], need: Need, draws: boolean): boolean {
  if (need === NEED.none) return true;
  const above = categoryOf(evaluate([...hand, ...board])) - categoryOf(evaluate(board));
  if (draws && above < 2 && hasDraw(hand, board)) return true;
  if (need === NEED.trips) return above >= 3;
  if (need === NEED.twoPair || above >= 2) return above >= 2;
  if (above < 1) return false;
  if (need === NEED.pair) return true;
  const ranks = board.map(rankOf).sort((x, y) => y - x);
  return pairRank(hand, board) >= (need === NEED.topPair ? ranks[0] : ranks[1]);
}

// Share of a preflop range (the top `top` of hands) that holds a pair or a draw on this board.
function hitRate(top: number, board: Card[]) {
  const c = combosFor({ top, need: NEED.pair, draws: true, bluff: 0 }, board, board);
  const total = c.value.length + (c.air === c.value ? 0 : c.air.length);
  return c.value.length / Math.max(total, 1);
}

// --- simulation -------------------------------------------------------------------------

const CAT = 16 ** 5; // one hand category in evaluate()'s score

// A flush draw or an open-ended straight draw that uses a hole card.
export function hasDraw(hand: readonly Card[], board: readonly Card[]): boolean {
  if (board.length >= 5) return false;
  const all = [...hand, ...board];
  for (let s = 0; s < 4; s++) {
    const n = all.filter((c) => suitOf(c) === s).length;
    if (n === 4 && hand.some((c) => suitOf(c) === s)) return true;
  }
  let mask = 0;
  for (const c of all) mask |= 1 << (rankOf(c) + 1);
  if (mask & (1 << 13)) mask |= 1; // ace plays low too
  const holeBits = hand.reduce((m, c) => m | (1 << (rankOf(c) + 1)) | (rankOf(c) === 12 ? 1 : 0), 0);
  for (let lo = 1; lo + 3 <= 12; lo++) {
    const run = 0b1111 << lo;
    if ((mask & run) === run && holeBits & run) return true; // both ends open
  }
  return false;
}

// How keen a hand is to continue facing a bet, for ranking a range: before the flop the
// starting-hand rank; after it the made hand, with a draw counted as a weak pair.
// Assumed: players continue with their strongest hands first.
export function continueScore(hand: readonly Card[], board: readonly Card[]): number {
  if (board.length === 0) return -handPercentile(hand[0], hand[1]);
  const s = evaluate([...hand, ...board]);
  const boardCat = categoryOf(evaluate(board));
  if (categoryOf(s) <= boardCat && hasDraw(hand, board)) return (boardCat + 1) * CAT;
  return s;
}

// Every two-card hand a range can hold on this board, split into its value part (fits the
// line they've taken) and its air (doesn't), with the known cards removed. Exact, not
// sampled by trial: a narrow range on a dry board ("two pair or better") still gets its
// real hands. Memoised, since a decision asks for the same range several times.
interface Combos {
  value: Card[][];
  air: Card[][];
}
const combosMemo = new Map<string, Combos>();

function combosFor(r: RangeModel, board: Card[], dead: Card[]): Combos {
  const shaped = board.length >= 3 && r.need !== NEED.none;
  const key = `${r.top.toFixed(4)}|${shaped ? r.need : 0}|${shaped && r.draws}|${board.join(',')}|${dead.join(',')}`;
  const hit = combosMemo.get(key);
  if (hit) return hit;
  const deck = remainingDeck(dead);
  const inRange: Card[][] = [];
  const all: Card[][] = [];
  for (let i = 0; i < deck.length; i++) {
    for (let k = i + 1; k < deck.length; k++) {
      const h = [deck[i], deck[k]];
      all.push(h);
      if (handPercentile(h[0], h[1]) < r.top) inRange.push(h);
    }
  }
  const pool = inRange.length ? inRange : all;
  let value = pool;
  let air: Card[][] = [];
  if (shaped) {
    value = pool.filter((h) => fits(h, board, r.need, r.draws));
    // Air holds nothing: no pair of its own, no draw. A middling hand is neither value for
    // a strong line nor a bluff, so it's in neither part.
    air = pool.filter((h) => !fits(h, board, NEED.pair, r.draws));
    // A line their preflop range can't hold here: take any hand that fits it.
    if (!value.length) value = all.filter((h) => fits(h, board, r.need, r.draws));
    if (!value.length) value = pool;
  }
  if (!air.length) air = value;
  const out = { value, air };
  if (combosMemo.size > 400) combosMemo.clear();
  combosMemo.set(key, out);
  return out;
}

// Deals opponent hands from their ranges, then the rest of the board, `iterations` times.
// Each range is air with probability `bluff`, value otherwise, so the share is exact.
function simulate(
  hole: Card[],
  board: Card[],
  ranges: RangeModel[],
  iterations: number,
  rng: () => number,
  each: (hands: Card[][], full: Card[]) => void,
) {
  const dead = [...hole, ...board];
  const stub = remainingDeck(dead);
  const lists = ranges.map((r) => combosFor(r, board, dead));
  const used = new Uint8Array(52);

  for (let it = 0; it < iterations; it++) {
    used.fill(0);
    const hands: Card[][] = [];
    ranges.forEach((r, i) => {
      const list = rng() < r.bluff ? lists[i].air : lists[i].value;
      let hand = list[Math.floor(rng() * list.length)];
      for (let tries = 0; tries < 40 && (used[hand[0]] || used[hand[1]]); tries++) {
        hand = list[Math.floor(rng() * list.length)];
      }
      if (used[hand[0]] || used[hand[1]]) {
        // Every hand drawn so far collides with another player's cards: take a free one.
        const free = list.filter((h) => !used[h[0]] && !used[h[1]]);
        hand = free.length ? free[Math.floor(rng() * free.length)] : stub.filter((c) => !used[c]).slice(0, 2);
      }
      used[hand[0]] = used[hand[1]] = 1;
      hands.push(hand);
    });

    const full = board.slice();
    while (full.length < 5) {
      const c = stub[Math.floor(rng() * stub.length)];
      if (used[c]) continue;
      used[c] = 1;
      full.push(c);
    }
    each(hands, full);
  }
}

// Monte Carlo equity against opponents whose hands are sampled from their ranges.
export function estimateEquity(
  hole: Card[],
  board: Card[],
  ranges: RangeModel[],
  iterations: number,
  rng: () => number = Math.random,
): number {
  let won = 0;
  simulate(hole, board, ranges, iterations, rng, (hands, full) => {
    const mine = evaluate([...hole, ...full]);
    let best = 0;
    let ties = 0;
    for (const h of hands) {
      const s = evaluate([...h, ...full]);
      if (s > best) {
        best = s;
        ties = 0;
      } else if (s === best) ties++;
    }
    if (mine > best) won += 1;
    else if (mine === best) won += 1 / (ties + 2);
  });
  return won / iterations;
}

export interface BetOutcome {
  pFold: number; // everyone folds
  eCalled: number; // equity against the hands that continue, when someone does
}

// For each bet size: how often everyone folds, and the equity against whoever continues.
// foldRates[i][s] is opponent i's chance of folding to size s; each opponent folds the
// weakest part of their range (by continueScore) and continues with the rest.
export function betOutcome(
  hole: Card[],
  board: Card[],
  ranges: RangeModel[],
  foldRates: number[][],
  iterations: number,
  rng: () => number = Math.random,
): BetOutcome[] {
  const sizes = foldRates[0]?.length ?? 0;
  // Ties between equal hands are broken at random so a fold rate is met exactly on average.
  const jitter = () => rng() * (board.length ? 0.5 : 1e-5);
  const thresholds = ranges.map((r, i) => {
    const scores: number[] = [];
    // Where each fold rate cuts the range: a quantile, so its error shrinks with the samples.
    simulate(hole, board, [r], Math.max(240, iterations), rng, ([h]) => scores.push(continueScore(h, board) + jitter()));
    scores.sort((a, b) => a - b);
    return foldRates[i].map((f) => (f <= 0 ? -Infinity : f >= 1 ? Infinity : scores[Math.floor(f * scores.length)]));
  });

  const folds = new Array(sizes).fill(0);
  const wins = new Array(sizes).fill(0);
  simulate(hole, board, ranges, iterations, rng, (hands, full) => {
    const mine = evaluate([...hole, ...full]);
    const keen = hands.map((h) => continueScore(h, board) + jitter());
    const finals = hands.map((h) => evaluate([...h, ...full]));
    for (let s = 0; s < sizes; s++) {
      let best = -1;
      let ties = 0;
      for (let i = 0; i < hands.length; i++) {
        if (keen[i] < thresholds[i][s]) continue;
        if (finals[i] > best) {
          best = finals[i];
          ties = 0;
        } else if (finals[i] === best) ties++;
      }
      if (best < 0) folds[s]++;
      else if (mine > best) wins[s] += 1;
      else if (mine === best) wins[s] += 1 / (ties + 2);
    }
  });
  return folds.map((f, s) => ({
    pFold: f / iterations,
    eCalled: iterations > f ? wins[s] / (iterations - f) : 0,
  }));
}

// --- the maths of a decision ------------------------------------------------------------

// Share of all-in equity a hand actually realises when there is betting still to come.
// Assumed: the player acting last sees more before deciding, so keeps more of it. Before
// the flop, what a hand wins on later streets when it hits roughly offsets what it gives up
// when it misses, in position.
export const REALISE = { inPosition: 1, outOfPosition: 0.9, preflopIn: 1, preflopOut: 0.85 };
// Strong hands realise more than their equity (they win more on later streets) and weak ones
// less (they fold to later bets): realisation moves this much per unit of equity from even.
// Assumed. Nothing is left to realise on the river.
const REALISE_SLOPE = 0.3;
const realiseFor = (base: number, equity: number, river: boolean) =>
  river ? 1 : clamp(base + REALISE_SLOPE * (equity - 0.5), 0.6, 1.15);
// Below this many big blinds, it's all-in or fold before the flop.
export const SHORT_STACK_BB = 12;
// Up to this many big blinds, a reraise before the flop commits most of the stack: Coach
// weighs all-in as a reraise size.
export const RESHOVE_BB = 25;
// Standard open sizes by effective stack, in big blinds before limpers (one more BB each):
// smaller as stacks get shorter, so an open never commits much of the stack. A convention
// of the game, not maths.
export const openSize = (depth: number): [number, number] => (depth > 40 ? [2.5, 3] : depth > 20 ? [2.2, 2.5] : [2, 2.2]);

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// A seeded generator (mulberry32): the same seed gives the same numbers.
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A stream of its own for each part of a decision, so one part drawing more numbers (another
// size weighed) doesn't change the samples another part sees.
const fork = (rng: () => number) => seeded(Math.floor(rng() * 4294967296));

// The most a player can win by calling: each player's chips count only up to what they match.
export function winnablePot(view: BotView) {
  const myTotal = view.myCommitted + view.toCall;
  return view.committed.reduce((s, c) => s + Math.min(c, myTotal), 0) + myTotal;
}

export interface Option {
  kind: 'fold' | 'check' | 'call' | 'raise';
  to: number; // raise: total bet this street
  ev: number; // chips, relative to folding now
  pFold?: number;
  eCalled?: number;
  bluff?: boolean; // loses chips when called: only profitable through folds
}

// A bet that leaves too little behind to fold is an all-in.
export function sizeTo(view: BotView, target: number) {
  let to = Math.round(Math.max(target, view.minRaiseTo));
  if (to >= view.maxRaiseTo * 0.6) to = view.maxRaiseTo;
  return Math.min(to, view.maxRaiseTo);
}

// How I look to the table after betting or raising to `to`: my line so far plus this action.
function meAfter(view: BotView, to: number): OpponentView {
  const me = view.me;
  const preflop = view.board.length === 0;
  const opening = preflop && !view.opponents.some((o) => o.raisesPreflop > 0) && me.raisesPreflop === 0;
  return {
    ...me,
    voluntary: true,
    raisesPreflop: me.raisesPreflop + (preflop ? 1 : 0),
    openBehind: opening ? view.opponents.filter((o) => !o.acted).length : me.openBehind,
    barrels: me.barrels + (!preflop && !me.aggrStreet ? 1 : 0),
    raisesOverBet: me.raisesOverBet + (!preflop && view.currentBet > 0 ? 1 : 0),
    allIn: to === view.maxRaiseTo,
    committed: view.myCommitted + (to - view.myBet),
  };
}

// Isotonic (non-decreasing) fit by pooling adjacent violators: equity should rise with
// hand strength, and this removes the simulation's noise without inventing a shape.
function isotonic(ys: number[], ws: number[]) {
  const blocks: { y: number; w: number; n: number }[] = [];
  ys.forEach((y, i) => {
    blocks.push({ y, w: ws[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      const w = a.w + b.w;
      blocks.push({ y: (a.y * a.w + b.y * b.w) / w, w, n: a.n + b.n });
    }
  });
  return blocks.flatMap((b) => Array(b.n).fill(b.y));
}

const BUCKETS = 12;

// Equity of each slice of an opponent's range (weakest first, by continueScore) against
// the range I represent. Each slice holds an equal share of their range.
function sliceEquity(view: BotView, theirs: RangeModel, mine: RangeModel, samples: number, rng: () => number) {
  // Before the flop the matchup table gives each slice exactly: sampled, the slices' equities
  // are too close together for the noise (every hand has 30–45% against a tight range).
  if (view.board.length === 0) return isotonic(preflopSlices(theirs.top, mine.top, view.hole, BUCKETS), Array(BUCKETS).fill(1));
  const rows: [number, number][] = [];
  const jitter = () => rng() * (view.board.length ? 0.5 : 1e-5);
  simulate(view.hole, view.board, [theirs, mine], samples, rng, ([t, m], full) => {
    const a = evaluate([...t, ...full]);
    const b = evaluate([...m, ...full]);
    rows.push([continueScore(t, view.board) + jitter(), a > b ? 1 : a === b ? 0.5 : 0]);
  });
  rows.sort((x, y) => x[0] - y[0]);
  const size = rows.length / BUCKETS;
  const eq: number[] = [];
  for (let k = 0; k < BUCKETS; k++) {
    const part = rows.slice(Math.round(k * size), Math.round((k + 1) * size));
    eq.push(part.reduce((s, r) => s + r[1], 0) / Math.max(part.length, 1));
  }
  return isotonic(eq, Array(BUCKETS).fill(1));
}

// Share of the slices whose equity is below the price: those fold. Interpolated within the
// boundary slice.
function foldShare(slices: number[], need: number) {
  let folded = 0;
  for (let k = 0; k < slices.length; k++) {
    if (slices[k] >= need) {
      const prev = k ? slices[k - 1] : 0;
      const part = slices[k] > prev ? (need - prev) / (slices[k] - prev) : 0;
      return (folded + clamp(part, 0, 1)) / slices.length;
    }
    folded++;
  }
  return 1;
}

// Players are partly, not fully, rational: a fold rate blends what the maths says this
// player should do here with what their stats say they do (fold to a bet, or to a raise).
// The stat gets half the weight with no sample, rising toward 90% as their sample grows,
// so a well-read calling station is treated as one. Assumed. Before the flop an all-in has
// no stat of its own, so a looser player calls it wider than the maths, in proportion to
// how much looser than the table they are.
const statWeight = (n: number) => 0.5 + 0.4 * (n / (n + 20));

// `standard`: (Coach) what the maths says they'd fold to a standard size here. Their stat was
// measured at standard sizes, so it moves by as much as the maths does between that size and
// this one: an overbet folds more of the range, and what calls it is stronger.
function foldFor(
  view: BotView, o: OpponentView, reasoned: number, shove: boolean, to: number, bySize: boolean, standard?: number,
) {
  const r = o.read;
  if (shove && view.board.length === 0) return reasoned - (r.vpip.rate - r.prior.vpip) * 0.5;
  const facingRaise = o.aggrStreet || (view.board.length === 0 && o.raisesPreflop > 0);
  // An opening bet after the flop: how this player folds to bets of this size.
  const opening = bySize && view.board.length > 0 && view.currentBet === 0;
  // The size estimate builds on their overall fold rate, so it carries that sample's weight too.
  const stat = facingRaise
    ? r.foldToRaise
    : opening
      ? { ...r[SIZE_STATS[sizeBucket(to / Math.max(1, view.pot))]], n: r.foldToBet.n }
      : r.foldToBet;
  const w = statWeight(stat.n);
  const rate = opening || standard === undefined ? stat.rate : clamp(stat.rate + reasoned - standard, 0, 1);
  return (1 - w) * reasoned + w * rate;
}

export interface Analysis {
  equity: number; // against their ranges, all the way to showdown
  realise: number;
  options: Option[]; // fold/check, call, and each raise size, with EV
  ranges: RangeModel[];
  players: OpponentView[]; // the opponents those ranges belong to: everyone in the hand
  short: boolean; // all-in-or-fold territory
}

// Every option in this spot with its expected value. Bots and Coach use the same maths.
// Big blinds actually at stake: my chips, or the deepest opponent's if they have fewer.
export function effectiveBB(view: BotView) {
  const mine = view.maxRaiseTo; // my bet this street plus what's behind
  const deepest = Math.max(0, ...view.opponents.map((o) => o.stack + o.bet));
  return Math.min(mine, deepest || mine) / view.bigBlind;
}

export const isShort = (view: BotView) => view.board.length === 0 && effectiveBB(view) <= SHORT_STACK_BB;

// `alsoRaiseTo` adds one raise size to those weighed (Coach grades the size the hero chose).
// `bySize` prices folds to an opening bet with each player's folds to that size: Coach only.
// Bots that did would feed back on the averages they're measured against (bigger bets, read
// as stronger, fold more players), so bots weigh every size with the overall fold rate.
export function analyse(
  view: BotView,
  iterations = 600,
  rng: () => number = Math.random,
  alsoRaiseTo?: number,
  bySize = false,
): Analysis {
  // Coach (bySize) affords as many slice samples as runouts; bots a quarter.
  const sliceSamples = bySize ? iterations : Math.max(300, Math.round(iterations / 4));
  const [rngEquity, rngRaise, rngAllIn, rngBets] = [fork(rng), fork(rng), fork(rng), fork(rng)];
  const preflop = view.board.length === 0;
  const myStack = view.maxRaiseTo - view.myBet;
  const short = isShort(view);
  // Before the flop, only players who have put chips in by choice are in the hand so far.
  // Those still to act are assumed to fold to a raise; an all-in is the exception, since
  // its callers can come from anywhere at the table.
  const entered = preflop ? view.opponents.filter((o) => o.voluntary) : view.opponents;
  const players = entered.length ? entered : view.opponents;
  const seated = view.seats?.length;
  const ranges = players.map((o) => rangeFor(o, view.bigBlind, view.board, view.pot, seated));

  const equity = estimateEquity(view.hole, view.board, ranges, iterations, rngEquity);
  // Nothing left to bet once a call puts me or everyone facing me all-in.
  const allInCall =
    view.toCall >= myStack ||
    (view.opponents.some((o) => o.allIn && o.bet === view.currentBet) &&
      view.opponents.every((o) => o.allIn || (preflop && !o.voluntary)));
  const realise = allInCall
    ? 1
    : realiseFor(
        preflop
          ? view.inPosition ? REALISE.preflopIn : REALISE.preflopOut
          : view.inPosition ? REALISE.inPosition : REALISE.outOfPosition,
        equity,
        view.board.length === 5,
      );


  const options: Option[] = [];
  const win = winnablePot(view);
  if (view.toCall === 0) options.push({ kind: 'check', to: view.currentBet, ev: equity * realise * view.pot });
  else {
    options.push({ kind: 'fold', to: 0, ev: 0 });
    options.push({ kind: 'call', to: view.currentBet, ev: equity * realise * win - view.toCall });
  }

  const raisable = view.canRaise && myStack > view.toCall;
  if (raisable) {
    const potAfterCall = view.pot + view.toCall;
    const targets = short
      ? [view.maxRaiseTo]
      : view.toCall === 0
        ? preflop
          ? [view.bigBlind * 3]
          : [0.33, 0.66, 1].map((x) => view.pot * x)
        : preflop
          ? [view.currentBet * 3]
          : [0.75, 1.1].map((x) => view.currentBet + potAfterCall * x);
    // Coach opens at the standard size for the stack depth, and facing a raise also weighs 4x
    // and, short of 25 big blinds, all-in. Bots keep to 3x: other sizes would shift the
    // averages their reads are measured against.
    const raised = view.opponents.some((o) => o.raisesPreflop > 0);
    if (bySize && preflop && !short) {
      if (!raised) targets[0] = view.bigBlind * (openSize(effectiveBB(view))[1] + view.opponents.filter((o) => o.voluntary).length);
      else {
        targets.push(view.currentBet * 4);
        if (effectiveBB(view) <= RESHOVE_BB) targets.push(view.maxRaiseTo);
      }
    }
    // The size each player's fold stat was measured at: the first target, which is the bots'.
    const standardTo = sizeTo(view, preflop ? (raised ? view.currentBet * 3 : view.bigBlind * 3) : targets[0]);
    const sized = targets.map((t) => sizeTo(view, t));
    if (alsoRaiseTo) sized.push(Math.min(Math.max(Math.round(alsoRaiseTo), view.minRaiseTo), view.maxRaiseTo));
    const tos = [...new Set(sized)].filter((t) => t > view.currentBet);
    if (tos.length) {
      // Everyone left can call an all-in before the flop; otherwise only those in the hand.
      const facing = short ? view.opponents : players;
      const facingRanges = short ? view.opponents.map((o) => rangeFor(o, view.bigBlind, view.board, view.pot, seated)) : ranges;
      // Reasoned: each opponent continues with the part of their range that has the equity
      // to call, against the range this bet or raise represents, at the price it gives them.
      // Blended with their own fold stats (foldFor). All-in opponents can't fold.
      const slicesFor = new Map<string, number[][]>();
      const folds = facing.map((o, i) =>
        tos.map((to) => {
          if (o.allIn) return 0;
          const allIn = to === view.maxRaiseTo;
          const key = allIn ? 'allin' : 'raise';
          if (!slicesFor.has(key)) {
            const mine = rangeFor(meAfter(view, to), view.bigBlind, view.board, 0, seated);
            const r = allIn ? rngAllIn : rngRaise;
            slicesFor.set(key, facing.map((_, j) => sliceEquity(view, facingRanges[j], mine, sliceSamples, r)));
          }
          // Their price: what they put in against what they can win, which counts my
          // chips only up to what they can match.
          const needAt = (t: number) => {
            const matched = Math.min(t, o.bet + o.stack);
            const callAmount = matched - o.bet;
            return callAmount / (view.pot + Math.max(0, matched - view.myBet) + callAmount);
          };
          const slices = slicesFor.get(key)!;
          const standard = bySize && !allIn ? foldShare(slices[i], needAt(standardTo)) : undefined;
          return clamp(foldFor(view, o, foldShare(slices[i], needAt(to)), allIn, to, bySize, standard), 0.02, 0.98);
        }),
      );
      const outcomes = betOutcome(view.hole, view.board, facingRanges, folds, iterations, rngBets);
      tos.forEach((to, s) => {
        const { pFold, eCalled } = outcomes[s];
        // Called by one player, the deepest, who matches as much as they can. Assumed: one
        // caller. What I bet beyond their stack comes back, so it's neither risked nor won.
        const callers = facing.filter((o) => !o.allIn);
        const matched = Math.max(view.currentBet, ...callers.map((o) => Math.min(to, o.bet + o.stack)));
        const caller = callers.find((o) => Math.min(to, o.bet + o.stack) === matched);
        const risk = matched - view.myBet;
        const finalPot = view.pot + risk + (caller ? matched - caller.bet : 0);
        const real = to === view.maxRaiseTo || matched < to ? 1 : realise;
        const whenCalled = eCalled * real * finalPot - risk;
        options.push({
          kind: 'raise', to, pFold, eCalled,
          ev: pFold * view.pot + (1 - pFold) * whenCalled,
          bluff: whenCalled < 0,
        });
      });
    }
  }
  return { equity, realise, options, ranges, players, short };
}

// --- deciding ---------------------------------------------------------------------------

const toDecision = (o: Option): Decision =>
  o.kind === 'raise' ? { type: 'raise', to: o.to } : { type: o.kind };

export function decide(view: BotView, me: Personality, rng: () => number = Math.random): Decision {
  const preflop = view.board.length === 0;
  const raises = Math.max(0, ...view.opponents.map((o) => o.raisesPreflop));

  // Unopened or limped pots before the flop: a position-based opening range (the standard,
  // equity-ranked one), unless short-stacked, which is all-in or fold (or a free check).
  if (preflop && raises === 0) {
    if (!isShort(view)) return openOrLimp(view, me, rng);
    const a = analyse(view, 400, rng);
    const shove = a.options.find((o) => o.kind === 'raise');
    const stay = a.options.find((o) => o.kind === 'check') ?? { kind: 'fold' as const, to: 0, ev: 0 };
    return toDecision(shove && shove.ev > stay.ev ? shove : stay);
  }

  const a = analyse(view, preflop ? 400 : 600, rng);
  const passive = a.options.filter((o) => o.kind !== 'raise');
  // Stickier players call a little below the price; before the flop, loose players defend
  // wider and tight ones narrower.
  const call = passive.find((o) => o.kind === 'call');
  if (call) call.ev += (preflop ? -me.tightness * 0.5 : me.stickiness) * winnablePot(view);
  const baseline = passive.reduce((b, o) => (o.ev > b.ev ? o : b));
  const raise = a.options.filter((o) => o.kind === 'raise').reduce<Option | null>((b, o) => (!b || o.ev > b.ev ? o : b), null);

  if (!raise || raise.ev <= baseline.ev) return toDecision(baseline);
  if (a.short) return toDecision(raise);
  if (raise.bluff) {
    // Near break-even, mix; clearly profitable bluffs are made almost every time.
    const edge = (raise.ev - baseline.ev) / Math.max(view.pot, 1);
    return rng() < clamp(edge * 5, 0, 1) * clamp(me.bluff, 0, 1.5) ? toDecision(raise) : toDecision(baseline);
  }
  // A value bet: passive players sometimes just call or check instead.
  return rng() < 0.3 + 0.7 * me.aggression ? toDecision(raise) : toDecision(baseline);
}

// --- before the flop, unopened ----------------------------------------------------------

export type PreflopSpot = 'unopened' | 'limped' | 'raised' | 'reraised';

export interface PreflopPlan {
  pct: number; // share of starting hands stronger than this one
  spot: PreflopSpot;
  action: 'raise' | 'call' | 'check' | 'fold';
  raiseRange: number; // raise with hands in this top share
  callRange: number; // call with hands in this top share (0 = never call)
  steal: number; // opening range widened (>1) or narrowed by how loose the players left are
}

// Preflop: starting-hand rank (which credits suitedness and connectivity) scaled by position.
// `shift` loosens or tightens the hand's rank; bots pass personality plus noise, Coach passes 0.
// Players left to act who fold a lot make an open more profitable, so the range widens,
// in proportion to how far below the average their VPIP is.
export function preflopPlan(view: BotView, shift = 0, aggression = 0.5): PreflopPlan {
  const pct = handPercentile(view.hole[0], view.hole[1]);
  const p = pct + shift;
  const raises = Math.max(0, ...view.opponents.map((o) => o.raisesPreflop));
  const limpers = view.opponents.filter((o) => o.voluntary && o.raisesPreflop === 0).length;
  const behind = view.opponents.filter((o) => !o.acted);
  const yetToAct = behind.length;
  const potOdds = view.toCall / (view.pot + view.toCall);
  const average = view.me.read.prior.vpip;
  const looseness = behind.length ? behind.reduce((s, o) => s + o.read.vpip.rate, 0) / behind.length : average;
  const steal = clamp(average / looseness, 0.75, 1.5);

  const plan = (spot: PreflopSpot, raiseRange: number, callRange: number): PreflopPlan => {
    let action: PreflopPlan['action'] = 'fold';
    if (p < raiseRange) action = 'raise';
    else if (p < callRange) action = view.toCall === 0 ? 'check' : 'call';
    else if (view.toCall === 0) action = 'check';
    return { pct, spot, action, raiseRange, callRange, steal };
  };

  if (raises === 0) {
    const open = openRange(yetToAct, view.seats?.length) * steal;
    if (!limpers) return plan('unopened', open, 0);
    return plan('limped', open * 0.75, view.toCall === 0 || potOdds < 0.25 ? open * 1.3 : 0);
  }
  if (raises === 1) {
    const defend = (potOdds < 0.35 ? 0.35 : 0.2) * (view.opponents.length <= 2 ? 1.3 : 1);
    return plan('raised', 0.03 + 0.04 * aggression, defend);
  }
  return plan('reraised', 0.02, 0.06);
}

function openOrLimp(view: BotView, me: Personality, rng: () => number): Decision {
  const plan = preflopPlan(view, me.tightness + (rng() - 0.5) * 0.04, me.aggression);
  // A passive player limps hands others would raise, keeping only the best for a raise.
  if (plan.action === 'raise' && rng() > 0.3 + 0.7 * me.aggression && plan.pct > 0.05) {
    return view.toCall === 0 ? { type: 'check' } : { type: 'call' };
  }
  if (plan.action !== 'raise') {
    // A loose player calls a limped pot with hands just outside the range.
    if (plan.action === 'fold' && me.stickiness > 0.05 && plan.pct + me.tightness < plan.raiseRange * 1.6) {
      return { type: 'call' };
    }
    return { type: plan.action };
  }
  const limpers = view.opponents.filter((o) => o.voluntary && o.raisesPreflop === 0).length;
  return { type: 'raise', to: sizeTo(view, view.bigBlind * (3 + limpers)) };
}

