import { describe, expect, it } from 'vitest';
import { betOutcome, decide, estimateEquity, STYLES, type BotView, type OpponentView } from './bot';
import { parseCards } from './cards';
import { emptyTally, PRIOR, PRIOR_READ, readOf } from './reads';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const seat = (o: Partial<OpponentView>): OpponentView => ({
  name: 'Ada', voluntary: true, acted: false, allIn: false, raisesPreflop: 0, openBehind: null, raisesPostflop: 0,
  callsPostflop: 0, bet: 0, committed: 100, stack: 900, read: PRIOR_READ, ...o,
  barrels: o.barrels ?? o.raisesPostflop ?? 0, raisesOverBet: o.raisesOverBet ?? 0,
  aggrStreet: o.aggrStreet ?? ((o.bet ?? 0) > 0 && ((o.raisesPostflop ?? 0) > 0 || (o.raisesPreflop ?? 0) > 0)),
});

const ME = seat({ name: 'You' });

const spot = (hole: string, board: string, o: Partial<BotView> = {}): BotView => ({
  hole: parseCards(hole), board: parseCards(board), pot: 200, toCall: 0, currentBet: 0, myBet: 0,
  minRaiseTo: 10, maxRaiseTo: 900, canRaise: true, bigBlind: 10, opponents: [seat({})],
  myCommitted: 100, committed: [100], me: ME, pfAggressor: false, inPosition: true, ...o,
});

const readWith = (t: Partial<ReturnType<typeof emptyTally>>) => readOf({ ...emptyTally(), ...t });

describe('reads', () => {
  it('start at the population average and move to the player with a sample', () => {
    expect(PRIOR_READ.foldToBet.rate).toBeCloseTo(PRIOR.foldToBet);
    const few = readWith({ facedBet: 2, foldedToBet: 2 });
    const many = readWith({ facedBet: 200, foldedToBet: 180 });
    expect(few.foldToBet.rate).toBeLessThan(0.65); // two folds is not a read
    expect(many.foldToBet.rate).toBeCloseTo(0.9, 1);
    expect(many.foldToBet.sd).toBeLessThan(few.foldToBet.sd);
  });
});

describe('betOutcome', () => {
  it('matches the fold rate it is given, and equity when nobody folds', () => {
    const rng = seeded(5);
    const hole = parseCards('Qs Jd');
    const board = parseCards('Ks 8c 3h');
    const range = { top: 1, need: 0 as const, draws: false, bluff: 0 };
    const [never, half, always] = betOutcome(hole, board, [range], [[0, 0.5, 1]], 4000, rng);
    expect(never.pFold).toBe(0);
    expect(always.pFold).toBe(1);
    expect(half.pFold).toBeGreaterThan(0.45);
    expect(half.pFold).toBeLessThan(0.55);
    expect(never.eCalled).toBeCloseTo(estimateEquity(hole, board, [range], 4000, rng), 1);
    // Folding the weakest half leaves stronger hands: worse for us when called.
    expect(half.eCalled).toBeLessThan(never.eCalled);
  });
});

// How often a bot makes each kind of decision in one spot.
function tally(view: BotView, style: keyof typeof STYLES, n = 300) {
  const rng = seeded(11);
  const out = { fold: 0, check: 0, call: 0, raise: 0 };
  for (let i = 0; i < n; i++) out[decide(view, STYLES[style], rng).type]++;
  return out;
}

describe('bluffing follows the read', () => {
  // River, missed everything: betting only wins when they fold.
  const air = (k: number) =>
    spot('7c 2d', 'As Kh 9d 4s 3c', {
      opponents: [seat({ read: readWith({ hands: 80, vpip: 20, pfr: 12, facedBet: 50, foldedToBet: k }) })],
    });

  it('bluffs a player who folds a lot, and not one who never does', () => {
    const folder = tally(air(42), 'regular');
    const station = tally(air(4), 'regular');
    expect(folder.raise).toBeGreaterThan(150);
    expect(station.raise).toBeLessThan(10);
  });

  it('a tight player bluffs less than a loose-aggressive one in the same spot', () => {
    const v = air(30);
    expect(tally(v, 'tight').raise).toBeLessThan(tally(v, 'loose-aggressive').raise);
  });
});

describe('styles', () => {
  it('a calling station calls a river bet with a weak hand more than a tight player', () => {
    // Second pair, weak kicker, facing a pot-sized river bet from an average player:
    // a little short of the price, which a station calls anyway.
    const v = spot('Kd 5c', 'As Kh 9d 7s 3c', {
      pot: 400, toCall: 200, currentBet: 200, minRaiseTo: 400, maxRaiseTo: 800, myCommitted: 100, committed: [300],
      opponents: [seat({ raisesPostflop: 1, bet: 200, committed: 300, stack: 700 })],
    });
    expect(tally(v, 'calling-station').call).toBeGreaterThan(tally(v, 'tight').call);
  });
});

describe('short stacks', () => {
  const short = (hole: string, toAct: number) =>
    spot(hole, '', {
      pot: 15, toCall: 10, currentBet: 10, minRaiseTo: 20, maxRaiseTo: 80, myCommitted: 0, committed: [5, 10],
      inPosition: false,
      opponents: Array.from({ length: toAct }, (_, i) => seat({ name: `P${i}`, voluntary: false, committed: i < 2 ? [5, 10][i] : 0, bet: i < 2 ? [5, 10][i] : 0, stack: 800 })),
    });

  it('at 8 big blinds, aces go all-in and 7-2 folds', () => {
    expect(tally(short('Ah Ad', 5), 'regular', 40).raise).toBe(40);
    expect(tally(short('7c 2d', 5), 'regular', 40).fold).toBe(40);
  });

  it('never makes a small raise when short', () => {
    const t = { fold: 0, raise: 0, small: 0 };
    const rng = seeded(3);
    for (let i = 0; i < 60; i++) {
      const d = decide(short('Kh Td', 3), STYLES.regular, rng);
      if (d.type === 'raise') d.to === 80 ? t.raise++ : t.small++;
      else t.fold++;
    }
    expect(t.small).toBe(0);
  });
});
