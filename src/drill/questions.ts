// Statistics: quick-fire probability questions, each with an exact answer and its working.
// Every answer follows from the stated premise alone (outs are clean, hands are dealt at random).

export type QuestionKind =
  | 'outs-1' | 'outs-2' | 'pot-odds' | 'bluff' | 'odds-against' | 'preflop' | 'set' | 'flush' | 'ace-out';

export const KIND_NAMES: Record<QuestionKind, string> = {
  'outs-1': 'Outs, one card',
  'outs-2': 'Outs, two cards',
  'pot-odds': 'Pot odds',
  bluff: 'Bluff break-even',
  'odds-against': 'Odds to percent',
  preflop: 'Starting hands',
  set: 'Flop a set',
  flush: 'Flop a flush',
  'ace-out': 'An ace out there',
};
export const KINDS = Object.keys(KIND_NAMES) as QuestionKind[];

export interface Question {
  kind: QuestionKind;
  prompt: string;
  exact: number; // 0..1
  working: [string, string][]; // label, line
  shortcut?: [string, string]; // a rule of thumb, shown after the exact working
}

type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
export const pct = (p: number, dp = 2) => `${(p * 100).toFixed(dp)}%`;

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_NAMES: Record<string, string> = {
  '2': 'twos', '3': 'threes', '4': 'fours', '5': 'fives', '6': 'sixes', '7': 'sevens', '8': 'eights',
  '9': 'nines', '10': 'tens', J: 'jacks', Q: 'queens', K: 'kings', A: 'aces',
};
const SUITS = ['♠', '♥', '♦', '♣'];
const HANDS = 1326; // C(52, 2)

function outsOne(rng: Rng): Question {
  const turn = rng() < 0.5;
  const k = int(rng, 2, 15);
  const n = turn ? 46 : 47;
  return {
    kind: 'outs-1',
    prompt: `${k} outs on the ${turn ? 'turn' : 'flop'}. Chance to hit on the ${turn ? 'river' : 'turn'}?`,
    exact: k / n,
    working: [
      ['Unseen', `52 − ${turn ? 6 : 5} = ${n}`],
      ['Hit', `${k}/${n} = ${pct(k / n)}`],
    ],
    shortcut: ['Rule of 2', `${k} × 2 = ${k * 2}%`],
  };
}

function outsTwo(rng: Rng): Question {
  const k = int(rng, 2, 15);
  const miss = ((47 - k) / 47) * ((46 - k) / 46);
  return {
    kind: 'outs-2',
    prompt: `${k} outs on the flop. Chance to hit by the river?`,
    exact: 1 - miss,
    working: [
      ['Unseen', '52 − 5 = 47'],
      ['Miss both', `${47 - k}/47 × ${46 - k}/46 = ${pct(miss)}`],
      ['Hit', `1 − ${pct(miss)} = ${pct(1 - miss)}`],
    ],
    shortcut: ['Rule of 4', `${k} × 4 = ${k * 4}%${k > 8 ? `, minus ${k - 8} over 8 outs = ${k * 4 - (k - 8)}%` : ''}`],
  };
}

const BET_SIZES = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.5, 2];
const potAndBet = (rng: Rng) => {
  const pot = int(rng, 4, 60) * 10;
  const bet = Math.max(5, Math.round((pot * pick(rng, BET_SIZES)) / 5) * 5);
  return { pot, bet };
};

function potOdds(rng: Rng): Question {
  const { pot, bet } = potAndBet(rng);
  const total = pot + 2 * bet;
  return {
    kind: 'pot-odds',
    prompt: `The pot is ${pot} and your opponent bets ${bet}. What equity do you need to call?`,
    exact: bet / total,
    working: [
      ['Pot after call', `${pot} + ${bet} + ${bet} = ${total}`],
      ['Need', `${bet}/${total} = ${pct(bet / total)}`],
    ],
  };
}

function bluff(rng: Rng): Question {
  const { pot, bet } = potAndBet(rng);
  return {
    kind: 'bluff',
    prompt: `You bet ${bet} into ${pot}. How often must they fold for the bluff to break even?`,
    exact: bet / (bet + pot),
    working: [
      ['Risk', `${bet} to win ${pot}`],
      ['Break-even', `${bet}/(${bet} + ${pot}) = ${pct(bet / (bet + pot))}`],
    ],
  };
}

