import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../engine/cards';
import { computeOdds, type Horizon, type OddsBreakdown } from '../engine/odds';
import { targetsFor, type OfferedTarget } from '../engine/targets';
import { parseAnswer } from '../answer';
import { errorPts, grade, saveAttempt, type Attempt } from '../stats';
import { CardRow } from './CardView';

const pct = (p: number, dp = 2) => `${(p * 100).toFixed(dp)}%`;

interface Active {
  target: OfferedTarget;
  horizon: Horizon;
  hole: Card[];
  board: Card[];
  started: number;
}

interface Result {
  attempt: Attempt;
  odds: OddsBreakdown;
  entered: string;
  prior: Average | null; // this target type's average before this answer
}

interface Average {
  n: number;
  err: number;
  ms: number;
}

function average(list: Attempt[]): Average | null {
  if (list.length === 0) return null;
  return {
    n: list.length,
    err: list.reduce((s, a) => s + errorPts(a), 0) / list.length,
    ms: list.reduce((s, a) => s + a.ms, 0) / list.length,
  };
}

const whenText = (board: Card[], horizon: Horizon) =>
  board.length === 4 ? 'on the river' : horizon === 'next' ? 'on the turn' : 'by the river';

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA';
};

interface Props {
  hole: Card[];
  board: Card[];
  attempts: Attempt[];
  sessionStart: number;
  onSaved: () => void;
  onAsking?: (asking: boolean) => void; // a question is open
}

