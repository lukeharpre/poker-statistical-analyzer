// Independent cross-checks: a naive evaluator and brute-force runout enumeration.
import { describe, expect, it } from 'vitest';
import { freshDeck, remainingDeck, shuffle, type Card } from './cards';
import { evaluate } from './evaluator';
import { computeOdds } from './odds';
import { targetsFor } from './targets';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

// Naive 5-card evaluator written from the rules, sharing no code with evaluate().
function naive5(cards: Card[]): number[] {
  const ranks = cards.map((c) => c >> 2).sort((a, b) => b - a);
  const flush = cards.every((c) => (c & 3) === (cards[0] & 3));
  const uniq = [...new Set(ranks)];
  let straightHi = -1;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHi = uniq[0];
    if (uniq.join() === '12,3,2,1,0') straightHi = 3;
  }
  const groups = uniq
    .map((r) => [ranks.filter((x) => x === r).length, r])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = groups.map((g) => g[0]).join('');
  const byGroup = groups.map((g) => g[1]);
  if (straightHi >= 0 && flush) return [8, straightHi];
  if (shape === '41') return [7, ...byGroup];
  if (shape === '32') return [6, ...byGroup];
  if (flush) return [5, ...ranks];
  if (straightHi >= 0) return [4, straightHi];
  if (shape === '311') return [3, ...byGroup];
  if (shape === '221') return [2, ...byGroup];
  if (shape === '2111') return [1, ...byGroup];
  return [0, ...ranks];
}
const cmp = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1);
  return 0;
};
function naive7(cards: Card[]): number[] {
  let best: number[] = [-1];
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++) {
      const five = cards.filter((_, i) => i !== a && i !== b);
      const v = naive5(five);
      if (cmp(v, best) > 0) best = v;
    }
  return best;
}

describe('audit: evaluator vs naive best-of-21', () => {
  it('orders 20,000 random pairs of 7-card hands identically', () => {
    const rng = seeded(42);
    for (let t = 0; t < 20000; t++) {
      const d = shuffle(freshDeck(), rng);
      const board = d.slice(0, 5);
      const h1 = [...d.slice(5, 7), ...board];
      const h2 = [...d.slice(7, 9), ...board];
      const fast = Math.sign(evaluate(h1) - evaluate(h2));
      const slow = Math.sign(cmp(naive7(h1), naive7(h2)));
      if (fast !== slow) throw new Error(`mismatch: ${h1} vs ${h2}`);
    }
  });
});

describe('audit: odds breakdown vs brute-force runouts', () => {
  it('every offered target, 400 random flops and turns, both horizons', () => {
    const rng = seeded(7);
    let checked = 0;
    for (let t = 0; t < 400; t++) {
      const d = shuffle(freshDeck(), rng);
      const hole = d.slice(0, 2);
      const board = d.slice(2, t % 2 ? 6 : 5);
      for (const target of targetsFor(hole, board)) {
        for (const horizon of ['next', 'river'] as const) {
          const r = computeOdds(hole, board, target, horizon);
          const unseen = remainingDeck([...hole, ...board]);
          let hits = 0;
          let total = 0;
          if (r.cardsToCome === 1) {
            for (const c of unseen) {
              total++;
              if (target.hits([...board, c])) hits++;
            }
          } else {
            for (let i = 0; i < unseen.length; i++)
              for (let j = i + 1; j < unseen.length; j++) {
                total++;
                if (target.hits([...board, unseen[i], unseen[j]])) hits++;
              }
          }
          expect(r.totalCombos).toBe(total);
          expect(r.hitCombos).toBe(hits);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
