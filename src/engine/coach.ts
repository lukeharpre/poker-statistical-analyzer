import { RANK_PLURALS, cardLabel, rankOf, remainingDeck, suitOf } from './cards';
import { STRAIGHT, categoryOf, evaluate } from './evaluator';
import {
  NEED,
  RESHOVE_BB,
  analyse,
  effectiveBB,
  hasDraw,
  isShort,
  openSize,
  preflopPlan,
  seeded,
  sizeTo,
  winnablePot,
  type Analysis,
  type BotView,
  type OpponentView,
  type Option,
  type PreflopPlan,
} from './bot';
import type { Action } from './game';
import { headsUpTree, OOP_REALISE, type Move, type Spot } from './preflopTree';
import { classOf, headsUp, rangeShare, threeHanded, versus, type Range } from './pushfold';
import { handPercentile } from './ranges';
import type { Estimate } from './reads';

export { winnablePot };

export type Verdict = 'good' | 'close' | 'mistake';

export interface CoachNote {
  id: number;
  verdict: Verdict;
  headline: string;
  lines: string[];
}

type Note = Omit<CoachNote, 'id'>;

// Runouts simulated per decision. Standard error of an equity estimate is
// sqrt(e(1-e)/N): at most 0.7 percentage points.
const ITERATIONS = 5000;
// How far a fold rate could be off: the model's least certain number. Assumed.
const FOLD_UNCERTAINTY = 0.15;
// A note is a headline and at most this many lines.
const MAX_LINES = 5;

// A raise this many times the standard (or best) size is flagged close; OVERSIZE_MISTAKE times, a mistake.
const OVERSIZE = 1.5;
const OVERSIZE_MISTAKE = 2;
// Up to this many big blinds, an open all-in is priced like a short-stack shove.
const OPEN_SHOVE_BB = 20;
// A pocket pair flops a set or better: 1 − C(48,3)/C(50,3). Exact.
const SET_ODDS = 1 - (48 * 47 * 46) / (50 * 49 * 48);

const pct = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);

const handClass = (view: BotView) => {
  const [a, b] = view.hole;
  const [hi, lo] = rankOf(a) >= rankOf(b) ? [a, b] : [b, a];
  if (rankOf(hi) === rankOf(lo)) return `Pocket ${RANK_PLURALS[rankOf(hi)]}`;
  // Cards written out separately so "10" and "7" never run together as "107".
  return `${cardLabel(hi)} ${cardLabel(lo)} (${suitOf(hi) === suitOf(lo) ? 'suited' : 'offsuit'})`;
};

// Where the hand ranks among starting hands, on the same ranking the ranges and opening
// charts use (how it holds up against hands that play).
const strength = (view: BotView) => {
  const above = handPercentile(view.hole[0], view.hole[1]);
  const top = Math.max(1, Math.ceil(above * 100));
  return `${handClass(view)}: ${top <= 50 ? `top ${top}%` : `bottom ${Math.max(1, Math.round((1 - above) * 100))}%`} of starting hands.`;
};

const actionLevel = (type: string) => (type === 'raise' ? 2 : type === 'call' ? 1 : 0);

// FNV-1a: a spot's seed, so the same spot always gets the same note.
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

// Lines in the order they're read, each with a priority: past MAX_LINES, the lowest go first.
type Slot = [string | null | undefined, number];
const compose = (slots: Slot[]): string[] => {
  let kept = slots.filter((s): s is [string, number] => !!s[0]);
  while (kept.length > MAX_LINES) {
    const worst = kept.reduce((w, s) => (s[1] >= w[1] ? s : w));
    kept = kept.filter((s) => s !== worst);
  }
  return kept.map((s) => s[0]);
};
// Why, cost and need-versus-have first; then implied odds or the equilibrium, a read, a size
// tip and stack depth.
const P = { why: 1, cost: 1, need: 2, odds: 2, read: 2, size: 3, depth: 4 };

let nextId = 1;

// Grades the hero's decision using only what the hero could see when acting. `seed` picks the
// samples (by default the spot's own, so the same spot always gets the same note).
export function coachDecision(view: BotView, action: Action, seed?: number): CoachNote {
  const act: Action =
    action.type === 'allin'
      ? view.maxRaiseTo > view.currentBet && view.canRaise
        ? { type: 'raise', to: view.maxRaiseTo }
        : { type: 'call' }
      : action;
  const rng = seeded(seed ?? hash(JSON.stringify(view)));
  const raises = Math.max(0, ...view.opponents.map((o) => o.raisesPreflop));
  const note =
    treeSpot(view, act) ??
    nash(view, act, rng) ??
    (view.board.length === 0 && raises === 0 && !isShort(view) ? unopened(view, act, rng) : weighed(view, act, rng));
  return { id: nextId++, ...note };
}

// --- reads ------------------------------------------------------------------------------

// A rate clearly differs from the table average when there's a 90% chance it sits on that
// side of it: the posterior mean at least 1.28 standard deviations away (normal approximation).
const CLEAR_Z = 1.2816;
const side = (e: Estimate, average: number) => {
  const z = (e.rate - average) / Math.max(e.sd, 1e-9);
  return Math.abs(z) >= CLEAR_Z ? Math.sign(z) : 0;
};

