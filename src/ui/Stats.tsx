import { ordinal } from '../engine/game';
import { KIND_NAMES } from '../engine/targets';
import type { SpinRecord } from '../engine/spin';
import { clearAttempts, errorPts, grade, type Attempt } from '../stats';

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

function summary(list: Attempt[]) {
  const errs = list.map(errorPts);
  return {
    count: list.length,
    err: avg(errs),
    time: avg(list.map((a) => a.ms)) / 1000,
    pinpoint: list.length ? errs.filter((e) => e <= 1).length / list.length : 0,
  };
}

interface Props {
  attempts: Attempt[];
  onCleared: () => void;
  spinRecord?: SpinRecord; // Spin & Go: finishes this session
}

export function Stats({ spinRecord, ...rest }: Props) {
  if (!spinRecord) return <Attempts {...rest} />;
  return (
    <>
      <div className="stats spin-record">
        <h4>Spin & Go session</h4>
        <div className="result-nums">
          <div>
            <div className="num">{spinRecord[0] + spinRecord[1] + spinRecord[2]}</div>
            <div className="lbl">Played</div>
          </div>
          {spinRecord.map((n, i) => (
            <div key={i}>
              <div className="num">{n}</div>
              <div className="lbl">{ordinal(i + 1)}</div>
            </div>
          ))}
        </div>
      </div>
      <Attempts {...rest} />
    </>
  );
}

function Attempts({ attempts, onCleared }: Omit<Props, 'spinRecord'>) {
  if (attempts.length === 0) return <p className="muted">No attempts yet.</p>;

  const all = summary(attempts);
  const last20 = summary(attempts.slice(-20));
  const kindName = (a: Attempt) => KIND_NAMES[a.kind] ?? a.label;
  const groups = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const key = `${kindName(a)}|${a.cardsToCome}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const rows = [...groups].map(([key, list]) => {
    const [name, cards] = key.split('|');
    return { key, name, cards, s: summary(list) };
  });

  return (
    <div className="stats">
      <div className="result-nums">
        <div>
          <div className="num">{all.count}</div>
          <div className="lbl">Attempts</div>
        </div>
        <div>
          <div className="num">{all.err.toFixed(2)}</div>
          <div className="lbl">Avg pts off</div>
        </div>
        <div>
          <div className="num">{all.time.toFixed(1)}s</div>
          <div className="lbl">Avg time</div>
        </div>
        <div>
          <div className="num">{Math.round(all.pinpoint * 100)}%</div>
          <div className="lbl">Pinpoint</div>
        </div>
      </div>
      <p className="muted small">
        Last 20: {last20.err.toFixed(2)} pts off, {last20.time.toFixed(1)}s, {Math.round(last20.pinpoint * 100)}%
        pinpoint
      </p>

      <table>
        <thead>
          <tr>
            <th>Target</th>
            <th>Cards</th>
            <th>#</th>
            <th>Pts off</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.name}</td>
              <td>{r.cards}</td>
              <td>{r.s.count}</td>
              <td>{r.s.err.toFixed(2)}</td>
              <td>{r.s.time.toFixed(1)}s</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Recent</h4>
      <table>
        <thead>
          <tr>
            <th>Target</th>
            <th>You</th>
            <th>Exact</th>
            <th>Pts off</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {attempts
            .slice(-12)
            .reverse()
            .map((a) => {
              const e = errorPts(a);
              return (
                <tr key={a.at}>
                  <td>{a.label}</td>
                  <td>{(a.guess * 100).toFixed(1)}%</td>
                  <td>{(a.exact * 100).toFixed(1)}%</td>
                  <td className={`grade-text ${grade(e).tone}`}>{e.toFixed(1)}</td>
                  <td>{(a.ms / 1000).toFixed(1)}s</td>
                </tr>
              );
            })}
        </tbody>
      </table>

      <button
        className="link"
        onClick={() => {
          if (confirm('Clear all stats?')) {
            clearAttempts();
            onCleared();
          }
        }}
      >
        Clear stats
      </button>
    </div>
  );
}
