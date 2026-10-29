// Coach audit: standard spots with a known right answer, each graded by Coach.
//   npx vite-node scripts/coach-audit.ts            all spots, notes in full
//   npx vite-node scripts/coach-audit.ts --brief    one line per decision
//   npx vite-node scripts/coach-audit.ts --all      every note in full, passing or not
//   npx vite-node scripts/coach-audit.ts --spin 200  as many Spin & Gos for the check below
// Then Spin & Gos played out by bots (seeded): at each of one seat's decisions every option
// is graded, and a note that calls another option better when that option's own note calls
// it a mistake is a contradiction. Any fails the audit.
// A spot fails when Coach's verdict on an action contradicts the expected one, or when the
// samples alone turn it into a mistake or out of one: each is graded again on SEEDS other
// random seeds. Good against close on another seed is a borderline spot, listed, not failed.
import { decide, seeded, sizeTo, STYLES, type BotView, type OpponentView } from '../src/engine/bot';
import { cardLabel, parseCards } from '../src/engine/cards';
import { coachDecision, type Verdict } from '../src/engine/coach';
import type { Action } from '../src/engine/game';
import { emptyTally, PRIOR_READ, readOf, type Tally } from '../src/engine/reads';
import { SpinAndGo } from '../src/engine/spin';

const brief = process.argv.includes('--brief');
const SEEDS = 5;
const BB = 10;

const read = (t: Partial<Tally> = {}) => (Object.keys(t).length ? readOf({ ...emptyTally(), ...t }) : PRIOR_READ);
// Reads over 80 hands for a recognisable type.
const STATION = read({ hands: 80, vpip: 45, pfr: 6, postActs: 120, postAggr: 10, facedBet: 50, foldedToBet: 8, riverBetsShown: 4, bluffsShown: 0 });
const NIT = read({ hands: 80, vpip: 8, pfr: 6, postActs: 40, postAggr: 12, facedBet: 20, foldedToBet: 13, riverBetsShown: 4, bluffsShown: 0 });
const FOLDER = read({ hands: 80, vpip: 20, pfr: 12, postActs: 60, postAggr: 15, facedBet: 40, foldedToBet: 30 });
const BLUFFER = read({ hands: 80, vpip: 35, pfr: 22, postActs: 90, postAggr: 45, facedBet: 30, foldedToBet: 12, riverBetsShown: 10, bluffsShown: 5 });

const opp = (o: Partial<OpponentView>): OpponentView => ({
  name: 'Villain', voluntary: true, acted: true, allIn: false, raisesPreflop: 0, openBehind: null,
  raisesPostflop: 0, callsPostflop: 0, bet: 0, committed: 0, stack: 1000, read: PRIOR_READ, ...o,
  barrels: o.barrels ?? o.raisesPostflop ?? 0, raisesOverBet: o.raisesOverBet ?? 0,
  aggrStreet: o.aggrStreet ?? ((o.bet ?? 0) > 0 && ((o.raisesPostflop ?? 0) > 0 || (o.raisesPreflop ?? 0) > 0)),
});

const ME = opp({ name: 'You' });

interface Spot {
  name: string;
  view: BotView;
  expect: [Action, Verdict | 'not-mistake' | 'not-good'][];
}

// A postflop spot: pot already in, each player committed half (heads-up) or equal shares.
function post(hole: string, board: string, pot: number, opts: {
  toCall?: number; opps?: Partial<OpponentView>[]; inPosition?: boolean; pfAggressor?: boolean; stack?: number;
}): BotView {
  const toCall = opts.toCall ?? 0;
  const opps = (opts.opps ?? [{}]).map((o) => opp(o));
  const n = opps.length + 1;
  const base = (pot - toCall) / n;
  const stack = opts.stack ?? 900;
  for (const o of opps) {
    o.committed = base + o.bet;
    o.stack = o.stack === 1000 ? stack - o.bet : o.stack;
  }
  return {
    hole: parseCards(hole), board: parseCards(board), pot, toCall, currentBet: toCall, myBet: 0,
    minRaiseTo: Math.max(BB, toCall * 2), maxRaiseTo: stack, canRaise: true, bigBlind: BB,
    opponents: opps, myCommitted: base, committed: opps.map((o) => o.committed),
    me: opts.pfAggressor ? { ...ME, raisesPreflop: 1 } : ME, pfAggressor: opts.pfAggressor ?? false, inPosition: opts.inPosition ?? true,
  };
}

