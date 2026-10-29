import { describe, expect, it } from 'vitest';
import { choose, KINDS, makeQuestion, nextQuestion } from './questions';

// Every two-card hand from a 52-card deck: card = rank * 4 + suit.
const hands: [number, number][] = [];
for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) hands.push([a, b]);
const rank = (c: number) => c >> 2;
const suit = (c: number) => c & 3;

const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};

describe('statistics questions', () => {
  it('counts starting hands by brute force', () => {
    expect(hands).toHaveLength(1326);
    expect(hands.filter(([a, b]) => rank(a) === rank(b))).toHaveLength(78);
    expect(hands.filter(([a, b]) => suit(a) === suit(b))).toHaveLength(312);
    expect(hands.filter(([a, b]) => rank(a) === 12 || rank(b) === 12)).toHaveLength(198);
    expect(hands.filter(([a, b]) => rank(a) === 11 && rank(b) === 12)).toHaveLength(16);
  });

  it('flop odds match a count of every flop', () => {
    // Hero holds cards 0 and 1 (two 2s); flops come from the other 50.
    let set = 0;
    let flops = 0;
    for (let a = 2; a < 52; a++)
      for (let b = a + 1; b < 52; b++)
        for (let c = b + 1; c < 52; c++) {
          flops++;
          if ([a, b, c].some((x) => rank(x) === 0)) set++;
        }
    expect(makeQuestion('set').exact).toBeCloseTo(set / flops, 12);
    expect(makeQuestion('flush').exact).toBeCloseTo(choose(11, 3) / choose(50, 3), 12);
  });

  it('gives the ace-out chance by inclusion of every deal size', () => {
    for (let n = 1; n <= 8; n++) {
      const q = makeQuestion('ace-out', seq((n - 1) / 8 + 0.01, 0.5, 0.2, 0.3, 0.4));
      expect(q.prompt).toContain(`${n} opponent`);
      expect(q.exact).toBeCloseTo(1 - choose(46, 2 * n) / choose(50, 2 * n), 12);
    }
  });

  it('prices pot odds and bluffs', () => {
    const p = makeQuestion('pot-odds');
    const [pot, bet] = p.prompt.match(/\d+/g)!.map(Number);
    expect(p.exact).toBeCloseTo(bet / (pot + 2 * bet), 12);
    const b = makeQuestion('bluff');
    const [bb, bp] = b.prompt.match(/\d+/g)!.map(Number);
    expect(b.exact).toBeCloseTo(bb / (bb + bp), 12);
  });

  it('always asks a probability, and never the same kind twice running', () => {
    let last = null;
    for (let i = 0; i < 2000; i++) {
      const q = nextQuestion(last);
      expect(q.kind).not.toBe(last);
      expect(q.exact).toBeGreaterThan(0);
      expect(q.exact).toBeLessThan(1);
      last = q.kind;
    }
    for (const k of KINDS) expect(makeQuestion(k).working.length).toBeGreaterThan(0);
  });
});
