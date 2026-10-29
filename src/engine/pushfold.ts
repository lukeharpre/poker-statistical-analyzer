// All-in-or-fold equilibrium (Nash) before the flop, heads-up and three-handed, no antes.
//
// The game: the first player in pushes or folds; each player after calls or folds. Every
// player's range is the best response to the others', found by fictitious play (each round
// every player best-responds to the average of the others' past ranges, which converges on
// the equilibrium in push/fold games). Payoffs are chips, exact given the equities, which
// come from a 169 × 169 table of all-in matchups (scripts/preflop-matchups.ts) with the
// combinations a hand blocks removed. Three-way all-ins are estimated from two-way equities
// (each player's chance to win both matchups, normalised to one): the table has no 3-way
// matchups, and those pots are rare in push/fold since overcalls are tight.
import { rankOf, suitOf, type Card } from './cards';
import { PREFLOP_MATCHUPS } from './preflopMatchups';
import { handPercentile } from './ranges';

// --- hand classes -------------------------------------------------------------------------

// Key: hi * 26 + lo * 2 + (suited ? 1 : 0), ranks 0 = deuce .. 12 = ace (as in ranges.ts).
export const CLASS_KEYS: number[] = [];
for (let hi = 12; hi >= 0; hi--) {
  for (let lo = hi; lo >= 0; lo--) {
    if (hi === lo) CLASS_KEYS.push(hi * 26 + lo * 2);
    else CLASS_KEYS.push(hi * 26 + lo * 2 + 1, hi * 26 + lo * 2);
  }
}
const N = CLASS_KEYS.length; // 169
const INDEX = new Map(CLASS_KEYS.map((k, i) => [k, i]));

export const classOf = (a: Card, b: Card) => {
  const hi = Math.max(rankOf(a), rankOf(b));
  const lo = Math.min(rankOf(a), rankOf(b));
  return INDEX.get(hi * 26 + lo * 2 + (hi !== lo && suitOf(a) === suitOf(b) ? 1 : 0))!;
};

// Every two-card combination of a class: 6 for a pair, 4 suited, 12 offsuit.
export function classCombos(key: number): [Card, Card][] {
  const hi = Math.floor(key / 26);
  const lo = Math.floor((key % 26) / 2);
  const suited = key % 2 === 1;
  const out: [Card, Card][] = [];
  for (let s = 0; s < 4; s++) {
    for (let t = 0; t < 4; t++) {
      if (hi === lo ? t <= s : suited ? s !== t : s === t) continue;
      out.push([hi * 4 + s, lo * 4 + t]);
    }
  }
  return out;
}
const COMBOS = CLASS_KEYS.map(classCombos);

// --- the equity table ---------------------------------------------------------------------

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function encodeEquities(eq: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < eq.length; i++) {
    const q = Math.round(eq[i] * 4095);
    s += ALPHA[q >> 6] + ALPHA[q & 63];
  }
  return s;
}

let eqTable: Float64Array | null = null;
let weights: Float64Array | null = null;

// eq[i * N + j]: class i's all-in equity against class j. weights[i * N + j]: how many of
// class j's combinations are left once a hand of class i is dealt.
export function tables() {
  if (!eqTable || !weights) {
    eqTable = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) {
      eqTable[i] = (ALPHA.indexOf(PREFLOP_MATCHUPS[2 * i]) * 64 + ALPHA.indexOf(PREFLOP_MATCHUPS[2 * i + 1])) / 4095;
    }
    weights = new Float64Array(N * N);
    for (let i = 0; i < N; i++) {
      // Averaged over every combination of i, so suits don't favour one of them.
      for (const [a, b] of COMBOS[i]) {
        for (let j = 0; j < N; j++) {
          let n = 0;
          for (const [c, d] of COMBOS[j]) if (c !== a && c !== b && d !== a && d !== b) n++;
          weights[i * N + j] += n / COMBOS[i].length;
        }
      }
    }
  }
  return { eq: eqTable, w: weights };
}

