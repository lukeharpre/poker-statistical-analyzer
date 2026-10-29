import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, Snapshot } from '../src/h2h/protocol';
import { H2H_LEVEL_MS } from '../src/h2h/protocol';
import { cleanName, firstPerson, Lobby, Match } from './h2h';

const conn = () => {
  const got: ServerMessage[] = [];
  return { got, send: (m: ServerMessage) => got.push(m), last: () => (got.filter((m) => m.t === 'state').at(-1) as { s: Snapshot }).s };
};

// A match with both players at the table.
const seated = (now?: () => number) => {
  const m = new Match(['Ann', 'Sam'], now);
  m.attach(0, conn());
  m.attach(1, conn());
  return m;
};

describe('head to head', () => {
  afterEach(() => vi.useRealTimers());

  it('lets a player show one card or both after the hand, and waits 2s after a show', () => {
    vi.useFakeTimers();
    const m = seated();
    const g = m.game;
    const folder = g.toAct;
    const other = 1 - folder;
    const hole = [...g.players[folder].hole];
    m.show(folder, [0]); // not during the hand
    expect(m.snapshot(other).players[1].shown).toEqual([false, false]);
    m.act(folder, { type: 'fold' });
    const hand = g.handNumber;
    vi.advanceTimersByTime(1500); // the 2s pause after a fold is nearly over
    m.show(folder, [1]);
    const seen = m.snapshot(other).players[1];
    expect(seen.hole[1]).toBe(hole[1]);
    expect(seen.shown).toEqual([false, true]);
    expect(m.snapshot(other).history.at(-1)!.lines.at(-1)).toMatch(/^Ann shows |^Sam shows /);
    expect(m.snapshot(folder).history.at(-1)!.lines.at(-1)).toMatch(/^You show /);
    vi.advanceTimersByTime(1900);
    expect(g.handNumber).toBe(hand); // still showing
    vi.advanceTimersByTime(200);
    expect(g.handNumber).toBe(hand + 1);
    expect(m.snapshot(other).players[1].shown).toEqual([false, false]);
  });

    it('tosses a coin for the first button and logs who won it', () => {
    for (const [r, seat] of [[0.2, 0], [0.7, 1]] as const) {
      const m = new Match(['Ann', 'Sam'], Date.now, () => r);
      expect(m.game.button).toBe(seat);
      expect(m.snapshot(seat).button).toBe(0);
      expect(m.snapshot(seat).history[0].lines[0]).toBe('You win the coin toss and the button');
    }
  });

    it('pairs the second arrival with the first and deals 500 each at 10/20', () => {
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.receive(a, JSON.stringify({ t: 'join', name: 'Ann' }));
    expect(a.got).toEqual([{ t: 'waiting' }]);
    lobby.receive(b, JSON.stringify({ t: 'join', name: 'Sam' }));
    const sa = a.last();
    const sb = b.last();
    expect(sa.players.map((p) => p.name)).toEqual(['You', 'Sam']);
    expect(sb.players.map((p) => p.name)).toEqual(['You', 'Ann']);
    expect(sa.players[0].stack + sa.players[0].committed).toBe(500);
    expect([sa.smallBlind, sa.bigBlind]).toEqual([10, 20]);
    expect(sa.nextBlinds).toEqual([15, 30]);
  });

  it("never sends a player the other's cards before they are shown", () => {
    const m = new Match(['Ann', 'Sam']);
    const real = m.game.players[1].hole;
    const s = m.snapshot(0);
    expect(s.players[1].hole).toHaveLength(2);
    expect(s.players[1].hole).not.toEqual(real);
    expect(JSON.stringify(s.view ?? {})).not.toContain(JSON.stringify(real));
    expect(m.snapshot(1).players[0].hole).toEqual(real);
  });

  it('plays a hand to the end and deals the next after a pause', () => {
    vi.useFakeTimers();
    const m = seated();
    const g = m.game;
    m.act(g.toAct, { type: 'fold' });
    expect(g.phase).toBe('handOver');
    const folder = g.players.findIndex((p) => p.folded);
    expect(m.snapshot(folder).history.at(-1)!.heroFolded).toBe('preflop');
    expect(m.snapshot(folder).history.at(-1)!.lines).toContain('You fold');
    expect(m.snapshot(1 - folder).history.at(-1)!.heroNet).toBeGreaterThan(0);
    vi.advanceTimersByTime(1999);
    expect(g.handNumber).toBe(1);
    vi.advanceTimersByTime(1);
    expect(g.handNumber).toBe(2);
  });

  it('holds the next hand while a player is away, and deals it when they are back', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.receive(a, JSON.stringify({ t: 'join', name: 'Ann' }));
    lobby.receive(b, JSON.stringify({ t: 'join', name: 'Sam' }));
    const m = [...lobby.matches][0];
    const token = (a.got.find((x) => x.t === 'state') as { token: string }).token;
    lobby.closed(a);
    m.act(m.game.toAct, { type: 'fold' });
    vi.advanceTimersByTime(10_000);
    expect(m.game.handNumber).toBe(1);
    lobby.receive(conn(), JSON.stringify({ t: 'join', name: 'Ann', token }));
    vi.advanceTimersByTime(2000);
    expect(m.game.handNumber).toBe(2);
  });

  it('keeps each Coach line to its own player', () => {
    const m = new Match(['Ann', 'Sam']);
    const seat = m.game.toAct;
    m.act(seat, { type: 'call' }, 'Coach: Good call');
    expect(m.snapshot(seat).history[0].lines).toContain('Coach: Good call');
    expect(m.snapshot(1 - seat).history[0].lines.join()).not.toContain('Coach');
  });

  it('raises the blinds on the clock, from the next hand', () => {
    vi.useFakeTimers();
    let t = 0;
    const m = seated(() => t);
    t = H2H_LEVEL_MS + 1;
    expect(m.snapshot(0).nextBlindsIn).toBe(0);
    m.act(m.game.toAct, { type: 'fold' });
    vi.advanceTimersByTime(2000);
    expect([m.game.smallBlind, m.game.bigBlind]).toEqual([15, 30]);
  });

  it('gives the match to the player who stays', () => {
    const m = new Match(['Ann', 'Sam']);
    m.leave(1);
    const s = m.snapshot(0);
    expect(s.finished).toBe(true);
    expect(s.players[0].place).toBe(1);
    expect(s.players[0].stack).toBe(1000);
    expect(s.pot).toBe(0);
  });

  it('seats a reconnect back by its token', () => {
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.receive(a, JSON.stringify({ t: 'join', name: 'Ann' }));
    lobby.receive(b, JSON.stringify({ t: 'join', name: 'Sam' }));
    const token = (a.got.find((m) => m.t === 'state') as { token: string }).token;
    lobby.closed(a);
    expect(b.last().opponentConnected).toBe(false);
    const a2 = conn();
    lobby.receive(a2, JSON.stringify({ t: 'join', name: 'Ann', token }));
    expect(a2.last().players[1].name).toBe('Sam');
    expect(b.last().opponentConnected).toBe(true);
    const gone = conn();
    lobby.receive(gone, JSON.stringify({ t: 'join', name: 'X', token: 'nope' }));
    expect(gone.got).toEqual([{ t: 'closed' }]);
  });

  it('writes your own lines in the first person', () => {
    expect(firstPerson('Ann raises to 60', 'Ann')).toBe('You raise to 60');
    expect(firstPerson('Sam wins 40 with a pair; Ann wins 20', 'Ann')).toBe('Sam wins 40 with a pair; You win 20');
    expect(firstPerson('Ann & Sam split 40', 'Sam')).toBe('Ann & You split 40');
    expect(firstPerson('Ann 2 calls 20', 'Ann')).toBe('Ann 2 calls 20');
    expect(firstPerson('Ann is out in 2nd', 'Ann')).toBe('You are out in 2nd');
    expect(cleanName('  you ')).toBe('Player');
    expect(new Match(['Sam', 'sam']).seats[1].name).toBe('sam 2');
  });
});

describe('head to head showdown', () => {
  it('names the winner in the third person, and yours in the first', () => {
    for (let n = 0; n < 30; n++) {
      const m = new Match(['Ann', 'Sam']);
      const g = m.game;
      while (g.phase === 'betting') m.act(g.toAct, { type: 'call' });
      if (g.phase !== 'handOver') continue; // no all-in, so this never runs out
      const result = g.currentRecord!.result!;
      if (result.includes('split')) continue;
      expect(result).toMatch(/^(Ann|Sam) wins /);
      const winner = g.players.findIndex((p) => result.startsWith(p.name));
      expect(m.snapshot(winner).history[0].result).toMatch(/^You win /);
      return;
    }
  });
});
