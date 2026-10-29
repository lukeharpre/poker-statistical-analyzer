import { useEffect, useReducer, useState } from 'react';
import { decide } from './engine/bot';
import { coachDecision, type CoachNote } from './engine/coach';
import { BLIND_LEVELS, Game, HANDS_PER_LEVEL, MAX_ENTRANTS, handPause, runoutPause, type Action, type Format } from './engine/game';
import { SEATS } from './engine/field';
import { SPIN_LEVEL_MS, SPIN_STACKS, SpinAndGo, type SpinRecord } from './engine/spin';
import { H2H_LEVEL_MS, H2H_STACK, NAME_MAX } from './h2h/protocol';
import { RemoteGame, hasSeat, savedName } from './h2h/RemoteGame';
import { loadAttempts, type Attempt } from './stats';
import { ActionBar } from './ui/ActionBar';
import { Coach } from './ui/Coach';
import { Drill } from './ui/Drill';
import { HandLog } from './ui/HandLog';
import { Stats } from './ui/Stats';
import { Table } from './ui/Table';
import { Trainer } from './ui/Trainer';
import { loadUnit, saveUnit } from './ui/units';

const BOT_DELAY = [550, 1100]; // ms, randomised so bots don't act like metronomes
const sessionStart = Date.now(); // answers after page load count as this session
type Section = 'online' | 'training' | 'statistics';
const SECTIONS: { id: Section; name: string; blurb: string }[] = [
  { id: 'online', name: 'Online', blurb: 'Head to head against another player' },
  { id: 'training', name: 'Training', blurb: "Hold'em against bots, with odds targets" },
  { id: 'statistics', name: 'Statistics', blurb: 'Quick-fire probability questions' },
];
type Mode = 'headsup' | 'ring' | 'tournament' | 'spin';
const MODES: { id: Mode; name: string; blurb: string }[] = [
  { id: 'headsup', name: 'Heads Up', blurb: 'You and one opponent' },
  { id: 'ring', name: 'Ring Game', blurb: 'Blinds 5/10 · rebuy when busted' },
  { id: 'tournament', name: 'Tournament', blurb: `Blinds rise every ${HANDS_PER_LEVEL} hands · last one standing` },
  { id: 'spin', name: 'Spin & Go', blurb: `3 players · blinds up every ${SPIN_LEVEL_MS / 60_000} minutes` },
];
const PLAYER_COUNTS = [3, 4, 5, 6, 7, 8, 9]; // you included; 2 is Heads Up
const clock = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clampEntrants = (n: number) => Math.min(MAX_ENTRANTS, Math.max(3, Math.round(n) || 3));

