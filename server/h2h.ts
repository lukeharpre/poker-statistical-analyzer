// Head to head: two players on their own devices at one table. The match runs here, on the
// dev server, so neither browser ever holds the other player's cards; each gets the table as
// its own seat sees it.
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { Plugin } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { cardLabel, type Card } from '../src/engine/cards';
import { Game, handPause, runoutPause, type Action, type Street } from '../src/engine/game';
import {
  H2H_LEVELS, H2H_LEVEL_MS, H2H_PATH, H2H_STACK, NAME_MAX,
  type ClientMessage, type ServerMessage, type Snapshot,
} from '../src/h2h/protocol';

const ABANDONED_MS = 30 * 60_000; // both players gone this long: the match is dropped
const SHOW_PAUSE = 2000; // the next hand waits at least this long after a player shows a card
// A line only one seat sees (their Coach's verdict): PRIVATE, the seat, then the line.
const PRIVATE = '\u0000';

export interface Conn {
  send(m: ServerMessage): void;
}

interface Seat {
  name: string;
  token: string;
  conn: Conn | null;
  left: boolean;
}

// What each seat had in a hand, for that seat's own log.
interface SeatHand {
  holes: Card[][];
  starts: number[];
  nets: (number | null)[];
  folds: (Street | null)[];
}

