// Amounts on the table show in chips or in big blinds; the hero switches by clicking their stack.
export type Unit = 'chips' | 'bb';

const KEY = 'pst.units';

export function loadUnit(): Unit {
  try {
    return localStorage.getItem(KEY) === 'bb' ? 'bb' : 'chips';
  } catch {
    return 'chips';
  }
}

export function saveUnit(u: Unit) {
  try {
    localStorage.setItem(KEY, u);
  } catch {
    // preference lasts this session only
  }
}

// Big blinds to two places at most: 2.5 BB, 3.33 BB. The unit never wraps away from its number.
export const inBB = (chips: number, bb: number) => Math.round((chips / bb) * 100) / 100;

export const money = (chips: number, unit: Unit, bb: number) =>
  unit === 'bb' ? `${inBB(chips, bb).toLocaleString()}\u00a0BB` : chips.toLocaleString();
