import { RANK_CHARS, RANK_PLURALS, type Card } from './cards';

export const CATEGORY_NAMES = [
  'High card',
  'Pair',
  'Two pair',
  'Three of a kind',
  'Straight',
  'Flush',
  'Full house',
  'Four of a kind',
  'Straight flush',
];

export const STRAIGHT = 4;

// Score = category * 16^5 + up to five tiebreak ranks in base 16. Higher wins.
const CAT_UNIT = 16 ** 5;

export const categoryOf = (score: number) => Math.floor(score / CAT_UNIT);

function pack(cat: number, ranks: number[]): number {
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + Math.max(ranks[i] ?? 0, 0);
  return s;
}

function popcount(m: number): number {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
}

// Highest rank of a 5-card run in a 13-bit rank mask, or -1. The wheel (A-5) returns 3.
function straightHigh(mask: number): number {
  const m = (mask << 1) | ((mask >> 12) & 1); // ace also sits below the deuce
  for (let h = 13; h >= 4; h--) {
    if (((m >> (h - 4)) & 31) === 31) return h - 1;
  }
  return -1;
}

function topRanks(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r--) if (mask & (1 << r)) out.push(r);
  return out;
}

const counts = new Int8Array(13);
const suitMasks = new Int32Array(4);

// Best poker hand from up to seven cards.
export function evaluate(cards: readonly Card[]): number {
  counts.fill(0);
  suitMasks.fill(0);
  let rankMask = 0;
  for (const c of cards) {
    const r = c >> 2;
    counts[r]++;
    suitMasks[c & 3] |= 1 << r;
    rankMask |= 1 << r;
  }

  // With seven cards or fewer a flush can't coexist with quads or a full house.
  for (let s = 0; s < 4; s++) {
    const m = suitMasks[s];
    if (popcount(m) >= 5) {
      const sf = straightHigh(m);
      return sf >= 0 ? pack(8, [sf]) : pack(5, topRanks(m, 5));
    }
  }

  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  const singles: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const n = counts[r];
    if (n === 4) quad = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
    else if (n === 1) singles.push(r);
  }

  if (quad >= 0) {
    return pack(7, [quad, Math.max(trips[0] ?? -1, pairs[0] ?? -1, singles[0] ?? -1)]);
  }
  if (trips.length >= 2 || (trips.length && pairs.length)) {
    return pack(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  }
  const st = straightHigh(rankMask);
  if (st >= 0) return pack(4, [st]);
  if (trips.length) return pack(3, [trips[0], ...singles.slice(0, 2)]);
  if (pairs.length >= 2) {
    return pack(2, [pairs[0], pairs[1], Math.max(pairs[2] ?? -1, singles[0] ?? -1)]);
  }
  if (pairs.length) return pack(1, [pairs[0], ...singles.slice(0, 3)]);
  return pack(0, singles.slice(0, 5));
}

const rankName = (r: number) => {
  const c = RANK_CHARS[r];
  return c === 'T' ? '10' : c;
};

export function describe(score: number): string {
  const cat = categoryOf(score);
  const k = (i: number) => Math.floor(score / 16 ** (4 - i)) % 16;
  switch (cat) {
    case 0: return `${rankName(k(0))} high`;
    case 1: return `Pair of ${RANK_PLURALS[k(0)]}`;
    case 2: return `Two pair, ${RANK_PLURALS[k(0)]} and ${RANK_PLURALS[k(1)]}`;
    case 3: return `Three ${RANK_PLURALS[k(0)]}`;
    case 4: return `Straight, ${rankName(k(0))} high`;
    case 5: return `Flush, ${rankName(k(0))} high`;
    case 6: return `Full house, ${RANK_PLURALS[k(0)]} full of ${RANK_PLURALS[k(1)]}`;
    case 7: return `Four ${RANK_PLURALS[k(0)]}`;
    default: return k(0) === 12 ? 'Royal flush' : `Straight flush, ${rankName(k(0))} high`;
  }
}