// A player's tendency that changes the decision at hand, with what to do about it. Nothing
// unless their stats clearly differ from the table average: that's no read.
export function readTip(o: OpponentView, focus: 'folds' | 'raises' | 'bluffs' | 'shove'): string | null {
  const r = o.read;
  const avg = (x: number) => `table average ${pct(x)}`;
  if (focus === 'folds' || focus === 'raises') {
    const e = focus === 'folds' ? r.foldToBet : r.foldToRaise;
    const prior = focus === 'folds' ? r.prior.foldToBet : r.prior.foldToRaise;
    const what = focus === 'folds' ? 'bets' : 'raises';
    const dir = side(e, prior);
    if (dir > 0) return `${o.name} folds to ${what} a lot (${pct(e.rate)}, ${avg(prior)}): bluffs work.`;
    if (dir < 0) return `${o.name} rarely folds to ${what} (${pct(e.rate)}, ${avg(prior)}): bet good hands, bluff less.`;
    return null;
  }
  if (focus === 'bluffs') {
    const e = r.bluff;
    const dir = side(e, r.prior.bluff);
    const seen = `${e.k} of ${e.n} river bets shown down`;
    if (dir > 0) return `${o.name} bluffed ${seen}: call more often.`;
    if (dir < 0) return `${o.name} bluffed ${seen}: fold more often.`;
    return null;
  }
  const dir = side(r.vpip, r.prior.vpip);
  if (dir > 0) return `${o.name} plays ${pct(r.vpip.rate)} of hands (${avg(r.prior.vpip)}): expect more calls.`;
  if (dir < 0) return `${o.name} plays ${pct(r.vpip.rate)} of hands (${avg(r.prior.vpip)}): expect more folds.`;
  return null;
}

// The player who made the bet the hero faces.
const bettor = (view: BotView) =>
  view.opponents.find((o) => o.bet === view.currentBet && o.bet > view.myBet && (o.raisesPreflop || o.raisesPostflop)) ??
  view.opponents.find((o) => o.bet === view.currentBet);

// --- short stacks: the equilibrium -------------------------------------------------------

// Up to this many big blinds, heads-up or three-handed, decisions before the flop are graded
// against an equilibrium (preflopTree.ts heads-up and between the blinds, pushfold.ts from the
// button). Deeper, raises short of all-in and reraises matter more than those games allow.
const EQUILIBRIUM_BB = 20;
// Chips given up against the equilibrium, in big blinds: under the first a choice is as good
// as the best, under the second it's close.
const NASH_EVEN = 0.05;
const NASH_CLOSE = 0.2;
// The sizes the heads-up equilibrium raises to, in big blinds, unless the hand's own raise
// is the one being priced: the standard short-stack open (openSize) and a raise over a limp.
const TREE_RAISE = 2;
const TREE_ISO = 3;

const gerund: Record<Move, string> = { fold: 'folding', check: 'checking', call: 'calling', raise: 'raising', allin: 'shoving' };
const verb3: Record<Move, string> = { fold: 'folds', check: 'checks', call: 'calls', raise: 'raises', allin: 'shoves' };

// Who is in the hand before the flop, short-stacked, heads-up or three-handed, from the
// seats: null when it isn't one of the equilibrium's games.
function shortTable(view: BotView) {
  const seats = view.seats;
  if (view.board.length || !seats || seats.length < 2 || seats.length > 3) return null;
  const bb = view.bigBlind;
  if (seats.some((s) => s.chips < bb)) return null; // a blind posted short: not the game
  const live = new Set([view.me.name, ...view.opponents.map((o) => o.name)]);
  const me = seats.findIndex((s) => s.name === view.me.name);
  if (me < 0) return null;
  const chips = seats.map((s) => s.chips);
  const others = chips.filter((_, i) => i !== me && live.has(seats[i].name));
  const depth = Math.min(chips[me], Math.max(...others)) / bb;
  if (depth > EQUILIBRIUM_BB) return null;
  return { seats, live, me, chips, depth, byName: new Map(view.opponents.map((o) => [o.name, o])) };
}

// A shove: their raise is for everything, or for at least everything I have.
const shoves = (view: BotView, o: OpponentView | undefined) =>
  !!o && o.raisesPreflop >= 1 && (o.allIn || o.bet >= view.maxRaiseTo);

// "limps Pocket Sevens", or "raises K♦ 7♥ (offsuit) 55% of the time, limps it 43%": the
// equilibrium's mix with this hand, its main moves only.
function mixText(mix: Record<Move, number>, sbFirst: boolean, hand: string): string {
  const say = (m: Move) => (sbFirst && m === 'call' ? 'limps' : verb3[m]);
  const parts = (Object.entries(mix) as [Move, number][]).filter(([, f]) => f >= 0.1).sort((a, b) => b[1] - a[1]);
  if (parts[0][1] >= 0.9) return `${say(parts[0][0])} ${hand}`;
  const [[m, f], ...rest] = parts;
  return `${say(m)} ${hand} ${pct(f)} of the time, ${rest.map(([x, g]) => `${say(x)} it ${pct(g)}`).join(', ')}`;
}

