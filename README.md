# Wavelength 🎯

A fast, replayable party game inspired by *Wavelength*, played free-for-all like
skribbl.io. The **clue-giver** role rotates around the table. On your turn a
spectrum is in play (e.g. *Cold ⟷ Hot*), you secretly see a random target number
from **1–20**, and you give a hint that fits that spot. Everyone else reads the
spectrum + hint and **guesses the number**. Closest guesses score; the clue-giver
scores for getting people close. Highest individual score after the last round wins.

Play with **2 to 10 players**, on one device passed around or with everyone on
their own phone or laptop over a live connection.

## How it works

1. A player creates a game and gets a 4-letter room code; friends join with it.
2. The host picks the **number of rounds** and starts. (One round = everyone
   clue-gives once.)
3. The **clue-giver** sets the spectrum — pick a **preset category** or write your
   own two ends — secretly sees a number 1–20, and types a hint (no numbers!).
   Stuck on the current spectrum? Hit **Change category** right on your turn to swap it.
4. Everyone else slides to pick a number 1–20.
5. The reveal shows the target, each guess, points earned, and the live **standings**.
6. **Next turn** passes the clue-giver role to the next player, round-robin.
7. The spectrum **persists** across turns until the current clue-giver taps
   **Change spectrum**, handing the next clue-giver a blank one.
8. After the final round, a **winner screen** shows the leaderboard. **Play again**
   resets scores.

**Extras:** an exact guess (0 off) sets off **fireworks**, and a live **chat**
sidebar runs alongside the game the whole time. Chat uses its own lightweight
socket events (`chatMessage` / `chatHistory`) rather than riding on game-state
updates, so it keeps a large backlog (up to 1000 messages, 500 chars each) cheaply.

### Scoring (individual — no teams)

**Guessers** score by how far their guess is from the secret target:

| Off by | Points |
|--------|--------|
| 0 (exact) | 4 |
| 1 | 3 |
| 2 | 2 |
| 3 | 1 |
| 4+ | 0 |

**The clue-giver** scores **+1 for every guesser who landed points** that turn
(so if two people guessed close, the clue-giver gets +2). It rewards a hint that's
clear enough to land but not a giveaway.

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. To test multiplayer on one machine, open
several browser tabs/windows: create a game in one, join with the code in the others.

To play across phones on the same Wi-Fi, share your machine's local IP
(e.g. `http://192.168.1.20:3000`).

## Deploying

The app is a single Node server that serves the frontend and handles the live
Socket.IO connection — no database, no build step. It runs anywhere that supports
a persistent Node process and WebSockets:

- **Render / Railway / Fly.io / Heroku**: point the service at this repo,
  build command `npm install`, start command `npm start`. The server reads
  `process.env.PORT` automatically.

> Note: game state is held in memory, so all players in a game must connect to the
> same server instance. If you scale to multiple instances, add a shared store
> (e.g. a Redis adapter for Socket.IO) so rooms are shared across them.

## Project layout

```
server.js          Express + Socket.IO server: rooms, round-robin, scoring (target hidden here)
public/index.html  Screens: home, lobby, compose, guess, reveal, gameover + chat sidebar
public/styles.css  Styling (two-column layout)
public/app.js      Client: live socket connection + rendering
public/presets.js  Preset spectrum categories for quick-pick
test-e2e.js        Scripted 3-player end-to-end test (run with `npm test`)
data/items.js      Deprecated, unused (the old AI item bank); safe to delete
```

## Anti-cheat note

The server sends each player a **tailored** state. The secret target number goes
**only to the clue-giver** during the compose and guess phases (and to everyone at
reveal). Guessers never receive the number over the wire, so it cannot be inspected
early through the browser. The spectrum ends are also withheld from guessers until
the clue-giver submits them.
