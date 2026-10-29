import type { CoachNote } from '../engine/coach';

const VERDICT_LABEL = { good: 'Good', close: 'Close', mistake: 'Mistake' };

// An original cartoon coach: cap, whistle, clipboard grin.
function CoachAvatar() {
  return (
    <svg className="coach-avatar" viewBox="0 0 80 80" aria-hidden="true">
      <circle cx="40" cy="40" r="39" fill="#1d2b25" stroke="#e8b54d" strokeWidth="2" />
      {/* shoulders + shirt */}
      <path d="M14 78c2-14 13-21 26-21s24 7 26 21" fill="#2f6f8f" />
      <path d="M33 58l7 8 7-8" fill="none" stroke="#f4efe2" strokeWidth="2.5" strokeLinejoin="round" />
      {/* lanyard + whistle */}
      <path d="M30 59c2 8 6 12 10 14M50 59c-2 8-6 12-10 14" fill="none" stroke="#e66a5c" strokeWidth="1.6" />
      <rect x="36" y="70" width="9" height="5" rx="2.5" fill="#cfd6d2" />
      {/* face */}
      <ellipse cx="40" cy="38" rx="15" ry="17" fill="#e7b48f" />
      <ellipse cx="25" cy="39" rx="3" ry="4.5" fill="#d9a07b" />
      <ellipse cx="55" cy="39" rx="3" ry="4.5" fill="#d9a07b" />
      {/* cap */}
      <path d="M24 31c0-11 7-17 16-17s16 6 16 17z" fill="#e8b54d" />
      <path d="M40 31c8 0 18 1 22 4-6 1-14 1-22-1z" fill="#c99634" />
      <circle cx="40" cy="15" r="2" fill="#c99634" />
      {/* eyes, brows, smile */}
      <circle cx="34" cy="38" r="1.9" fill="#1b1b1b" />
      <circle cx="46" cy="38" r="1.9" fill="#1b1b1b" />
      <path d="M31 34.5l5-1M44 33.5l5 1" stroke="#6b4a33" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M34 46c3 3 9 3 12 0" fill="none" stroke="#6b4a33" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M33 50c4 2 10 2 14 0" fill="none" stroke="#c98f6c" strokeWidth="1" opacity="0.6" />
    </svg>
  );
}

interface Props {
  note: CoachNote | null;
  open: boolean;
  onToggle: () => void; // the avatar shows or hides the last note
  onClose: () => void;
}

// Top right of the table: the coach, with his last note as an overlay to his left.
export function Coach({ note, open, onToggle, onClose }: Props) {
  return (
    <div className="coach-dock">
      {note && open && (
        <div className={`bubble ${note.verdict}`} key={note.id} role="status">
          <div className="bubble-head">
            <span className="coach-name">Coach</span>
            <span className={`verdict ${note.verdict}`}>{VERDICT_LABEL[note.verdict]}</span>
            <span className="spacer" />
            <button className="bubble-close" onClick={onClose} aria-label="Dismiss">
              ×
            </button>
          </div>
          <div className="bubble-headline">{note.headline}</div>
          <ul>
            {note.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      )}
      <button className="coach-button" onClick={onToggle} aria-label="Coach" aria-expanded={!!note && open}>
        <CoachAvatar />
      </button>
    </div>
  );
}