// A preflop spot: blinds 5/10, `behind` players still to act who have put nothing in.
function pre(hole: string, opts: { openTo?: number; opener?: Partial<OpponentView>; behind: number; stack?: number; heroBlind?: number; inPosition?: boolean }): BotView {
  const stack = opts.stack ?? 1000;
  const opps: OpponentView[] = [];
  if (opts.openTo) {
    opps.push(opp({ name: 'Opener', raisesPreflop: 1, openBehind: opts.behind + 1, bet: opts.openTo, committed: opts.openTo, stack: stack - opts.openTo, ...opts.opener }));
  }
  for (let i = 0; i < opts.behind; i++) opps.push(opp({ name: `Behind${i + 1}`, voluntary: false, acted: false, stack }));
  // Blinds: if the hero isn't one, the last two players behind posted them.
  const blinds = opps.filter((o) => !o.voluntary).slice(-2);
  if (opts.heroBlind === undefined) blinds.forEach((o, i) => { o.bet = o.committed = i === 0 ? 5 : 10; o.stack -= o.bet; });
  const myBet = opts.heroBlind ?? 0;
  const currentBet = opts.openTo ?? BB;
  const pot = opps.reduce((s, o) => s + o.committed, 0) + myBet + (opts.heroBlind === 10 ? 5 : opts.heroBlind === 5 ? 10 : 0);
  return {
    hole: parseCards(hole), board: [], pot, toCall: currentBet - myBet, currentBet, myBet,
    minRaiseTo: currentBet * 2, maxRaiseTo: stack, canRaise: true, bigBlind: BB,
    // The other blind, folded, still has its chips in the pot.
    opponents: opps, myCommitted: myBet,
    committed: [...opps.map((o) => o.committed), ...(opts.heroBlind === 10 ? [5] : opts.heroBlind === 5 ? [10] : [])],
    me: ME, pfAggressor: false, inPosition: opts.inPosition ?? true,
  };
}

// Heads-up, `depth` big blinds each, no antes: the hero in the small blind (the button) with
// it folded to them, or in the big blind facing the small blind's shove.
function hu(hole: string, depth: number, hero: 'sb' | 'bb'): BotView {
  const S = depth * BB;
  const seats = [{ name: 'You', chips: S }, { name: 'Villain', chips: S }];
  if (hero === 'sb') {
    return {
      hole: parseCards(hole), board: [], pot: 15, toCall: 5, currentBet: 10, myBet: 5, minRaiseTo: 20, maxRaiseTo: S,
      canRaise: true, bigBlind: BB, opponents: [opp({ voluntary: false, acted: false, bet: 10, committed: 10, stack: S - 10 })],
      myCommitted: 5, committed: [10], me: { ...ME, voluntary: false, bet: 5, committed: 5 }, seats, pfAggressor: false, inPosition: true,
    };
  }
  return {
    hole: parseCards(hole), board: [], pot: S + 10, toCall: S - 10, currentBet: S, myBet: 10, minRaiseTo: S, maxRaiseTo: S,
    canRaise: false, bigBlind: BB, opponents: [opp({ raisesPreflop: 1, openBehind: 1, allIn: true, bet: S, committed: S, stack: 0 })],
    myCommitted: 10, committed: [S], me: { ...ME, voluntary: false, bet: 10, committed: 10 }, seats: seats.reverse(), pfAggressor: false, inPosition: false,
  };
}

// Three-handed, `depth` big blinds each, folded to the hero on the button.
function button(hole: string, depth: number): BotView {
  const S = depth * BB;
  const blind = (name: string, bet: number) => opp({ name, voluntary: false, acted: false, bet, committed: bet, stack: S - bet });
  return {
    hole: parseCards(hole), board: [], pot: 15, toCall: 10, currentBet: 10, myBet: 0, minRaiseTo: 20, maxRaiseTo: S, canRaise: true,
    bigBlind: BB, opponents: [blind('Small', 5), blind('Big', 10)], myCommitted: 0, committed: [5, 10], me: ME,
    seats: [{ name: 'You', chips: S }, { name: 'Small', chips: S }, { name: 'Big', chips: S }], pfAggressor: false, inPosition: true,
  };
}

const R = (to: number): Action => ({ type: 'raise', to });
const F: Action = { type: 'fold' };
const C: Action = { type: 'call' };
const X: Action = { type: 'check' };

