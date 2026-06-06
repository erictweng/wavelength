// Wavelength — real-time multiplayer game server (skribbl-style round robin).
// Turns rotate through every player. On your turn you're the CLUE-GIVER: a
// spectrum (persistent, written or picked from a preset) is in play, you secretly
// see a random 1-20 target, and you give a hint. Everyone else guesses the number.
// Guessers score by distance; the clue-giver scores +1 per guesser who scored.
// Play runs a fixed number of rounds, then a winner screen.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const SCALE_MIN = 1;
const SCALE_MAX = 20;
const MAX_ROUNDS = 10;
const MAX_PLAYERS = 10;
const MAX_MESSAGES = 1000; // chat history kept per room (sent once on join)
const MAX_MSG_LEN = 500;   // per-message character limit

/** @type {Map<string, any>} */
const rooms = new Map();

// ---- Helpers ----------------------------------------------------------------

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      alphabet[Math.floor(Math.random() * alphabet.length)]
    ).join("");
  } while (rooms.has(code));
  return code;
}

function randomTarget() {
  return Math.floor(Math.random() * (SCALE_MAX - SCALE_MIN + 1)) + SCALE_MIN;
}

// Guesser score: exact = 4, then -1 per point of distance, floor 0.
function calculateScore(target, guess) {
  const distance = Math.abs(target - guess);
  if (distance === 0) return 4;
  if (distance === 1) return 3;
  if (distance === 2) return 2;
  if (distance === 3) return 1;
  return 0;
}

function connectedPlayers(room) {
  return room.order.map((id) => room.players[id]).filter((p) => p && p.connected);
}

function clueGiverId(room) {
  const active = connectedPlayers(room);
  if (!active.length) return null;
  return active[room.turnIndex % active.length].id;
}

function guesserIds(room) {
  const giver = clueGiverId(room);
  return connectedPlayers(room).filter((p) => p.id !== giver).map((p) => p.id);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) if (room.players[socketId]) return room;
  return null;
}

function publicState(room, viewerId) {
  const giver = clueGiverId(room);
  const guessers = guesserIds(room);

  const players = room.order
    .map((id) => room.players[id])
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
      score: p.score,
      role: room.phase === "lobby" || room.phase === "gameover" ? null : p.id === giver ? "clue" : "guesser",
      hasGuessed: room.round ? room.round.guesses[p.id] != null : false,
    }));

  const base = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    you: viewerId,
    youAreGiver: viewerId === giver,
    clueGiverId: giver,
    clueGiverName: giver && room.players[giver] ? room.players[giver].name : null,
    guesserIds: guessers,
    turnNumber: room.turnNumber,
    roundNumber: room.roundNumber,
    roundsTarget: room.roundsTarget,
    scaleMin: SCALE_MIN,
    scaleMax: SCALE_MAX,
    spectrum: room.spectrum || null,
    players,
  };

  if (!room.round) return base;

  const r = room.round;
  const submitted = room.phase === "guess" || room.phase === "reveal";
  const round = { hint: submitted ? r.hint : null };

  const canSeeTarget = room.phase === "reveal" || viewerId === giver;
  if (canSeeTarget) round.target = r.target;

  if (room.phase === "reveal") {
    round.results = room.order
      .map((id) => room.players[id])
      .filter((p) => p && r.guesses[p.id] != null)
      .map((p) => {
        const guess = r.guesses[p.id];
        return {
          id: p.id,
          name: p.name,
          guess,
          distance: Math.abs(r.target - guess),
          score: calculateScore(r.target, guess),
        };
      });
    round.giverScore = r.giverScore;
  }

  return { ...base, round };
}

function broadcast(room) {
  for (const id of Object.keys(room.players)) {
    if (!room.players[id].connected) continue;
    const sock = io.sockets.sockets.get(id);
    if (sock) sock.emit("state", publicState(room, id));
  }
}

function startTurn(room) {
  room.turnNumber += 1;
  room.round = {
    hint: null,
    target: randomTarget(), // hidden — only the clue-giver receives it
    guesses: {},
    giverScore: null,
  };
  room.phase = "compose";
  broadcast(room);
}

function doReveal(room) {
  if (!room.round) return;
  const r = room.round;
  const giver = clueGiverId(room);
  let giverScore = 0;
  for (const id of Object.keys(r.guesses)) {
    const s = calculateScore(r.target, r.guesses[id]);
    if (room.players[id]) room.players[id].score += s;
    if (s > 0) giverScore += 1; // +1 per guesser who scored
  }
  if (giver && room.players[giver]) room.players[giver].score += giverScore;
  r.giverScore = giverScore;
  room.phase = "reveal";
  broadcast(room);
}

function maybeReveal(room) {
  if (room.phase !== "guess") return;
  const guessers = guesserIds(room);
  if (!guessers.length) return;
  if (guessers.every((id) => room.round.guesses[id] != null)) doReveal(room);
}

