import { remainingDeck, sortByRankDesc, type Card } from './cards';
import type { Target } from './targets';

// 'next' = the next card only; 'river' = every card still to come.
export type Horizon = 'next' | 'river';

export interface OddsBreakdown {
  knownCount: number;
  unseen: number;
  cardsToCome: 1 | 2;
  outs: Card[];
  totalCombos: number;
  outCombos: number; // runouts containing at least one out
  runnerCombos: number; // runouts that hit without any single out
  runnerExamples: Card[][];
  hitCombos: number;
  probability: number;
}

// Exact probability, from the hero's seat, that the target hits. Opponents' cards are
// unknown to the hero, so they count as unseen.
export function computeOdds(hole: Card[], board: Card[], target: Target, horizon: Horizon): OddsBreakdown {
  if (board.length !== 3 && board.length !== 4) {
    throw new Error('Odds are computed on the flop or the turn');
  }
  const known = [...hole, ...board];
  const unseen = remainingDeck(known);
  const n = unseen.length;
  const cardsToCome: 1 | 2 = board.length === 3 && horizon === 'river' ? 2 : 1;

  const outs = unseen.filter((c) => target.hits([...board, c]));
  const k = outs.length;
  const base = { knownCount: known.length, unseen: n, cardsToCome, outs: sortByRankDesc(outs) };

  if (cardsToCome === 1) {
    return {
      ...base, totalCombos: n, outCombos: k, runnerCombos: 0, runnerExamples: [], hitCombos: k,
      probability: k / n,
    };
  }

  const isOut = new Set(outs);
  const totalCombos = (n * (n - 1)) / 2;
  const outCombos = totalCombos - ((n - k) * (n - k - 1)) / 2;
  let runnerCombos = 0;
  const runnerExamples: Card[][] = [];
  for (let i = 0; i < n; i++) {
    if (isOut.has(unseen[i])) continue;
    for (let j = i + 1; j < n; j++) {
      if (isOut.has(unseen[j])) continue;
      if (target.hits([...board, unseen[i], unseen[j]])) {
        runnerCombos++;
        if (runnerExamples.length < 3) runnerExamples.push([unseen[j], unseen[i]]);
      }
    }
  }
  const hitCombos = outCombos + runnerCombos;
  return {
    ...base, totalCombos, outCombos, runnerCombos, runnerExamples, hitCombos,
    probability: hitCombos / totalCombos,
  };
}
