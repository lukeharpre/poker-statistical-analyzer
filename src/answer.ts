// Parses the hero's answer into a probability (0..1).
//   A plain number is always a percentage: "35" = 35%, "0.8" = 0.8%, "1" = 1%.
//   "%" anywhere makes that number a percentage: "35%", "9/47%"... rarely needed.
//   Arithmetic gives a probability when it comes out at 1 or below ("9/47",
//   "1-38/47*37/46") and a percentage when above 1 ("9*4" = 36%).
export function parseAnswer(input: string): number | null {
  const src = input.replace(/\s+/g, '').replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-');
  if (!src) return null;

  if (/^(\d+\.?\d*|\.\d+)$/.test(src)) {
    const v = Number(src) / 100;
    return v <= 1 ? v : null;
  }

  let i = 0;
  let sawPercent = false;

  const expr = (): number => {
    let v = term();
    while (src[i] === '+' || src[i] === '-') v = src[i++] === '+' ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = factor();
    while (src[i] === '*' || src[i] === '/') v = src[i++] === '*' ? v * factor() : v / factor();
    return v;
  };
  const factor = (): number => {
    let v: number;
    if (src[i] === '-') {
      i++;
      return -factor();
    }
    if (src[i] === '(') {
      i++;
      v = expr();
      if (src[i++] !== ')') throw new Error('unbalanced');
    } else {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) throw new Error('number expected');
      i += m[0].length;
      v = Number(m[0]);
    }
    if (src[i] === '%') {
      i++;
      sawPercent = true;
      v /= 100;
    }
    return v;
  };

  try {
    let v = expr();
    if (i !== src.length || !Number.isFinite(v)) return null;
    if (!sawPercent && v > 1) v /= 100;
    return v >= 0 && v <= 1 ? v : null;
  } catch {
    return null;
  }
}