// The log is written in the third person; each player reads their own lines as "You call".
const VERBS: [string, string][] = [
  ['calls all-in', 'call all-in'], ['folds', 'fold'], ['checks', 'check'], ['calls', 'call'],
  ['bets', 'bet'], ['raises to', 'raise to'], ['wins', 'win'], ['shows', 'show'],
  ['is out', 'are out'], ['left', 'left'],
];
export function firstPerson(line: string, name: string): string {
  return line
    .split('; ')
    .map((part) => {
      if (part.startsWith(`${name} & `)) return `You${part.slice(name.length)}`;
      if (part.includes(` & ${name} split `)) return part.replace(` & ${name} split `, ' & You split ');
      if (!part.startsWith(`${name} `)) return part;
      const rest = part.slice(name.length + 1);
      const verb = VERBS.find(([v]) => rest.startsWith(v));
      return verb ? `You ${verb[1]}${rest.slice(verb[0].length)}` : part;
    })
    .join('; ');
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? '')
    .replace(/[;&\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
  return !name || /^you$/i.test(name) ? 'Player' : name;
}

const token = () => randomBytes(18).toString('base64url');

export class Match {
  game: Game;
  seats: Seat[];
  started: number;
  idleSince: number | null = null; // both players disconnected since
  private hands = new Map<number, SeatHand>();
  private runout: ReturnType<typeof setTimeout> | null = null;
  private next: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0; // when the next hand deals, while one is scheduled
  private shown: boolean[][] = [[false, false], [false, false]]; // hole cards shown after the hand
  private dealing = false;
  private conceded = false;

  constructor(
    names: [string, string],
    private now: () => number = Date.now,
    rng: () => number = Math.random,
  ) {
    if (names[0].toLowerCase() === names[1].toLowerCase()) names[1] = `${names[1].slice(0, NAME_MAX - 2)} 2`;
    this.seats = names.map((name) => ({ name, token: token(), conn: null, left: false }));
    const g = new Game(1, H2H_STACK, rng, 'tournament', 2);
    // Neither seat is the app's "You": the log names both players.
    g.players.forEach((p, i) => Object.assign(p, { name: names[i], isHuman: false, personality: undefined }));
    g.blindLevels = H2H_LEVELS;
    this.started = now();
    g.levelFor = () => Math.floor((this.now() - this.started) / H2H_LEVEL_MS);
    g.onChange = () => this.changed();
    this.game = g;
    // A coin toss for the first button, which acts first preflop. The next hand moves it on.
    const first = rng() < 0.5 ? 0 : 1;
    g.button = 1 - first;
    this.deal();
    g.currentRecord?.lines.unshift(`${names[first]} wins the coin toss and the button`);
  }

  attach(seat: number, conn: Conn) {
    this.seats[seat].conn = conn;
    this.idleSince = null;
    this.scheduleDeal();
    this.broadcast();
  }

  detach(seat: number, conn: Conn) {
    if (this.seats[seat].conn !== conn) return; // already replaced by a reconnect
    this.seats[seat].conn = null;
    if (this.seats.every((s) => !s.conn)) this.idleSince = this.now();
    this.broadcast();
  }

  // Over and nobody to tell, or abandoned: the lobby drops it.
  get done(): boolean {
    const gone = this.seats.every((s) => s.left || !s.conn);
    return (
      this.seats.every((s) => s.left) ||
      (gone && this.game.finished) ||
      (this.idleSince !== null && this.now() - this.idleSince > ABANDONED_MS)
    );
  }

  act(seat: number, action: Action, coach?: string) {
    const g = this.game;
    if (this.conceded || g.phase !== 'betting' || g.toAct !== seat) return;
    // Heads up a fold ends the hand, and the log goes out with it: note the street first.
    if (action.type === 'fold') {
      const h = this.hands.get(g.handNumber);
      if (h) h.folds[seat] = g.street;
    }
    g.act(seat, action, coach ? `${PRIVATE}${seat}${coach}` : undefined);
  }

  // The next hand deals after a pause, with both players at the table.
  private scheduleDeal(ms = handPause(this.game.result)) {
    const g = this.game;
    if (this.next || this.conceded || g.phase !== 'handOver' || g.finished) return;
    if (!this.seats.every((s) => s.conn)) return; // a reconnect picks it up
    this.nextAt = this.now() + ms;
    this.next = setTimeout(() => {
      this.next = null;
      if (this.seats.every((s) => s.conn)) this.deal();
    }, ms);
  }

  // After the hand, a player may show one hole card or both. The next hand waits at least
  // SHOW_PAUSE from then, so the other player sees them.
  show(seat: number, cards: number[]) {
    const g = this.game;
    const hole = g.players[seat].hole;
    if (this.conceded || g.phase !== 'handOver' || g.finished || hole.length !== 2) return;
    if (g.result?.revealed.includes(seat)) return; // already face up
    const fresh = cards.filter((i) => !this.shown[seat][i]);
    if (!fresh.length) return;
    for (const i of fresh) this.shown[seat][i] = true;
    g.note(`${g.players[seat].name} shows ${fresh.map((i) => cardLabel(hole[i])).join(' ')}`);
    if (this.next && this.nextAt - this.now() < SHOW_PAUSE) {
      clearTimeout(this.next);
      this.next = null;
      this.scheduleDeal(SHOW_PAUSE);
    }
    this.broadcast();
  }

  // Leaving before the end concedes the match.
  leave(seat: number) {
    const g = this.game;
    this.seats[seat].left = true;
    this.seats[seat].conn = null;
    if (g.finished) return;
    this.conceded = true;
    if (this.runout) clearTimeout(this.runout);
    if (this.next) clearTimeout(this.next);
    const quitter = g.players[seat];
    const winner = g.players[1 - seat];
    // Every chip, the pot included, goes to the player who stays.
    winner.stack += g.pot + quitter.stack;
    for (const p of g.players) Object.assign(p, { bet: 0, committed: 0 });
    Object.assign(quitter, { stack: 0, out: true, place: 2, folded: true });
    winner.place = 1;
    g.phase = 'handOver';
    g.toAct = -1;
    const record = g.currentRecord;
    const h = this.hands.get(g.handNumber);
    if (h && h.nets[0] === null) h.nets = g.players.map((p, i) => p.stack - h.starts[i]);
    if (record && record.result === null) record.result = `${quitter.name} left`;
    g.note(`${quitter.name} left`);
    g.note(`${winner.name} wins the tournament`);
    this.broadcast();
  }

  private deal() {
    const g = this.game;
    const starts = g.players.map((p) => p.stack);
    this.dealing = true;
    g.startHand();
    this.dealing = false;
    this.shown = [[false, false], [false, false]];
    this.hands.set(g.handNumber, {
      holes: g.players.map((p) => [...p.hole]),
      starts,
      nets: [null, null],
      folds: [null, null],
    });
    for (const n of this.hands.keys()) if (!g.history.some((r) => r.number === n)) this.hands.delete(n);
    this.broadcast();
  }

  private changed() {
    if (this.dealing) return;
    const g = this.game;
    const h = this.hands.get(g.handNumber);
    if (g.phase === 'handOver' && h && h.nets[0] === null) h.nets = g.players.map((p, i) => p.stack - h.starts[i]);
    this.scheduleDeal();
    if (g.phase === 'runout' && !this.runout) {
      this.runout = setTimeout(() => {
        this.runout = null;
        g.runoutStep();
      }, runoutPause(g.board.length));
    }
    this.broadcast();
  }

  private broadcast() {
    this.seats.forEach((s, i) => s.conn?.send({ t: 'state', token: s.token, s: this.snapshot(i) }));
  }

  // The table from one seat: that seat is players[0]; the other's cards stay hidden until shown.
  snapshot(seat: number): Snapshot {
    const g = this.game;
    const opp = 1 - seat;
    const id = (i: number) => (i < 0 ? i : i ^ seat);
    const name = this.seats[seat].name;
    const me = g.players[seat];
    const them = g.players[opp];
    const shown = !!g.result?.revealed.includes(opp) || (g.phase === 'runout' && !them.folded);
    const theirShown = this.shown[opp];
    const lineFor = (l: string) => (l.startsWith(PRIVATE) ? l.slice(2) : firstPerson(l, name));
    const elapsed = this.now() - this.started;
    const last = g.level >= g.blindLevels.length - 1;
    return {
      players: [
        { ...me, id: 0, name: 'You', isHuman: true, hole: [...me.hole], shown: [...this.shown[seat]] },
        // Face-down placeholders for cards not shown, so the seat still shows two backs.
        {
          ...them, id: 1, isHuman: false,
          hole: shown ? [...them.hole] : them.hole.map((c, i) => (theirShown[i] ? c : i)),
          shown: shown ? [true, true] : [...theirShown],
        },
      ],
      board: [...g.board],
      button: id(g.button),
      toAct: id(g.toAct),
      phase: g.phase,
      street: g.street,
      pot: g.pot,
      currentBet: g.currentBet,
      smallBlind: g.smallBlind,
      bigBlind: g.bigBlind,
      handNumber: g.handNumber,
      result: g.result && {
        pots: g.result.pots.map((p) => ({ ...p, winners: p.winners.map(id) })),
        revealed: g.result.revealed.map(id),
        winnings: Object.fromEntries(Object.entries(g.result.winnings).map(([k, v]) => [id(Number(k)), v])),
      },
      history: g.history.map((r) => {
        const h = this.hands.get(r.number);
        return {
          ...r,
          lines: r.lines.filter((l) => !l.startsWith(PRIVATE) || l[1] === String(seat)).map(lineFor),
          result: r.result === null ? null : firstPerson(r.result, name),
          heroHole: h?.holes[seat] ?? [],
          heroStart: h?.starts[seat] ?? 0,
          heroNet: h?.nets[seat] ?? null,
          heroFolded: h?.folds[seat] ?? null,
        };
      }),
      legal: g.legal(seat),
      finished: g.finished,
      view: g.phase === 'betting' && g.toAct === seat ? g.botView(seat) : null,
      opponentConnected: !!this.seats[opp].conn,
      nextBlinds: last ? null : g.blindLevels[g.level + 1],
      nextBlindsIn: last ? 0 : Math.max(0, (g.level + 1) * H2H_LEVEL_MS - elapsed),
    };
  }
}

function parseMessage(raw: string): ClientMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const msg = m as Record<string, unknown>;
  switch (msg.t) {
    case 'join':
      return { t: 'join', name: cleanName(msg.name), token: typeof msg.token === 'string' ? msg.token : undefined };
    case 'leave':
      return { t: msg.t };
    case 'show': {
      if (!Array.isArray(msg.cards)) return null;
      const cards = [0, 1].filter((i) => (msg.cards as unknown[]).includes(i));
      return cards.length ? { t: 'show', cards } : null;
    }
    case 'act': {
      const a = msg.action as Record<string, unknown> | undefined;
      const type = a?.type;
      let action: Action;
      if (type === 'fold' || type === 'check' || type === 'call' || type === 'allin') action = { type };
      else if (type === 'raise' && typeof a?.to === 'number' && Number.isFinite(a.to)) action = { type, to: a.to };
      else return null;
      const coach = typeof msg.coach === 'string' && msg.coach.startsWith('Coach: ') ? msg.coach.slice(0, 300) : undefined;
      return { t: 'act', action, coach };
    }
  }
  return null;
}

