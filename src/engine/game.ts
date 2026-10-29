import { cardLabel, freshDeck, shuffle, type Card } from './cards';
import { describe, evaluate } from './evaluator';
import { randomPersonality, type BotView, type Decision, type OpponentView, type Personality } from './bot';
import { categoryOf } from './evaluator';
import { emptyTally, priorFor, readOf, sizeBucket, type Read, type Tally } from './reads';
import { Field, SEATS } from './field';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type Phase = 'idle' | 'betting' | 'runout' | 'handOver';
export type Action = Decision | { type: 'allin' };
// Ring: a busted player rebuys. Tournament: a busted player is out, and blinds rise.
export type Format = 'ring' | 'tournament';

export interface Player {
  id: number;
  name: string;
  isHuman: boolean;
  personality?: Personality;
  stack: number;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  bet: number; // this street
  committed: number; // this hand
  acted: boolean;
  voluntary: boolean;
  raisesPreflop: number;
  raisesPostflop: number;
  callsPostflop: number;
  barrels: number; // streets after the flop on which they bet or raised
  raisesOverBet: number; // raises over someone else's bet after the flop
  openBehind: number | null; // players still to act when this player opened the betting before the flop
  aggrStreet: boolean; // bet or raised on this street
  aggrRiver: boolean; // bet or raised on the river
  lastAction: string | null;
  actedAtRaise: number; // value of Game.fullRaises when this player last acted; -1 = not yet
  out: boolean; // tournament: busted, or an empty seat; sits out every hand
  place: number | null; // tournament: finishing place once out, or 1 for the winner; null for an empty seat
  shown?: boolean[]; // head to head: which hole cards this player chose to show after the hand
}

export interface PotResult {
  label: string;
  amount: number;
  winners: number[];
  hand: string | null;
}

// One hand as the log shows it: a summary row that expands to every action.
export interface HandRecord {
  number: number;
  heroHole: Card[];
  board: Card[];
  lines: string[];
  result: string | null; // null while the hand is in play
  heroStart: number;
  heroNet: number | null;
  heroFolded: Street | null;
}

export interface HandResult {
  pots: PotResult[];
  revealed: number[];
  winnings: Record<number, number>;
}

// "Ada calls" but "You call".
const BASE_FORM: Record<string, string> = {
  folds: 'fold', checks: 'check', calls: 'call', 'calls all-in': 'call all-in', bets: 'bet',
  'raises to': 'raise to', wins: 'win', shows: 'show', rebuys: 'rebuy',
};
const says = (p: Player, verb: string) => `${p.name} ${p.isHuman ? BASE_FORM[verb] : verb}`;

// Enough for a 45-player tournament, all different.
const BOT_NAMES = [
  'Ada', 'Blaise', 'Carl', 'Emmy', 'Kurt', 'Sofia', 'Alan', 'Hypatia', 'Pierre', 'Florence',
  'Ronald', 'Grace', 'Srinivasa', 'Maryam', 'Leonhard', 'Emil', 'Katherine', 'Bernhard',
  'Sophie', 'Andrey', 'Thomas', 'Karl', 'Evariste', 'Mary', 'Jacob', 'Daniel', 'Joseph',
  'Henri', 'David', 'Georg', 'Felix', 'Hermann', 'Olga', 'Julia', 'Ingrid', 'Dorothy',
  'Edward', 'Jerzy', 'William', 'Harald', 'Abraham', 'Norbert', 'John', 'Paul', 'Terence',
  'Andrew', 'Grigori', 'Cathleen', 'Augustin', 'Gottfried', 'Niels', 'Isaac', 'Rene', 'Pafnuty',
];
export const MAX_ENTRANTS = 45;

// Tournament blinds: up one level every HANDS_PER_LEVEL hands, the last level holding.
export const HANDS_PER_LEVEL = 10;
export const BLIND_LEVELS: [number, number][] = [
  [5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200], [150, 300],
  [200, 400], [300, 600], [500, 1000], [600, 1200], [800, 1600], [1000, 2000], [1500, 3000],
  [2000, 4000],
];

