import type { BotView } from '../engine/bot';
import type { Action, HandRecord, HandResult, Phase, Player, Street } from '../engine/game';

// Head to head, after PokerStars' heads-up hyper-turbo sit & go: 500 chips each, blinds from
// 10/20, up every 2 minutes, no antes. The schedule is the one HUSNG.com lists for it.
export const H2H_STACK = 500;
export const H2H_LEVEL_MS = 2 * 60_000;
export const H2H_LEVELS: [number, number][] = [
  [10, 20], [15, 30], [20, 40], [25, 50], [30, 60], [40, 80], [50, 100], [60, 120], [75, 150],
  [90, 180], [105, 210], [125, 250], [150, 300], [180, 360], [210, 420], [250, 500],
];
export const H2H_PATH = '/h2h';
export const NAME_MAX = 16;

export type ClientMessage =
  | { t: 'join'; name: string; token?: string }
  | { t: 'act'; action: Action; coach?: string }
  | { t: 'show'; cards: number[] } // after the hand: hole card 0, 1 or both
  | { t: 'leave' };

export type ServerMessage =
  | { t: 'waiting' }
  | { t: 'state'; token: string; s: Snapshot }
  | { t: 'closed' }; // the seat's match is gone

// The match from one seat: that player is always players[0], named 'You'.
export interface Snapshot {
  players: Player[];
  board: number[];
  button: number;
  toAct: number;
  phase: Phase;
  street: Street;
  pot: number;
  currentBet: number;
  smallBlind: number;
  bigBlind: number;
  handNumber: number;
  result: HandResult | null;
  history: HandRecord[];
  legal: { toCall: number; canCheck: boolean; canRaise: boolean; minRaiseTo: number; maxRaiseTo: number };
  finished: boolean;
  view: BotView | null; // on your turn, the spot as Coach prices it
  opponentConnected: boolean;
  nextBlinds: [number, number] | null; // null at the last level
  nextBlindsIn: number; // ms; 0 once due, from the next hand
}
