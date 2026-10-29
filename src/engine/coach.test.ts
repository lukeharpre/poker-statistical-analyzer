import { describe, expect, it } from 'vitest';
import { analyse, seeded, type BotView, type OpponentView } from './bot';
import { PRIOR_READ, emptyTally, readOf } from './reads';
import { parseCards } from './cards';
import { coachDecision } from './coach';
import { Game, type Action } from './game';

const seat = (o: Partial<OpponentView>): OpponentView => ({
  name: 'Ada', voluntary: false, acted: false, allIn: false, raisesPreflop: 0, openBehind: null, raisesPostflop: 0,
  callsPostflop: 0, bet: 0, committed: 0, stack: 1000, read: PRIOR_READ, ...o,
  barrels: o.barrels ?? o.raisesPostflop ?? 0, raisesOverBet: o.raisesOverBet ?? 0,
  aggrStreet: o.aggrStreet ?? ((o.bet ?? 0) > 0 && ((o.raisesPostflop ?? 0) > 0 || (o.raisesPreflop ?? 0) > 0)),
});
const opp = seat({ voluntary: true, acted: true, raisesPostflop: 1 });
const ME = seat({ name: 'You', voluntary: true });
const view = (hole: string, board: string, pot: number, toCall: number): BotView => ({
  hole: parseCards(hole), board: parseCards(board), pot, toCall, currentBet: toCall, myBet: 0,
  minRaiseTo: toCall * 2, maxRaiseTo: 1000, canRaise: true, bigBlind: 10, opponents: [{ ...opp, bet: toCall }],
  // Earlier streets matched; this street the opponent bet toCall into us.
  myCommitted: (pot - toCall) / 2, committed: [(pot + toCall) / 2],
  me: ME, pfAggressor: false, inPosition: false,
});

describe('coachDecision', () => {
  it('flags a call without odds and a good fold', () => {
    // 7-high, no draw, facing a pot-sized bet.
    const v = view('7c 2d', 'As Kh Qd', 200, 100);
    expect(coachDecision(v, { type: 'call' }).verdict).toBe('mistake');
    expect(coachDecision(v, { type: 'fold' }).verdict).toBe('good');
  });

  it('a big draw facing a small bet: calling pays, raising pays more', () => {
    // Nut flush draw + gutshot, facing a tiny bet: 9+ outs vs a 1/11 price. The raise
    // adds fold equity to a hand that is often ahead when called.
    const v = view('Ah 5h', 'Kh 4h 3c', 200, 20);
    const call = coachDecision(v, { type: 'call' });
    expect(call.verdict).not.toBe('mistake');
    expect(call.lines.join(' ')).toMatch(/You need 9% to call/);
    expect(coachDecision(v, { type: 'raise', to: 185 }).verdict).toBe('good');
  });

  it('preflop: folding 7-2 offsuit unopened is standard', () => {
    const v: BotView = {
      ...view('7c 2d', '', 15, 10),
      opponents: Array.from({ length: 5 }, () => seat({})),
    };
    expect(coachDecision(v, { type: 'fold' }).verdict).toBe('good');
    expect(coachDecision(v, { type: 'raise', to: 30 }).verdict).toBe('mistake');
  });
});