export function Trainer({ hole, board, attempts, sessionStart, onSaved, onAsking }: Props) {
  const [horizon, setHorizon] = useState<Horizon>('river');
  const [active, setActive] = useState<Active | null>(null);
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const street = board.length === 3 ? 'flop' : board.length === 4 ? 'turn' : null;
  const available = street !== null && hole.length === 2;
  const effectiveHorizon: Horizon = street === 'turn' ? 'next' : horizon;
  const cardsToCome = street === 'flop' && horizon === 'river' ? 2 : 1;

  const holeKey = hole.join();
  const boardKey = board.join();
  const offered = useMemo(
    () => (available ? targetsFor(hole, board) : []),
    // keyed by card values: the arrays are rebuilt each render
    [available, holeKey, boardKey],
  );
  const shown = offered.filter((t) => effectiveHorizon === 'river' || t.singleCard);
  // Number keys follow on-screen order: your cards first, then draws.
  const ordered = [...shown.filter((t) => t.group === 'cards'), ...shown.filter((t) => t.group === 'draws')];

  const averageFor = (kind: string, cards: number) =>
    average(attempts.filter((a) => a.kind === kind && a.cardsToCome === cards));
  const session = average(attempts.filter((a) => a.at >= sessionStart));

  useEffect(() => {
    if (active) inputRef.current?.focus();
    onAsking?.(!!active);
  }, [active]);

  const start = (target: OfferedTarget) => {
    setResult(null);
    setInput('');
    setActive({ target, horizon: effectiveHorizon, hole: [...hole], board: [...board], started: performance.now() });
  };

  // 1-9 pick a target, Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active) {
        setActive(null);
        return;
      }
      if (active || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = Number(e.key) - 1;
      if (i >= 0 && i < ordered.length && i < 9) {
        e.preventDefault();
        start(ordered[i]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const parsed = parseAnswer(input);

  const submit = () => {
    if (!active || parsed === null) return;
    const ms = performance.now() - active.started;
    const odds = computeOdds(active.hole, active.board, active.target, active.horizon);
    const attempt: Attempt = {
      at: Date.now(),
      kind: active.target.kind,
      label: active.target.label,
      horizon: active.horizon,
      street: active.board.length === 3 ? 'flop' : 'turn',
      cardsToCome: odds.cardsToCome,
      guess: parsed,
      exact: odds.probability,
      ms,
      outs: odds.outs.length,
    };
    const prior = averageFor(attempt.kind, attempt.cardsToCome);
    saveAttempt(attempt);
    onSaved();
    setResult({ attempt, odds, entered: input.trim(), prior });
    setActive(null);
  };

  const group = (g: 'cards' | 'draws', title: string) => {
    const list = ordered.filter((t) => t.group === g);
    if (list.length === 0) return null;
    return (
      <section className="target-group">
        <h3 className="group-title">{title}</h3>
        <div className="targets">
          {list.map((t) => {
            const key = ordered.indexOf(t) + 1;
            const avg = averageFor(t.kind, cardsToCome);
            return (
              <button key={t.kind + t.label} className="target" onClick={() => start(t)}>
                <kbd className="target-key">{key <= 9 ? key : ''}</kbd>
                <span className="target-text">
                  <span className="target-label">{t.label}</span>
                  <span className="target-meta">{t.singleCard ? `Makes ${t.makes}` : 'Needs both cards'}</span>
                </span>
                {avg ? (
                  <span className="target-avg" title={`${avg.n} answered`}>
                    <b>{avg.err.toFixed(1)}</b> pts
                    <br />
                    <b>{(avg.ms / 1000).toFixed(1)}</b>s
                  </span>
                ) : (
                  <span className="target-avg new">New</span>
                )}
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  const context = (cards: Card[], b: Card[]) => (
    <div className="spot">
      <span className="spot-part">
        <span className="spot-label">You</span>
        <CardRow cards={cards} />
      </span>
      <span className="spot-part">
        <span className="spot-label">{b.length === 3 ? 'Flop' : b.length === 4 ? 'Turn' : 'Board'}</span>
        <CardRow cards={b} />
      </span>
    </div>
  );

  return (
    <div className="trainer">
      {active ? (
        <div className="prompt">
          {context(active.hole, active.board)}
          <div className="prompt-q">
            Chance you {active.target.question} {whenText(active.board, active.horizon)}?
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className={`answer-box ${input && parsed === null ? 'invalid' : ''}`}>
              <input
                ref={inputRef}
                className="answer"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                aria-label="Your estimate"
                autoComplete="off"
                spellCheck={false}
                inputMode="decimal"
              />
              {input && <span className="answer-preview">{parsed === null ? '?' : `= ${pct(parsed, parsed < 0.01 ? 2 : 1)}`}</span>}
            </div>
            <div className="answer-actions">
              <button type="button" className="ghost" onClick={() => setActive(null)}>
                Cancel <kbd>Esc</kbd>
              </button>
              <button type="submit" className="btn-raise" disabled={parsed === null}>
                Submit <kbd>↵</kbd>
              </button>
            </div>
          </form>
        </div>
      ) : available ? (
        <div className="picker">
          {context(hole, board)}
          <div className="horizon" role="radiogroup" aria-label="Cards to come">
            {street === 'flop' ? (
              <>
                <button
                  role="radio"
                  aria-checked={horizon === 'next'}
                  className={horizon === 'next' ? 'on' : ''}
                  onClick={() => setHorizon('next')}
                >
                  Turn <span>1 card</span>
                </button>
                <button
                  role="radio"
                  aria-checked={horizon === 'river'}
                  className={horizon === 'river' ? 'on' : ''}
                  onClick={() => setHorizon('river')}
                >
                  River <span>2 cards</span>
                </button>
              </>
            ) : (
              <button role="radio" aria-checked className="on" disabled>
                River <span>1 card</span>
              </button>
            )}
          </div>
          {shown.length === 0 && <p className="muted">No live targets.</p>}
          {group('cards', 'Your cards')}
          {group('draws', 'Draws')}
        </div>
      ) : (
        <p className="muted">Targets open on the flop and turn.</p>
      )}

      {result && <ResultView r={result} key={result.attempt.at} />}

      {session && (
        <div className="session">
          <span>This session</span>
          <span>
            <b>{session.n}</b> {session.n === 1 ? 'answer' : 'answers'}
          </span>
          <span>
            <b>{session.err.toFixed(1)}</b> pts off
          </span>
          <span>
            <b>{(session.ms / 1000).toFixed(1)}s</b> avg
          </span>
        </div>
      )}
    </div>
  );
}

export function AccuracyBar({ guess, exact }: { guess: number; exact: number }) {
  const g = guess * 100;
  const e = exact * 100;
  const clamp = (x: number) => Math.min(94, Math.max(6, x));
  return (
    <div className="acc" role="img" aria-label={`You ${g.toFixed(1)}%, exact ${e.toFixed(2)}%`}>
      <div className="acc-label above" style={{ left: `${clamp(g)}%` }}>
        You {g.toFixed(1)}%
      </div>
      <div className="acc-track">
        <div className="acc-gap" style={{ left: `${Math.min(g, e)}%`, width: `${Math.abs(g - e)}%` }} />
        <div className="acc-exact" style={{ left: `${e}%` }} />
        <div className="acc-guess" style={{ left: `${g}%` }} />
      </div>
      <div className="acc-label below" style={{ left: `${clamp(e)}%` }}>
        Exact {e.toFixed(2)}%
      </div>
    </div>
  );
}

// Lower is better for both time and error.
function Delta({ value, unit, label }: { value: number; unit: string; label: string }) {
  const good = value < 0;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  return (
    <span className={`delta ${Math.abs(value) < 0.05 ? '' : good ? 'up' : 'down'}`}>
      {sign}
      {Math.abs(value).toFixed(1)}
      {unit} <span className="muted">{label}</span>
    </span>
  );
}

function ResultView({ r }: { r: Result }) {
  const { attempt: a, odds: o } = r;
  const err = errorPts(a);
  const g = grade(err);
  const n = o.unseen;
  const k = o.outs.length;
  const boardCount = o.knownCount - 2;
  const missProb = ((n - k) / n) * ((n - 1 - k) / (n - 1));
  const when = a.street === 'turn' ? 'river' : a.horizon === 'next' ? 'turn' : 'by river';
  const isFormula = /[^\d.%\s]/.test(r.entered);

  return (
    <div className="result-card">
      <div className="result-head">
        <span>
          {a.label} <span className="muted">· {when}</span>
        </span>
        <span className={`grade ${g.tone}`}>{g.label}</span>
      </div>
      <div className="result-nums">
        <div>
          <div className="num">{(a.ms / 1000).toFixed(1)}s</div>
          <div className="lbl">Time</div>
        </div>
        <div>
          <div className="num">{pct(a.guess, 1)}</div>
          <div className="lbl">You</div>
        </div>
        <div>
          <div className="num">{pct(a.exact)}</div>
          <div className="lbl">Exact</div>
        </div>
        <div>
          <div className="num">{err.toFixed(2)}</div>
          <div className="lbl">Pts off</div>
        </div>
      </div>
      <AccuracyBar guess={a.guess} exact={a.exact} />
      {(r.prior || isFormula) && (
        <div className="compare">
          {isFormula && (
            <div>
              <span className="muted">You entered </span>
              <code>{r.entered}</code>
            </div>
          )}
          {r.prior && (
            <div className="deltas">
              <Delta value={a.ms / 1000 - r.prior.ms / 1000} unit="s" label="vs your avg time" />
              <Delta value={err - r.prior.err} unit=" pts" label="vs your avg error" />
            </div>
          )}
        </div>
      )}

      <div className="working">
        <div className="step">
          <span className="lbl">Unseen</span>
          <span>
            52 − {o.knownCount} = <b>{n}</b>
            <span className="muted"> (2 in hand, {boardCount} on board)</span>
          </span>
        </div>
        <div className="step">
          <span className="lbl">Outs</span>
          <span>
            <b>{k}</b> {k > 0 && <CardRow cards={o.outs} />}
          </span>
        </div>
        {o.cardsToCome === 1 ? (
          <>
            <div className="step">
              <span className="lbl">Hit</span>
              <span>
                {k}/{n} = <b>{pct(o.probability)}</b>
              </span>
            </div>
            <div className="step muted">
              <span className="lbl">Rule of 2</span>
              <span>
                {k} × 2 = {k * 2}%
              </span>
            </div>
          </>
        ) : (
          <>
            {k > 0 && (
              <>
                <div className="step">
                  <span className="lbl">Miss both</span>
                  <span>
                    {n - k}/{n} × {n - 1 - k}/{n - 1} = {pct(missProb)}
                  </span>
                </div>
                <div className="step">
                  <span className="lbl">Hit an out</span>
                  <span>
                    1 − {pct(missProb)} = {pct(1 - missProb)}
                  </span>
                </div>
              </>
            )}
            {o.runnerCombos > 0 && (
              <div className="step">
                <span className="lbl">Runner-runner</span>
                <span>
                  {o.runnerCombos} of {o.totalCombos} runouts = {pct(o.runnerCombos / o.totalCombos)}
                  <span className="examples">
                    {o.runnerExamples.map((pair, i) => (
                      <CardRow key={i} cards={pair} />
                    ))}
                  </span>
                </span>
              </div>
            )}
            <div className="step">
              <span className="lbl">Exact</span>
              <span>
                {o.runnerCombos > 0 ? `(${o.outCombos} + ${o.runnerCombos})` : o.outCombos} / {o.totalCombos} ={' '}
                <b>{pct(o.probability)}</b>
              </span>
            </div>
            {k > 0 && (
              <div className="step muted">
                <span className="lbl">Rule of 4</span>
                <span>
                  {k} × 4 = {k * 4}%{k > 8 && `, minus ${k - 8} over 8 outs = ${k * 4 - (k - 8)}%`}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
