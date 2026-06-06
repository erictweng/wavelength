/* Wavelength — client. Round-robin: each turn one player is the clue-giver who
   secretly sees a 1-20 target and hints; everyone else guesses. The server sends
   each player a tailored state — only the clue-giver receives the target before
   reveal. Individual scores, fixed rounds, persistent spectrum with presets. */

const socket = io();

const state = {
  me: null,
  joined: false,
  data: null,
  lockedTurn: null,
  renderedTurn: null,
  messages: [],
  firedTurn: null,
};

const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "compose", "guess", "reveal", "gameover"];
const SMIN = 1, SMAX = 20;

function showScreen(name) {
  for (const s of screens) $("screen-" + s).classList.toggle("active", s === name);
}
function setError(id, msg) { $(id).textContent = msg || ""; }
function show(el, on) { el.classList.toggle("hidden", !on); }
function pct(v) { return ((v - SMIN) / (SMAX - SMIN)) * 100; }
function myScore(d) { const me = d.players.find((p) => p.id === state.me); return me ? me.score : 0; }

/* ---- Home ------------------------------------------------------------- */
$("btn-create").addEventListener("click", () => {
  const name = $("home-name").value.trim();
  if (!name) return setError("home-error", "Enter your name first.");
  setError("home-error", "");
  socket.emit("createRoom", { name }, (res) => {
    if (res && res.ok) { state.me = res.you; state.joined = true; }
  });
});
$("btn-join").addEventListener("click", joinGame);
$("home-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinGame(); });
function joinGame() {
  const name = $("home-name").value.trim();
  const code = $("home-code").value.trim().toUpperCase();
  if (!name) return setError("home-error", "Enter your name first.");
  if (code.length !== 4) return setError("home-error", "Enter the 4-letter room code.");
  setError("home-error", "");
  socket.emit("joinRoom", { code, name }, (res) => {
    if (!res || !res.ok) return setError("home-error", (res && res.error) || "Could not join.");
    state.me = res.you; state.joined = true;
  });
}

/* ---- Lobby ------------------------------------------------------------ */
$("room-code").addEventListener("click", () => {
  if (!state.data) return;
  navigator.clipboard?.writeText(state.data.code).catch(() => {});
  const el = $("room-code"); const prev = el.textContent;
  el.textContent = "Copied!"; setTimeout(() => (el.textContent = prev), 900);
});
$("btn-start").addEventListener("click", () => {
  const rounds = Number($("rounds-select").value) || 3;
  socket.emit("startGame", { rounds }, (res) => {
    if (!res || !res.ok) $("lobby-hint").textContent = (res && res.error) || "Could not start.";
  });
});

/* ---- Compose ---------------------------------------------------------- */
$("btn-submit-round").addEventListener("click", submitRound);
$("hint-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submitRound(); });
function submitRound() {
  const hint = $("hint-input").value.trim();
  if (!hint) return setError("compose-error", "Type a hint.");
  const payload = { hint };
  if (!state.data || !state.data.spectrum) {
    const leftLabel = $("left-input").value.trim();
    const rightLabel = $("right-input").value.trim();
    if (!leftLabel || !rightLabel) return setError("compose-error", "Set both ends of the spectrum.");
    payload.leftLabel = leftLabel;
    payload.rightLabel = rightLabel;
  }
  socket.emit("submitRound", payload, (res) => {
    if (!res || !res.ok) return setError("compose-error", (res && res.error) || "Could not send.");
  });
}

function buildPresets() {
  const wrap = $("preset-chips");
  if (wrap.childElementCount || !window.PRESETS) return;
  window.PRESETS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "preset-chip";
    b.innerHTML = `<b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.left)} ⟷ ${escapeHtml(p.right)}</span>`;
    b.addEventListener("click", () => {
      $("left-input").value = p.left;
      $("right-input").value = p.right;
    });
    wrap.appendChild(b);
  });
}

/* ---- Guess ------------------------------------------------------------ */
const slider = $("slider");
slider.addEventListener("input", () => { $("slider-value").textContent = slider.value; });
$("btn-lock").addEventListener("click", () => {
  socket.emit("lockGuess", { value: Number(slider.value) }, () => {});
  state.lockedTurn = state.data ? state.data.turnNumber : null;
  render();
});

/* ---- Reveal / gameover ------------------------------------------------ */
$("btn-next").addEventListener("click", () => socket.emit("nextTurn"));
$("btn-newgame").addEventListener("click", () => socket.emit("newGame"));
$("btn-change-spectrum").addEventListener("click", () => socket.emit("changeSpectrum"));
$("btn-change-compose").addEventListener("click", () => socket.emit("changeSpectrum"));
$("btn-playagain").addEventListener("click", () => socket.emit("newGame"));

