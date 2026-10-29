// Reads: what each player's actions so far say about how they play.
//
// Counted per player over the session, the standard tracking stats. A raw rate
// from a handful of hands is mostly noise, so every estimate is shrunk toward a
// population average: it starts as the average and moves to the player's own
// rate as their sample grows (a Beta prior worth WEIGHT observations). The
// population averages are measured, not assumed: the bots' own mix of styles
// over twenty simulated nine-handed tables of 300 hands (54,000 player-hands),
// weighted by how often each style is dealt, rounded. Folds by bet size were added
// 2026-10-20; re-measured 2026-10-29 after preflop folds became exact, and again
// after chips past a caller's stack stopped counting as risked. Re-measure after changing how bots play (scripts/styles.ts).

export interface Tally {
  hands: number; // dealt in
  vpip: number; // put chips in voluntarily before the flop
  pfr: number; // raised before the flop
  postAggr: number; // bets and raises after the flop
  postActs: number; // every action after the flop
  facedBet: number; // first bet against them on a street
  foldedToBet: number;
  facedRaise: number; // raised after they bet or raised on the same street
  foldedToRaise: number;
  cbetSpots: number; // raised before the flop and first to bet the flop
  cbets: number;
  riverBetsShown: number; // bet or raised the river and showed the hand
  bluffsShown: number; // ...holding nothing better than the board
  // Facing an unraised bet after the flop, by its size (SIZE_BUCKETS): small, medium, large.
  facedBySize: [number, number, number];
  foldedBySize: [number, number, number];
}

// Bet sizes as a fraction of the pot before the bet: under 45% is small, under 85% medium,
// the rest large. Cut so the bots' usual ⅓, ⅔ and pot bets fall one in each.
export const SIZE_BUCKETS = [0.45, 0.85];
export const sizeBucket = (fractionOfPot: number) =>
  fractionOfPot < SIZE_BUCKETS[0] ? 0 : fractionOfPot < SIZE_BUCKETS[1] ? 1 : 2;
export const SIZE_STATS = ['foldToSmall', 'foldToMedium', 'foldToLarge'] as const;

export const emptyTally = (): Tally => ({
  hands: 0, vpip: 0, pfr: 0, postAggr: 0, postActs: 0, facedBet: 0, foldedToBet: 0,
  facedRaise: 0, foldedToRaise: 0, cbetSpots: 0, cbets: 0, riverBetsShown: 0, bluffsShown: 0,
  facedBySize: [0, 0, 0], foldedBySize: [0, 0, 0],
});

export type Stat =
  | 'vpip' | 'pfr' | 'aggression' | 'foldToBet' | 'foldToRaise' | 'cbet' | 'bluff'
  | (typeof SIZE_STATS)[number];

// Population averages (measured, above) and how many observations each is worth.
export type Priors = Record<Stat, number>;
export const PRIOR: Priors = {
  vpip: 0.25, pfr: 0.11, aggression: 0.22, foldToBet: 0.42, foldToRaise: 0.34, cbet: 0.4, bluff: 0.17,
  foldToSmall: 0.19, foldToMedium: 0.34, foldToLarge: 0.6,
};
// Heads-up and three-handed, everyone plays far more hands: the same measurement at those
// table sizes (scripts/styles.ts 2 and 3), rounded. The averages set how wide bots open, so
// these were measured until they held (three rounds, 2026-10-29; three more after the
// uncalled-chips fix).
export const PRIORS_BY_SIZE: Record<number, Priors> = {
  2: {
    vpip: 0.65, pfr: 0.34, aggression: 0.25, foldToBet: 0.34, foldToRaise: 0.23, cbet: 0.45, bluff: 0.3,
    foldToSmall: 0.14, foldToMedium: 0.36, foldToLarge: 0.5,
  },
  3: {
    vpip: 0.63, pfr: 0.28, aggression: 0.24, foldToBet: 0.38, foldToRaise: 0.24, cbet: 0.45, bluff: 0.25,
    foldToSmall: 0.19, foldToMedium: 0.34, foldToLarge: 0.54,
  },
};
// The averages for a table of this many players; a full table's from four up.
export const priorFor = (seated: number) => PRIORS_BY_SIZE[seated] ?? PRIOR;

const WEIGHT: Record<Stat, number> = {
  vpip: 12, pfr: 12, aggression: 10, foldToBet: 8, foldToRaise: 6, cbet: 6, bluff: 4,
  foldToSmall: 8, foldToMedium: 8, foldToLarge: 8,
};

export interface Estimate {
  rate: number; // shrunk estimate
  sd: number; // posterior standard deviation
  n: number; // observations behind it
  k: number; // times it happened
}

// `prior`: the table averages the estimates are shrunk toward, and read against.
export type Read = Record<Stat, Estimate> & { hands: number; prior: Priors };

function estimate(stat: Stat, k: number, n: number, prior: number): Estimate {
  const a = k + prior * WEIGHT[stat];
  const b = n - k + (1 - prior) * WEIGHT[stat];
  const t = a + b;
  return { rate: a / t, sd: Math.sqrt((a * b) / (t * t * (t + 1))), n, k };
}

export function readOf(t: Tally, prior: Priors = PRIOR): Read {
  const est = (stat: Stat, k: number, n: number) => estimate(stat, k, n, prior[stat]);
  const foldToBet = est('foldToBet', t.foldedToBet, t.facedBet);
  // Folds to one size start from the player's overall fold rate, moved by how much more or
  // less the table folds to that size, then follow what they've done against that size.
  const sized = (i: number) => {
    const stat = SIZE_STATS[i];
    const start = Math.min(0.95, Math.max(0.05, foldToBet.rate + prior[stat] - prior.foldToBet));
    return estimate(stat, t.foldedBySize[i], t.facedBySize[i], start);
  };
  return {
    hands: t.hands,
    prior,
    vpip: est('vpip', t.vpip, t.hands),
    pfr: est('pfr', t.pfr, t.hands),
    aggression: est('aggression', t.postAggr, t.postActs),
    foldToBet,
    foldToRaise: est('foldToRaise', t.foldedToRaise, t.facedRaise),
    cbet: est('cbet', t.cbets, t.cbetSpots),
    bluff: est('bluff', t.bluffsShown, t.riverBetsShown),
    foldToSmall: sized(0),
    foldToMedium: sized(1),
    foldToLarge: sized(2),
  };
}

// A player nobody has seen: the population average.
export const PRIOR_READ: Read = readOf(emptyTally());