// Heads-up, or between the blinds once the button has folded, up to EQUILIBRIUM_BB: every
// option priced in the one equilibrium (preflopTree.ts). Null for the big blind facing an
// open: the tree's small blind seldom raises or shoves (it limps), so its ranges there are
// thin. A raise is weighed instead, and a shove graded by push/fold, the game the bots play
// that short (nash).
function treeSpot(view: BotView, act: Action): Note | null {
  const t = shortTable(view);
  if (!t) return null;
  const { seats, live, me, depth, byName } = t;
  const three = seats.length === 3;
  if (three && (me === 0 || live.has(seats[0].name))) return null; // the button is in
  const [s, b] = three ? [1, 2] : [0, 1];
  if (me !== s && me !== b) return null;
  const bb = view.bigBlind;
  const opp = byName.get(seats[me === s ? b : s].name);
  if (!opp) return null;
  const mine = view.me;
  const allIn = act.type === 'raise' && act.to >= Math.min(view.maxRaiseTo, (opp.stack + opp.bet) || view.maxRaiseTo);
  const raiseTo = act.type === 'raise' && !allIn ? act.to / bb : null;

  let spot: Spot;
  let raise = TREE_RAISE;
  let iso = TREE_ISO;
  if (me === s) {
    if (!mine.voluntary && !opp.voluntary) {
      spot = 'sb';
      if (raiseTo) raise = raiseTo;
    } else if (mine.voluntary && mine.raisesPreflop === 0 && opp.raisesPreflop === 1) {
      spot = shoves(view, opp) ? 'sb-limp-shove' : 'sb-iso';
      if (spot === 'sb-iso') iso = view.currentBet / bb;
    } else if (mine.raisesPreflop === 1 && shoves(view, opp) && opp.raisesPreflop === 1) {
      spot = 'sb-raise-shove';
      raise = view.myBet / bb;
    } else return null;
  } else {
    if (mine.raisesPreflop) return null;
    if (opp.voluntary && opp.raisesPreflop === 0) {
      spot = 'bb-limp';
      if (raiseTo) iso = raiseTo;
    } else return null; // a raise (weighed) or a shove (push/fold, in nash)
  }
  // Raise sizes to the nearest half big blind, so nearby sizes share a solve.
  const half = (x: number) => Math.max(2, Math.round(x * 2) / 2);
  const tree = headsUpTree({ stack: depth, raise: half(raise), iso: half(iso), sbInPosition: !three });
  const h = classOf(view.hole[0], view.hole[1]);
  const priced = tree.price(spot, h);
  if (!priced) return null;

  let move: Move =
    act.type === 'fold' ? (priced.moves.includes('fold') ? 'fold' : 'check')
      : act.type === 'raise' ? (allIn ? 'allin' : 'raise')
        : act.type === 'allin' ? 'allin' : act.type;
  // A raise short of all-in where the tree has none (too little behind to fold): an all-in.
  // Facing a shove, all-in is a call.
  if (move === 'raise' && !priced.moves.includes('raise')) move = 'allin';
  if (move === 'allin' && !priced.moves.includes('allin')) move = 'call';
  if (!priced.moves.includes(move)) return null;

  const ev = priced.ev;
  const best = priced.moves.reduce((x, m) => (ev[m] > ev[x] ? m : x));
  const cost = (ev[best] - ev[move]) * bb;
  const sbFirst = spot === 'sb';
  const word = (m: Move) => (sbFirst && m === 'call' ? 'limping' : gerund[m]);
  const where = three ? 'between the blinds' : 'heads-up';
  const why = `At ${Math.round(depth)} big blinds ${where}, the equilibrium ${mixText(priced.mix, sbFirst, handClass(view))}.`;
  // Facing a shove: the price against the range that shoves here.
  let odds: string | null = null;
  if (spot.endsWith('shove')) {
    const [, eq] = versus(h, priced.reach);
    odds = `You need ${pct(view.toCall / winnablePot(view))} to call; against their equilibrium range (top ${pct(rangeShare(priced.reach))}) you have ${pct(eq)}.`;
  }
  // A flop's worth is the assumption: say so when the choice or the better one sees one.
  const flops = (m: Move) => (m === 'call' && !spot.endsWith('shove')) || m === 'check' || m === 'raise';
  const assumed = flops(move) || flops(best) ? `Assumed: after the flop, out of position keeps ${pct(OOP_REALISE)} of their equity.` : null;
  const read = readTip(opp, 'shove');
  const lines = (costLine: string | null) =>
    compose([[why, P.why], [costLine, P.cost], [odds, P.odds], [read, P.read], [assumed, P.depth]]);

  if (cost <= NASH_EVEN * bb) {
    return {
      verdict: 'good',
      headline: best === move ? `${cap(word(move))} is right.` : `${cap(word(move))} and ${word(best)} are about even.`,
      lines: lines(null),
    };
  }
  const close = cost <= NASH_CLOSE * bb;
  return {
    verdict: close ? 'close' : 'mistake',
    headline: close ? `${cap(word(best))} was worth a little more.` : `${cap(word(best))} would be better here.`,
    lines: lines(`Costs about ${Math.max(1, Math.round(cost))} chips on average, against equilibrium play.`),
  };
}

