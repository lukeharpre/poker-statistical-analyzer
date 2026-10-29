import { useState } from 'react';
import type { HandRecord } from '../engine/game';
import { CardRow } from './CardView';

const STREET_NAME = { preflop: 'preflop', flop: 'on the flop', turn: 'on the turn', river: 'on the river' };

export function HandLog({ history }: { history: HandRecord[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (history.length === 0) return <p className="muted">No hands yet.</p>;
  const current = history[history.length - 1];
  // The hand in play stays open until another is picked.
  const openNumber = open ?? (current.result === null ? current.number : null);

  return (
    <div className="hand-log">
      {[...history].reverse().map((h) => {
        const isOpen = openNumber === h.number;
        const net = h.heroNet;
        return (
          <div key={h.number} className={`hand-row ${isOpen ? 'open' : ''}`}>
            <button className="hand-summary" onClick={() => setOpen(isOpen ? -1 : h.number)} aria-expanded={isOpen}>
              <span className="hand-no">#{h.number}</span>
              <CardRow cards={h.heroHole} />
              <span className="hand-board">{h.board.length > 0 && <CardRow cards={h.board} />}</span>
              <span className={`hand-net ${net === null ? '' : net > 0 ? 'up' : net < 0 ? 'down' : ''}`}>
                {net === null ? 'In play' : net > 0 ? `+${net}` : net < 0 ? `−${-net}` : '0'}
              </span>
              <span className="hand-result">
                {h.heroFolded ? `You folded ${STREET_NAME[h.heroFolded]} · ` : ''}
                {h.result ?? ''}
              </span>
            </button>
            {isOpen && (
              <ul className="hand-lines">
                {h.lines.map((l, i) => (
                  <li key={i} className={l.startsWith('Coach:') ? 'coach-line' : /^(Flop|Turn|River):/.test(l) ? 'street-line' : ''}>
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