/* ---- Chat ------------------------------------------------------------- */
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
function sendChat() {
  const text = $("chat-input").value.trim();
  if (!text) return;
  socket.emit("chat", { text });
  $("chat-input").value = "";
}
function appendChatMessage(m) {
  const list = $("chat-messages");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const div = document.createElement("div");
  div.className = "cmsg" + (m.id === state.me ? " mine" : "");
  div.innerHTML = `<span class="cname">${escapeHtml(m.name)}</span><span class="ctext">${escapeHtml(m.text)}</span>`;
  list.appendChild(div);
  if (atBottom) list.scrollTop = list.scrollHeight; // don't yank if scrolled up
}
function renderChatFull() {
  $("chat-messages").innerHTML = "";
  state.messages.forEach(appendChatMessage);
  const list = $("chat-messages");
  list.scrollTop = list.scrollHeight;
}

// Chat arrives on its own events, separate from game state.
socket.on("chatHistory", (msgs) => { state.messages = Array.isArray(msgs) ? msgs.slice() : []; renderChatFull(); });
socket.on("chatMessage", (m) => { state.messages.push(m); appendChatMessage(m); });

/* ---- State pump ------------------------------------------------------- */
socket.on("state", (data) => { state.data = data; if (state.joined) render(); });

function render() {
  const d = state.data;
  if (!d) return;
  $("chat").classList.remove("hidden");
  if (d.phase === "lobby") return renderLobby(d);
  if (d.phase === "compose") return renderCompose(d);
  if (d.phase === "guess") return renderGuess(d);
  if (d.phase === "reveal") return renderReveal(d);
  if (d.phase === "gameover") return renderGameover(d);
}

function roundLabel(d) { return `Round ${Math.min(d.roundNumber, d.roundsTarget)}/${d.roundsTarget}`; }

function renderLobby(d) {
  showScreen("lobby");
  $("room-code").textContent = d.code;
  $("lobby-players").innerHTML = d.players
    .map((p) => `<li class="${p.connected ? "" : "off"}${p.id === state.me ? " you" : ""}">${escapeHtml(p.name)}${p.isHost ? " ⭐" : ""}</li>`)
    .join("");
  const enough = d.players.filter((p) => p.connected).length >= 2;
  $("lobby-hint").textContent = enough ? "Everyone in? Set rounds and start." : "Waiting for at least 2 players…";
  const host = d.hostId === state.me;
  show($("rounds-field"), host);
  $("btn-start").disabled = !enough;
  $("btn-start").textContent = host ? "Start game" : "Waiting for host to start…";
}

function renderCompose(d) {
  showScreen("compose");
  $("compose-round").textContent = roundLabel(d);
  $("compose-score").textContent = myScore(d);
  if (state.renderedTurn !== d.turnNumber) { resetInputs(); state.renderedTurn = d.turnNumber; }

  const giver = d.youAreGiver;
  show($("compose-giver-view"), giver);
  show($("compose-wait-view"), !giver);

  if (giver) {
    const hasSpectrum = !!d.spectrum;
    show($("compose-setup"), !hasSpectrum);
    show($("compose-current"), hasSpectrum);
    if (!hasSpectrum) buildPresets();
    if (hasSpectrum) {
      $("compose-cur-left").textContent = d.spectrum.leftLabel;
      $("compose-cur-right").textContent = d.spectrum.rightLabel;
    }
    $("compose-target").textContent = d.round.target;
  } else {
    const setup = !d.spectrum;
    $("compose-wait-text").textContent = setup
      ? `Waiting for ${d.clueGiverName} to pick a spectrum…`
      : `${d.clueGiverName} is thinking of a hint…`;
  }
}

function renderGuess(d) {
  showScreen("guess");
  $("guess-round").textContent = roundLabel(d);
  $("guess-score").textContent = myScore(d);

  const giver = d.youAreGiver;
  const guesser = !giver;
  const locked = state.lockedTurn === d.turnNumber;
  show($("guess-active-view"), guesser && !locked);
  show($("guess-wait-view"), giver || locked);

  const spec = d.spectrum || { leftLabel: "", rightLabel: "" };
  if (guesser && !locked) {
    if (!$("tick-row").childElementCount) buildTicks();
    $("hint-from").textContent = `${d.clueGiverName}'s hint`;
    $("hint-text").textContent = d.round.hint || "…";
    $("guess-left").textContent = spec.leftLabel;
    $("guess-right").textContent = spec.rightLabel;
  } else {
    $("guess-your-hint-from").textContent = giver ? "Your hint" : "The hint";
    $("guess-your-hint").textContent = d.round.hint || "…";
    $("guess-left-2").textContent = spec.leftLabel;
    $("guess-right-2").textContent = spec.rightLabel;
    const total = d.guesserIds.length;
    const done = d.players.filter((p) => d.guesserIds.includes(p.id) && p.hasGuessed).length;
    $("guess-wait-text").textContent = giver
      ? `Waiting for guesses… (${done}/${total})`
      : `Locked in. Waiting for others… (${done}/${total})`;
  }
}