// Three-handed: the button first in, or a blind facing the button's shove. Shoving and
// calling a shove are priced by the all-in-or-fold equilibrium (pushfold.ts). From the
// button a smaller raise or a limp isn't in that game: it's graded by the standard opening
// range, and the one play both agree on is the one every note names.
function nash(view: BotView, act: Action, rng: () => number): Note | null {
  const t = shortTable(view);
  if (!t) return null;
  const { seats, me, chips, depth, byName } = t;
  const bb = view.bigBlind;
  const sb = bb / 2;
  const voluntary = view.opponents.filter((o) => o.voluntary);
  const h = classOf(view.hole[0], view.hole[1]);
  // Heads-up, or between the blinds: the big blind facing the small blind's shove.
  if (seats.length === 2 || !t.live.has(seats[0].name)) {
    const [s, b] = seats.length === 2 ? [0, 1] : [1, 2];
    if (me !== b || voluntary.length !== 1 || !shoves(view, byName.get(seats[s].name))) return null;
    const game = headsUp(chips[s], chips[b], sb, bb);
    return callNote(view, act, {
      ev: game.callEV(h), range: game.call, from: 'in the big blind', vs: game.push, h,
      read: readTip(byName.get(seats[s].name)!, 'shove'),
    });
  }
  const game = threeHanded(chips[0], chips[1], chips[2], sb, bb);
  const read = view.opponents.map((o) => readTip(o, 'shove')).find((l) => l) ?? null;

  if (me === 0) {
    if (voluntary.length) return null;
    const ev = game.pushEV(h); // chips, against folding
    const fold = [game.sbCall, game.bbCall].reduce((f, r) => f * (1 - versus(h, r)[0]), 1);
    return unopened(view, act, rng, {
      gain: ev,
      even: NASH_EVEN * bb,
      close: NASH_CLOSE * bb,
      why: `At ${Math.round(depth)} big blinds, Nash shoves the top ${pct(rangeShare(game.push))} on the button; ${handClass(view)} ${inIt(view, h, game.push)}.`,
      odds: `If they call like Nash, both blinds fold ${pct(fold)}.`,
      read,
      costLine: (c) => `Costs about ${Math.max(1, Math.round(c))} chips on average, if they call like Nash.`,
    });
  }

  // A blind facing the button's shove.
  if (!shoves(view, byName.get(seats[0].name))) return null;
  const small = byName.get(seats[1].name);
  if (me === 1) {
    if (voluntary.length !== 1) return null;
    return callNote(view, act, { ev: game.sbCallEV(h), range: game.sbCall, from: 'in the small blind', vs: game.push, h, read });
  }
  if (!small) {
    if (voluntary.length !== 1) return null;
    return callNote(view, act, { ev: game.bbCallEV(h), range: game.bbCall, from: 'in the big blind', vs: game.push, h, read });
  }
  if (small.voluntary && small.raisesPreflop === 0) {
    return callNote(view, act, { ev: game.bbOvercallEV(h), range: game.bbOvercall, from: 'in the big blind', vs: null, h, read });
  }
  return null;
}

// "Pocket Twos are in it", for a hand's place in an equilibrium range.
function inIt(view: BotView, h: number, r: Range) {
  const be = rankOf(view.hole[0]) === rankOf(view.hole[1]) ? 'are' : 'is';
  return r[h] >= 0.8 ? `${be} in it` : r[h] <= 0.2 ? `${be}n't in it` : `${be} on its edge`;
}

// Calling a shove or folding, against the push/fold equilibrium. `vs`: the shoving range,
// null when a call is in too (three ways, there's no single price to quote).
function callNote(
  view: BotView, act: Action,
  spot: { ev: number; range: Range; from: string; vs: Range | null; h: number; read: string | null },
): Note | null {
  if (act.type === 'check') return null;
  const bb = view.bigBlind;
  const playing = act.type === 'call' || act.type === 'raise' || act.type === 'allin';
  const cost = Math.max(0, playing ? -spot.ev : spot.ev);
  const why = `Nash calls ${spot.vs ? 'this shove' : 'a shove and a call'} ${spot.from} with the top ${pct(rangeShare(spot.range))}; ${handClass(view)} ${inIt(view, spot.h, spot.range)}.`;
  const odds = spot.vs
    ? `You need ${pct(view.toCall / winnablePot(view))} to call; against Nash's shoving range (top ${pct(rangeShare(spot.vs))}) you have ${pct(versus(spot.h, spot.vs)[1])}.`
    : null;
  const lines = (costLine: string | null) => compose([[why, P.why], [costLine, P.cost], [odds, P.odds], [spot.read, P.read]]);
  if (cost <= NASH_EVEN * bb) {
    const even = Math.abs(spot.ev) <= NASH_EVEN * bb;
    return {
      verdict: 'good',
      headline: even ? 'Calling and folding are about even.' : `${playing ? 'Calling' : 'Folding'} is right.`,
      lines: lines(null),
    };
  }
  const close = cost <= NASH_CLOSE * bb;
  const better = playing ? 'folding' : 'calling';
  return {
    verdict: close ? 'close' : 'mistake',
    headline: close ? `${cap(better)} was worth a little more.` : `${cap(better)} would be better here.`,
    lines: lines(`Costs about ${Math.max(1, Math.round(cost))} chips on average, if they play like Nash.`),
  };
}

// --- grading by expected value ----------------------------------------------------------

const VERB = { fold: 'folding', check: 'checking', call: 'calling', raise: 'raising' };

function chosenOption(a: Analysis, act: Action): Option {
  const kind = act.type === 'allin' ? 'raise' : act.type === 'fold' && !a.options.some((o) => o.kind === 'fold') ? 'check' : act.type;
  if (kind === 'raise') return nearest(a.options.filter((o) => o.kind === 'raise'), (act as { to: number }).to);
  return a.options.find((o) => o.kind === kind) ?? a.options[0];
}

const nearest = (raises: Option[], to: number) =>
  raises.reduce((b, o) => (Math.abs(o.to - to) < Math.abs(b.to - to) ? o : b), raises[0]);

const NEED_TEXT: Record<number, string> = {
  [NEED.pair]: 'a pair', [NEED.secondPair]: 'second pair or better', [NEED.topPair]: 'top pair or better',
  [NEED.twoPair]: 'two pair or better', [NEED.trips]: 'trips or better',
};

// The range a verdict rests on, as the model built it: their stats and their line. Assumed.
function rangeText(view: BotView, a: Analysis, who?: OpponentView): string {
  const i = who ? a.players.indexOf(who) : a.players.length === 1 ? 0 : -1;
  if (i < 0) return 'their ranges (assumed)';
  const r = a.ranges[i];
  const parts = [`their top ${pct(r.top)}`];
  if (view.board.length && r.need !== NEED.none) {
    parts.push(`${NEED_TEXT[r.need]}${r.draws ? ' or a draw' : ''}`);
    if (r.bluff >= 0.05) parts.push(`${pct(r.bluff)} air`);
  }
  return `${parts.join(', ')} (assumed)`;
}