// What the table and action bar read: a Game, or a head-to-head match seen from one seat.
export type TableState = Pick<
  Game,
  | 'players' | 'board' | 'button' | 'toAct' | 'phase' | 'street' | 'pot' | 'currentBet' | 'smallBlind' | 'bigBlind'
  | 'handNumber' | 'result' | 'hero' | 'finished' | 'entrants' | 'legal'
>;

// Hands deal on their own after a pause to read the result, a longer one when cards were shown.
export const handPause = (result: HandResult | null) => (result?.revealed.length ? 4000 : 2000);

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
};

// The wait before each step of an all-in runout, by cards already on the board: each street
// comes slower than the last, the river slowest, and the result follows once it has been seen.
export const runoutPause = (cards: number) => (cards < 3 ? 1500 : cards === 3 ? 2200 : cards === 4 ? 3200 : 2200);

export class Game {
  players: Player[];
  smallBlind = 5;
  bigBlind = 10;
  startingStack: number;
  button = -1;
  deck: Card[] = [];
  board: Card[] = [];
  street: Street = 'preflop';
  phase: Phase = 'idle';
  currentBet = 0;
  minRaise = 0;
  // Full raises this betting round. A player who acted since the last one may only call or
  // fold when an all-in raise is too small to count as a full raise.
  fullRaises = 0;
  // After the flop, the size bucket of this street's opening bet; null before a bet or once raised.
  betBucket: number | null = null;
  toAct = -1;
  handNumber = 0;
  result: HandResult | null = null;
  history: HandRecord[] = []; // newest last
  // Every player's stats this session, by name; bots and Coach read them.
  tallies = new Map<string, Tally>();
  pfAggressor = -1; // seat that made the last raise before the flop
  format: Format;
  level = 0; // index into BLIND_LEVELS; stays 0 in a ring game
  entrants: number; // tournament: everyone who started, at every table
  field: Field | null = null; // tournament over more than one table: the tables not shown
  // Tournament structure: which level a hand is played at. Head to head swaps in a clock.
  blindLevels = BLIND_LEVELS;
  levelFor = (hand: number) => Math.floor((hand - 1) / HANDS_PER_LEVEL);
  onChange: () => void = () => {};
  private rng: () => number;

  // A tournament of more than one table (entrants over SEATS) seats the hero at
  // a full-size table and the rest in the field; botCount is then ignored.
  constructor(
    botCount: number,
    startingStack = 1000,
    rng: () => number = Math.random,
    format: Format = 'ring',
    entrants = botCount + 1,
  ) {
    this.startingStack = startingStack;
    this.rng = rng;
    this.format = format;
    const seat = (id: number, name: string, isHuman: boolean, personality?: Personality): Player => ({
      id, name, isHuman, personality, stack: startingStack, hole: [], folded: false, allIn: false,
      bet: 0, committed: 0, acted: false, voluntary: false, raisesPreflop: 0, raisesPostflop: 0,
      callsPostflop: 0, barrels: 0, raisesOverBet: 0, openBehind: null, aggrStreet: false, aggrRiver: false, lastAction: null,
      actedAtRaise: -1, out: false, place: null,
    });
    const names = shuffle([...BOT_NAMES], rng);
    const multiTable = format === 'tournament' && entrants > SEATS;
    if (multiTable) botCount = SEATS - 1;
    this.entrants = multiTable ? entrants : botCount + 1;
    this.players = [seat(0, 'You', true)];
    for (let i = 0; i < botCount; i++) {
      this.players.push(seat(i + 1, names[i], false, randomPersonality(rng)));
    }
    if (multiTable) {
      // Tables start as even as they divide; seats past the hero's share start empty.
      const atTable = Math.ceil(entrants / Math.ceil(entrants / SEATS));
      for (const p of this.players.slice(atTable)) Object.assign(p, { name: '', stack: 0, out: true });
      const rest = names.slice(botCount, botCount + entrants - atTable);
      this.field = new Field(rest.map((name) => ({ name, stack: startingStack })), rng);
    }
  }

