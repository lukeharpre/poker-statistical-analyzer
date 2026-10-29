// Casino colours by value; an amount is drawn as one column per denomination.
const DENOMS = [1000, 500, 100, 25, 5, 1];
const MAX_COLUMNS = 5;
const MAX_HEIGHT = 8; // chips drawn per column; the label carries the exact amount
const STEP = 4; // px each chip sits above the one below

export function breakdown(amount: number): { value: number; count: number }[] {
  const out: { value: number; count: number }[] = [];
  let left = Math.max(0, Math.round(amount));
  for (const value of DENOMS) {
    const count = Math.floor(left / value);
    if (count > 0) {
      out.push({ value, count });
      left -= count * value;
    }
  }
  return out;
}

export function ChipStack({ amount }: { amount: number }) {
  const columns = breakdown(amount).slice(0, MAX_COLUMNS);
  return (
    <span className="chip-stack" aria-hidden="true">
      {columns.map(({ value, count }) => {
        const shown = Math.min(count, MAX_HEIGHT);
        return (
          <span key={value} className="chip-col" style={{ height: `calc(var(--chip) + ${(shown - 1) * STEP}px)` }}>
            {Array.from({ length: shown }, (_, i) => (
              <span key={i} className={`chip chip-${value}`} style={{ bottom: i * STEP, animationDelay: `${i * 30}ms` }} />
            ))}
          </span>
        );
      })}
    </span>
  );
}