// A decision where the maths can price every option: facing a bet, betting after the flop,
// or any short-stacked spot. Each option's EV comes from the same model the bots use.
function weighed(view: BotView, act: Action, rng: () => number): Note {
  const raiseTo = act.type === 'raise' ? act.to : undefined;
  const a = analyse(view, ITERATIONS, rng, raiseTo, true);
  const preflop = view.board.length === 0;
  const raised = Math.max(0, ...view.opponents.map((o) => o.raisesPreflop));

  const depth = a.short ? `${depthText(view)}: all-in or fold.` : null;
  // How often the hand wins against the ranges their stats and betting suggest (an estimate).
  const have = pct(a.equity);
  const win = winnablePot(view);
  const facer = view.toCall > 0 ? bettor(view) : undefined;
  // Before the flop with nobody raised, the call is only the blind: no price worth quoting.
  const facingBet = view.toCall > 0 && !(preflop && raised === 0);
  let need: string | null = null;
  if (facingBet) {
    const sidePot = view.pot + view.toCall - win;
    need = `You need ${pct(view.toCall / win)} to call; you have about ${have} against ${rangeText(view, a, facer)}.${sidePot > 0 ? ` ${sidePot} is a side pot you can't win.` : ''}`;
  } else if (!(a.short && view.toCall > 0)) {
    // (an unopened shove: the fold and called numbers in the verdict say it all)
    need = `You have about ${have} against ${rangeText(view, a, facer)}.`;
  }

  // Whose tendencies matter: the bettor when facing a bet, else whoever would have to fold.
  const focus = (o: OpponentView) =>
    o === facer ? (view.board.length === 5 && act.type !== 'raise' ? 'bluffs' : act.type === 'raise' ? 'raises' : 'folds') : a.short ? 'shove' : 'folds';
  const candidates = [facer, ...a.players.filter((o) => !o.allIn && o !== facer)].filter((o): o is OpponentView => !!o);
  const read = candidates.map((o) => readTip(o, focus(o))).find((l) => l) ?? null;

  // A reraise before the flop is weighed at the conventional size: until the range it
  // represents depends on its size, a bigger one would only look better for its folds.
  const conv = preflop && raised === 1 && !a.short ? reraiseSize(view) : null;
  const allRaises = a.options.filter((o) => o.kind === 'raise');
  const convOption = conv && allRaises.length ? nearest(allRaises, conv.to) : null;
  const options = convOption ? a.options.filter((o) => o.kind !== 'raise' || o === convOption) : a.options;
  const chosen = chosenOption(a, act);

  // Simulation noise plus slack for the model's assumptions (fold rates, realisation), so
  // near-even spots are called good or close, not wrong.
  const stake = Math.max(win, view.pot, 1);
  const margin = (0.05 + 2 * Math.sqrt((a.equity * (1 - a.equity)) / ITERATIONS)) * stake;
  const aggressive = (o: Option) =>
    o.to === view.maxRaiseTo ? 'going all-in' : view.currentBet === 0 ? 'betting' : 'raising';
  const word = (o: Option) => (o.kind === 'raise' ? aggressive(o) : VERB[o.kind]);
  const sized = (o: Option) => sizeName(view, o.to);

  // A bluff's edge rests on the fold rate, the least certain number here: any bluff after the
  // flop, the hero's or one Coach would suggest, is valued with folds 15 points lower. (Before
  // the flop a shove that loses when called still has real equity: it's not air.)
  const value = (o: Option) => {
    if (o.kind !== 'raise' || !o.bluff || o.pFold === undefined || preflop) return o.ev;
    const whenCalled = o.pFold < 1 ? (o.ev - o.pFold * view.pot) / (1 - o.pFold) : 0;
    const p = Math.max(0, o.pFold - FOLD_UNCERTAINTY);
    return p * view.pot + (1 - p) * whenCalled;
  };
  const best = options.reduce((b, o) => (value(o) > value(b) ? o : b));
  // The right action at a different size is the right action: the size is a tip, not a fault.
  const bestOfKind = (k: Option['kind']) => options.filter((o) => o.kind === k).reduce((b, o) => (value(o) > value(b) ? o : b), chosen);
  const chosenBest = chosen.kind === 'raise' ? (convOption ?? bestOfKind('raise')) : chosen;
  const gap = value(best) - value(chosen.kind === best.kind ? chosenBest : chosen);
  const ratio = chosen.kind === 'raise' ? Math.max(chosen.to / chosenBest.to, chosenBest.to / chosen.to) : 1;

  // Sizing, when betting or raising is the play and one size clearly beats the next.
  const raises = options.filter((o) => o.kind === 'raise').sort((x, y) => x.to - y.to);
  let sizing: string | null = null;
  if (best.kind === 'raise' && raises.length > 1 && !a.short && !conv) {
    const i = raises.indexOf(best);
    const next = [raises[i - 1], raises[i + 1]].filter((o): o is Option => !!o);
    if (next.every((o) => value(best) - value(o) > margin)) {
      const outcome = best.bluff
        ? `they fold about ${pct(best.pFold!)}`
        : `they fold about ${pct(best.pFold!)}; called, you win about ${pct(best.eCalled!)}`;
      sizing = `Best size is ${sized(best)}, against their fold rates so far: ${outcome}.`;
    }
  }
  const lines = (why: string | null, cost: string | null, odds: string | null = null) =>
    compose([[why, P.why], [sizing, P.size], [cost, P.cost], [need, P.need], [odds, P.odds], [depth, P.depth], [read, P.read]]);
  const short = a.short && chosen.kind === 'raise' && chosen.to === view.maxRaiseTo;

  // The right action at a size far from the right one (half again or more either way).
  if (gap <= margin && chosen.kind === 'raise' && best.kind === 'raise' && ratio >= OVERSIZE && !a.short) {
    const bigger = chosen.to > chosenBest.to;
    if (conv) {
      return {
        verdict: ratio >= OVERSIZE_MISTAKE ? 'mistake' : 'close',
        headline: conv.to === view.maxRaiseTo ? 'Raising is right, but all-in is the size.' : `Raising is right, but ${bigger ? 'smaller' : 'bigger'}.`,
        lines: lines(conv.line, null),
      };
    }
    // Measured against the pot the best raise makes: before the flop the blinds alone would
    // make a few chips look like a lot.
    const sizeGap = value(chosenBest) - value(chosen);
    const raisedPot = view.pot + chosenBest.to - view.myBet;
    if (sizeGap > margin && sizeGap > 0.1 * raisedPot) {
      return {
        verdict: sizeGap > 0.25 * raisedPot && ratio >= OVERSIZE_MISTAKE ? 'mistake' : 'close',
        headline: `${cap(word(chosenBest))} is right, but ${bigger ? 'smaller' : 'bigger'}.`,
        lines: lines(preflop ? depthSizing(view) : null, `Costs about ${Math.round(sizeGap)} chips on average.`),
      };
    }
  }

  // Calling or folding before the river: what a call needs from later streets when it hits.
  const implied = facingBet && view.board.length < 5 && !a.short && (chosen.kind === 'call' || best.kind === 'call') ? impliedOdds(view) : null;

  if (gap <= margin) {
    if (short) {
      return { verdict: 'good', headline: 'All-in is right.', lines: lines(`They fold about ${pct(chosen.pFold!)}; called, you win about ${pct(chosen.eCalled!)}.`, null) };
    }
    if (chosen.kind === 'raise' && chosen.bluff) {
      return { verdict: 'good', headline: 'A good bluff.', lines: lines(sizing ? null : `They fold about ${pct(chosen.pFold!)}, enough to pay even if it's 15 points fewer.`, null) };
    }
    const headline = chosen.kind === 'raise' && conv && ratio < OVERSIZE
      ? 'Raising is right.'
      : chosenBest === best ? `${cap(word(chosen))} is the best play.` : `${cap(word(chosen))} is as good as anything here.`;
    return { verdict: 'good', headline, lines: lines(conv && chosen.kind === 'raise' ? conv.line : null, null, implied?.line) };
  }
  const why = best.kind === 'raise' && best.bluff
    ? `As a bluff: they fold about ${pct(best.pFold!)}, enough even if it's 15 points fewer.`
    : best.kind === 'raise'
      ? `Worse hands call: ${aggressive(best)} wins more.`
      : chosen.kind === 'raise' && chosen.bluff
        ? `A bluff here needs more folds than their ${pct(chosen.pFold!)}, less 15 points for the doubt.`
        : null;
  // Close: gives up less than 10% of the pot at stake, or takes a profitable passive line
  // before the river where a raise scores higher, or calls a draw whose implied odds can
  // still pay. While streets remain, the model doesn't count what a call or check wins later
  // (a slowplayed hand, a draw that hits), so it doesn't grade those a mistake.
  const slowplay =
    view.board.length < 5 && (chosen.kind === 'call' || chosen.kind === 'check') &&
    best.kind === 'raise' && chosenBest.ev > 0;
  const paidLater = !!implied && chosen.kind === 'call' && implied.need <= implied.behind;
  const close = gap <= 0.1 * stake || slowplay || paidLater;
  const verdict: Verdict = close ? 'close' : 'mistake';
  return {
    verdict,
    headline: verdict === 'close' ? `${cap(word(best))} was worth more.` : `${cap(word(best))} would be better here.`,
    lines: lines(why, `Costs about ${Math.round(gap)} chips on average.`, implied?.line),
  };
}