export default function App() {
  const [section, setSection] = useState<Section | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [players, setPlayers] = useState(6);
  const [entrantsText, setEntrantsText] = useState('18');
  const [spinStack, setSpinStack] = useState(500);
  // This session's Spin & Go finishes; gone once the session is left.
  const [spinRecord, setSpinRecord] = useState<SpinRecord>([0, 0, 0]);
  const [name, setName] = useState(savedName);
  const [remote, setRemote] = useState<RemoteGame | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const openRemote = (r: RemoteGame) => {
    r.onStatus = () => (r.status === 'closed' ? setRemote(null) : rerender());
    setRemote(r);
    return r;
  };
  // A match this browser is seated in carries on after a reload.
  useEffect(() => {
    if (!hasSeat()) return;
    const r = openRemote(new RemoteGame(savedName(), true));
    return () => r.disconnect();
  }, []);

  if (remote?.status === 'playing') {
    const leave = () => {
      if (!remote.finished && !confirm(`Leave and concede the match to ${remote.opponent.name}?`)) return;
      remote.leave();
      setRemote(null);
    };
    return <TableScreen game={remote} onLeave={leave} />;
  }

  if (remote) {
    const cancel = () => {
      remote.leave();
      setRemote(null);
    };
    return (
      <div className="setup">
        <div className="setup-card">
          <div className="setup-suits">♠ ♥ ♦ ♣</div>
          <h1>Online</h1>
          <p className="muted">{remote.status === 'waiting' ? 'Waiting for an opponent' : 'Connecting'}</p>
          <button className="btn-end" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const newSpin = () => {
    const g = new SpinAndGo(spinStack);
    g.startHand();
    setGame(g);
  };
  if (game) {
    const leave = () => {
      setGame(null);
      setSpinRecord([0, 0, 0]);
    };
    const spin =
      game instanceof SpinAndGo
        ? {
            record: spinRecord,
            onFinished: (place: number) =>
              setSpinRecord((r) => r.map((n, i) => (i === place - 1 ? n + 1 : n)) as SpinRecord),
            onNext: newSpin,
          }
        : undefined;
    return <TableScreen game={game} onLeave={leave} spin={spin} />;
  }
  if (section === 'statistics') return <Drill onLeave={() => setSection(null)} />;

  if (!section) {
    return (
      <div className="setup">
        <div className="setup-card">
          <div className="setup-suits">♠ ♥ ♦ ♣</div>
          <h1>Poker Odds Trainer</h1>
          <div className="section-picker">
            {SECTIONS.map((s) => (
              <button key={s.id} onClick={() => setSection(s.id)}>
                <span className="mode-name">{s.name}</span>
                <span className="mode-blurb">{s.blurb}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const back = (
    <button className="ghost back" onClick={() => setSection(null)}>
      ← Back
    </button>
  );

  if (section === 'online') {
    const find = () => name.trim() && openRemote(new RemoteGame(name.trim()));
    return (
      <div className="setup">
        <div className="setup-card">
          {back}
          <h1>Online</h1>
          <p className="muted">
            Heads up · {H2H_STACK} chips · blinds up every {H2H_LEVEL_MS / 60_000} minutes
          </p>
          <div className="setup-label">Your name</div>
          <input
            className="name-input"
            value={name}
            maxLength={NAME_MAX}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && find()}
            aria-label="Your name"
          />
          <button className="btn-raise big" onClick={find} disabled={!name.trim()}>
            Find an opponent
          </button>
        </div>
      </div>
    );
  }

  const entrants = clampEntrants(Number(entrantsText));
  const tables = Math.ceil(entrants / SEATS);
  const opponents = mode === 'headsup' ? 1 : players - 1;
  const start = () => {
    if (mode === 'spin') return newSpin();
    const format: Format = mode === 'tournament' ? 'tournament' : 'ring';
    const g =
      mode === 'tournament'
        ? new Game(entrants - 1, 1000, Math.random, format, entrants)
        : new Game(opponents, 1000, Math.random, format);
    g.startHand();
    setGame(g);
  };
  const step = (d: number) => setEntrantsText(String(clampEntrants(entrants + d)));
  return (
    <div className="setup">
      <div className="setup-card">
        {back}
        <h1>Training</h1>
        <p className="muted">No-limit Hold'em · {mode === 'spin' ? spinStack : '1,000'} chips</p>
        <div className="mode-picker">
          {MODES.map((m) => (
            <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
              <span className="mode-name">{m.name}</span>
              <span className="mode-blurb">{m.blurb}</span>
            </button>
          ))}
        </div>
        {mode === 'tournament' && (
          <>
            <div className="setup-label">How many players?</div>
            <div className="stepper">
              <button onClick={() => step(-1)} disabled={entrants <= 3} aria-label="Fewer players">
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={3}
                max={MAX_ENTRANTS}
                value={entrantsText}
                onChange={(e) => setEntrantsText(e.target.value)}
                onBlur={() => setEntrantsText(String(entrants))}
                aria-label="Players"
              />
              <button onClick={() => step(1)} disabled={entrants >= MAX_ENTRANTS} aria-label="More players">
                +
              </button>
              <span className="muted">
                3 to {MAX_ENTRANTS} · {tables} {tables === 1 ? 'table' : 'tables'}
              </span>
            </div>
          </>
        )}
        {mode === 'ring' && (
          <>
            <div className="setup-label">How many players?</div>
            <div className="count-picker">
              {PLAYER_COUNTS.map((n) => (
                <button key={n} className={players === n ? 'on' : ''} onClick={() => setPlayers(n)}>
                  {n}
                </button>
              ))}
            </div>
          </>
        )}
        {mode === 'spin' && (
          <>
            <div className="setup-label">Starting chips</div>
            <div className="count-picker stacks">
              {SPIN_STACKS.map((n) => (
                <button key={n} className={spinStack === n ? 'on' : ''} onClick={() => setSpinStack(n)}>
                  {n}
                </button>
              ))}
            </div>
          </>
        )}
        {mode && (
          <button className="btn-raise big" onClick={start}>
            {mode === 'spin'
              ? `Start a Spin & Go with ${spinStack} chips`
              : mode === 'tournament'
              ? `Start the tournament with ${entrants} players`
              : `Sit down with ${opponents} ${opponents === 1 ? 'opponent' : 'opponents'}`}
          </button>
        )}
      </div>
    </div>
  );
}

interface SpinSession {
  record: SpinRecord;
  onFinished: (place: number) => void;
  onNext: () => void;
}

function TableScreen({ game, onLeave, spin }: { game: Game | RemoteGame; onLeave: () => void; spin?: SpinSession }) {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [tab, setTab] = useState<'trainer' | 'stats' | 'log'>('trainer');
  const [attempts, setAttempts] = useState<Attempt[]>(loadAttempts);
  const [coachOn, setCoachOn] = useState(() => {
    try {
      return localStorage.getItem('pst.coach') !== 'off';
    } catch {
      return true;
    }
  });
  const [note, setNote] = useState<CoachNote | null>(null);
  const [noteOpen, setNoteOpen] = useState(true);
  const [asking, setAsking] = useState(false); // a Trainer question is open: the next hand waits
  const [unit, setUnit] = useState(loadUnit);
  const toggleUnit = () => {
    const u = unit === 'bb' ? 'chips' : 'bb';
    setUnit(u);
    saveUnit(u);
  };

  const toggleCoach = () => {
    const on = !coachOn;
    setCoachOn(on);
    if (!on) setNote(null);
    try {
      localStorage.setItem('pst.coach', on ? 'on' : 'off');
    } catch {
      // preference lasts this session only
    }
  };

  // The hero's moves go through here so Coach sees the spot exactly as the hero did.
  const heroAct = (action: Action) => {
    const view = coachOn ? game.botView(0) : null;
    if (!view) return game.act(0, action);
    const n = coachDecision(view, action);
    game.act(0, action, `Coach: ${n.headline}`);
    setNote(n);
    setNoteOpen(true);
  };

  useEffect(() => {
    game.onChange = rerender;
    setNote(null); // a new spin starts with a clean slate
    rerender();
    return () => {
      game.onChange = () => {};
    };
  }, [game]);

  // Spin & Go: each finish goes on the session's record, once.
  useEffect(() => {
    if (spin && game.finished) spin.onFinished(game.hero.place!);
  }, [game, game.finished]);

  // The next hand deals on its own (head to head: the server deals it).
  useEffect(() => {
    if (!(game instanceof Game) || game.phase !== 'handOver' || game.finished || asking) return;
    const t = setTimeout(() => game.startHand(), handPause(game.result));
    return () => clearTimeout(t);
  }, [game, game.phase, game.handNumber, asking]);

  // Bots act on their own after a short pause; the hero has no clock.
  useEffect(() => {
    if (!(game instanceof Game)) return; // head to head: the server runs the board out
    if (game.phase === 'runout') {
      const t = setTimeout(() => game.runoutStep(), runoutPause(game.board.length));
      return () => clearTimeout(t);
    }
    const p = game.players[game.toAct];
    if (game.phase !== 'betting' || !p || p.isHuman) return;
    const wait = BOT_DELAY[0] + Math.random() * (BOT_DELAY[1] - BOT_DELAY[0]);
    const t = setTimeout(() => game.act(p.id, decide(game.botView(p.id), p.personality!)), wait);
    return () => clearTimeout(t);
  });

  return (
    <div className="app">
      <header>
        <span className="title">
          <span className="logo">♠</span> Odds Trainer
        </span>
        <span className="muted">Hand {game.handNumber}</span>
        {(game instanceof RemoteGame || game instanceof SpinAndGo) && <BlindClock game={game} />}
        {game instanceof Game && !(game instanceof SpinAndGo) && game.format === 'tournament' && (
          <span className="muted">
            Blinds {game.smallBlind}/{game.bigBlind}
            {game.level < BLIND_LEVELS.length - 1 &&
              ` · up in ${HANDS_PER_LEVEL - ((game.handNumber - 1) % HANDS_PER_LEVEL)}`}
            {` · ${game.remaining} of ${game.entrants} left`}
          </span>
        )}
        <span className="spacer" />
        <button className={`btn-coach ${coachOn ? 'on' : ''}`} onClick={toggleCoach} aria-pressed={coachOn}>
          Coach {coachOn ? 'on' : 'off'}
        </button>
        <button className="btn-end" onClick={onLeave}>
          {game instanceof RemoteGame ? 'Leave' : 'New Game'}
        </button>
      </header>
      <main>
        <section className="play">
          <Table game={game} unit={unit} onUnit={toggleUnit} />
          {coachOn && (
            <Coach note={note} open={noteOpen} onToggle={() => setNoteOpen((o) => !o)} onClose={() => setNoteOpen(false)} />
          )}
        </section>
        <div className="actions-slot">
          <ActionBar
            game={game}
            onAct={heroAct}
            onLeave={onLeave}
            onNext={spin?.onNext}
            onShow={game instanceof RemoteGame ? (cards) => game.show(cards) : undefined}
            unit={unit}
          />
        </div>
        <aside>
          <div className="tabs">
            {(['trainer', 'stats', 'log'] as const).map((t) => (
              <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'trainer' ? 'Trainer' : t === 'stats' ? 'Stats' : 'Log'}
              </button>
            ))}
          </div>
          <div className={tab === 'trainer' ? '' : 'hidden'}>
            <Trainer
              hole={game.hero.hole}
              board={game.board}
              attempts={attempts}
              sessionStart={sessionStart}
              onSaved={() => setAttempts(loadAttempts())}
              onAsking={setAsking}
            />
          </div>
          {tab === 'stats' && <Stats attempts={attempts} onCleared={() => setAttempts([])} spinRecord={spin?.record} />}
          {tab === 'log' && <HandLog history={game.history} />}
        </aside>
      </main>
    </div>
  );
}

// Head to head and Spin & Go: the blinds clock ticks down. Only this re-renders each second,
// so the bots' and runout timers on the table aren't reset by the tick.
function BlindClock({ game }: { game: RemoteGame | SpinAndGo }) {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="muted">
      Blinds {game.smallBlind}/{game.bigBlind}
      {game.nextBlinds &&
        ` · ${game.nextBlinds[0]}/${game.nextBlinds[1]} ${game.nextBlindsIn > 0 ? `in ${clock(game.nextBlindsIn)}` : 'next hand'}`}
      {game instanceof RemoteGame && !game.opponentConnected && !game.finished && ` · ${game.opponent.name} disconnected`}
    </span>
  );
}
