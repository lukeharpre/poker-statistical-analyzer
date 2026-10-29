// A card is an integer 0..51: rank = card >> 2 (0 = deuce .. 12 = ace), suit = card & 3.
export type Card = number;

export const RANK_CHARS = '23456789TJQKA';
export const SUIT_CHARS = 'shdc';
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];

export const RANK_PLURALS = [
  'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights',
  'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces',
];

export const rankOf = (c: Card) => c >> 2;
export const suitOf = (c: Card) => c & 3;
export const makeCard = (rank: number, suit: number): Card => rank * 4 + suit;

export function cardLabel(c: Card): string {
  const r = RANK_CHARS[rankOf(c)];
  return (r === 'T' ? '10' : r) + SUIT_SYMBOLS[suitOf(c)];
}

export function parseCard(s: string): Card {
  const rank = RANK_CHARS.indexOf(s[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(s[1]?.toLowerCase());
  if (rank < 0 || suit < 0 || s.length !== 2) throw new Error(`Bad card: ${s}`);
  return makeCard(rank, suit);
}

export const parseCards = (s: string): Card[] =>
  s.trim() === '' ? [] : s.trim().split(/\s+/).map(parseCard);

export const freshDeck = (): Card[] => Array.from({ length: 52 }, (_, i) => i);

export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function remainingDeck(known: readonly Card[]): Card[] {
  const seen = new Set(known);
  return freshDeck().filter((c) => !seen.has(c));
}

export const sortByRankDesc = (cards: readonly Card[]): Card[] =>
  [...cards].sort((a, b) => b - a);