// --- implied odds -------------------------------------------------------------------------

// What a call that misses its price now needs to win on later streets when it hits:
// call ÷ P(hit) − pot − call. Exact given the hit chance, which is counted: a pocket pair
// flopping a set, or a draw making a straight or better on the next card. Assumes a call only
// wins when it hits. Null for other hands, or when the price alone pays.
function impliedOdds(view: BotView): { need: number; behind: number; line: string } | null {
  const call = view.toCall;
  let p: number;
  let hit: string;
  if (view.board.length === 0) {
    if (rankOf(view.hole[0]) !== rankOf(view.hole[1])) return null;
    p = SET_ODDS;
    hit = `a set flops ${pct(p, 1)} of the time`;
  } else {
    if (!hasDraw(view.hole, view.board)) return null;
    const unseen = remainingDeck([...view.hole, ...view.board]);
    const cat = (cards: number[]) => categoryOf(evaluate(cards));
    const outs = unseen.filter((c) => {
      const mine = cat([...view.hole, ...view.board, c]);
      return mine >= STRAIGHT && mine > cat([...view.board, c]);
    }).length;
    if (!outs) return null;
    p = outs / unseen.length;
    hit = `a straight or better on ${outs} of ${unseen.length} next cards (${pct(p, 1)})`;
  }
  const need = call / p - view.pot - call;
  if (need <= 0) return null;
  const opener = bettor(view);
  const behind = Math.min(view.maxRaiseTo - view.myBet - call, opener ? opener.stack : Infinity);
  return {
    need,
    behind,
    line: `Implied odds: ${hit}; a call needs ${Math.round(need)} more when you hit; ${behind} is behind.`,
  };
}

