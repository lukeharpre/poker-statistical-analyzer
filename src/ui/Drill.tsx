import { useEffect, useRef, useState } from 'react';
import { parseAnswer } from '../answer';
import { loadDrill, saveDrill, type DrillAttempt } from '../drill/attempts';
import { KIND_NAMES, KINDS, nextQuestion, pct, type Question } from '../drill/questions';
import { grade } from '../stats';
import { AccuracyBar } from './Trainer';

const sessionStart = Date.now();
const errorPts = (a: DrillAttempt) => Math.abs(a.guess - a.exact) * 100;

function average(list: DrillAttempt[]) {
  if (list.length === 0) return null;
  return {
    n: list.length,
    err: list.reduce((s, a) => s + errorPts(a), 0) / list.length,
    ms: list.reduce((s, a) => s + a.ms, 0) / list.length,
  };
}

// Answer, see the exact figure and the working, Enter for the next one.
export function Drill({ onLeave }: { onLeave: () => void }) {
  const [question, setQuestion] = useState<Question>(() => nextQuestion(null));
  const [started, setStarted] = useState(() => performance.now());
  const [input, setInput] = useState('');
  const [answered, setAnswered] = useState<DrillAttempt | null>(null);
  const [attempts, setAttempts] = useState(loadDrill);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = parseAnswer(input);

  useEffect(() => inputRef.current?.focus(), [question]);

  const next = () => {
    setQuestion(nextQuestion(question.kind));
    setInput('');
    setAnswered(null);
    setStarted(performance.now());
  };

  const submit = () => {
    if (answered) return next();
    if (parsed === null) return;
    const a: DrillAttempt = { at: Date.now(), kind: question.kind, guess: parsed, exact: question.exact, ms: performance.now() - started };
    setAttempts(saveDrill(a));
    setAnswered(a);
  };

  const session = average(attempts.filter((a) => a.at >= sessionStart));
  const err = answered ? errorPts(answered) : 0;
  const g = grade(err);

  return (
    <div className="app">
      <header>
        <span className="title">
          <span className="logo">♠</span> Odds Trainer
        </span>
        <span className="muted">Statistics</span>
        <span className="spacer" />
        <button className="btn-end" onClick={onLeave}>
          Menu
        </button>
      </header>
      <main className="drill">
        <section className="drill-card prompt" key={question.prompt + started}>
          <div className="setup-label">{KIND_NAMES[question.kind]}</div>
          <div className="prompt-q">{question.prompt}</div>
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
                readOnly={!!answered}
                aria-label="Your answer"
                autoComplete="off"
                spellCheck={false}
                inputMode="decimal"
              />
              {input && <span className="answer-preview">{parsed === null ? '?' : `= ${pct(parsed, parsed < 0.01 ? 2 : 1)}`}</span>}
            </div>
            <div className="answer-actions single">
              <button type="submit" className="btn-raise" disabled={!answered && parsed === null}>
                {answered ? 'Next' : 'Submit'} <kbd>↵</kbd>
              </button>
            </div>
          </form>
        </section>

        {answered && (
          <div className="result-card">
            <div className="result-head">
              <span>{KIND_NAMES[answered.kind]}</span>
              <span className={`grade ${g.tone}`}>{g.label}</span>
            </div>
            <div className="result-nums">
              <div>
                <div className="num">{(answered.ms / 1000).toFixed(1)}s</div>
                <div className="lbl">Time</div>
              </div>
              <div>
                <div className="num">{pct(answered.guess, 1)}</div>
                <div className="lbl">You</div>
              </div>
              <div>
                <div className="num">{pct(answered.exact)}</div>
                <div className="lbl">Exact</div>
              </div>
              <div>
                <div className="num">{err.toFixed(2)}</div>
                <div className="lbl">Pts off</div>
              </div>
            </div>
            <AccuracyBar guess={answered.guess} exact={answered.exact} />
            <div className="working">
              {question.working.map(([lbl, line]) => (
                <div className="step" key={lbl}>
                  <span className="lbl">{lbl}</span>
                  <span>{line}</span>
                </div>
              ))}
              {question.shortcut && (
                <div className="step muted">
                  <span className="lbl">{question.shortcut[0]}</span>
                  <span>{question.shortcut[1]}</span>
                </div>
              )}
            </div>
          </div>
        )}

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

        {attempts.length > 0 && (
          <table className="drill-kinds">
            <thead>
              <tr>
                <th>All time</th>
                <th>Answers</th>
                <th>Pts off</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map((k) => {
                const avg = average(attempts.filter((a) => a.kind === k));
                return (
                  <tr key={k}>
                    <td>{KIND_NAMES[k]}</td>
                    <td>{avg?.n ?? 0}</td>
                    <td>{avg ? avg.err.toFixed(1) : '–'}</td>
                    <td>{avg ? `${(avg.ms / 1000).toFixed(1)}s` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
