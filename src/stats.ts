import { CATEGORY_NAMES } from './engine/evaluator';
import type { Horizon } from './engine/odds';

export interface Attempt {
  at: number;
  kind: string; // target kind, see KIND_NAMES
  label: string; // the target as shown, e.g. "Pair your K"
  horizon: Horizon;
  street: 'flop' | 'turn';
  cardsToCome: 1 | 2;
  guess: number;
  exact: number;
  ms: number;
  outs: number;
}

const KEY = 'pst.attempts.v2';
const LEGACY_KEY = 'pst.attempts.v1';

// v1 targets were "category or better" over the whole board.
function migrate(): Attempt[] {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (!raw) return [];
  const old = JSON.parse(raw) as (Omit<Attempt, 'kind' | 'label'> & { category: number })[];
  const converted = old.map(({ category, ...a }) => ({
    ...a,
    kind: `legacy-${category}`,
    label: `${CATEGORY_NAMES[category]} or better (old)`,
  }));
  localStorage.setItem(KEY, JSON.stringify(converted));
  localStorage.removeItem(LEGACY_KEY);
  return converted;
}

export function loadAttempts(): Attempt[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Attempt[]) : migrate();
  } catch {
    return [];
  }
}

export function saveAttempt(a: Attempt): Attempt[] {
  const all = [...loadAttempts(), a];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: stats last for this session only
  }
  return all;
}

export function clearAttempts() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

// Error in percentage points.
export const errorPts = (a: Attempt) => Math.abs(a.guess - a.exact) * 100;

export function grade(pts: number): { label: string; tone: 'great' | 'good' | 'meh' | 'bad' } {
  if (pts <= 1) return { label: 'Pinpoint', tone: 'great' };
  if (pts <= 3) return { label: 'Close', tone: 'good' };
  if (pts <= 7) return { label: 'Off', tone: 'meh' };
  return { label: 'Way off', tone: 'bad' };
}