// --- stack depth ------------------------------------------------------------------------

// "18 big blinds effective", and whose stack sets it when the stacks differ.
function depthText(view: BotView): string {
  const eff = effectiveBB(view);
  const mine = view.maxRaiseTo / view.bigBlind;
  const whose = mine > eff + 0.5 ? ' (their stack)' : mine < eff - 0.5 ? ' (your stack)' : '';
  return `${Math.round(eff)} big blinds effective${whose}`;
}

// Before the flop, what the stack depth says about raise sizes.
function depthSizing(view: BotView): string | null {
  const eff = effectiveBB(view);
  if (view.currentBet <= view.bigBlind) {
    const [lo, hi] = openSize(eff);
    return `At ${Math.round(eff)} big blinds a standard open is ${lo}–${hi} BB.`;
  }
  return reraiseSize(view).line;
}

// The conventional reraise: about 3× the raise in position and 4× out of position; up to 25
// big blinds it commits most of the stack, so it's all-in. A convention of the game, not maths.
function reraiseSize(view: BotView): { to: number; line: string } {
  const eff = effectiveBB(view);
  if (eff <= RESHOVE_BB) {
    return { to: view.maxRaiseTo, line: `At ${Math.round(eff)} big blinds a reraise commits you: all-in is the size.` };
  }
  const to = sizeTo(view, view.currentBet * (view.inPosition ? 3 : 4));
  return {
    to,
    line: `A reraise is about 3× in position and 4× out of position, by convention: here ${to === view.maxRaiseTo ? 'all-in' : `to ${to}`}.`,
  };
}

// --- bet sizes ----------------------------------------------------------------------------

const FRACTIONS: [number, string][] = [
  [0.25, '¼ pot'], [1 / 3, '⅓ pot'], [0.5, '½ pot'], [2 / 3, '⅔ pot'], [0.75, '¾ pot'], [1, 'pot'], [1.5, '1.5× pot'], [2, '2× pot'],
];

// A size as players say it: "⅔ pot (60)" for a bet after the flop, "3 BB" for an open.
export function sizeName(view: BotView, to: number): string {
  if (to === view.maxRaiseTo) return `all-in (${to})`;
  if (view.currentBet === 0 && view.board.length > 0) {
    const f = to / Math.max(1, view.pot);
    const named = FRACTIONS.find(([x]) => Math.abs(f - x) < 0.04);
    return `${named ? named[1] : `${Math.round(f * 100)}% pot`} (${to})`;
  }
  if (view.board.length === 0 && view.currentBet <= view.bigBlind) return `${+(to / view.bigBlind).toFixed(1)} BB (${to})`;
  return `a raise to ${to}`;
}

// --- before the flop, unopened ----------------------------------------------------------

function spotText(plan: PreflopPlan) {
  const r = Math.round(plan.raiseRange * 100);
  const c = Math.round(plan.callRange * 100);
  return plan.spot === 'unopened'
    ? `A standard range opens the top ${r}% from your seat.`
    : `With limpers in, a standard range raises the top ${r}%${c > r ? ` and calls the top ${c}%` : ''}.`;
}

// How an open compares with the standard size at this depth. Lines only when it's well over:
// the depth's standard, and the folds each size needs to pay as a steal (risk ÷ (risk + pot), exact).
function openSizing(view: BotView, to: number): { over: number; lines: string[] } {
  const bb = view.bigBlind;
  const limpers = view.opponents.filter((o) => o.voluntary && o.raisesPreflop === 0).length;
  const eff = effectiveBB(view);
  const [lo, hi] = openSize(eff);
  const top = Math.round((hi + limpers) * bb);
  const over = to / top;
  if (over < OVERSIZE) return { over, lines: [] };
  const needs = (t: number) => pct((t - view.myBet) / (t - view.myBet + view.pot));
  return {
    over,
    lines: [
      `At ${Math.round(eff)} big blinds a standard open is ${lo}–${hi} BB${limpers ? ', plus 1 BB a limper' : ''}.`,
      `${cap(sizeName(view, to))} needs ${needs(to)} folds to pay as a steal; ${sizeName(view, top)} needs ${needs(top)}.`,
    ],
  };
}

const PLAY = { raise: 'raising', call: 'calling', check: 'checking', fold: 'folding' };

// Shoving, priced against folding (or checking), in an unopened pot short enough that a
// shove is a real option.
interface Shove {
  gain: number; // chips, against the passive option
  even: number; // within this many chips either way, about even
  close: number; // giving up at most this many is close
  why: string | null;
  odds: string | null;
  read: string | null;
  costLine: (c: number) => string;
}

// The shove priced by the model the bots use, against their fold rates so far.
function pricedShove(view: BotView, rng: () => number): Shove | null {
  const a = analyse(view, ITERATIONS, rng, view.maxRaiseTo, true);
  const shove = a.options.find((o) => o.kind === 'raise' && o.to === view.maxRaiseTo);
  const passive = a.options.find((o) => o.kind === 'fold' || o.kind === 'check');
  if (!shove || !passive) return null;
  // Simulation noise on what's risked, and the slack weighed() gives near-even spots.
  const even = Math.max(NASH_EVEN * view.bigBlind, 2 * Math.sqrt((a.equity * (1 - a.equity)) / ITERATIONS) * view.maxRaiseTo);
  return {
    gain: shove.ev - passive.ev,
    even,
    close: even + NASH_CLOSE * view.bigBlind,
    why: `${depthText(view)}: shoved, they fold about ${pct(shove.pFold!)}; called, you win about ${pct(shove.eCalled!)}.`,
    odds: null,
    read: a.players.filter((o) => !o.allIn).map((o) => readTip(o, 'shove')).find((l) => l) ?? null,
    costLine: (c) => `Costs about ${Math.max(1, Math.round(c))} chips on average, against their fold rates so far.`,
  };
}