const spots: Spot[] = [
  // --- before the flop ---
  { name: 'UTG, AKo, unopened, 8 behind', view: pre('As Kd', { behind: 8 }), expect: [[R(30), 'good'], [F, 'mistake']] },
  { name: 'UTG, 7-2o, unopened', view: pre('7c 2d', { behind: 8 }), expect: [[F, 'good'], [R(30), 'mistake']] },
  { name: 'Button, 7-6s, folded to', view: pre('7h 6h', { behind: 2 }), expect: [[R(30), 'not-mistake']] },
  { name: 'AQo on the button vs an open, blinds behind', view: pre('Ac Qd', { openTo: 30, behind: 2 }), expect: [[C, 'not-mistake'], [R(90), 'not-mistake'], [F, 'mistake']] },
  { name: 'AKo vs an open, 3 behind (the reported hand)', view: pre('Ac Kd', { openTo: 30, behind: 3 }), expect: [[R(90), 'good'], [F, 'mistake']] },
  { name: 'Big blind, 7-2o vs an open', view: pre('7c 2d', { openTo: 30, behind: 0, heroBlind: 10, inPosition: false }), expect: [[F, 'good'], [C, 'not-good']] },
  { name: 'Big blind, KJs vs a button open', view: pre('Kh Jh', { openTo: 25, opener: { openBehind: 2 }, behind: 0, heroBlind: 10, inPosition: false }), expect: [[C, 'not-mistake'], [F, 'not-good']] }, // worth about half a big blind
  { name: 'QQ vs an open: re-raise', view: pre('Qs Qd', { openTo: 30, behind: 2 }), expect: [[R(90), 'good'], [F, 'mistake']] },
  { name: '8bb, A5o unopened in the cutoff', view: pre('Ac 5d', { behind: 3, stack: 80 }), expect: [[R(80), 'not-mistake'], [F, 'not-mistake']] }, // no antes: near break-even
  { name: '8bb, 9-3o unopened UTG', view: pre('9c 3d', { behind: 8, stack: 80 }), expect: [[F, 'good'], [R(80), 'mistake']] },

  // --- short stacks: against the equilibrium ---
  // Shoves and calls from HoldemResources heads-up push/fold, no antes. The small blind's
  // first move is graded in the game with limps as well (preflopTree.ts), where a hand push/fold
  // folds can be worth a limp. 7-2o shoves only up to 1.6bb and calls up to 2.6bb.
  { name: 'HU 10bb, 7-2o in the small blind', view: hu('7c 2d', 10, 'sb'), expect: [[F, 'good'], [R(100), 'mistake']] },
  // Q7o shoves up to 10.3bb; at 15bb push/fold folds it, but a limp beats folding.
  { name: 'HU 8bb, Q7o in the small blind', view: hu('Qc 7d', 8, 'sb'), expect: [[R(80), 'good'], [F, 'not-good']] },
  { name: 'HU 15bb, Q7o in the small blind', view: hu('Qc 7d', 15, 'sb'), expect: [[C, 'good'], [F, 'not-good'], [R(150), 'not-good']] },
  { name: 'HU 15bb, T9s in the small blind', view: hu('Tc 9c', 15, 'sb'), expect: [[R(150), 'good'], [F, 'not-good']] },
  // Calls: K2s up to 10.7bb, 22 to 15.0, A2o to 15.8, T9s to 11.5.
  { name: 'HU 9bb, K2s in the big blind facing a shove', view: hu('Kc 2c', 9, 'bb'), expect: [[C, 'good'], [F, 'not-good']] },
  { name: 'HU 14bb, 22 in the big blind facing a shove', view: hu('2c 2d', 14, 'bb'), expect: [[C, 'good'], [F, 'not-good']] },
  { name: 'HU 14bb, A2o in the big blind facing a shove', view: hu('Ac 2d', 14, 'bb'), expect: [[C, 'good'], [F, 'not-good']] },
  { name: 'HU 15bb, T9s in the big blind facing a shove', view: hu('Tc 9c', 15, 'bb'), expect: [[F, 'good'], [C, 'not-good']] },
  { name: '3-handed 10bb, AA on the button', view: button('Ac Ad', 10), expect: [[R(100), 'good'], [F, 'mistake']] },
  { name: '3-handed 10bb, 7-2o on the button', view: button('7c 2d', 10), expect: [[F, 'good'], [R(100), 'mistake']] },

  // --- the flop ---
  { name: 'AK on K-8-5 two-tone, checked to (the screenshot)', view: post('Ac Kd', 'Ks 8c 5s', 75, { pfAggressor: true }), expect: [[R(50), 'good'], [X, 'not-good']] },
  { name: 'AK missed on 7-6-2, heads-up, checked to', view: post('Ac Kd', '7s 6h 2c', 75, { pfAggressor: true }), expect: [[R(25), 'not-mistake'], [X, 'not-mistake']] },
  { name: 'Nut flush draw facing a half-pot bet', view: post('As 9s', 'Ks 7s 2d', 120, { toCall: 30, inPosition: true, opps: [{ raisesPostflop: 1, bet: 30 }] }), expect: [[C, 'not-mistake'], [F, 'mistake']] },
  { name: 'Flush draw facing a half-pot c-bet', view: post('9s 8s', 'Ks 5s 2d', 90, { toCall: 30, opps: [{ raisesPreflop: 1, raisesPostflop: 1, bet: 30 }] }), expect: [[C, 'not-mistake'], [F, 'mistake']] },
  { name: 'Middle pair facing a half-pot c-bet', view: post('9h 8h', 'Kc 9d 3s', 90, { toCall: 30, opps: [{ raisesPreflop: 1, raisesPostflop: 1, bet: 30 }] }), expect: [[C, 'not-mistake'], [F, 'not-good']] },
  { name: 'Bottom set facing a bet', view: post('3h 3d', 'Kc 9d 3s', 90, { toCall: 30, opps: [{ raisesPostflop: 1, bet: 30 }] }), expect: [[R(110), 'not-mistake'], [C, 'not-mistake'], [F, 'mistake']] },
  { name: 'Air facing a pot bet, 3-way', view: post('Jh Tc', 'Ac 7d 3s', 150, { toCall: 50, opps: [{ raisesPostflop: 1, bet: 50 }, { acted: false }] }), expect: [[F, 'good'], [C, 'mistake']] },

  // --- turn and river ---
  { name: 'River: top pair good kicker facing a half-pot bet', view: post('Ah Qc', 'Qd 8s 4c 2h 7d', 200, { toCall: 50, opps: [{ raisesPostflop: 1, bet: 50 }] }), expect: [[C, 'not-mistake'], [F, 'mistake']] }, // a thin value raise is fine too
  { name: 'River: air vs a calling station, checked to', view: post('Jh Tc', 'As 8d 4c 2h 3d', 200, { opps: [{ read: STATION, callsPostflop: 2 }] }), expect: [[X, 'good'], [R(150), 'mistake']] },
  { name: 'River: air vs a player who folds a lot', view: post('Jh Tc', 'As 8d 4c 2h 3d', 200, { opps: [{ read: FOLDER, callsPostflop: 2 }] }), expect: [[R(150), 'not-mistake']] },
  { name: 'River: the nuts, checked to', view: post('Ah 5h', 'Kh 9h 2h 7c 3d', 200, {}), expect: [[R(150), 'good'], [X, 'mistake']] },
  // Half pot: calling needs 33%, and they bluff about 39% of the time.
  { name: 'River: second pair vs a known bluffer, half-pot bet', view: post('Kh 9c', 'As Kd 6c 2h 4s', 300, { toCall: 100, opps: [{ raisesPostflop: 3, barrels: 3, bet: 100, read: BLUFFER }] }), expect: [[C, 'good'], [F, 'mistake']] },
  { name: 'River: second pair vs a nit, pot bet', view: post('Kh 9c', 'As Kd 6c 2h 4s', 200, { toCall: 200, opps: [{ raisesPostflop: 3, barrels: 3, bet: 200, read: NIT }] }), expect: [[F, 'good'], [C, 'not-good']] },
  { name: 'Turn: top pair vs a station, checked to', view: post('Kh Jc', 'Kd 8s 4c 2h', 120, { opps: [{ read: STATION, callsPostflop: 1 }] }), expect: [[R(80), 'good'], [X, 'not-good']] },
];