  get pot(): number {
    return this.players.reduce((s, p) => s + p.committed, 0);
  }

  get hero(): Player {
    return this.players[0];
  }

  private live = () => this.players.filter((p) => !p.folded);
  private canAct = (p: Player) => !p.folded && !p.allIn;
  // The next seat still in the game; a ring game has nobody out, so this is just the next seat.
  private seatAfter = (i: number) => {
    let j = i;
    do j = (j + 1) % this.players.length;
    while (this.players[j].out);
    return j;
  };

  get seated(): Player[] {
    return this.players.filter((p) => !p.out);
  }

  // Players still in the tournament, at every table.
  get remaining(): number {
    return this.seated.length + (this.field?.size ?? 0);
  }

  // Tournament over for the hero: out, or the last one left. Never in a ring game.
  get finished(): boolean {
    return this.format === 'tournament' && (this.hero.out || this.remaining === 1);
  }

  get currentRecord(): HandRecord | undefined {
    return this.history[this.history.length - 1];
  }

  // Adds a line to the current hand's log (Coach's verdicts come in through here too).
  note(line: string) {
    this.currentRecord?.lines.push(line);
  }

  private emit(line?: string) {
    if (line) this.note(line);
    this.onChange();
  }

  startHand() {
    if (this.phase === 'betting' || this.phase === 'runout' || this.finished) return;
    this.handNumber++;
    const record: HandRecord = {
      number: this.handNumber, heroHole: [], board: [], lines: [], result: null,
      heroStart: 0, heroNet: null, heroFolded: null,
    };
    this.history.push(record);
    if (this.history.length > 200) this.history.shift();
    if (this.format === 'tournament') {
      const level = Math.min(this.levelFor(this.handNumber), this.blindLevels.length - 1);
      if (level !== this.level) {
        this.level = level;
        this.note(`Blinds up to ${this.blindLevels[level][0]}/${this.blindLevels[level][1]}`);
      }
      [this.smallBlind, this.bigBlind] = this.blindLevels[this.level];
      this.balance();
    }
    for (const p of this.players) {
      if (p.stack === 0 && this.format === 'ring') {
        p.stack = this.startingStack;
        this.note(`${says(p, 'rebuys')} for ${this.startingStack}`);
      }
      Object.assign(p, {
        hole: [], folded: p.out, allIn: false, bet: 0, committed: 0, acted: false,
        voluntary: false, raisesPreflop: 0, raisesPostflop: 0, callsPostflop: 0, barrels: 0,
        raisesOverBet: 0, openBehind: null,
        aggrStreet: false, aggrRiver: false, lastAction: null, actedAtRaise: -1,
      });
      if (!p.out) this.tally(p.name).hands++;
    }
    this.pfAggressor = -1;
    record.heroStart = this.hero.stack;
    this.result = null;
    this.board = [];
    this.street = 'preflop';
    this.phase = 'betting';
    this.deck = shuffle(freshDeck(), this.rng);
    this.button = this.seatAfter(this.button);

    const headsUp = this.seated.length === 2;
    const sb = headsUp ? this.button : this.seatAfter(this.button);
    const bb = this.seatAfter(sb);
    this.post(this.players[sb], this.smallBlind, 'SB');
    this.post(this.players[bb], this.bigBlind, 'BB');
    for (let r = 0; r < 2; r++) {
      let i = sb;
      do {
        this.players[i].hole.push(this.deck.pop()!);
        i = this.seatAfter(i);
      } while (i !== sb);
    }
    record.heroHole = [...this.hero.hole];
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.fullRaises = 0;
    this.betBucket = null;
    this.progress(bb);
  }

