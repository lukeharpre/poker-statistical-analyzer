// Measures each bot style's stats over simulated tables of 300 hands (54,000 player-hands), and the average
// weighted by how often each style is dealt: the priors in src/engine/reads.ts.
//   npx vite-node scripts/styles.ts          nine-handed (PRIOR)
//   npx vite-node scripts/styles.ts -- 2     heads-up, or any other table size (PRIORS_BY_SIZE)
import { decide } from '../src/engine/bot';
import { Game } from '../src/engine/game';
const size = Number(process.argv[process.argv.length - 1]) || 9;
const runs = Math.ceil((20 * 9) / size); // the same 54,000 player-hands at any size
const by: Record<string, number[]> = {};
const mix: Record<string, number> = { regular: 0.35, tight: 0.2, 'loose-aggressive': 0.2, 'calling-station': 0.25 };
for (let run = 0; run < runs; run++) {
  const g = new Game(size - 1, 1000, Math.random);
  g.hero.isHuman = false;
  g.hero.personality = { style: 'regular', tightness: 0, aggression: 0.65, bluff: 0.8, stickiness: 0 };
  for (let h = 0; h < 300; h++) {
    g.startHand();
    while (g.phase !== 'handOver') {
      if (g.phase === 'runout') { g.runoutStep(); continue; }
      const p = g.players[g.toAct];
      g.act(p.id, decide(g.botView(p.id), p.personality!));
    }
  }
  for (const p of g.players) {
    const t = g.tallies.get(p.name)!;
    const row = (by[p.personality!.style] ??= Array(20).fill(0));
    [
      t.vpip, t.hands, t.pfr, t.hands, t.postAggr, t.postActs, t.foldedToBet, t.facedBet, t.foldedToRaise, t.facedRaise,
      t.cbets, t.cbetSpots, t.bluffsShown, t.riverBetsShown,
      t.foldedBySize[0], t.facedBySize[0], t.foldedBySize[1], t.facedBySize[1], t.foldedBySize[2], t.facedBySize[2],
    ].forEach((v, i) => (row[i] += v));
  }
}
const names = ['vpip', 'pfr', 'aggression', 'foldToBet', 'foldToRaise', 'cbet', 'bluff', 'foldToSmall', 'foldToMedium', 'foldToLarge'];
const avg = Array(names.length).fill(0);
for (const [s, r] of Object.entries(by)) {
  const rates = names.map((_, i) => r[2 * i] / Math.max(1, r[2 * i + 1]));
  rates.forEach((x, i) => (avg[i] += x * mix[s]));
  console.log(s.padEnd(17), rates.map((x, i) => `${names[i]} ${(x * 100).toFixed(0)}%`).join('  '));
}
console.log('weighted'.padEnd(17), avg.map((x, i) => `${names[i]} ${(x * 100).toFixed(1)}%`).join('  '));