const AGAINST = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 11, 12, 15, 22];
function oddsAgainst(rng: Rng): Question {
  const a = pick(rng, AGAINST);
  const [x, y] = Number.isInteger(a) ? [a, 1] : [a * 2, 2];
  return {
    kind: 'odds-against',
    prompt: `${x} to ${y} against. As a probability?`,
    exact: y / (x + y),
    working: [['For', `${y}/(${x} + ${y}) = ${pct(y / (x + y))}`]],
  };
}

function preflop(rng: Rng): Question {
  const hi = int(rng, 1, 12);
  const lo = int(rng, 0, hi - 1);
  const [a, b] = [RANKS[hi], RANKS[lo]];
  const r = pick(rng, RANKS);
  const spots: { prompt: string; combos: number; how: string }[] = [
    { prompt: 'a pocket pair', combos: 78, how: '13 ranks × 6 pairs each = 78' },
    { prompt: `pocket ${RANK_NAMES[r]}`, combos: 6, how: 'C(4,2) = 6' },
    { prompt: 'two suited cards', combos: 312, how: '4 suits × C(13,2) = 4 × 78 = 312' },
    { prompt: `${a}-${b}, suited or not`, combos: 16, how: '4 × 4 = 16' },
    { prompt: `${a}-${b} suited`, combos: 4, how: 'one per suit = 4' },
    { prompt: 'at least one ace', combos: HANDS - choose(48, 2), how: `1326 − C(48,2) = 1326 − 1128 = 198` },
  ];
  const s = pick(rng, spots);
  return {
    kind: 'preflop',
    prompt: `Chance to be dealt ${s.prompt}?`,
    exact: s.combos / HANDS,
    working: [
      ['Hands', 'C(52,2) = 1326'],
      ['Combos', s.how],
      ['Chance', `${s.combos}/1326 = ${pct(s.combos / HANDS)}`],
    ],
  };
}

function flopSet(rng: Rng): Question {
  const r = pick(rng, RANKS);
  const miss = (48 / 50) * (47 / 49) * (46 / 48);
  return {
    kind: 'set',
    prompt: `You hold pocket ${RANK_NAMES[r]}. Chance the flop gives you a set or better?`,
    exact: 1 - miss,
    working: [
      ['Unseen', `50, with 2 more ${RANK_NAMES[r]}`],
      ['Miss all 3', `48/50 × 47/49 × 46/48 = ${pct(miss)}`],
      ['Hit', `1 − ${pct(miss)} = ${pct(1 - miss)}`],
    ],
  };
}

function flopFlush(rng: Rng): Question {
  const suit = pick(rng, SUITS);
  const hit = (11 / 50) * (10 / 49) * (9 / 48);
  return {
    kind: 'flush',
    prompt: `You hold two ${suit}. Chance the flop is three more ${suit}?`,
    exact: hit,
    working: [
      ['Unseen', `50, with 11 ${suit}`],
      ['All three', `11/50 × 10/49 × 9/48 = ${pct(hit)}`],
    ],
  };
}

function aceOut(rng: Rng): Question {
  const n = int(rng, 1, 8);
  const m = 2 * n; // cards the opponents hold
  const none = choose(46, m) / choose(50, m);
  const hi = int(rng, 1, 11);
  const lo = int(rng, 0, hi - 1);
  const hand = `${RANKS[hi]}${pick(rng, SUITS)} ${RANKS[lo]}${pick(rng, SUITS)}`;
  return {
    kind: 'ace-out',
    prompt: `You hold ${hand} against ${n} ${n === 1 ? 'opponent' : 'opponents'}. Chance at least one was dealt an ace?`,
    exact: 1 - none,
    working: [
      ['Unseen', `50, with 4 aces; opponents hold ${m}`],
      ['No ace', `C(46,${m})/C(50,${m}) = ${50 - m}/50 × ${49 - m}/49 × ${48 - m}/48 × ${47 - m}/47 = ${pct(none)}`],
      ['An ace', `1 − ${pct(none)} = ${pct(1 - none)}`],
    ],
  };
}

const MAKE: Record<QuestionKind, (rng: Rng) => Question> = {
  'outs-1': outsOne,
  'outs-2': outsTwo,
  'pot-odds': potOdds,
  bluff,
  'odds-against': oddsAgainst,
  preflop,
  set: flopSet,
  flush: flopFlush,
  'ace-out': aceOut,
};

// A random question, never the same kind twice running.
export function nextQuestion(last: QuestionKind | null, rng: Rng = Math.random): Question {
  const kinds = KINDS.filter((k) => k !== last);
  return MAKE[pick(rng, kinds)](rng);
}

export const makeQuestion = (kind: QuestionKind, rng: Rng = Math.random) => MAKE[kind](rng);
