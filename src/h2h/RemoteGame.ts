import type { BotView } from '../engine/bot';
import type { Action, TableState } from '../engine/game';
import { H2H_PATH, type ClientMessage, type ServerMessage, type Snapshot } from './protocol';

const TOKEN_KEY = 'pst.h2h';
const NAME_KEY = 'pst.name';
const RETRY_MS = 2000;

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // this tab only
    }
  },
};

export const savedName = () => store.get(NAME_KEY) ?? '';
// A seat in a match this browser hasn't left: reopening the page sits back down in it.
export const hasSeat = () => store.get(TOKEN_KEY) !== null;

export type Status = 'connecting' | 'waiting' | 'playing' | 'closed';

// A head-to-head match as one seat sees it. The server deals and rules; this sends moves
// and keeps the latest table.
export class RemoteGame implements TableState {
  status: Status = 'connecting';
  onChange: () => void = () => {}; // the table
  onStatus: () => void = () => {}; // connecting, waiting, playing or closed
  private s!: Snapshot;
  private received = 0;
  private ws: WebSocket | null = null;
  private stopped = false;

  // `resume`: sit back down in this browser's seat; otherwise join the queue afresh.
  constructor(private name: string, resume = false) {
    store.set(NAME_KEY, name);
    if (!resume) store.set(TOKEN_KEY, null);
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${H2H_PATH}`);
    this.ws = ws;
    ws.onopen = () => this.send({ t: 'join', name: this.name, token: store.get(TOKEN_KEY) ?? undefined });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data) as ServerMessage;
      const was = this.status;
      if (m.t === 'waiting') this.status = 'waiting';
      else if (m.t === 'closed') {
        store.set(TOKEN_KEY, null);
        this.status = 'closed';
        this.disconnect();
      } else {
        store.set(TOKEN_KEY, m.token);
        this.s = m.s;
        this.received = Date.now();
        this.status = 'playing';
      }
      if (this.status !== was) this.onStatus();
      else this.onChange();
    };
    // Dropped: try again. A seat comes back by its token; a wait starts over.
    ws.onclose = () => {
      if (!this.stopped) setTimeout(() => !this.stopped && this.connect(), RETRY_MS);
    };
  }

  private send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // Gone from this tab; the seat stays held for a reconnect.
  disconnect() {
    this.stopped = true;
    this.ws?.close();
  }

  // Leaving a match before the end concedes it.
  leave() {
    this.send({ t: 'leave' });
    store.set(TOKEN_KEY, null);
    this.disconnect();
  }

  get players() { return this.s.players; }
  get board() { return this.s.board; }
  get button() { return this.s.button; }
  get toAct() { return this.s.toAct; }
  get phase() { return this.s.phase; }
  get street() { return this.s.street; }
  get pot() { return this.s.pot; }
  get currentBet() { return this.s.currentBet; }
  get smallBlind() { return this.s.smallBlind; }
  get bigBlind() { return this.s.bigBlind; }
  get handNumber() { return this.s.handNumber; }
  get result() { return this.s.result; }
  get history() { return this.s.history; }
  get finished() { return this.s.finished; }
  get hero() { return this.s.players[0]; }
  get opponent() { return this.s.players[1]; }
  get opponentConnected() { return this.s.opponentConnected; }
  get nextBlinds() { return this.s.nextBlinds; }
  readonly entrants = 2;

  // Time to the next level as of now; 0 once it's due.
  get nextBlindsIn(): number {
    return Math.max(0, this.s.nextBlindsIn - (Date.now() - this.received));
  }

  legal(_id: number) {
    return this.s.legal;
  }

  botView(_id: number): BotView | null {
    return this.s.view;
  }

  act(_id: number, action: Action, annotation?: string) {
    this.send({ t: 'act', action, coach: annotation });
  }

  // After the hand: show hole card 0, 1 or both to the other player.
  show(cards: number[]) {
    this.send({ t: 'show', cards });
  }
}
