import { describe, expect, it } from 'vitest';
import { decide, STYLES } from './bot';
import { BLIND_LEVELS, Game, HANDS_PER_LEVEL } from './game';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

describe('Game', () => {
  it('plays many bot hands without losing or creating chips', () => {
    for (const bots of [1, 3, 8]) {
      const rng = seeded(bots * 7919);
      const g = new Game(bots, 1000, rng);
      const hero = STYLES.regular;
      for (let h = 0; h < 120; h++) {
        const rebuys = g.players.filter((p) => p.stack === 0).length;
        const before = g.players.reduce((s, p) => s + p.stack, 0) + rebuys * 1000;
        g.startHand();
        let guard = 0;
        while (g.phase !== 'handOver') {
          if (++guard > 500) throw new Error('hand did not finish');
          if (g.phase === 'runout') {
            g.runoutStep();
            continue;
          }
          const p = g.players[g.toAct];
          g.act(p.id, decide(g.botView(p.id), p.personality ?? hero, rng));
        }
        const after = g.players.reduce((s, p) => s + p.stack, 0);
        expect(after).toBe(before);
        const rec = g.currentRecord!;
        expect(rec.number).toBe(g.handNumber);
        expect(rec.result).toBeTruthy();
        expect(rec.heroNet).toBe(g.hero.stack - rec.heroStart);
        expect(rec.board).toEqual(g.board);
        expect(g.board).toHaveLength(g.result!.revealed.length ? 5 : g.board.length);
      }
      // Every player's stats add up: rates never exceed their opportunities.
      for (const t of g.tallies.values()) {
        expect(t.hands).toBe(120);
        expect(t.pfr).toBeLessThanOrEqual(t.vpip);
        expect(t.vpip).toBeLessThanOrEqual(t.hands);
        expect(t.foldedToBet).toBeLessThanOrEqual(t.facedBet);
        expect(t.foldedToRaise).toBeLessThanOrEqual(t.facedRaise);
        expect(t.cbets).toBeLessThanOrEqual(t.cbetSpots);
        expect(t.bluffsShown).toBeLessThanOrEqual(t.riverBetsShown);
        expect(t.postAggr).toBeLessThanOrEqual(t.postActs);
        // Bets by size are a subset of bets faced: the unraised ones.
        expect(t.facedBySize.reduce((a, b) => a + b)).toBeLessThanOrEqual(t.facedBet);
        t.foldedBySize.forEach((k, i) => expect(k).toBeLessThanOrEqual(t.facedBySize[i]));
      }
      const sized = [...g.tallies.values()].reduce((s, t) => s + t.facedBySize.reduce((a, b) => a + b), 0);
      expect(sized).toBeGreaterThan(0);
    }
  });
});

