import { describe, expect, it } from 'vitest';
import { parseCards } from './cards';
import { classOf, headsUp, preflopSlices, rangeShare, threeHanded, versus } from './pushfold';

const cls = (hand: string) => classOf(...(parseCards(hand) as [number, number]));
const only = (hand: string) => {
  const r = new Float64Array(169);
  r[cls(hand)] = 1;
  return r;
};

describe('matchup table', () => {
  it('matches well-known all-in equities', () => {
    expect(versus(cls('Ac Ad'), only('Kc Kd'))[1]).toBeCloseTo(0.82, 2);
    expect(versus(cls('Ac Kc'), only('Qc Qd'))[1]).toBeCloseTo(0.46, 1);
    expect(versus(cls('Ac Kd'), only('Qc Qd'))[1]).toBeCloseTo(0.43, 1);
  });

  it('cuts a range into equal slices, weakest first', () => {
    const s = preflopSlices(0.3, 0.12, parseCards('7c 2d'), 12);
    expect(s).toHaveLength(12);
    expect(s[11]).toBeGreaterThan(s[0]);
  });
});

describe('heads-up push/fold', () => {
  // HoldemResources, heads-up, no antes: the most big blinds each hand shoves and calls with.
  const NASH: [string, number, number][] = [
    ['2c 2d', 20, 15.0], ['Ac 2d', 20, 15.8], ['Kc 2c', 19.3, 10.7], ['Qc 7d', 10.3, 8.0], ['7c 2d', 1.6, 2.6], ['Tc 9c', 20, 11.5],
  ];
  const at = (bb: number) => headsUp(bb * 10, bb * 10, 5, 10);
  it.each(NASH)('%s shoves to %sbb and calls to %sbb, within a big blind', (hand, push, call) => {
    const h = cls(hand);
    if (push >= 2) expect(at(push - 1).push[h]).toBeGreaterThan(0.5);
    if (push < 19) expect(at(push + 1).push[h]).toBeLessThan(0.5);
    if (call >= 2) expect(at(call - 1).call[h]).toBeGreaterThan(0.5);
    if (call < 19) expect(at(call + 1).call[h]).toBeLessThan(0.5);
  });

  it('pushes wider than it calls, and both narrow as stacks deepen', () => {
    const [short, deep] = [at(5), at(15)];
    expect(rangeShare(short.push)).toBeGreaterThan(rangeShare(short.call));
    expect(rangeShare(short.push)).toBeGreaterThan(rangeShare(deep.push));
    expect(rangeShare(short.call)).toBeGreaterThan(rangeShare(deep.call));
  });
});

describe('three-handed push/fold', () => {
  it('the button pushes tighter than heads-up, with two players left to call', () => {
    const three = threeHanded(100, 100, 100, 5, 10);
    expect(rangeShare(three.push)).toBeLessThan(rangeShare(headsUp(100, 100, 5, 10).push));
    expect(three.push[cls('Ac Ad')]).toBeGreaterThan(0.99); // the average of every round's range, from a 50% start
    expect(three.push[cls('7c 2d')]).toBeLessThan(0.01);
    // Overcalling a push and a call takes more than calling the push alone.
    expect(rangeShare(three.bbOvercall)).toBeLessThan(rangeShare(three.bbCall));
  });
});