// --- slices of a range, exactly -----------------------------------------------------------

// Before the flop, without sampling: a range of the top `theirTop` of hands (ranked as the
// ranges are, ranges.ts), weakest first, cut into `buckets` equal shares, and each share's
// all-in equity against a range of the top `myTop`. `dead`: cards they can't hold (mine).
export function preflopSlices(theirTop: number, myTop: number, dead: Card[], buckets: number): number[] {
  const { eq, w } = tables();
  const rank = CLASS_KEYS.map((_, i) => handPercentile(COMBOS[i][0][0], COMBOS[i][0][1]));
  const within = (top: number) => {
    const inside = rank.map((r) => r < top);
    return inside.some(Boolean) ? inside : inside.map(() => true);
  };
  const theirs = within(theirTop);
  const mine = within(myTop);
  const rows: [number, number, number][] = []; // rank, weight, equity
  for (let i = 0; i < N; i++) {
    if (!theirs[i]) continue;
    const weight = COMBOS[i].filter(([a, b]) => !dead.includes(a) && !dead.includes(b)).length;
    if (!weight) continue;
    let mass = 0;
    let won = 0;
    for (let j = 0; j < N; j++) {
      if (!mine[j]) continue;
      mass += w[i * N + j];
      won += w[i * N + j] * eq[i * N + j];
    }
    rows.push([rank[i], weight, mass ? won / mass : 0.5]);
  }
  rows.sort((x, y) => y[0] - x[0]); // weakest (ranked lowest) first
  const total = rows.reduce((t, r) => t + r[1], 0);
  const out = new Array(buckets).fill(0);
  let k = 0;
  let room = total / buckets;
  for (const [, weight, e] of rows) {
    let left = weight;
    while (left > 1e-9 && k < buckets) {
      const take = Math.min(left, room);
      out[k] += take * e;
      left -= take;
      room -= take;
      if (room <= 1e-9) {
        out[k] /= total / buckets;
        k++;
        room = total / buckets;
      }
    }
  }
  return out;
}

// --- ranges as play frequencies -----------------------------------------------------------

export type Range = Float64Array; // per class: how often it pushes (or calls)

// Share of all 1,326 starting hands a range plays.
export const rangeShare = (r: Range) => r.reduce((s, x, i) => s + x * COMBOS[i].length, 0) / 1326;

// Hand h against range r: [chance r holds a hand at all (card removal), h's equity against it].
export function versus(h: number, r: Range): [number, number] {
  const { eq, w } = tables();
  let mass = 0;
  let total = 0;
  let won = 0;
  for (let x = 0; x < N; x++) {
    const m = w[h * N + x];
    total += m;
    if (!r[x]) continue;
    mass += m * r[x];
    won += m * r[x] * eq[h * N + x];
  }
  return [mass / total, mass ? won / mass : 0.5];
}

// One range against another, ignoring card removal between them.
function rangeVersus(a: Range, b: Range): number {
  const { eq } = tables();
  let mass = 0;
  let won = 0;
  for (let i = 0; i < N; i++) {
    if (!a[i]) continue;
    const wi = a[i] * COMBOS[i].length;
    for (let j = 0; j < N; j++) {
      if (!b[j]) continue;
      const m = wi * b[j] * COMBOS[j].length;
      mass += m;
      won += m * eq[i * N + j];
    }
  }
  return mass ? won / mass : 0.5;
}

// Three-way all-in: each player's chance to win, from the two-way equities. Estimated.
function threeWay(eAB: number, eAC: number, eBC: number): [number, number, number] {
  const a = eAB * eAC;
  const b = (1 - eAB) * eBC;
  const c = (1 - eAC) * (1 - eBC);
  const t = a + b + c || 1;
  return [a / t, b / t, c / t];
}