describe('reads', () => {
  // River, 7-high with no draw left: a bet only wins when they fold.
  const air = (foldToBet: { k: number; n: number }): BotView => {
    const tally = { ...emptyTally(), hands: 60, vpip: 18, pfr: 10, facedBet: foldToBet.n, foldedToBet: foldToBet.k };
    return {
      ...view('7c 2d', 'As Kh 9d 4s 3c', 200, 0),
      currentBet: 0, minRaiseTo: 10, myCommitted: 100, committed: [100],
      opponents: [seat({ voluntary: true, acted: false, read: readOf(tally) })],
    };
  };

  it('a bluff into a player who folds a lot is good, into one who never folds is a mistake', () => {
    expect(coachDecision(air({ k: 32, n: 40 }), { type: 'raise', to: 130 }).verdict).not.toBe('mistake');
    expect(coachDecision(air({ k: 3, n: 40 }), { type: 'raise', to: 130 }).verdict).toBe('mistake');
  });

  it('checking air against a big folder misses a profitable bluff, and says why', () => {
    const note = coachDecision(air({ k: 34, n: 40 }), { type: 'check' });
    expect(note.verdict).not.toBe('good');
    expect(note.lines.join(' ')).toMatch(/Ada folds to bets a lot \(\d+%/);
  });
});

describe('before the flop', () => {
  it('AK re-raising one opener, with the blinds still to act, is not a bluff', () => {
    // An average player opens to 30; button and blinds have not acted yet.
    const v: BotView = {
      ...view('Ac Kd', '', 45, 30),
      currentBet: 30, minRaiseTo: 50, maxRaiseTo: 1000, myCommitted: 0, committed: [30, 0, 5, 10], inPosition: true,
      opponents: [
        seat({ name: 'Maryam', voluntary: true, acted: true, raisesPreflop: 1, openBehind: 4, bet: 30, committed: 30, stack: 970 }),
        seat({ name: 'Carl' }),
        seat({ name: 'Felix', bet: 5, committed: 5 }),
        seat({ name: 'Olga', bet: 10, committed: 10 }),
      ],
    };
    const raise = coachDecision(v, { type: 'raise', to: 90 });
    expect(raise.verdict).toBe('good');
    
    expect(coachDecision(v, { type: 'fold' }).verdict).toBe('mistake');
    // Flat-calling AK is profitable, just less so: close, not a mistake.
    expect(coachDecision(v, { type: 'call' }).verdict).toBe('close');
  });
});

describe('side pots', () => {
  it('prices a short all-in call on the pot it can win', () => {
    // Hero has 15 left facing a 100 bet; the bettor put in 140 total, another caller 140.
    const v: BotView = {
      ...view('Ah Kd', '2c 7s 9h', 300, 15),
      myCommitted: 20,
      committed: [140, 140],
      maxRaiseTo: 35,
    };
    // Hero can match 35 from each: winnable = 35 + 35 + 35 = 105, price 15/105.
    const note = coachDecision(v, { type: 'call' });
    expect(note.lines.join(' ')).toMatch(/You need 14% to call/);
    expect(note.lines.join(' ')).toMatch(/side pot/);
  });
});

describe('hand names', () => {
  it('writes each card separately', () => {
    const v: BotView = {
      ...view('Th 7c', '', 15, 10),
      opponents: Array.from({ length: 5 }, () => seat({})),
    };
    const text = coachDecision(v, { type: 'fold' }).lines[0];
    expect(text).toMatch(/^10♥ 7♣ \(offsuit\): bottom \d+% of starting hands/);
    expect(text).not.toMatch(/107/);
  });
});

describe('brevity', () => {
  it('keeps every note to a few short lines', () => {
    const spots: [BotView, Parameters<typeof coachDecision>[1]][] = [
      [view('7c 2d', 'As Kh Qd', 200, 100), { type: 'call' }],
      [view('Ah 5h', 'Kh 4h 3c', 200, 20), { type: 'fold' }],
      [view('Ac Kd', '', 45, 30), { type: 'fold' }],
    ];
    for (const [v, a] of spots) {
      const note = coachDecision(v, a);
      expect(note.lines.length).toBeLessThanOrEqual(5);
      for (const l of note.lines) expect(l.length).toBeLessThanOrEqual(110);
    }
  });
});

describe('bet sizes', () => {
  it('names the best size when one clearly beats the next, and how it was priced', () => {
    // The nuts on the river, checked to: betting is the play, and pot beats ¾ by more than the noise.
    const v: BotView = { ...view('Ah 5h', 'Kh 9h 2h 7c 3d', 200, 0), currentBet: 0, minRaiseTo: 10, myCommitted: 100, committed: [100] };
    const text = coachDecision(v, { type: 'check' }).lines.join(' ');
    expect(text).toMatch(/Best size is (⅓ |⅔ |½ |¾ )?pot \(\d+\), against their fold rates so far: they fold about \d+%; called, you win about \d+%/);
    expect(text).not.toMatch(/earns about the same|less\.$/);
  });
});

describe('stack depth', () => {
  // Heads up, the hero on the button (small blind), nobody in yet. Blinds 10/20.
  const unopened = (hole: string, stack: number): BotView => ({
    ...view(hole, '', 30, 10),
    currentBet: 20, myBet: 10, minRaiseTo: 40, maxRaiseTo: stack, bigBlind: 20, myCommitted: 10, committed: [20],
    opponents: [seat({ bet: 20, committed: 20, stack: stack - 20 })], inPosition: true,
  });
  // The hero in the big blind facing a raise to `to`.
  const raised = (hole: string, stack: number, to: number): BotView => ({
    ...view(hole, '', 20 + to, to - 20),
    currentBet: to, myBet: 20, minRaiseTo: 2 * to - 20, maxRaiseTo: stack, bigBlind: 20, myCommitted: 20, committed: [to],
    opponents: [seat({ bet: to, committed: to, stack: stack - to, voluntary: true, acted: true, raisesPreflop: 1 })],
  });

  it('grades an open on its size for the stack depth', () => {
    expect(coachDecision(unopened('As Kd', 500), { type: 'raise', to: 50 }).verdict).toBe('good');
    const big = coachDecision(unopened('As Kd', 500), { type: 'raise', to: 120 });
    expect(big.verdict).toBe('mistake');
    expect(big.lines.join(' ')).toMatch(/At 25 big blinds a standard open is 2.2–2.5 BB/);
    // Risk ÷ (risk + pot): 110 ÷ 140 and 40 ÷ 70.
    expect(big.lines.join(' ')).toMatch(/6 BB \(120\) needs 79% folds to pay as a steal; 2.5 BB \(50\) needs 57%/);
    // 3 BB is standard 100 big blinds deep, and an over-size short of double is close.
    expect(coachDecision(unopened('As Kd', 2000), { type: 'raise', to: 60 }).verdict).toBe('good');
    expect(coachDecision(unopened('As Kd', 2000), { type: 'raise', to: 100 }).verdict).toBe('close');
  });

  it('says whose stack sets the depth when short', () => {
    const v = { ...unopened('As Kd', 2000), opponents: [seat({ bet: 20, committed: 20, stack: 180 })] };
    expect(coachDecision(v, { type: 'raise', to: 2000 }).lines.join(' ')).toMatch(/10 big blinds effective \(their stack\): all-in or fold/);
  });

  it('set mining: says what a call needs from later streets, and what is behind', () => {
    // Calling 40 into 80: 40 ÷ 11.8% − 80 − 40 = 220 more needed when the set comes.
    const deep = coachDecision(raised('4s 4d', 2000, 60), { type: 'call' });
    expect(deep.verdict).not.toBe('mistake');
    expect(deep.lines.join(' ')).toMatch(/a set flops 11.8% of the time; a call needs 220 more when you hit; 1940 is behind/);
    // 30 big blinds deep there isn't enough behind for that, and the price alone doesn't pay.
    const shallow = coachDecision(raised('4s 4d', 300, 60), { type: 'call' });
    expect(shallow.lines.join(' ')).toMatch(/a call needs 220 more when you hit; 240 is behind/);
  });
});

describe('short stacks', () => {
  // A Spin & Go hand at 15/30 with these stacks (button first), the hero's cards set.
  const spin = (stacks: number[], hole: string) => {
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const g = new Game(stacks.length - 1, 1000, rng, 'tournament');
    g.blindLevels = [[15, 30]];
    stacks.forEach((c, i) => (g.players[i].stack = c));
    g.button = stacks.length - 1; // startHand moves it to the hero, seat 0
    g.startHand();
    g.players[0].hole = parseCards(hole);
    return g.botView(0);
  };
  const grades = (v: BotView, actions: Action[]) => actions.map((a) => coachDecision(v, a));

  it('grades a short heads-up spot from a real deal against the equilibrium', () => {
    const note = coachDecision(spin([300, 300], '7h 5d'), { type: 'fold' });
    expect(note.lines[0]).toMatch(/^At 10 big blinds heads-up, the equilibrium /);
  });

  it('heads-up, every option comes from one equilibrium: only the best is right', () => {
    for (const hole of ['Kd 7h', '9d 5c', 'Ac Kd', '6c 4c']) {
      const v = spin([450, 450], hole);
      const notes = grades(v, [{ type: 'fold' }, { type: 'call' }, { type: 'raise', to: 60 }, { type: 'allin' }]);
      // Whatever a note says is better is never itself graded a mistake.
      const named = notes.filter((n) => n.verdict !== 'good').map((n) => n.headline.split(' ')[0].toLowerCase());
      const word = { fold: 'folding', call: 'limping', raise: 'raising', allin: 'shoving' } as const;
      const goods = (['fold', 'call', 'raise', 'allin'] as const).filter((_, i) => notes[i].verdict === 'good').map((k) => word[k]);
      expect(goods.length).toBeGreaterThan(0);
      for (const w of named) expect(goods).toContain(w);
    }
  });

  it('prices a shove the same whether or not the hero covers the blinds', () => {
    // AQo on the button, 11 big blinds against both blinds: chips past their stacks come
    // back uncalled, so covering them changes neither the price they get nor what's risked.
    const shove = (stacks: number[]) => {
      const a = analyse(spin(stacks, 'Ah Qc'), 3000, seeded(1), undefined, true);
      return a.options.find((o) => o.kind === 'raise' && o.to === a.options.at(-1)!.to)!;
    };
    const even = shove([330, 330, 330]);
    const covering = shove([860, 330, 310]);
    expect(even.ev).toBeGreaterThan(0);
    expect(Math.abs(covering.ev - even.ev)).toBeLessThan(15);
    expect(Math.abs(covering.pFold! - even.pFold!)).toBeLessThan(0.05);
  });

  it('three-handed from the button, folding and raising are never both right', () => {
    for (const hole of ['6c 4c', 'Kd 5h', 'Td 8c', '9d 4s']) {
      const v = spin([300, 300, 300], hole);
      const [fold, raise] = grades(v, [{ type: 'fold' }, { type: 'raise', to: 60 }]);
      expect(fold.verdict === 'good' && raise.verdict === 'good').toBe(false);
    }
  });

  it('a raise short of all-in is never called an all-in', () => {
    // Four-handed at 10 big blinds: no equilibrium game, so it's weighed.
    const v = spin([300, 300, 300, 300], 'Ac Qd');
    expect(coachDecision(v, { type: 'raise', to: 60 }).headline).not.toBe('All-in is right.');
  });
});