  private post(p: Player, amount: number, label: string) {
    const a = Math.min(amount, p.stack);
    this.put(p, a);
    p.lastAction = `${label} ${a}`;
  }

  private put(p: Player, amount: number) {
    p.stack -= amount;
    p.bet += amount;
    p.committed += amount;
    if (p.stack === 0) p.allIn = true;
  }

  legal(id: number) {
    const p = this.players[id];
    const toCall = Math.min(this.currentBet - p.bet, p.stack);
    const maxRaiseTo = p.bet + p.stack;
    return {
      toCall,
      canCheck: this.currentBet === p.bet,
      canRaise: maxRaiseTo > this.currentBet && p.actedAtRaise < this.fullRaises,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, maxRaiseTo),
      maxRaiseTo,
    };
  }

  tally(name: string): Tally {
    let t = this.tallies.get(name);
    if (!t) this.tallies.set(name, (t = emptyTally()));
    return t;
  }

  read(name: string): Read {
    return readOf(this.tally(name), priorFor(this.seated.length));
  }

  // Last to act after the flop among those who can still act: furthest from the button's left.
  // Before the flop, only against players who have put chips in by choice; the rest are
  // expected to fold.
  private inPosition(id: number) {
    const d = this.distanceFromButton(id);
    return this.players.every(
      (o) =>
        o.id === id || o.folded || o.allIn || (this.street === 'preflop' && !o.voluntary) ||
        this.distanceFromButton(o.id) < d,
    );
  }

  // A player as the others see them: their line this hand and their stats.
  seen(o: Player): OpponentView {
    return {
      name: o.name,
      voluntary: o.voluntary,
      acted: o.acted,
      allIn: o.allIn,
      raisesPreflop: o.raisesPreflop,
      openBehind: o.openBehind,
      raisesPostflop: o.raisesPostflop,
      barrels: o.barrels,
      raisesOverBet: o.raisesOverBet,
      callsPostflop: o.callsPostflop,
      aggrStreet: o.aggrStreet,
      bet: o.bet,
      committed: o.committed,
      stack: o.stack,
      read: this.read(o.name),
    };
  }

  botView(id: number): BotView {
    const p = this.players[id];
    const l = this.legal(id);
    return {
      hole: p.hole,
      board: this.board,
      pot: this.pot,
      toCall: l.toCall,
      currentBet: this.currentBet,
      myBet: p.bet,
      minRaiseTo: l.minRaiseTo,
      maxRaiseTo: l.maxRaiseTo,
      canRaise: l.canRaise,
      bigBlind: this.bigBlind,
      myCommitted: p.committed,
      committed: this.players.filter((o) => o.id !== id).map((o) => o.committed),
      opponents: this.players.filter((o) => o.id !== id && !o.folded).map((o) => this.seen(o)),
      me: this.seen(p),
      seats: this.seatsFromButton(),
      pfAggressor: this.pfAggressor === id,
      inPosition: this.inPosition(id),
    };
  }

  // Everyone dealt in, clockwise from the button, with their chips at the start of the hand.
  private seatsFromButton() {
    const out: { name: string; chips: number }[] = [];
    let i = this.button;
    do {
      const p = this.players[i];
      out.push({ name: p.name, chips: p.stack + p.committed });
      i = this.seatAfter(i);
    } while (i !== this.button);
    return out;
  }

  // `annotation` is logged right after the action, before any card it triggers.
  act(id: number, action: Action, annotation?: string): void {
    if (this.phase !== 'betting' || this.toAct !== id) return;
    const p = this.players[id];
    const l = this.legal(id);
    let line: string;

    if (action.type === 'allin') {
      action = l.maxRaiseTo > this.currentBet ? { type: 'raise', to: l.maxRaiseTo } : { type: 'call' };
    }
    const before = {
      voluntary: p.voluntary, raisesPreflop: p.raisesPreflop, aggrStreet: p.aggrStreet, opened: this.currentBet > 0,
      bucket: this.betBucket,
    };

    switch (action.type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        if (p.isHuman && this.currentRecord) this.currentRecord.heroFolded = this.street;
        line = says(p, 'folds');
        break;
      case 'check':
        if (!l.canCheck) return this.act(id, { type: 'call' }, annotation);
        p.lastAction = 'Check';
        line = says(p, 'checks');
        break;
      case 'call':
        if (l.toCall === 0) return this.act(id, { type: 'check' }, annotation);
        this.put(p, l.toCall);
        p.voluntary = true;
        if (this.street !== 'preflop') p.callsPostflop++;
        p.lastAction = p.allIn ? `All-in ${p.bet}` : `Call ${l.toCall}`;
        line = `${says(p, p.allIn ? 'calls all-in' : 'calls')} ${l.toCall}`;
        break;
      case 'raise': {
        if (!l.canRaise) return this.act(id, { type: 'call' }, annotation);
        const to = Math.min(Math.max(Math.round(action.to), l.minRaiseTo), l.maxRaiseTo);
        const increment = to - this.currentBet;
        const opening = this.currentBet === 0;
        if (increment >= this.minRaise) {
          this.minRaise = increment;
          this.fullRaises++;
        }
        if (this.street !== 'preflop') this.betBucket = opening ? sizeBucket(to / Math.max(1, this.pot)) : null;
        this.currentBet = to;
        this.put(p, to - p.bet);
        p.voluntary = true;
        if (this.street === 'preflop') {
          // An open: nobody has raised yet. Who is still to act sets how wide it can be.
          if (this.pfAggressor === -1) {
            p.openBehind = this.players.filter((o) => o !== p && !o.folded && !o.acted && !o.allIn).length;
          }
          p.raisesPreflop++;
          this.pfAggressor = p.id;
        } else {
          p.raisesPostflop++;
          if (!p.aggrStreet) p.barrels++;
          if (!opening) p.raisesOverBet++;
        }
        p.aggrStreet = true;
        if (this.street === 'river') p.aggrRiver = true;
        for (const o of this.players) if (o !== p) o.acted = false;
        const verb = opening ? 'bets' : 'raises to';
        p.lastAction = p.allIn ? `All-in ${to}` : `${opening ? 'Bet' : 'Raise'} ${to}`;
        line = `${says(p, verb)} ${to}${p.allIn ? ' (all-in)' : ''}`;
        break;
      }
    }
    this.count(p, action.type, l.toCall > 0, before);
    p.acted = true;
    p.actedAtRaise = this.fullRaises;
    this.note(line);
    if (annotation) this.note(annotation);
    this.progress(id);
  }

  // Adds one action to the player's stats. `before` is their state before acting.
  private count(
    p: Player,
    type: Decision['type'],
    facing: boolean,
    before: { voluntary: boolean; raisesPreflop: number; aggrStreet: boolean; opened: boolean; bucket: number | null },
  ) {
    const t = this.tally(p.name);
    const folded = type === 'fold';
    if (this.street === 'preflop') {
      if ((type === 'call' || type === 'raise') && !before.voluntary) t.vpip++;
      if (type === 'raise' && before.raisesPreflop === 0) t.pfr++;
      if (facing && before.raisesPreflop > 0) {
        t.facedRaise++;
        if (folded) t.foldedToRaise++;
      }
      return;
    }
    t.postActs++;
    if (type === 'raise') t.postAggr++;
    if (facing && before.aggrStreet) {
      t.facedRaise++;
      if (folded) t.foldedToRaise++;
    } else if (facing) {
      t.facedBet++;
      if (folded) t.foldedToBet++;
      if (before.bucket !== null) {
        t.facedBySize[before.bucket]++;
        if (folded) t.foldedBySize[before.bucket]++;
      }
    }
    if (this.street === 'flop' && p.id === this.pfAggressor && !before.opened && !before.aggrStreet) {
      t.cbetSpots++;
      if (type === 'raise') t.cbets++;
    }
  }

  private progress(from: number) {
    const live = this.live();
    if (live.length === 1) return this.awardUncontested(live[0]);

    const actors = live.filter(this.canAct);
    const roundDone =
      actors.length === 0 ||
      (actors.length === 1 && actors[0].bet >= this.currentBet) ||
      actors.every((p) => p.acted && p.bet === this.currentBet);

    if (!roundDone) {
      let i = this.seatAfter(from);
      while (true) {
        const p = this.players[i];
        if (this.canAct(p) && (!p.acted || p.bet < this.currentBet)) break;
        i = this.seatAfter(i);
      }
      this.toAct = i;
      return this.emit();
    }

    for (const p of this.players) p.bet = 0;
    this.currentBet = 0;
    this.toAct = -1;
    if (this.street === 'river') return this.showdown();
    if (actors.length <= 1) {
      this.phase = 'runout';
      return this.emit();
    }
    this.dealStreet();
    for (const p of this.players) {
      p.acted = false;
      p.aggrStreet = false;
      if (!p.folded && !p.allIn) p.lastAction = null;
    }
    this.minRaise = this.bigBlind;
    this.fullRaises = 0;
    this.betBucket = null;
    for (const p of this.players) p.actedAtRaise = -1;
    this.progress(this.button);
  }

  private dealStreet() {
    const next: Record<Street, Street> = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'river' };
    this.street = next[this.street];
    const n = this.street === 'flop' ? 3 : 1;
    const cards = Array.from({ length: n }, () => this.deck.pop()!);
    this.board = [...this.board, ...cards];
    const name = this.street[0].toUpperCase() + this.street.slice(1);
    this.note(`${name}: ${this.board.map(cardLabel).join(' ')}`);
  }

  // All-in with no further betting possible: deal one street per call.
  // One step of an all-in runout: the next street, or once the river is out, the showdown.
  runoutStep() {
    if (this.phase !== 'runout') return;
    if (this.board.length === 5) return this.showdown();
    this.dealStreet();
    this.emit();
  }

  private awardUncontested(winner: Player) {
    const amount = this.pot;
    winner.stack += amount;
    this.result = {
      pots: [{ label: 'Pot', amount, winners: [winner.id], hand: null }],
      revealed: [],
      winnings: { [winner.id]: amount },
    };
    this.endHand(`${says(winner, 'wins')} ${amount}`);
  }

  private showdown() {
    const live = this.live();
    const scores = new Map(live.map((p) => [p.id, evaluate([...p.hole, ...this.board])]));
    const levels = [...new Set(this.players.map((p) => p.committed).filter((c) => c > 0))].sort(
      (a, b) => a - b,
    );
    const pots: PotResult[] = [];
    const winnings: Record<number, number> = {};
    let prev = 0;
    for (const level of levels) {
      const amount = this.players.reduce(
        (s, p) => s + Math.min(p.committed, level) - Math.min(p.committed, prev),
        0,
      );
      const contributors = this.players.filter((p) => p.committed > prev);
      prev = level;
      if (contributors.length === 1) {
        contributors[0].stack += amount; // uncalled bet goes back
        continue;
      }
      let eligible = live.filter((p) => p.committed >= level);
      if (eligible.length === 0) eligible = live;
      const best = Math.max(...eligible.map((p) => scores.get(p.id)!));
      const winners = eligible.filter((p) => scores.get(p.id) === best);
      // Odd chips go to the first winner clockwise from the button.
      const ordered = [...winners].sort(
        (a, b) => this.distanceFromButton(a.id) - this.distanceFromButton(b.id),
      );
      const share = Math.floor(amount / winners.length);
      ordered.forEach((w, i) => {
        const won = share + (i === 0 ? amount - share * winners.length : 0);
        w.stack += won;
        winnings[w.id] = (winnings[w.id] ?? 0) + won;
      });
      const ids = winners.map((w) => w.id);
      const last = pots[pots.length - 1];
      if (last && last.winners.join() === ids.join()) last.amount += amount;
      else pots.push({ label: '', amount, winners: ids, hand: eligible.length > 1 ? describe(best) : null });
    }
    pots.forEach((p, i) => (p.label = i === 0 ? 'Main pot' : `Side pot ${i}`));
    if (pots.length === 1) pots[0].label = 'Pot';

    this.result = { pots, revealed: live.map((p) => p.id), winnings };
    for (const p of live) this.note(`${says(p, 'shows')} ${p.hole.map(cardLabel).join(' ')}`);
    // A river bet shown down with nothing better than the board's own hand was a bluff.
    const boardCat = categoryOf(evaluate(this.board));
    for (const p of live) {
      if (!p.aggrRiver) continue;
      const t = this.tally(p.name);
      t.riverBetsShown++;
      if (categoryOf(scores.get(p.id)!) <= boardCat) t.bluffsShown++;
    }
    const summary = pots
      .map((p) => {
        const names = p.winners.map((id) => this.players[id].name).join(' & ');
        return `${names} ${p.winners.length > 1 ? 'split' : this.players[p.winners[0]].isHuman ? 'win' : 'wins'} ${p.amount}${p.hand ? ` with ${p.hand}` : ''}`;
      })
      .join('; ');
    this.endHand(summary);
  }

  private distanceFromButton(id: number) {
    return (id - this.button - 1 + this.players.length) % this.players.length;
  }

  private endHand(line: string) {
    this.phase = 'handOver';
    this.toAct = -1;
    const record = this.currentRecord;
    if (record) {
      record.result = line;
      record.board = [...this.board];
      record.heroNet = this.hero.stack - record.heroStart;
    }
    this.note(line);
    if (this.format === 'tournament') this.knockOut();
    this.emit();
  }

  // Everyone who busted this hand is out, here and at the other tables, which
  // play their hand now. Out in the same hand: whoever started it with more
  // chips finishes higher.
  private knockOut() {
    const here = this.players.filter((p) => !p.out && p.stack === 0);
    const there = this.field?.playHand(this.bigBlind) ?? [];
    const busted = [
      ...here.map((p) => ({ player: p as Player | null, startStack: p.committed })),
      ...there.map((b) => ({ player: null, startStack: b.startStack })),
    ].sort((a, b) => b.startStack - a.startStack);
    let place = this.remaining - here.length + 1;
    for (const { player } of busted) {
      if (player) {
        player.out = true;
        player.place = place;
        this.note(`${player.name} ${player.isHuman ? 'are' : 'is'} out in ${ordinal(place)}`);
      }
      place++;
    }
    if (there.length) {
      this.note(`${there.length} out at the other tables · ${this.remaining} left`);
    }
    const left = this.seated;
    if (this.remaining === 1 && left.length === 1) {
      left[0].place = 1;
      this.note(`${left[0].name} ${left[0].isHuman ? 'win' : 'wins'} the tournament`);
    }
  }

  // Before a hand: players from the other tables take empty seats here, until
  // this table holds its share of those left — all of them once they fit at
  // one table, which is the final table.
  private balance() {
    if (!this.field?.size) return;
    const tables = Math.ceil(this.remaining / SEATS);
    const share = Math.ceil(this.remaining / tables);
    const free = this.players.length - this.seated.length;
    const moving = this.field.size <= free ? this.field.size : Math.max(0, share - this.seated.length);
    const empty = this.players.filter((p) => p.out);
    for (const e of this.field.take(moving)) {
      const seat = empty.shift()!;
      Object.assign(seat, {
        name: e.name, stack: e.stack, out: false, place: null, personality: randomPersonality(this.rng),
      });
      this.note(`${e.name} joins the table with ${e.stack.toLocaleString()}`);
    }
    if (!this.field.size && tables === 1) this.note('Final table');
  }
}