function renderReveal(d) {
  showScreen("reveal");
  const r = d.round;
  $("reveal-round").textContent = roundLabel(d);
  $("reveal-score").textContent = myScore(d);
  $("reveal-hint-from").textContent = `${d.clueGiverName}'s hint`;
  $("reveal-hint").textContent = r.hint || "—";
  const spec = d.spectrum || { leftLabel: "", rightLabel: "" };
  $("reveal-left").textContent = spec.leftLabel;
  $("reveal-right").textContent = spec.rightLabel;

  $("target-marker").style.left = pct(r.target) + "%";
  $("target-flag").textContent = "★ " + r.target;

  $("guess-markers").innerHTML = (r.results || [])
    .map(
      (res) => `<div class="guess-marker" style="left:${pct(res.guess)}%" title="${escapeHtml(res.name)}: ${res.guess}"><span class="gm-name">${escapeHtml(firstName(res.name))}</span></div>`
    )
    .join("");

  const n = r.giverScore || 0;
  $("giver-earned").textContent = `${d.clueGiverName} (clue-giver) earned +${n} — ${n} ${n === 1 ? "player" : "players"} guessed close.`;

  $("results-body").innerHTML = (r.results || [])
    .slice()
    .sort((a, b) => a.distance - b.distance)
    .map(
      (res) => `<tr>
        <td class="tname">${escapeHtml(res.name)}</td>
        <td>guessed ${res.guess}</td>
        <td>${res.distance} off</td>
        <td>+${res.score}</td>
      </tr>`
    )
    .join("");

  renderLeaderboard($("leaderboard-list"), d.players);

  state.lockedTurn = null;
  const changing = !d.spectrum;
  show($("btn-change-spectrum"), d.youAreGiver && !changing);
  $("reveal-next-info").textContent = changing
    ? "New spectrum will be written next turn."
    : "Tap Next turn — the clue-giver role passes on.";

  const bullseye = (r.results || []).some((res) => res.distance === 0);
  if (bullseye && state.firedTurn !== d.turnNumber) {
    state.firedTurn = d.turnNumber;
    launchFireworks(3200);
  }
}

function renderGameover(d) {
  showScreen("gameover");
  const sorted = d.players.slice().sort((a, b) => b.score - a.score);
  const top = sorted[0];
  $("winner-name").textContent = top ? top.name : "—";
  $("winner-sub").textContent = top ? `with ${top.score} point${top.score === 1 ? "" : "s"}` : "";
  renderLeaderboard($("final-leaderboard"), d.players);
  if (state.firedTurn !== "gameover") { state.firedTurn = "gameover"; launchFireworks(4000); }
}

function renderLeaderboard(ol, players) {
  const sorted = players.slice().sort((a, b) => b.score - a.score);
  ol.innerHTML = sorted
    .map((p, i) => `<li class="${p.id === state.me ? "you" : ""}">
        <span class="lb-rank">${i === 0 ? "👑" : i + 1}</span>
        <span class="lb-name">${escapeHtml(p.name)}${p.connected ? "" : " (left)"}</span>
        <span class="lb-score">${p.score}</span>
      </li>`)
    .join("");
}

function buildTicks() {
  const row = $("tick-row");
  row.innerHTML = "";
  for (let i = SMIN; i <= SMAX; i++) {
    const s = document.createElement("span");
    s.textContent = i;
    row.appendChild(s);
  }
}
function resetInputs() {
  slider.value = 10;
  $("slider-value").textContent = "10";
  $("left-input").value = "";
  $("right-input").value = "";
  $("hint-input").value = "";
  setError("compose-error", "");
}

/* ---- Fireworks --------------------------------------------------------- */
function launchFireworks(durationMs) {
  const canvas = $("fireworks");
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  function size() { canvas.width = window.innerWidth * dpr; canvas.height = window.innerHeight * dpr; }
  size();
  window.addEventListener("resize", size);
  canvas.classList.add("active");
  const W = () => canvas.width, H = () => canvas.height;
  const colors = ["#ffd166", "#6c5ce7", "#4cc9f0", "#ff7b72", "#51cf66", "#ffffff"];
  let particles = [];
  const start = performance.now();
  let lastBurst = 0;
  function burst(x, y) {
    const num = 60 + Math.floor(Math.random() * 40);
    const color = colors[Math.floor(Math.random() * colors.length)];
    for (let i = 0; i < num; i++) {
      const angle = (Math.PI * 2 * i) / num + Math.random() * 0.3;
      const speed = (2 + Math.random() * 4) * dpr;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, decay: 0.012 + Math.random() * 0.012, color, size: (1.5 + Math.random() * 2) * dpr });
    }
  }
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, W(), H());
    if (elapsed < durationMs && now - lastBurst > 320) {
      lastBurst = now;
      burst(W() * (0.2 + Math.random() * 0.6), H() * (0.2 + Math.random() * 0.4));
    }
    particles.forEach((p) => {
      p.vy += 0.04 * dpr; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    });
    particles = particles.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;
    if (elapsed < durationMs || particles.length) requestAnimationFrame(frame);
    else { canvas.classList.remove("active"); window.removeEventListener("resize", size); }
  }
  requestAnimationFrame(frame);
}

/* ---- utils ------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function firstName(n) { return String(n).split(" ")[0].slice(0, 8); }
