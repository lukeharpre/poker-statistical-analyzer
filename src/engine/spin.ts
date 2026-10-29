import { Game } from './game';
import { H2H_LEVELS } from '../h2h/protocol';

// Spin & Go: three players, a short stack, blinds up on a clock rather than by hands.
// Blinds start at 10/20 and follow the same hyper-turbo schedule as Head to Head.
export const SPIN_STACKS = [300, 500];
export const SPIN_LEVEL_MS = 2 * 60_000;

export class SpinAndGo extends Game {
  readonly started: number;

  constructor(stack: number, private now: () => number = Date.now, rng: () => number = Math.random) {
    super(2, stack, rng, 'tournament');
    this.blindLevels = H2H_LEVELS;
    this.started = now();
    this.levelFor = () => Math.floor((this.now() - this.started) / SPIN_LEVEL_MS);
    // A random first button; startHand moves it on one seat.
    this.button = Math.floor(rng() * this.players.length);
  }

  // Null at the last level.
  get nextBlinds(): [number, number] | null {
    return this.blindLevels[this.level + 1] ?? null;
  }

  // ms until the next level; 0 once it's due, from the next hand.
  get nextBlindsIn(): number {
    return Math.max(0, (this.level + 1) * SPIN_LEVEL_MS - (this.now() - this.started));
  }
}

// Finishes this session: 1st, 2nd and 3rd.
export type SpinRecord = [number, number, number];
