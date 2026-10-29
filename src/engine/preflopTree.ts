// Heads-up before the flop at short stacks: the small blind folds, limps, raises or goes
// all-in, and the big blind answers, each player's ranges the best response to the other's
// (fictitious play, as in pushfold.ts). Heads-up, or between the blinds once the button has
// folded. Every option comes out of one equilibrium, so a limp, a raise and a shove are
// priced against each other rather than by different models.
//
// The tree:
//   small blind: fold | limp | raise to r | all-in
//     limp   → big blind: check (a flop) | raise to iso | all-in
//                iso    → small blind: fold | call (a flop) | all-in → big blind: call | fold
//                all-in → small blind: call | fold
//     raise  → big blind: fold | call (a flop) | all-in → small blind: call | fold
//     all-in → big blind: call | fold
// All-ins pay by the matchup table's equities, exact. A flop is the one assumption: the
// player out of position keeps OOP_REALISE of their equity in the pot and the player in
// position the rest (bot.ts uses the same 85% before the flop).
import { REALISE } from './bot';
import { tables } from './pushfold';

const N = 169;
export const OOP_REALISE = REALISE.preflopOut;
// A raise this big a share of the stack leaves too little to fold: it's an all-in (as sizeTo).
const COMMITTED = 0.6;
const ITERATIONS = 300;

export type Spot = 'sb' | 'bb-limp' | 'bb-raise' | 'bb-shove' | 'sb-iso' | 'sb-limp-shove' | 'sb-raise-shove' | 'bb-iso-shove';
export type Move = 'fold' | 'check' | 'call' | 'raise' | 'allin';

type Node =
  | { t: 'act'; p: 0 | 1; spot: Spot; moves: Move[]; kids: Node[]; avg: Float64Array[] }
  | { t: 'fold'; loser: 0 | 1; put: [number, number] }
  | { t: 'allin' }
  | { t: 'flop'; put: number };

export interface TreeParams {
  stack: number; // effective, in big blinds (the small blind posts 0.5)
  raise: number; // the small blind's raise, to this many big blinds
  iso: number; // the big blind's raise over a limp, to this many big blinds
  sbInPosition: boolean; // heads-up the small blind is the button; between the blinds it isn't
}

export interface Priced {
  ev: Record<Move, number>; // big blinds, from the start of the hand; only the spot's moves
  moves: Move[];
  mix: Record<Move, number>; // how often the equilibrium makes each move with this hand
  reach: Float64Array; // the opponent's range here: how often each class gets to this spot
}

export interface Tree {
  params: TreeParams;
  spots: Spot[];
  price: (spot: Spot, h: number) => Priced | null;
}

function build({ stack: e, raise, iso }: TreeParams) {
  const act = (p: 0 | 1, spot: Spot, pairs: [Move, Node][]): Node => ({
    t: 'act', p, spot, moves: pairs.map((x) => x[0]), kids: pairs.map((x) => x[1]),
    avg: pairs.map(() => new Float64Array(N).fill(1 / pairs.length)),
  });
  const fold = (loser: 0 | 1, sb: number, bb: number): Node => ({ t: 'fold', loser, put: [sb, bb] });
  const allin: Node = { t: 'allin' };
  const flop = (put: number): Node => ({ t: 'flop', put });
  const shoveTo = (p: 0 | 1, spot: Spot, folded: [number, number]) =>
    act(p, spot, [['call', allin], ['fold', fold(p, ...folded)]]);
  const canRaise = (to: number) => to < COMMITTED * e;

  const sb: [Move, Node][] = [['fold', fold(0, 0.5, 1)]];
  const afterLimp: [Move, Node][] = [['check', flop(1)]];
  if (canRaise(iso)) {
    afterLimp.push(['raise', act(0, 'sb-iso', [
      ['fold', fold(0, 1, iso)], ['call', flop(iso)], ['allin', shoveTo(1, 'bb-iso-shove', [1, iso])],
    ])]);
  }
  afterLimp.push(['allin', shoveTo(0, 'sb-limp-shove', [1, e])]);
  sb.push(['call', act(1, 'bb-limp', afterLimp)]);
  if (canRaise(raise)) {
    sb.push(['raise', act(1, 'bb-raise', [
      ['fold', fold(1, raise, 1)], ['call', flop(raise)], ['allin', shoveTo(0, 'sb-raise-shove', [raise, e])],
    ])]);
  }
  sb.push(['allin', shoveTo(1, 'bb-shove', [e, 1])]);
  return act(0, 'sb', sb);
}

// For each of one player's classes, against the other's classes weighted by `reach` (how
// often each gets here) and by card removal: the weight, and the weighted equity.
function sums(reach: Float64Array, eq: Float64Array, w: Float64Array): [Float64Array, Float64Array] {
  const s0 = new Float64Array(N);
  const s1 = new Float64Array(N);
  for (let h = 0; h < N; h++) {
    const o = h * N;
    let a = 0;
    let b = 0;
    for (let j = 0; j < N; j++) {
      const m = w[o + j] * reach[j];
      a += m;
      b += m * eq[o + j];
    }
    s0[h] = a;
    s1[h] = b;
  }
  return [s0, s1];
}

