import { RANK_CHARS, SUIT_SYMBOLS, rankOf, remainingDeck, suitOf, type Card } from './cards';
import { categoryOf, evaluate } from './evaluator';

// A target is an event on the hero's own cards ("pair your King"), never a hand the board
// makes on its own. `hits` is checked against the full community board; every target is
// monotonic (more cards can't un-hit it), which the odds breakdown relies on.
export interface Target {
  kind: string; // stable id, used to group stats
  group: 'cards' | 'draws';
  label: string;
  question: string;
  hits: (board: Card[]) => boolean;
}

export interface OfferedTarget extends Target {
  singleCard: boolean; // one card can hit it; otherwise it needs both turn and river
  makes: string; // what hitting gives you, from the actual runouts, e.g. "two pair or better"
}

export const KIND_NAMES: Record<string, string> = {
  'pair-one': 'Pair one hole card',
  'pair-either': 'Pair either hole card',
  'pair-both': 'Pair both hole cards',
  'improve-pair': 'Two pair or trips',
  trips: 'Trips',
  set: 'Set',
  'full-house': 'Full house+',
  quads: 'Quads',
  flush: 'Flush',
  'backdoor-flush': 'Backdoor flush',
  straight: 'Straight',
  'backdoor-straight': 'Backdoor straight',
  'straight-or-flush': 'Straight or flush',
};

const MADE = ['high card', 'a pair', 'two pair', 'trips', 'a straight', 'a flush', 'a full house', 'quads', 'a straight flush'];
const SINGULAR = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const PLURAL = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const short = (r: number) => (RANK_CHARS[r] === 'T' ? '10' : RANK_CHARS[r]);

const countRank = (cards: Card[], r: number) => cards.reduce((n, c) => n + (rankOf(c) === r ? 1 : 0), 0);
const countSuit = (cards: Card[], s: number) => cards.reduce((n, c) => n + (suitOf(c) === s ? 1 : 0), 0);
const rankMask = (cards: Card[]) => cards.reduce((m, c) => m | (1 << rankOf(c)), 0);

// Five-rank windows, wheel (A-2-3-4-5) included.
const WINDOWS = [0b1000000001111, ...Array.from({ length: 9 }, (_, i) => 0b11111 << i)];

// A straight that includes at least one of the hero's ranks.
function straightWith(holeMask: number, mask: number) {
  return WINDOWS.some((w) => (mask & w) === w && (holeMask & w) !== 0);
}

function flushTarget(hole: Card[], suit: number, backdoor: boolean): Target {
  const inHand = countSuit(hole, suit);
  return {
    kind: backdoor ? 'backdoor-flush' : 'flush',
    group: 'draws',
    label: `${backdoor ? 'Backdoor flush' : 'Flush'} ${SUIT_SYMBOLS[suit]}`,
    question: `make a ${SUIT_SYMBOLS[suit]} flush`,
    hits: (board) => inHand > 0 && inHand + countSuit(board, suit) >= 5,
  };
}

