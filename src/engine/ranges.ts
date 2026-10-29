import { rankOf, suitOf, type Card } from './cards';
import { PREFLOP_EQUITY } from './preflopEquity';
import { PREFLOP_VS_RANGE } from './preflopVsRange';

// Two rankings of the 169 starting-hand classes:
// - against one random hand (scripts/preflop-equity.ts): the plain statistic, quoted to the
//   player ("wins 45% against a random hand").
// - against the top 30% of hands (scripts/preflop-vs-range.ts): what holds up against hands
//   that actually play. Ranges, opening charts and decisions use this one; against a random
//   hand, K-7 offsuit outranks 7-6 suited, against hands that call it doesn't.
const keyOf = (a: Card, b: Card) => {
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  return hi * 26 + lo * 2 + (hi !== lo && suitOf(a) === suitOf(b) ? 1 : 0);
};

const combosOf = (key: number) => {
  const hi = Math.floor(key / 26);
  const lo = Math.floor((key % 26) / 2);
  return hi === lo ? 6 : key % 2 ? 4 : 12;
};

// stronger[key] = share of the 1,326 starting hands ranked above.
function shares(table: Map<number, number>) {
  const stronger = new Map<number, number>();
  for (const [key, eq] of table) {
    let above = 0;
    for (const [other, e] of table) {
      if (e > eq) above += combosOf(other);
    }
    stronger.set(key, above / 1326);
  }
  return { stronger };
}

const random = shares(PREFLOP_EQUITY);
const vsRange = PREFLOP_VS_RANGE.size ? shares(PREFLOP_VS_RANGE) : random;

// Share of starting hands ranked above this one (0 = the best hand), by how it holds up
// against a continuing range. Ranges and decisions use this.
export const handPercentile = (a: Card, b: Card) => vsRange.stronger.get(keyOf(a, b))!;

// The same by equity against one random hand.
export const randomPercentile = (a: Card, b: Card) => random.stronger.get(keyOf(a, b))!;