function solve(params: TreeParams, iterations = ITERATIONS): Tree {
  const { eq, w } = tables();
  const e = params.stack;
  const root = build(params);
  const ip: 0 | 1 = params.sbInPosition ? 0 : 1;

  // Player p's value for each of its classes at `node`, the opponent reaching it with
  // `reach`, p playing its best response there and after (`choose`: each class's pick at
  // p's nodes). Weighted by how often the opponent gets here, not normalised.
  const value = (p: 0 | 1, node: Node, reach: Float64Array, choose?: Map<Node, Uint8Array>): Float64Array => {
    if (node.t === 'act' && node.p !== p) {
      const total = new Float64Array(N);
      node.kids.forEach((k, a) => {
        const s = node.avg[a];
        const next = new Float64Array(N);
        for (let j = 0; j < N; j++) next[j] = reach[j] * s[j];
        const v = value(p, k, next, choose);
        for (let h = 0; h < N; h++) total[h] += v[h];
      });
      return total;
    }
    if (node.t === 'act') {
      const kids = node.kids.map((k) => value(p, k, reach, choose));
      const best = new Float64Array(N).fill(-Infinity);
      const at = new Uint8Array(N);
      kids.forEach((v, a) => {
        for (let h = 0; h < N; h++) if (v[h] > best[h]) [best[h], at[h]] = [v[h], a];
      });
      choose?.set(node, at);
      return best;
    }
    const out = new Float64Array(N);
    if (node.t === 'fold') {
      const [s0] = sums(reach, eq, w);
      const x = node.loser === p ? -node.put[p] : node.put[1 - p];
      for (let h = 0; h < N; h++) out[h] = x * s0[h];
      return out;
    }
    const [s0, s1] = sums(reach, eq, w);
    for (let h = 0; h < N; h++) {
      if (node.t === 'allin') out[h] = s1[h] * 2 * e - e * s0[h];
      else {
        const x = node.put;
        const share = p === ip ? (1 - OOP_REALISE) * s0[h] + OOP_REALISE * s1[h] : OOP_REALISE * s1[h];
        out[h] = 2 * x * share - x * s0[h];
      }
    }
    return out;
  };

  const ones = new Float64Array(N).fill(1);
  for (let t = 1; t <= iterations; t++) {
    const step = 1 / (t + 1);
    for (const p of [0, 1] as const) {
      // Best responses to the other's average so far, then averaged in.
      const choose = new Map<Node, Uint8Array>();
      value(p, root, ones, choose);
      for (const [node, at] of choose) {
        if (node.t !== 'act') continue;
        node.avg.forEach((s, a) => {
          for (let h = 0; h < N; h++) s[h] += ((at[h] === a ? 1 : 0) - s[h]) * step;
        });
      }
    }
  }

  // Where each spot is, and the path to it.
  const paths = new Map<Spot, [Node & { t: 'act' }, number][]>();
  const index = new Map<Spot, Node & { t: 'act' }>();
  const walk = (n: Node, path: [Node & { t: 'act' }, number][]) => {
    if (n.t !== 'act') return;
    paths.set(n.spot, path);
    index.set(n.spot, n);
    n.kids.forEach((k, a) => walk(k, [...path, [n, a]]));
  };
  walk(root, []);

  const price = (spot: Spot, h: number): Priced | null => {
    const node = index.get(spot);
    if (!node) return null;
    const p = node.p;
    const reach = new Float64Array(N).fill(1);
    for (const [n, a] of paths.get(spot)!) {
      if (n.p !== p) for (let j = 0; j < N; j++) reach[j] *= n.avg[a][j];
    }
    const [s0] = sums(reach, eq, w);
    if (s0[h] <= 1e-9) return null;
    const ev = {} as Record<Move, number>;
    const mix = {} as Record<Move, number>;
    node.kids.forEach((k, a) => {
      ev[node.moves[a]] = value(p, k, reach)[h] / s0[h];
      mix[node.moves[a]] = node.avg[a][h];
    });
    return { ev, moves: node.moves, mix, reach };
  };
  return { params, spots: [...index.keys()], price };
}

const memo = new Map<string, Tree>();
// Stacks to the nearest quarter big blind, so nearby hands share a solve.
export function headsUpTree(params: TreeParams): Tree {
  const p = { ...params, stack: Math.round(params.stack * 4) / 4 };
  const key = `${p.stack}|${p.raise}|${p.iso}|${p.sbInPosition}`;
  if (!memo.has(key)) {
    if (memo.size > 32) memo.clear();
    memo.set(key, solve(p));
  }
  return memo.get(key)!;
}