export function targetsFor(hole: Card[], board: Card[]): OfferedTarget[] {
  const [ra, rb] = hole.map(rankOf);
  const targets: Target[] = [];
  const add = (t: Target) => targets.push(t);

  if (ra === rb) {
    const k = countRank(board, ra);
    if (k === 0) {
      add({
        kind: 'set', group: 'cards', label: `Set (another ${short(ra)})`,
        question: `hit a set of ${PLURAL[ra]}`, hits: (b) => countRank(b, ra) >= 1,
      });
    } else if (k === 1) {
      add({
        kind: 'quads', group: 'cards', label: `Quads (last ${short(ra)})`,
        question: `hit the last ${SINGULAR[ra]}`, hits: (b) => countRank(b, ra) >= 2,
      });
    }
  } else {
    const ranks = [Math.max(ra, rb), Math.min(ra, rb)];
    const [hi, lo] = ranks;
    const k = (r: number) => countRank(board, r);
    for (const r of ranks) {
      if (k(r) === 0) {
        add({
          kind: 'pair-one', group: 'cards', label: `Pair your ${short(r)}`,
          question: `pair your ${SINGULAR[r]}`, hits: (b) => countRank(b, r) >= 1,
        });
      }
    }
    if (k(hi) === 0 && k(lo) === 0) {
      add({
        kind: 'pair-either', group: 'cards', label: `Pair ${short(hi)} or ${short(lo)}`,
        question: `pair your ${SINGULAR[hi]} or your ${SINGULAR[lo]}`,
        hits: (b) => countRank(b, hi) >= 1 || countRank(b, lo) >= 1,
      });
      add({
        kind: 'pair-both', group: 'cards', label: `Pair both ${short(hi)} and ${short(lo)}`,
        question: `pair both your ${SINGULAR[hi]} and your ${SINGULAR[lo]}`,
        hits: (b) => countRank(b, hi) >= 1 && countRank(b, lo) >= 1,
      });
    }
    for (const r of ranks) {
      const other = r === hi ? lo : hi;
      if (k(r) === 2) {
        add({
          kind: 'quads', group: 'cards', label: `Quads (last ${short(r)})`,
          question: `hit the last ${SINGULAR[r]}`, hits: (b) => countRank(b, r) >= 3,
        });
      }
      if (k(r) === 1) {
        add({
          kind: 'trips', group: 'cards', label: `Another ${short(r)}`,
          question: `hit another ${SINGULAR[r]} for trips`, hits: (b) => countRank(b, r) >= 2,
        });
        if (k(other) === 0) {
          add({
            kind: 'improve-pair', group: 'cards', label: `Pair your ${short(other)} or another ${short(r)}`,
            question: `pair your ${SINGULAR[other]} or hit another ${SINGULAR[r]}`,
            hits: (b) => countRank(b, other) >= 1 || countRank(b, r) >= 2,
          });
        }
      }
    }
  }

  // Full house from two pair or trips the hero's cards already make.
  const holeRanksOnBoard = (r: number) => countRank(board, r) + countRank(hole, r);
  const madeWithHole = hole.some((c) => holeRanksOnBoard(rankOf(c)) >= 2);
  const cat = categoryOf(evaluate([...hole, ...board]));
  if (madeWithHole && (cat === 2 || cat === 3)) {
    add({
      kind: 'full-house', group: 'cards', label: 'Full house',
      question: 'make a full house or better',
      hits: (b) => categoryOf(evaluate([...hole, ...b])) >= 6,
    });
  }

  // Flush draws in each suit the hero holds.
  const flushes: Target[] = [];
  for (const s of new Set(hole.map(suitOf))) {
    const have = countSuit(hole, s) + countSuit(board, s);
    if (have === 4) flushes.push(flushTarget(hole, s, false));
    else if (have === 3 && board.length === 3) flushes.push(flushTarget(hole, s, true));
  }

  // Straight draws that use a hole card.
  const holeMask = rankMask(hole);
  const straight: Target = {
    kind: 'straight', group: 'draws', label: 'Straight', question: 'make a straight',
    hits: (b) => straightWith(holeMask, holeMask | rankMask(b)),
  };
  const boardMask = rankMask(board);
  const oneAway = Array.from({ length: 13 }, (_, r) => r).some((r) =>
    straightWith(holeMask, holeMask | boardMask | (1 << r)),
  );
  const straights: Target[] = [];
  if (oneAway) straights.push(straight);
  else if (board.length === 3) {
    straights.push({ ...straight, kind: 'backdoor-straight', label: 'Backdoor straight' });
  }

  targets.push(...flushes, ...straights);
  const flushDraw = flushes.find((f) => f.kind === 'flush');
  if (flushDraw && oneAway) {
    add({
      kind: 'straight-or-flush', group: 'draws', label: 'Straight or flush',
      question: 'make a straight or a flush',
      hits: (b) => flushDraw.hits(b) || straight.hits(b),
    });
  }

  // Keep targets that are still live and that improve the hand you hold now; a card that
  // leaves your hand where it is isn't an out. `makes` comes from every hitting runout.
  const current = categoryOf(evaluate([...hole, ...board]));
  const made = (extra: Card[]) => categoryOf(evaluate([...hole, ...board, ...extra]));
  const unseen = remainingDeck([...hole, ...board]);
  const offered: OfferedTarget[] = [];
  for (const t of targets) {
    if (t.hits(board)) continue;
    let cats = unseen.filter((c) => t.hits([...board, c])).map((c) => made([c]));
    const singleCard = cats.length > 0;
    if (!singleCard) {
      if (board.length !== 3) continue;
      cats = [];
      for (let i = 0; i < unseen.length; i++)
        for (let j = i + 1; j < unseen.length; j++)
          if (t.hits([...board, unseen[i], unseen[j]])) cats.push(made([unseen[i], unseen[j]]));
      if (cats.length === 0) continue;
    }
    const worst = Math.min(...cats);
    if (worst <= current) continue;
    const best = Math.max(...cats);
    offered.push({ ...t, singleCard, makes: MADE[worst] + (best > worst ? ' or better' : '') });
  }
  return offered;
}