const ok = (v: Verdict, want: Verdict | 'not-mistake' | 'not-good') =>
  want === 'not-mistake' ? v !== 'mistake' : want === 'not-good' ? v !== 'good' : v === want;
const label = (a: Action) => (a.type === 'raise' ? `raise ${a.to}` : a.type);

let failed = 0;
let unstable = 0;
for (const s of spots) {
  for (const [action, want] of s.expect) {
    const note = coachDecision(s.view, action);
    const others = Array.from({ length: SEEDS }, (_, i) => coachDecision(s.view, action, 1000 + i).verdict);
    const flips = others.filter((v) => v !== note.verdict);
    const crossed = flips.some((v) => v === 'mistake' || note.verdict === 'mistake');
    const pass = ok(note.verdict, want) && !crossed;
    if (!pass) failed++;
    if (crossed) unstable++;
    const shaky = flips.length
      ? ` · ${crossed ? 'UNSTABLE' : 'borderline'}: ${flips.length} of ${SEEDS} seeds say ${[...new Set(flips)].join('/')}`
      : '';
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${s.name} — ${label(action)}: ${note.verdict} (want ${want}) · ${note.headline}${shaky}`);
    if ((!brief && !pass) || process.argv.includes('--all')) for (const l of note.lines) console.log(`       ${l}`);
  }
}
console.log(`\n${failed} of ${spots.reduce((n, s) => n + s.expect.length, 0)} checks failed (${unstable} on the samples alone)`);

// --- contradictions, in Spin & Gos ------------------------------------------------------

const SPINS = Number(process.argv[process.argv.indexOf('--spin') + 1]) || 6;
// The play a headline names as better, or null when it names none ("…, but smaller" is a size).
const NAMED: [RegExp, string][] = [
  [/^(Borderline\. )?Folding\b/, 'fold'], [/^(Borderline\. )?Checking\b/, 'check'], [/^(Borderline\. )?(Calling|Limping)\b/, 'call'],
  [/^(Borderline\. )?(Raising|Betting)\b/, 'raise'], [/^(Borderline\. )?(Shoving|Going all-in)\b/, 'allin'],
];
const named = (headline: string) =>
  /, but |about even/.test(headline) ? null : (NAMED.find(([re]) => re.test(headline))?.[1] ?? null);

function options(v: BotView): [string, Action][] {
  const out: [string, Action][] = v.toCall ? [['fold', F], ['call', C]] : [['check', X]];
  // Facing only all-ins, going all-in is a call.
  if (!v.canRaise || v.maxRaiseTo <= v.currentBet || v.opponents.every((o) => o.allIn)) return out;
  const small = v.board.length
    ? sizeTo(v, v.currentBet + 0.5 * (v.pot + v.toCall))
    : Math.max(v.minRaiseTo, v.currentBet <= v.bigBlind ? 2 * v.bigBlind : Math.round(2.5 * v.currentBet));
  if (small < v.maxRaiseTo * 0.6) out.push(['raise', R(small)]);
  out.push(['allin', { type: 'allin' }]);
  return out;
}

let decisions = 0;
const contradictions: string[] = [];
for (let n = 0; n < SPINS; n++) {
  let clock = 0;
  const rng = seeded(1000 + n);
  const g = new SpinAndGo(n % 2 ? 300 : 500, () => clock, rng);
  for (let hand = 0; hand < 400 && !g.finished; hand++) {
    clock += 24_000; // a hand every 24 seconds: about five a level
    g.startHand();
    while (g.phase === 'betting' || g.phase === 'runout') {
      if (g.phase === 'runout') { g.runoutStep(); continue; }
      const id = g.toAct;
      const v = g.botView(id);
      if (id === 0) {
        decisions++;
        const graded = options(v).map(([name, a]) => ({ name, note: coachDecision(v, a) }));
        for (const { name, note } of graded) {
          const better = note.verdict === 'good' ? null : named(note.headline);
          const other = better && better !== name ? graded.find((x) => x.name === better) : undefined;
          if (other?.note.verdict === 'mistake') {
            contradictions.push(`${v.hole.map(cardLabel).join(' ')} ${v.board.map(cardLabel).join(' ')} · ${name}: ${note.headline} · ${better}: ${other.note.headline}`);
          }
        }
      }
      g.act(id, decide(v, id === 0 ? STYLES.regular : g.players[id].personality!, rng));
    }
  }
}
for (const c of contradictions) console.log(`FAIL ${c}`);
console.log(`${contradictions.length} contradictions in ${decisions} Spin & Go decisions (${SPINS} spins)`);
if (failed || contradictions.length) process.exitCode = 1;

