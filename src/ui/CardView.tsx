import { RANK_CHARS, SUIT_SYMBOLS, rankOf, suitOf, type Card } from '../engine/cards';

interface Props {
  card?: Card;
  hidden?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  dim?: boolean;
  highlight?: boolean;
  delay?: number; // ms before the deal animation starts
  animate?: 'deal' | 'flip' | 'none';
}

// Face and back sit on either side of one element; flipping `hidden` turns it over.
export function CardView({ card, hidden, size = 'md', dim, highlight, delay = 0, animate = 'deal' }: Props) {
  if (card === undefined) return <div className={`card card-${size} card-slot`} />;
  const r = RANK_CHARS[rankOf(card)];
  const rank = r === 'T' ? '10' : r;
  const s = suitOf(card);
  const tone = s === 1 || s === 2 ? 'red' : 'black';
  return (
    <div
      className={['card', `card-${size}`, animate !== 'none' && `anim-${animate}`, dim && 'dim', highlight && 'highlight']
        .filter(Boolean)
        .join(' ')}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`card-inner ${hidden ? 'flipped' : ''}`} style={{ animationDelay: `${delay}ms` }}>
        <div className={`card-face ${tone}`}>
          <span className="corner">
            {rank}
            <br />
            {SUIT_SYMBOLS[s]}
          </span>
          <span className="pip">{SUIT_SYMBOLS[s]}</span>
        </div>
        <div className="card-face card-back" />
      </div>
    </div>
  );
}

export function CardRow({ cards }: { cards: Card[] }) {
  return (
    <span className="card-row">
      {cards.map((c) => (
        <CardView key={c} card={c} size="xs" animate="none" />
      ))}
    </span>
  );
}
