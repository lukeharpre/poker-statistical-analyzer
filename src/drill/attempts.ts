import type { QuestionKind } from './questions';

export interface DrillAttempt {
  at: number;
  kind: QuestionKind;
  guess: number;
  exact: number;
  ms: number;
}

const KEY = 'pst.drill.v1';

export function loadDrill(): DrillAttempt[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DrillAttempt[]) : [];
  } catch {
    return [];
  }
}

export function saveDrill(a: DrillAttempt): DrillAttempt[] {
  const all = [...loadDrill(), a];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: answers last for this session only
  }
  return all;
}
