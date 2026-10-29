import { useEffect, useRef } from 'react';
import { ordinal, type TableState } from '../engine/game';
import { describe, evaluate } from '../engine/evaluator';
import { CardView } from './CardView';
import { ChipStack } from './ChipStack';
import { money, type Unit } from './units';

const DEAL_STEP = 60;
// Felt width at which seats, bets and tags show at full size; smaller felts scale them down
// with the cards, so the top seat never lands on the pot.
const FULL_FELT_PX = 820;
const MIN_SCALE = 0.6;
const SEAT_RX = 46;
const SEAT_RY = 43;

// Seats sit on an ellipse, hero at the bottom, action running clockwise.
function seatPoint(i: number, n: number, rx: number, ry: number) {
  const a = ((90 + (i * 360) / n) * Math.PI) / 180;
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

interface Props {
  game: TableState;
  unit: Unit;
  onUnit: () => void; // the hero clicked their stack
}

export function Table({ game, unit, onUnit }: Props) {
  const n = game.players.length;
  const m = (chips: number) => money(chips, unit, game.bigBlind);
  const felt = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = felt.current;
    if (!el) return;
    const fit = () => {
      const s = Math.min(1, Math.max(MIN_SCALE, el.clientWidth / FULL_FELT_PX));
      el.style.setProperty('--ui-scale', s.toFixed(3));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);
  const showHands = new Set(
    game.result?.revealed ??
      (game.phase === 'runout' ? game.players.filter((p) => !p.folded).map((p) => p.id) : []),
  );
  const hero = game.hero;
  const heroHand =
    hero.hole.length && game.board.length >= 3 && !hero.folded
      ? describe(evaluate([...hero.hole, ...game.board]))
      : null;
  const dealOrder = (id: number) => (id - game.button - 1 + n) % n;
  const winningHand = (id: number) => game.result?.pots.find((p) => p.winners.includes(id) && p.hand)?.hand;

  return (
    <div className="table-wrap">
      <div className="felt" ref={felt}>
        <div className="rail-line" />
        <div className="center">
          <span className="pot-label" key={game.pot}>
            {game.phase !== 'idle' && game.pot > 0 ? `Pot ${m(game.pot)}` : ''}
          </span>
          <div className="board">
            {Array.from({ length: 5 }, (_, i) => (
              <CardView
                key={game.board[i] ?? `slot-${i}`}
                card={game.board[i]}
                size="lg"
                animate="flip"
                delay={i < 3 ? i * 140 : 0}
              />
            ))}
          </div>
          {game.phase !== 'idle' && game.pot > 0 && !game.result && (
            <div className="pot">
              {/* chips already pulled in; this street's bets still sit in front of the players */}
              <ChipStack amount={game.pot - game.players.reduce((s, p) => s + p.bet, 0)} />
            </div>
          )}
          {game.result && (
            <div className="result-banner" key={game.handNumber}>
              {game.result.pots.map((p, i) => (
                <div key={i}>
                  {game.result!.pots.length > 1 && <span className="muted">{p.label} · </span>}
                  <b>{p.winners.map((id) => game.players[id].name).join(' & ')}</b>{' '}
                  {p.winners.length > 1 ? 'split' : p.winners[0] === 0 ? 'win' : 'wins'} {m(p.amount)}
                  {p.hand && <span className="muted"> · {p.hand}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {game.result &&
          Object.entries(game.result.winnings).map(([id, amount]) => {
            const to = seatPoint(Number(id), n, SEAT_RX, SEAT_RY);
            return (
              <div
                key={`${game.handNumber}-sweep-${id}`}
                className="sweep"
                style={{ '--x': `${to.x}%`, '--y': `${to.y}%` } as React.CSSProperties}
              >
                <ChipStack amount={amount} />
              </div>
            );
          })}

        {game.players.map((p, i) => {
          const seat = seatPoint(i, n, SEAT_RX, SEAT_RY);
          // Upper seats sit further from the board, so their bets come in a little less.
          const bet = seatPoint(i, n, 30, seat.y < 50 ? 29 : 20);
          if (p.out && p.place === null) return null; // an empty seat
          const won = game.result?.winnings[p.id];
          const reveal = p.isHuman || showHands.has(p.id);
          const acting = game.toAct === p.id;
          const showCards = p.hole.length > 0 && (!p.folded || p.isHuman || !!p.shown?.some(Boolean));
          return (
            <div key={p.id}>
              <div
                className={['seat', p.isHuman && 'hero', acting && 'acting', p.folded && 'folded', p.shown?.some(Boolean) && 'showing', p.out && 'out', won && 'winner', showHands.has(p.id) && 'shown']
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: `${seat.x}%`, top: `${seat.y}%` }}
              >
                <div className="seat-cards">
                  {showCards &&
                    p.hole.map((c, ci) => (
                      <CardView
                        key={`${game.handNumber}-${ci}`}
                        card={c}
                        hidden={!reveal && !p.shown?.[ci]}
                        size={p.isHuman ? 'lg' : 'md'}
                        dim={p.folded && !p.shown?.[ci]}
                        animate={p.isHuman ? 'flip' : 'deal'}
                        delay={(dealOrder(p.id) + ci * n) * DEAL_STEP}
                      />
                    ))}
                </div>
                <div className="seat-info">
                  {/* Pinned to the name pill so it can never sit under anyone's cards. */}
                  {game.button === p.id && game.phase !== 'idle' && (
                    <div className="dealer-puck" key={game.handNumber}>
                      D
                    </div>
                  )}
                  <div className="avatar">{p.name[0]}</div>
                  <div className="seat-text">
                    <div className="seat-name">{p.name}</div>
                    {p.out ? (
                      <div className="seat-stack">Out · {ordinal(p.place!)}</div>
                    ) : p.isHuman ? (
                      <button className="seat-stack stack-toggle" onClick={onUnit}>
                        {m(p.stack)}
                      </button>
                    ) : (
                      <div className="seat-stack">{m(p.stack)}</div>
                    )}
                  </div>
                </div>
                <div className="seat-action" key={`${game.handNumber}-${p.lastAction}-${!!won}`}>
                  {won ? (
                    <span className="win-tag">
                      Win {m(won)}
                      {winningHand(p.id) && <span className="win-hand"> · {winningHand(p.id)}</span>}
                    </span>
                  ) : p.isHuman && heroHand ? (
                    <span className="hand-name">{heroHand}</span>
                  ) : (
                    p.lastAction && (
                      <span className={`pill act-${p.lastAction.split(' ')[0].toLowerCase()}`}>
                        {p.lastAction.replace(/\d+$/, (n) => m(Number(n)))}
                      </span>
                    )
                  )}
                </div>
              </div>
              {p.bet > 0 && (
                <div className="bet" key={`${game.street}-${p.bet}`} style={{ left: `${bet.x}%`, top: `${bet.y}%` }}>
                  <ChipStack amount={p.bet} />
                  <span className="bet-label">{m(p.bet)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