// What player 0 wins from an all-in between the players in `stakes` (chips each put in),
// given who wins each pot: pots are split by level, the side pots between the deeper players.
// win2[k]: player 0's chance to beat player k heads-up; win3: chance to win three ways.
function share(stakes: number[], dead: number, win2: number[], win3: number): number {
  const levels = [...new Set(stakes)].sort((a, b) => a - b);
  let prev = 0;
  let won = 0;
  for (const level of levels) {
    if (stakes[0] < level) break;
    const inPot = stakes.map((s, k) => (s >= level ? k : -1)).filter((k) => k >= 0);
    const pot = stakes.reduce((s, x) => s + Math.min(x, level) - Math.min(x, prev), 0) + (prev === 0 ? dead : 0);
    prev = level;
    if (inPot.length === 1) won += pot; // an uncalled excess comes back
    else if (inPot.length === 2) won += pot * win2[inPot[1]];
    else won += pot * win3;
  }
  return won;
}

// --- heads-up -------------------------------------------------------------------------------

export interface HeadsUp {
  push: Range; // small blind (the button)
  call: Range; // big blind
  pushEV: (h: number) => number; // chips, against folding, at the small blind
  callEV: (h: number) => number; // chips, against folding, at the big blind
}

const ITERATIONS = 400;
const ITERATIONS_3 = 200; // three-handed: each round costs about eight times as much
const memo = new Map<string, unknown>();
const cached = <T>(key: string, make: () => T): T => {
  if (!memo.has(key)) {
    if (memo.size > 64) memo.clear();
    memo.set(key, make());
  }
  return memo.get(key) as T;
};

// Small blind `sbStack` against big blind `bbStack`, chips each at the start of the hand.
export function headsUp(sbStack: number, bbStack: number, sb: number, bb: number): HeadsUp {
  return cached(`hu|${sbStack}|${bbStack}|${sb}|${bb}`, () => solveHeadsUp(sbStack, bbStack, sb, bb));
}

function solveHeadsUp(sbStack: number, bbStack: number, sb: number, bb: number): HeadsUp {
  const e = Math.min(sbStack, bbStack);
  const push = new Float64Array(N).fill(1);
  const call = new Float64Array(N).fill(0.5);
  const pushEV = (h: number) => {
    const [p, eq] = versus(h, call);
    return (1 - p) * (sb + bb) + p * (eq * 2 * e - e + sb);
  };
  const callEV = (h: number) => {
    const [p, eq] = versus(h, push);
    return p ? eq * 2 * e - e + bb : 0;
  };
  for (let t = 1; t <= ITERATIONS; t++) {
    const step = 1 / (t + 1);
    const br = Array.from({ length: N }, (_, h) => (pushEV(h) > 0 ? 1 : 0));
    br.forEach((x, h) => (push[h] += (x - push[h]) * step));
    const bc = Array.from({ length: N }, (_, h) => (callEV(h) > 0 ? 1 : 0));
    bc.forEach((x, h) => (call[h] += (x - call[h]) * step));
  }
  return { push, call, pushEV, callEV };
}

// --- three-handed ---------------------------------------------------------------------------

export interface ThreeHanded {
  push: Range; // button, first in
  sbCall: Range; // small blind against the button's push
  bbCall: Range; // big blind against the button's push, the small blind folded
  bbOvercall: Range; // big blind against the push and the small blind's call
  pushEV: (h: number) => number;
  sbCallEV: (h: number) => number;
  bbCallEV: (h: number) => number;
  bbOvercallEV: (h: number) => number;
}

// Button, small blind and big blind stacks at the start of the hand. Folded to the small
// blind, it's the heads-up game between the blinds.
export function threeHanded(btn: number, sbStack: number, bbStack: number, sb: number, bb: number): ThreeHanded {
  return cached(`3|${btn}|${sbStack}|${bbStack}|${sb}|${bb}`, () => solveThree(btn, sbStack, bbStack, sb, bb));
}