// Pairs players as they arrive: the first waits, the second starts a match with them.
export class Lobby {
  matches = new Set<Match>();
  private waiting: { conn: Conn; name: string } | null = null;
  private seated = new Map<Conn, { match: Match; seat: number }>();

  constructor(private now: () => number = Date.now) {}

  receive(conn: Conn, raw: string) {
    const msg = parseMessage(raw);
    if (!msg) return;
    if (msg.t === 'join') return this.join(conn, msg.name, msg.token);
    const at = this.seated.get(conn);
    if (!at) return;
    if (msg.t === 'act') at.match.act(at.seat, msg.action, msg.coach);
    else if (msg.t === 'show') at.match.show(at.seat, msg.cards);
    else {
      at.match.leave(at.seat);
      this.seated.delete(conn);
      this.tidy();
    }
  }

  closed(conn: Conn) {
    if (this.waiting?.conn === conn) this.waiting = null;
    const at = this.seated.get(conn);
    if (!at) return;
    this.seated.delete(conn);
    at.match.detach(at.seat, conn);
    this.tidy();
  }

  tidy() {
    for (const m of this.matches) if (m.done) this.matches.delete(m);
  }

  private join(conn: Conn, name: string, token?: string) {
    if (this.seated.has(conn)) return;
    if (token) {
      for (const match of this.matches) {
        const seat = match.seats.findIndex((s) => s.token === token && !s.left);
        if (seat < 0) continue;
        this.seated.set(conn, { match, seat });
        return match.attach(seat, conn);
      }
      return conn.send({ t: 'closed' });
    }
    const other = this.waiting;
    if (!other || other.conn === conn) {
      this.waiting = { conn, name };
      return conn.send({ t: 'waiting' });
    }
    this.waiting = null;
    const match = new Match([other.name, name], this.now);
    this.matches.add(match);
    this.seated.set(other.conn, { match, seat: 0 });
    this.seated.set(conn, { match, seat: 1 });
    match.seats[0].conn = other.conn;
    match.attach(1, conn);
  }
}

function serve(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const lobby = new Lobby();
  httpServer.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== H2H_PATH) return; // Vite's HMR, etc.
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const conn: Conn = { send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)) };
      ws.on('message', (data) => lobby.receive(conn, data.toString()));
      ws.on('close', () => lobby.closed(conn));
    });
  });
  const sweep = setInterval(() => lobby.tidy(), 60_000);
  sweep.unref();
  httpServer.on('close', () => {
    clearInterval(sweep);
    wss.close();
  });
}

export function headToHead(): Plugin {
  return {
    name: 'head-to-head',
    configureServer(server) {
      if (server.httpServer) serve(server.httpServer as HttpServer);
    },
    configurePreviewServer(server) {
      serve(server.httpServer as HttpServer);
    },
  };
}