// ---- Socket handlers --------------------------------------------------------

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name }, cb) => {
    const cleanName = (name || "Player").toString().slice(0, 20).trim() || "Player";
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      players: {},
      order: [],
      turnIndex: 0,
      turnNumber: 0,
      roundNumber: 1,
      roundsTarget: 3,
      spectrum: null,
      round: null,
      messages: [],
    };
    room.players[socket.id] = { id: socket.id, name: cleanName, connected: true, score: 0 };
    room.order.push(socket.id);
    rooms.set(code, room);
    socket.join(code);
    cb && cb({ ok: true, code, you: socket.id });
    socket.emit("chatHistory", room.messages);
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toString().toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    const cleanName = (name || "Player").toString().slice(0, 20).trim() || "Player";
    if (!room.players[socket.id]) {
      if (connectedPlayers(room).length >= MAX_PLAYERS)
        return cb && cb({ ok: false, error: `Room is full (${MAX_PLAYERS} players max).` });
      room.players[socket.id] = { id: socket.id, name: cleanName, connected: true, score: 0 };
      room.order.push(socket.id);
    }
    socket.join(code);
    cb && cb({ ok: true, code, you: socket.id });
    socket.emit("chatHistory", room.messages);
    broadcast(room);
  });

  // Any player can start once there are 2+; host's chosen round count is used.
  socket.on("startGame", ({ rounds } = {}, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return cb && cb({ ok: false, error: "No room." });
    if (connectedPlayers(room).length < 2)
      return cb && cb({ ok: false, error: "Need at least 2 players to start." });
    let n = parseInt(rounds, 10);
    if (!Number.isFinite(n)) n = 3;
    room.roundsTarget = Math.max(1, Math.min(MAX_ROUNDS, n));
    room.roundNumber = 1;
    room.turnIndex = 0;
    room.turnNumber = 0;
    for (const id of Object.keys(room.players)) room.players[id].score = 0;
    cb && cb({ ok: true });
    startTurn(room);
  });

  // Clue-giver submits a hint (and the spectrum ends only on a setup turn).
  socket.on("submitRound", ({ leftLabel, rightLabel, hint }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "compose") return;
    if (socket.id !== clueGiverId(room))
      return cb && cb({ ok: false, error: "Only the clue-giver sets the round." });
    const clue = (hint || "").toString().slice(0, 60).trim();
    if (!clue) return cb && cb({ ok: false, error: "Type a hint." });

    if (!room.spectrum) {
      const left = (leftLabel || "").toString().slice(0, 40).trim();
      const right = (rightLabel || "").toString().slice(0, 40).trim();
      if (!left || !right) return cb && cb({ ok: false, error: "Set both ends of the spectrum." });
      room.spectrum = { leftLabel: left, rightLabel: right };
    }

    room.round.hint = clue;
    room.phase = "guess";
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on("lockGuess", ({ value }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "guess") return;
    if (!guesserIds(room).includes(socket.id)) return;
    let v = Number(value);
    if (!Number.isFinite(v)) v = Math.round((SCALE_MIN + SCALE_MAX) / 2);
    v = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(v)));
    room.round.guesses[socket.id] = v;
    cb && cb({ ok: true });
    broadcast(room);
    maybeReveal(room);
  });

  // Clear the spectrum so a fresh one gets written. The current clue-giver can do
  // this during their own compose turn (if stuck) or on the reveal screen (for
  // the next clue-giver). Either way it just unsets the spectrum.
  socket.on("changeSpectrum", () => {
    const room = findRoomBySocket(socket.id);
    if (!room || (room.phase !== "reveal" && room.phase !== "compose")) return;
    if (socket.id !== clueGiverId(room)) return;
    room.spectrum = null;
    broadcast(room);
  });

  // Advance to next turn -> rotate clue-giver; end after the target rounds.
  socket.on("nextTurn", () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "reveal") return;
    const n = connectedPlayers(room).length;
    if (n < 1) return;
    room.turnIndex = (room.turnIndex + 1) % n;
    if (room.turnIndex === 0) room.roundNumber += 1; // completed a full cycle
    if (room.roundNumber > room.roundsTarget) {
      room.phase = "gameover";
      room.round = null;
      broadcast(room);
      return;
    }
    startTurn(room);
  });

  // Chat is its own lightweight event — not bundled into game-state broadcasts.
  // Only the single new message goes out; history is sent once on join.
  socket.on("chat", ({ text }) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    const clean = (text || "").toString().slice(0, MAX_MSG_LEN).trim();
    if (!clean) return;
    const msg = { id: socket.id, name: player.name, text: clean, ts: Date.now() };
    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES) room.messages.shift();
    io.to(room.code).emit("chatMessage", msg);
  });

  socket.on("newGame", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    room.phase = "lobby";
    room.round = null;
    room.spectrum = null;
    room.turnIndex = 0;
    room.turnNumber = 0;
    room.roundNumber = 1;
    for (const id of Object.keys(room.players)) room.players[id].score = 0;
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    const player = room.players[socket.id];
    if (player) player.connected = false;

    if (room.hostId === socket.id) {
      const next = connectedPlayers(room)[0];
      if (next) room.hostId = next.id;
    }

    if (connectedPlayers(room).length === 0) {
      setTimeout(() => {
        const r = rooms.get(room.code);
        if (r && connectedPlayers(r).length === 0) rooms.delete(room.code);
      }, 60 * 1000);
      return;
    }

    if ((room.phase === "compose" || room.phase === "guess") && !clueGiverId(room)) {
      room.phase = "lobby";
      room.round = null;
    }
    broadcast(room);
    maybeReveal(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wavelength running on http://localhost:${PORT}`);
});
