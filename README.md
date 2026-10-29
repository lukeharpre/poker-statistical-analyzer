# Poker Odds Trainer

No-limit Hold'em against bots in the browser, with a Coach that grades every decision and drills
for estimating odds fast. No accounts, no backend beyond the dev server; stats stay in your
browser.

## What it does

- **Play** Heads Up, Ring Game (3–9 players), Tournament (up to 45 over several tables) or
  Spin & Go against bots in four hidden styles. You read them from their stats.
- **Coach** grades each decision good, close or mistake, with the reason and the cost in chips.
  Short stacks (up to 20 big blinds) are graded against push/fold and limp/raise equilibria
  solved in the browser.
- **Odds trainer**: on the flop or turn, estimate your chance of hitting a target. It shows the
  exact answer and the working (outs, rule of 2 and 4).
- **Statistics**: quick-fire probability questions with exact answers.
- **Head to Head**: two people on separate devices, played through the dev server.

## Run it

Needs Node 18 or later.

```sh
npm install
npm run dev     # http://localhost:5173
npm test
```

For Head to Head on a second device, run `npm run dev -- --host` and open the address it prints.

## Where things are

| Path | What |
| --- | --- |
| `src/engine/game.ts` | Rules, betting, tournaments |
| `src/engine/bot.ts` | Bot decisions, priced in chips |
| `src/engine/coach.ts` | Coach |
| `src/engine/pushfold.ts`, `preflopTree.ts` | Short-stack equilibria |
| `src/engine/reads.ts` | Player stats and table averages |
| `server/h2h.ts` | Head to Head over WebSocket |
| `scripts/coach-audit.ts` | Checks Coach against known spots and Spin & Go play |

## Assumptions

- After the flop, the player out of position keeps 85% of their equity.
- Table averages are measured from the bots. Re-measure with `npx vite-node scripts/styles.ts`
  after changing how they play.
- In a Spin & Go, chips are valued as prize money.

## License

MIT. Take it and run with it.