function solveThree(btn: number, sbStack: number, bbStack: number, sb: number, bb: number): ThreeHanded {
  const push = new Float64Array(N).fill(0.5);
  const sbCall = new Float64Array(N).fill(0.2);
  const bbCall = new Float64Array(N).fill(0.3);
  const bbOvercall = new Float64Array(N).fill(0.1);
  // Chips each puts in when everyone calls the button: no one more than the button's stack.
  const stakeS = Math.min(sbStack, btn);
  const stakeG = Math.min(bbStack, btn);
  const stakes3 = [btn, stakeS, stakeG];
  // Range against range, once a round rather than once a hand.
  let eSG = 0.5; // small blind's calls against the big blind's overcalls
  let eBG = 0.5; // the button's pushes against the overcalls
  let eBS = 0.5; // the pushes against the small blind's calls
  const between = () => {
    eSG = rangeVersus(sbCall, bbOvercall);
    eBG = rangeVersus(push, bbOvercall);
    eBS = rangeVersus(push, sbCall);
  };

  // The button: S and G respond. Seats in `share` are ordered button, small, big blind.
  const pushEV = (h: number) => {
    const [pS, eS] = versus(h, sbCall);
    const [pG1, eG1] = versus(h, bbCall);
    const [pG2, eG2] = versus(h, bbOvercall);
    const [w3] = threeWay(eS, eG2, eSG);
    const e1 = Math.min(btn, bbStack);
    const e2 = Math.min(btn, sbStack);
    const foldFold = sb + bb;
    const vsG = eG1 * (2 * e1 + sb) - e1;
    const vsS = eS * (2 * e2 + bb) - e2;
    const all3 = share(stakes3, 0, [0, eS, eG2], w3) - btn;
    return (1 - pS) * ((1 - pG1) * foldFold + pG1 * vsG) + pS * ((1 - pG2) * vsS + pG2 * all3);
  };
  // The small blind facing the button's push, the big blind still to act.
  const sbCallEV = (h: number) => {
    const [pB, eB] = versus(h, push);
    if (!pB) return 0;
    const [pG, eG] = versus(h, bbOvercall);
    const e2 = Math.min(btn, sbStack);
    const vsB = eB * (2 * e2 + bb) - e2 + sb;
    // Seats ordered small blind, button, big blind.
    const [w3] = threeWay(eB, eG, eBG);
    const all3 = share([stakeS, btn, stakeG], 0, [0, eB, eG], w3) - stakeS + sb;
    return (1 - pG) * vsB + pG * all3;
  };
  // The big blind facing the push alone: heads-up with the small blind dead in the pot.
  const bbCallEV = (h: number) => {
    const [pB, eB] = versus(h, push);
    if (!pB) return 0;
    const e1 = Math.min(btn, bbStack);
    return eB * (2 * e1 + sb) - e1 + bb;
  };
  // The big blind facing the push and a call.
  const bbOvercallEV = (h: number) => {
    const [pB, eB] = versus(h, push);
    const [pS, eS] = versus(h, sbCall);
    if (!pB || !pS) return 0;
    const [w3] = threeWay(eB, eS, eBS);
    return share([stakeG, btn, stakeS], 0, [0, eB, eS], w3) - stakeG + bb;
  };

  const ranges: [Range, (h: number) => number][] = [
    [push, pushEV], [sbCall, sbCallEV], [bbCall, bbCallEV], [bbOvercall, bbOvercallEV],
  ];
  for (let t = 1; t <= ITERATIONS_3; t++) {
    const step = 1 / (t + 1);
    between();
    for (const [r, ev] of ranges) {
      const br = Array.from({ length: N }, (_, h) => (ev(h) > 0 ? 1 : 0));
      br.forEach((x, h) => (r[h] += (x - r[h]) * step));
    }
  }
  between();
  return { push, sbCall, bbCall, bbOvercall, pushEV, sbCallEV, bbCallEV, bbOvercallEV };
}