describe('tournament', () => {
  it('knocks players out until one is left, with no chips made or lost', () => {
    for (const bots of [2, 5, 8]) {
      const rng = seeded(bots * 104729);
      const g = new Game(bots, 1000, rng, 'tournament');
      const total = (bots + 1) * 1000;
      const hero = STYLES.regular;
      // The hero plays as a bot so the table runs to the end; stop at one left, not at the hero's exit.
      g.hero.isHuman = false;
      let hands = 0;
      while (g.seated.length > 1) {
        if (++hands > 2000) throw new Error('tournament did not finish');
        g.startHand();
        expect(g.players.filter((p) => p.out).every((p) => p.hole.length === 0 && p.folded)).toBe(true);
        let guard = 0;
        while (g.phase !== 'handOver') {
          if (++guard > 500) throw new Error('hand did not finish');
          if (g.phase === 'runout') {
            g.runoutStep();
            continue;
          }
          const p = g.players[g.toAct];
          expect(p.out).toBe(false);
          g.act(p.id, decide(g.botView(p.id), p.personality ?? hero, rng));
        }
        expect(g.players.reduce((s, p) => s + p.stack, 0)).toBe(total);
        if (g.hero.out) break; // finished for the hero: no more hands are dealt
      }
      expect(g.finished).toBe(true);
      const places = g.players.map((p) => p.place).filter((p) => p !== null);
      expect(new Set(places).size).toBe(places.length);
      expect(g.hero.place).not.toBeNull();
      if (g.hero.out) {
        const before = g.handNumber;
        g.startHand();
        expect(g.handNumber).toBe(before);
      } else {
        expect(g.hero.place).toBe(1);
        expect(places.sort((a, b) => a! - b!)).toEqual(Array.from({ length: bots + 1 }, (_, i) => i + 1));
      }
      expect(g.bigBlind).toBe(BLIND_LEVELS[g.level][1]);
    }
  });

  it('runs a multi-table tournament to one player, the other tables simulated', () => {
    for (const entrants of [10, 23, 45]) {
      const rng = seeded(entrants * 31337);
      const g = new Game(0, 1000, rng, 'tournament', entrants);
      const hero = STYLES.regular;
      g.hero.isHuman = false;
      const names = [...g.seated.map((p) => p.name), ...g.field!.players.map((p) => p.name)];
      expect(new Set(names).size).toBe(entrants);
      expect(g.remaining).toBe(entrants);
      const chips = () => g.players.reduce((s, p) => s + p.stack, 0) + g.field!.players.reduce((s, p) => s + p.stack, 0);
      let hands = 0;
      let before = entrants;
      while (g.remaining > 1) {
        if (++hands > 3000) throw new Error('tournament did not finish');
        g.startHand();
        expect(g.seated.length).toBeGreaterThanOrEqual(2);
        expect(g.seated.length).toBeLessThanOrEqual(9);
        if (g.remaining <= 9) expect(g.field!.size).toBe(0);
        while (g.phase !== 'handOver') {
          if (g.phase === 'runout') {
            g.runoutStep();
            continue;
          }
          const p = g.players[g.toAct];
          g.act(p.id, decide(g.botView(p.id), p.personality ?? hero, rng));
        }
        expect(chips()).toBe(entrants * 1000);
        expect(g.remaining).toBeLessThanOrEqual(before);
        before = g.remaining;
        if (g.hero.out) break;
      }
      expect(g.finished).toBe(true);
      expect(g.hero.place).toBeGreaterThanOrEqual(1);
      expect(g.hero.place).toBeLessThanOrEqual(entrants);
      if (!g.hero.out) expect(g.hero.place).toBe(1);
    }
  });

  it('raises the blinds every level', () => {
    const g = new Game(3, 1000, seeded(1), 'tournament');
    for (let h = 0; h < HANDS_PER_LEVEL + 1; h++) {
      g.startHand();
      while (g.phase !== 'handOver') {
        if (g.phase === 'runout') g.runoutStep();
        else g.act(g.toAct, { type: 'fold' });
      }
    }
    expect([g.smallBlind, g.bigBlind]).toEqual(BLIND_LEVELS[1]);
  });

  it('draws different names', () => {
    const g = new Game(8, 1000, seeded(3));
    const names = g.players.map((p) => p.name);
    expect(new Set(names).size).toBe(9);
  });
});

describe('incomplete all-in raises', () => {
  it('caller facing a short all-in raise may only call or fold', () => {
    const g = new Game(2, 1000, () => 0.5);
    g.startHand(); // button 0, SB 1, BB 2; hero acts first
    g.players[2].stack = 25; // BB has 25 behind after the 10 blind (35 total)
    g.act(0, { type: 'raise', to: 30 }); // hero raises to 30 (a raise of 20)
    g.act(1, { type: 'fold' });
    g.act(2, { type: 'allin' }); // BB all-in to 35: only 5 more, less than the 20 minimum
    expect(g.toAct).toBe(0);
    expect(g.legal(0).toCall).toBe(5);
    expect(g.legal(0).canRaise).toBe(false);
  });
});
