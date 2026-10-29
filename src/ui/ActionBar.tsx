import { useEffect, useRef, useState } from 'react';
import { ordinal, type Action, type TableState } from '../engine/game';
import { CardView } from './CardView';
import { inBB, money, type Unit } from './units';

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA';
};

interface Props {
  game: TableState;
  onAct: (a: Action) => void;
  onLeave: () => void;
  onNext?: () => void; // Spin & Go: another spin in the same session
  onShow?: (cards: number[]) => void; // head to head: show hole cards after the hand
  unit: Unit;
}

export function ActionBar({ game, onAct, onLeave, onNext, onShow, unit }: Props) {
  const heroTurn = game.phase === 'betting' && game.toAct === 0;
  const l = game.legal(0);
  const [amount, setAmount] = useState(l.minRaiseTo);
  const sizing = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (heroTurn) setAmount(l.minRaiseTo);
  }, [heroTurn, l.minRaiseTo]);

  const to = Math.min(Math.max(amount, l.minRaiseTo), l.maxRaiseTo);
  const canRaise = l.canRaise && l.toCall < game.hero.stack;
  // One big blind up or down, from the − / + buttons or the mouse wheel over the bet controls.
  const nudge = (dir: 1 | -1) => setAmount(Math.min(Math.max(to + dir * game.bigBlind, l.minRaiseTo), l.maxRaiseTo));

  // A wheel listener that can stop the page scrolling (React's onWheel is passive).
  useEffect(() => {
    const el = sizing.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  const handOver = game.phase === 'handOver' || game.phase === 'idle';

  // F fold · C check/call · R raise
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (heroTurn && k === 'f' && !l.canCheck) onAct({ type: 'fold' });
      else if (heroTurn && k === 'c') onAct({ type: l.canCheck ? 'check' : 'call' });
      else if (heroTurn && k === 'r' && canRaise) onAct({ type: 'raise', to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (handOver && game.finished) {
    const place = game.hero.place!;
    return (
      <div className="action-bar">
        <span className="finish">
          {game.entrants === 2
            ? place === 1
              ? 'You won'
              : `${game.players.find((p) => p.place === 1)?.name} won`
            : place === 1
              ? 'You won the tournament'
              : `You finished ${ordinal(place)} of ${game.entrants}`}
        </span>
        <span className="spacer" />
        <button className="btn-raise" onClick={onNext ?? onLeave}>
          {onNext ? 'Next spin' : 'New game'}
        </button>
      </div>
    );
  }

  // The next hand deals on its own. Head to head, until it does, either player may show their cards.
  if (handOver) {
    const hole = game.hero.hole;
    const faceUp = game.result?.revealed.includes(0);
    const hidden = onShow && hole.length === 2 && !faceUp ? [0, 1].filter((i) => !game.hero.shown?.[i]) : [];
    return (
      <div className="action-bar waiting show-cards">
        {hidden.map((i) => (
          <button key={i} onClick={() => onShow!([i])}>
            Show <CardView card={hole[i]} size="xs" animate="none" />
          </button>
        ))}
        {hidden.length === 2 && <button onClick={() => onShow!([0, 1])}>Show both</button>}
      </div>
    );
  }

  if (!heroTurn) {
    const p = game.players[game.toAct];
    return (
      <div className="action-bar waiting">
        <span className="muted">
          {game.phase === 'runout' ? 'All-in · running the board' : game.hero.folded ? `Folded · ${p?.name ?? ''} to act` : `${p?.name ?? ''} to act`}
        </span>
      </div>
    );
  }

  const opening = game.currentBet === 0;
  const bb = game.bigBlind;
  const m = (chips: number) => money(chips, unit, bb);
  // Type an amount (or drag the slider) and press Enter to bet it.
  const placeOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAct({ type: 'raise', to });
    }
  };
  const clamp = (chips: number) => Math.min(l.maxRaiseTo, Math.max(l.minRaiseTo, Math.round(chips)));
  // A raise of a share of the pot: call first, then that share of the pot after the call.
  const ofPot = (frac: number) => game.currentBet + (game.pot + l.toCall) * frac;
  const cb = game.currentBet;
  // Sizes as GG offers them: big blinds to open, multiples of the bet to reraise preflop,
  // shares of the pot after the flop. A size under the minimum raise or over the stack isn't
  // offered; all-in always is.
  const sizes: [string, number][] =
    game.street !== 'preflop'
      ? [['33%', ofPot(1 / 3)], ['50%', ofPot(0.5)], ['75%', ofPot(0.75)], ['Pot', ofPot(1)]]
      : cb <= bb
        ? [['2 BB', 2 * bb], ['2.5 BB', 2.5 * bb], ['3 BB', 3 * bb], ['Pot', ofPot(1)]]
        : [['2.5x', 2.5 * cb], ['3x', 3 * cb], ['4x', 4 * cb], ['Pot', ofPot(1)]];
  const presets = [
    ...sizes.map(([k, v]): [string, number] => [k, Math.round(v)]).filter(([, v]) => v >= l.minRaiseTo && v < l.maxRaiseTo),
    ['All-in', l.maxRaiseTo] as [string, number],
  ].filter(([, v], i, all) => all.findIndex(([, w]) => w === v) === i);
  // The slider moves in small blinds from the minimum, and its far end is always all-in.
  const fromSlider = (v: number) =>
    v >= l.maxRaiseTo ? l.maxRaiseTo : clamp(l.minRaiseTo + Math.round((v - l.minRaiseTo) / game.smallBlind) * game.smallBlind);
  const fill = ((to - l.minRaiseTo) / Math.max(1, l.maxRaiseTo - l.minRaiseTo)) * 100;

  return (
    <div className="action-bar your-turn">
      {canRaise && (
        <div className="sizing" ref={sizing}>
          <div className="presets">
            {presets.map(([label, v]) => (
              <button key={label} className={v === to ? 'on' : ''} onClick={() => setAmount(v)}>
                {label}
              </button>
            ))}
            <input
              type="number"
              className="amount"
              min={unit === 'bb' ? inBB(l.minRaiseTo, bb) : l.minRaiseTo}
              max={unit === 'bb' ? inBB(l.maxRaiseTo, bb) : l.maxRaiseTo}
              step={unit === 'bb' ? 0.5 : 1}
              value={unit === 'bb' ? inBB(amount, bb) : amount}
              onChange={(e) => setAmount(unit === 'bb' ? Math.round(Number(e.target.value) * bb) : Number(e.target.value))}
              aria-label={unit === 'bb' ? 'Amount in big blinds' : 'Amount in chips'}
              onKeyDown={placeOnEnter}
            />
          </div>
          <div className="slider-row">
            <button className="nudge" onClick={() => nudge(-1)} disabled={to <= l.minRaiseTo} aria-label="One big blind less">
              −
            </button>
            <input
              type="range"
              className="bet-slider"
              min={l.minRaiseTo}
              max={l.maxRaiseTo}
              step={1}
              value={to}
              style={{ '--fill': `${fill}%` } as React.CSSProperties}
              onChange={(e) => setAmount(fromSlider(Number(e.target.value)))}
              onKeyDown={placeOnEnter}
              aria-label="Bet size"
            />
            <button className="nudge" onClick={() => nudge(1)} disabled={to >= l.maxRaiseTo} aria-label="One big blind more">
              +
            </button>
          </div>
        </div>
      )}
      <div className="main-actions">
        {!l.canCheck && (
          <button className="btn-fold" onClick={() => onAct({ type: 'fold' })}>
            Fold <kbd>F</kbd>
          </button>
        )}
        <button className="btn-call" onClick={() => onAct({ type: l.canCheck ? 'check' : 'call' })}>
          {l.canCheck ? 'Check' : l.toCall >= game.hero.stack ? `Call all-in ${m(l.toCall)}` : `Call ${m(l.toCall)}`}{' '}
          <kbd>C</kbd>
        </button>
        {canRaise && (
          <button className="btn-raise" onClick={() => onAct({ type: 'raise', to })}>
            {to === l.maxRaiseTo ? `All-in ${m(to)}` : `${opening ? 'Bet' : 'Raise to'} ${m(to)}`} <kbd>R</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
