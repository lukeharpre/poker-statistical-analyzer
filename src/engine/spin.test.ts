import { describe, expect, it } from 'vitest';
import { SPIN_LEVEL_MS, SpinAndGo } from './spin';

describe('Spin & Go', () => {
  it('seats three with the chosen stack and raises blinds on the clock', () => {
    let t = 0;
    const g = new SpinAndGo(300, () => t);
    expect(g.players.map((p) => p.stack)).toEqual([300, 300, 300]);
    g.startHand();
    expect([g.smallBlind, g.bigBlind]).toEqual([10, 20]);
    expect(g.nextBlindsIn).toBe(SPIN_LEVEL_MS);
    t = SPIN_LEVEL_MS + 1;
    expect(g.nextBlindsIn).toBe(0); // due, from the next hand
    while (g.phase === 'betting') g.act(g.toAct, { type: 'fold' });
    g.startHand();
    expect([g.smallBlind, g.bigBlind]).toEqual([15, 30]);
  });

  it('plays to a finish with a place for the hero', () => {
    const g = new SpinAndGo(500);
    for (let i = 0; i < 2000 && !g.finished; i++) {
      g.startHand();
      while (g.phase === 'betting') g.act(g.toAct, { type: 'allin' });
      while (g.phase === 'runout') g.runoutStep();
    }
    expect(g.finished).toBe(true);
    expect([1, 2, 3]).toContain(g.hero.place);
  });
});
