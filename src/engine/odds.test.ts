import { describe, expect, it } from 'vitest';
import { parseCards } from './cards';
import { computeOdds } from './odds';
import { targetsFor } from './targets';

const offer = (hole: string, board: string) => targetsFor(parseCards(hole), parseCards(board));
const pick = (hole: string, board: string, kind: string) => {
  const t = offer(hole, board).find((x) => x.kind === kind);
  if (!t) throw new Error(`${kind} not offered`);
  return t;
};
const odds = (hole: string, board: string, kind: string, h: 'next' | 'river' = 'river') =>
  computeOdds(parseCards(hole), parseCards(board), pick(hole, board, kind), h);

describe('targets', () => {
  it('unpaired cards: pair each, either, both', () => {
    const kinds = offer('Ah Kd', '2c 7s 9h').map((t) => t.label);
    expect(kinds).toEqual(['Pair your A', 'Pair your K', 'Pair A or K', 'Pair both A and K']);
    expect(odds('Ah Kd', '2c 7s 9h', 'pair-one').outs).toHaveLength(3);
    expect(odds('Ah Kd', '2c 7s 9h', 'pair-either').probability).toBeCloseTo(1 - (41 / 47) * (40 / 46), 10);
    // Pairing both needs one of each: 3 × 3 runouts.
    expect(odds('Ah Kd', '2c 7s 9h', 'pair-both').probability).toBeCloseTo(9 / 1081, 10);
  });

  it('two pair counts only the hero pairing, not the board', () => {
    // Board pairing the 7 would give "two pair" on paper; the target ignores it.
    const r = odds('Ah Kd', 'Ac 7s 9h', 'pair-one', 'next');
    expect(r.outs).toHaveLength(3); // the Kings
    expect(odds('Ah Kd', 'Ac 7s 9h', 'improve-pair', 'next').outs).toHaveLength(5);
    expect(odds('Ah Kd', 'Ac 7s 9h', 'trips', 'next').outs).toHaveLength(2);
  });

  it('pocket pair: set with 2 outs, full house from a set', () => {
    expect(odds('5h 5d', 'Kc 9s 2h', 'set', 'next').probability).toBeCloseTo(2 / 47, 10);
    const fh = odds('5h 5d', 'Kc 5s 2h Jd', 'full-house', 'next');
    expect(fh.outs).toHaveLength(10); // 1 five, 3 kings, 3 twos, 3 jacks
  });

  it('flush draw: 9 outs, backdoor on the flop only by river', () => {
    const r = odds('Ah Kh', '2h 7h 9c', 'flush');
    expect(r.outs).toHaveLength(9);
    expect(r.probability).toBeCloseTo(1 - (38 / 47) * (37 / 46), 10);
    const bd = pick('Ah Kh', '2h 7c 9d', 'backdoor-flush');
    expect(bd.singleCard).toBe(false);
    expect(computeOdds(parseCards('Ah Kh'), parseCards('2h 7c 9d'), bd, 'river').runnerCombos).toBe(45);
  });

  it('straight draws need a hole card; combo draw counts 15 outs', () => {
    expect(odds('8c 9d', '6h 7s Kc', 'straight', 'next').outs).toHaveLength(8);
    expect(offer('Ah Kd', '5c 6s 7h 8d').some((t) => t.kind === 'straight')).toBe(false);
    expect(odds('8h 9h', '6h 7h Kc', 'straight-or-flush', 'next').outs).toHaveLength(15);
  });

  it('turn targets are one-card only', () => {
    const t = offer('Ah Kh', '2h 7c 9d Js');
    expect(t.every((x) => x.singleCard)).toBe(true);
    expect(t.some((x) => x.kind === 'backdoor-flush' || x.kind === 'pair-both')).toBe(false);
  });
});

describe('targets only offer real improvements', () => {
  it("drops a pair that doesn't improve two pair", () => {
    // A4 on A99: aces and nines already; pairing the 4 is still two pair.
    expect(offer('As 4d', 'Ah 9c 9d').some((t) => t.label === 'Pair your 4')).toBe(false);
  });

  it('describes what hitting actually makes', () => {
    // 55 on KK2: the third five makes a full house, not a set.
    expect(pick('5h 5d', 'Kc Ks 2h', 'set').makes).toBe('a full house');
    // AK on A72: pairing the king makes two pair.
    expect(pick('Ah Kd', 'Ac 7s 2h', 'pair-one').makes).toBe('two pair');
    // Flush draw: some flush cards also make a straight flush.
    expect(pick('6h 7h', '8h 9h Kc', 'flush').makes).toBe('a flush or better');
  });

  it('offers quads when one hole card already has trips', () => {
    expect(pick('9h 8d', '9c 9s 2h', 'quads').singleCard).toBe(true);
  });
});