// No price to compare yet, so grade against a standard opening range for the seat,
// widened or narrowed by how loose the players still to act have been. The cost comes from
// pricing the chart's play and the hero's with the model, when it agrees the chart's is better.
// Up to OPEN_SHOVE_BB, shoving is priced too (`shove`, by default with the model), and every
// note names the same play: the chart's open, else a shove that pays, else the chart's.
function unopened(view: BotView, act: Action, rng: () => number, shove?: Shove | null): Note {
  const plan = preflopPlan(view);
  let steal: string | null = null;
  if (Math.abs(plan.steal - 1) >= 0.1) {
    const behind = view.opponents.filter((o) => !o.acted);
    const vpip = behind.reduce((s, o) => s + o.read.vpip.rate, 0) / behind.length;
    const avg = view.me.read.prior.vpip;
    steal = plan.steal > 1
      ? `Players behind are tight (${pct(vpip)} of hands, table average ${pct(avg)}): open wider.`
      : `Players behind are loose (${pct(vpip)} of hands, table average ${pct(avg)}): open tighter.`;
  }
  const eff = effectiveBB(view);
  if (shove === undefined) shove = eff <= OPEN_SHOVE_BB ? pricedShove(view, rng) : null;
  const allIn = !!shove && act.type === 'raise' && act.to === view.maxRaiseTo;
  // The chart's open is a raise short of all-in; with too little behind for one, it's a shove.
  const canOpen = sizeTo(view, openSize(eff)[0] * view.bigBlind) < view.maxRaiseTo;
  const want: PreflopPlan['action'] =
    plan.action === 'raise' && !canOpen ? (view.toCall ? 'fold' : 'check') : plan.action;
  const shoves = !!shove && shove.gain > shove.even;
  const best = want === 'raise' ? 'raising' : shoves ? 'shoving' : PLAY[want];

  const did = actionLevel(act.type);
  const doing = PLAY[act.type as keyof typeof PLAY];
  // An open far over the standard size for the stack depth: it risks more to win the same blinds.
  const to = act.type === 'raise' && !allIn ? act.to : 0;
  const size = to ? openSizing(view, to) : null;
  const lines = (cost: string | null) =>
    compose([
      [strength(view), P.why], [spotText(plan), P.why], [cost, P.cost], [shove?.why, P.odds], [steal ?? shove?.read, P.read],
      [size?.lines[0], P.size], [size?.lines[1], P.size],
    ]);
  const shoveLines = (cost: string | null) =>
    compose([[shove!.why, P.why], [cost, P.cost], [shove!.odds, P.odds], [spotText(plan), P.need], [shove!.read, P.read]]);
  const byCost = (c: number): Note => ({
    verdict: c <= shove!.close ? 'close' : 'mistake',
    headline: c <= shove!.close ? `${cap(best)} was worth a little more.` : `${cap(best)} would be better here.`,
    lines: shoveLines(shove!.costLine(c)),
  });

  if (allIn) {
    if (shove!.gain >= -shove!.even) {
      const even = !shoves && best !== 'raising';
      return { verdict: 'good', headline: even ? `Shoving and ${best} are about even.` : 'Shoving is right.', lines: shoveLines(null) };
    }
    return byCost(-shove!.gain);
  }
  // Passing up a shove that pays, where the chart has no open to offer instead. Its gain is
  // over folding: a limp the chart allows has a worth of its own, unpriced, so only close.
  if (shoves && want !== 'raise' && did <= actionLevel(want)) {
    if (did === 0) return byCost(shove!.gain);
    return { verdict: 'close', headline: 'Shoving was worth a little more.', lines: shoveLines(null) };
  }

  if (did === actionLevel(want) && size && size.over >= OVERSIZE) {
    return {
      verdict: size.over >= OVERSIZE_MISTAKE ? 'mistake' : 'close',
      headline: `Raising is right, but ${sizeName(view, to)} is too big.`,
      lines: lines(null),
    };
  }
  if (did === actionLevel(want)) return { verdict: 'good', headline: `${cap(doing)} is right here.`, lines: lines(null) };

  const a = analyse(view, ITERATIONS, rng, to || undefined, true);
  const raises = a.options.filter((o) => o.kind === 'raise');
  const passive = (k: string) => a.options.find((o) => o.kind === k) ?? a.options.find((o) => o.kind === 'check');
  const priced = (k: string, at?: number) =>
    k === 'raise' ? (raises.length ? (at ? nearest(raises, at) : raises[0]) : undefined) : passive(k);
  const chart = priced(want);
  const mine = priced(act.type === 'allin' ? 'raise' : act.type, to);
  const cost = chart && mine && !shoves ? chart.ev - mine.ev : 0;
  const costLine = cost >= 1 ? `Costs about ${Math.round(cost)} chips on average, against their fold rates so far.` : null;

  // Near the boundary between the two choices, either is defensible.
  const edge = Math.max(did, actionLevel(want)) === 2 ? plan.raiseRange : plan.callRange;
  const near = edge > 0 && Math.abs(plan.pct - edge) < 0.05;
  return {
    verdict: near ? 'close' : 'mistake',
    headline: near ? `Borderline. ${cap(best)} is slightly better.` : `${cap(best)} would be better here.`,
    lines: lines(costLine),
  };
}
