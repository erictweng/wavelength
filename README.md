# Wavelength 🎯

A fast, replayable party game inspired by *Wavelength*. Each turn one player —
the **clue-giver** — writes a spectrum (two opposite ends, e.g. *Cold ⟷ Hot*),
secretly sees a random target number from **1–20**, and gives a hint that fits
that spot on the spectrum. Everyone else reads the spectrum and hint and **guesses
the number**. The closer the guess, the more points the group scores. Then the
clue-giver role rotates.

Play with **2 or more**, on one device passed around or with everyone on their own
phone or laptop over a live connection.

## How a turn works

1. A player creates a game and gets a 4-letter room code; friends join with it.
2. Any player taps **Start**. One player is the clue-giver.
3. The **clue-giver** writes the two ends of a spectrum, secretly sees a number
   from 1–20, and types a hint (no numbers!) that lands on that spot.
4. The **guessers** read the spectrum + hint and slide to pick a number 1–20.
5. The reveal shows the target, every guess, how far off each was, and the points.
6. **Next turn → roles swap** — the new clue-giver writes a fresh spectrum. It
   keeps going until you hit **New game** to reset the score.

With more than 2 players, the clue-giver role rotates each turn and everyone else
guesses.

**Extras:** a nail-on-the-head exact guess (0 off) sets off **fireworks**, and
there's a live **room chat** in every screen so players can talk, argue, and
gloat in real time.

### Scoring

Cooperative — the group works together. Based on how far the guess is from the
secret target:

| Off by | Points |
|--------|--------|
| 0 (exact) | 4 |
| 1 | 3 |
| 2 | 2 |
| 3 | 1 |
| 4+ | 0 |

With multiple guessers, each guesser's points are added to a running group total.
**New game** resets it.

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
server.js          Express + Socket.IO server: rooms, turn rotation, scoring (target hidden here)
public/index.html  Screens: home, lobby, compose, guess, reveal
public/styles.css  Styling
public/app.js      Client: live socket connection + rendering
test-e2e.js        Scripted 2-player end-to-end test (run with `npm test`)
data/items.js      Deprecated, unused (the old AI item bank); safe to delete
```

## Anti-cheat note

The server sends each player a **tailored** state. The secret target number goes
**only to the clue-giver** during the compose and guess phases (and to everyone at
reveal). Guessers never receive the number over the wire, so it cannot be inspected
early through the browser. The spectrum ends are also withheld from guessers until
the clue-giver submits them.
