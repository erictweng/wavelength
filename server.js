// Wavelength — real-time multiplayer game server.
// Each turn one player is the CLUE-GIVER: they write a spectrum (two ends),
// secretly see a random target number from 1-20, and give a hint. Everyone else
// guesses the number from the hint. Then roles rotate. The target is sent ONLY
// to the clue-giver (and to everyone at reveal), so it can't be peeked.

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

// Scoring: exact = 4, then step down by 1 per point of distance.
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

// Per-viewer state. The target number goes ONLY to the clue-giver before reveal;
// the spectrum ends and hint are shared once the clue-giver submits them.
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
      role: room.phase === "lobby" ? null : p.id === giver ? "clue" : "guesser",
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
    totalScore: room.totalScore,
    scaleMin: SCALE_MIN,
    scaleMax: SCALE_MAX,
    players,
  };

  if (!room.round) return base;

  const r = room.round;
  const submitted = room.phase === "guess" || room.phase === "reveal";
  const round = {
    // Spectrum ends are shared once submitted; before that only the giver knows.
    leftLabel: submitted || viewerId === giver ? r.leftLabel : null,
    rightLabel: submitted || viewerId === giver ? r.rightLabel : null,
    hint: submitted ? r.hint : null,
  };

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
    round.turnScore = r.turnScore;
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

// Begin a turn: roll a fresh secret target and let the clue-giver compose.
function startTurn(room) {
  room.turnNumber += 1;
  room.round = {
    leftLabel: null,
    rightLabel: null,
    hint: null,
    target: randomTarget(), // hidden — only the clue-giver receives it
    guesses: {},
    turnScore: null,
  };
  room.phase = "compose";
  broadcast(room);
}

function doReveal(room) {
  if (!room.round) return;
  const r = room.round;
  let turnScore = 0;
  for (const id of Object.keys(r.guesses)) {
    turnScore += calculateScore(r.target, r.guesses[id]);
  }
  r.turnScore = turnScore;
  room.totalScore += turnScore;
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
      totalScore: 0,
      round: null,
    };
    room.players[socket.id] = { id: socket.id, name: cleanName, connected: true };
    room.order.push(socket.id);
    rooms.set(code, room);
    socket.join(code);
    cb && cb({ ok: true, code, you: socket.id });
    broadcast(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = (code || "").toString().toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb && cb({ ok: false, error: "Room not found." });
    const cleanName = (name || "Player").toString().slice(0, 20).trim() || "Player";
    if (!room.players[socket.id]) {
      room.players[socket.id] = { id: socket.id, name: cleanName, connected: true };
      room.order.push(socket.id);
    }
    socket.join(code);
    cb && cb({ ok: true, code, you: socket.id });
    broadcast(room);
  });

  // Any player can start once there are at least 2 connected.
  socket.on("startGame", (_payload, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return cb && cb({ ok: false, error: "No room." });
    if (connectedPlayers(room).length < 2)
      return cb && cb({ ok: false, error: "Need at least 2 players to start." });
    cb && cb({ ok: true });
    startTurn(room);
  });

  // Clue-giver submits their written spectrum + hint -> guessing phase.
  socket.on("submitRound", ({ leftLabel, rightLabel, hint }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "compose") return;
    if (socket.id !== clueGiverId(room))
      return cb && cb({ ok: false, error: "Only the clue-giver sets the round." });
    const left = (leftLabel || "").toString().slice(0, 40).trim();
    const right = (rightLabel || "").toString().slice(0, 40).trim();
    const clue = (hint || "").toString().slice(0, 60).trim();
    if (!left || !right) return cb && cb({ ok: false, error: "Fill in both ends of the spectrum." });
    if (!clue) return cb && cb({ ok: false, error: "Type a hint." });
    room.round.leftLabel = left;
    room.round.rightLabel = right;
    room.round.hint = clue;
    room.phase = "guess";
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on("lockGuess", ({ value }, cb) => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "guess") return;
    if (!guesserIds(room).includes(socket.id)) return; // clue-giver can't guess
    let v = Number(value);
    if (!Number.isFinite(v)) v = Math.round((SCALE_MIN + SCALE_MAX) / 2);
    v = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(v)));
    room.round.guesses[socket.id] = v;
    cb && cb({ ok: true });
    broadcast(room);
    maybeReveal(room);
  });

  // Advance to next turn -> rotate clue-giver (roles swap).
  socket.on("nextTurn", () => {
    const room = findRoomBySocket(socket.id);
    if (!room || room.phase !== "reveal") return;
    const n = connectedPlayers(room).length;
    if (n >= 1) room.turnIndex = (room.turnIndex + 1) % n;
    startTurn(room);
  });

  socket.on("newGame", () => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    room.phase = "lobby";
    room.round = null;
    room.turnIndex = 0;
    room.turnNumber = 0;
    room.totalScore = 0;
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

    // If the clue-giver dropped mid-turn, fall back to the lobby.
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
