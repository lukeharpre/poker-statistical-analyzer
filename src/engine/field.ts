// The rest of a multi-table tournament: everyone not at the hero's table.
//
// These tables are never shown, so they are not dealt. Each hand at the hero's
// table, every other table plays one simulated hand: two players contest a pot
// and a coin flip decides it. Most pots are a few big blinds; some are all-in,
// and a short stack (10 big blinds or less) is much more likely to be in one,
// so players go out there at a rate that rises with the blinds, as they do at
// a real table. Chips only move between players, never in or out.

export interface Entrant {
  name: string;
  stack: number;
}

export interface Bust {
  name: string;
  startStack: number; // ranks players out in the same hand: more chips, higher place
}

export const SEATS = 9;
const ALL_IN = 0.07; // chance a table's hand is an all-in, before short stacks
const SHORT_SHOVE = 0.3; // extra chance when someone at the table is short

export class Field {
  constructor(
    public players: Entrant[],
    private rng: () => number,
  ) {}

  get size() {
    return this.players.length;
  }

  // One hand at every table; the busted leave the field and come back as the result.
  playHand(bigBlind: number): Bust[] {
    const start = new Map(this.players.map((p) => [p, p.stack]));
    for (const table of this.tables()) this.simulate(table, bigBlind);
    const busted = this.players.filter((p) => p.stack === 0);
    this.players = this.players.filter((p) => p.stack > 0);
    return busted.map((p) => ({ name: p.name, startStack: start.get(p)! }));
  }

  // Players moving to the hero's table, chosen at random.
  take(n: number): Entrant[] {
    const taken: Entrant[] = [];
    for (let i = 0; i < n && this.players.length; i++) {
      taken.push(this.players.splice(Math.floor(this.rng() * this.players.length), 1)[0]);
    }
    return taken;
  }

  // The field split into tables of at most SEATS, as evenly as it goes.
  private tables(): Entrant[][] {
    const count = Math.ceil(this.players.length / SEATS);
    const tables: Entrant[][] = Array.from({ length: count }, () => []);
    this.players.forEach((p, i) => tables[i % count].push(p));
    return tables;
  }

  private simulate(table: Entrant[], bigBlind: number) {
    if (table.length < 2) return;
    const pick = (from: Entrant[]) => from[Math.floor(this.rng() * from.length)];
    const short = table.filter((p) => p.stack <= bigBlind * 10);
    const allIn = this.rng() < ALL_IN || (short.length > 0 && this.rng() < SHORT_SHOVE);
    const a = allIn && short.length ? pick(short) : pick(table);
    const b = pick(table.filter((p) => p !== a));
    const pot = allIn
      ? Math.min(a.stack, b.stack)
      : Math.min(a.stack, b.stack, Math.round(bigBlind * (1.5 + this.rng() * 4)));
    const [winner, loser] = this.rng() < 0.5 ? [a, b] : [b, a];
    winner.stack += pot;
    loser.stack -= pot;
  }
}
