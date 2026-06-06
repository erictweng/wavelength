/* Wavelength — client. Each turn the clue-giver writes a spectrum, secretly
   sees a 1-20 target, and hints; everyone else guesses the number. The server
   sends each player a tailored state — only the clue-giver receives the target
   before reveal, so guessers never have the answer to peek at. */

const socket = io();

const state = {
  me: null,
  joined: false,
  data: null,
  lockedTurn: null,    // turn we locked a guess for
  submittedTurn: null, // turn we (as giver) submitted the round for
  renderedTurn: null,  // for resetting inputs once per turn
};

const $ = (id) => document.getElementById(id);
const screens = ["home", "lobby", "compose", "guess", "reveal"];
const SMIN = 1, SMAX = 20;

function showScreen(name) {
  for (const s of screens) $("screen-" + s).classList.toggle("active", s === name);
}
function setError(id, msg) { $(id).textContent = msg || ""; }
function show(el, on) { el.classList.toggle("hidden", !on); }
function pct(v) { return ((v - SMIN) / (SMAX - SMIN)) * 100; }

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
  socket.emit("startGame", {}, (res) => {
    if (!res || !res.ok) $("lobby-hint").textContent = (res && res.error) || "Could not start.";
  });
});

/* ---- Compose (clue-giver) --------------------------------------------- */
$("btn-submit-round").addEventListener("click", submitRound);
function submitRound() {
  const leftLabel = $("left-input").value.trim();
  const rightLabel = $("right-input").value.trim();
  const hint = $("hint-input").value.trim();
  if (!leftLabel || !rightLabel) return setError("compose-error", "Fill in both ends of the spectrum.");
  if (!hint) return setError("compose-error", "Type a hint.");
  socket.emit("submitRound", { leftLabel, rightLabel, hint }, (res) => {
    if (!res || !res.ok) return setError("compose-error", (res && res.error) || "Could not send.");
    state.submittedTurn = state.data ? state.data.turnNumber : null;
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

/* ---- Reveal ----------------------------------------------------------- */
$("btn-next").addEventListener("click", () => socket.emit("nextTurn"));
$("btn-newgame").addEventListener("click", () => socket.emit("newGame"));

/* ---- State pump ------------------------------------------------------- */
socket.on("state", (data) => { state.data = data; if (state.joined) render(); });

function render() {
  const d = state.data;
  if (!d) return;
  if (d.phase === "lobby") return renderLobby(d);
  if (d.phase === "compose") return renderCompose(d);
  if (d.phase === "guess") return renderGuess(d);
  if (d.phase === "reveal") return renderReveal(d);
}

function renderLobby(d) {
  showScreen("lobby");
  $("room-code").textContent = d.code;
  $("lobby-players").innerHTML = d.players
    .map((p) => `<li class="${p.connected ? "" : "off"}${p.id === state.me ? " you" : ""}">${escapeHtml(p.name)}${p.isHost ? " ⭐" : ""}</li>`)
    .join("");
  const enough = d.players.filter((p) => p.connected).length >= 2;
  $("lobby-hint").textContent = enough ? "Everyone in? Tap start." : "Waiting for at least 2 players…";
  $("btn-start").disabled = !enough;
}

function renderCompose(d) {
  showScreen("compose");
  $("compose-turn").textContent = "Turn " + d.turnNumber;
  $("compose-score").textContent = d.totalScore;
  if (state.renderedTurn !== d.turnNumber) { resetInputs(); state.renderedTurn = d.turnNumber; }

  const giver = d.youAreGiver;
  show($("compose-giver-view"), giver);
  show($("compose-wait-view"), !giver);

  if (giver) {
    $("compose-target").textContent = d.round.target; // giver-only
  } else {
    $("compose-wait-text").textContent = `Waiting for ${d.clueGiverName} to set up the round…`;
  }
}

function renderGuess(d) {
  showScreen("guess");
  $("guess-turn").textContent = "Turn " + d.turnNumber;
  $("guess-score").textContent = d.totalScore;

  const giver = d.youAreGiver;
  const guesser = !giver;
  const locked = state.lockedTurn === d.turnNumber;

  show($("guess-active-view"), guesser && !locked);
  show($("guess-wait-view"), giver || locked);

  if (guesser && !locked) {
    if (!$("tick-row").childElementCount) buildTicks();
    $("hint-from").textContent = `${d.clueGiverName}'s hint`;
    $("hint-text").textContent = d.round.hint || "…";
    $("guess-left").textContent = d.round.leftLabel;
    $("guess-right").textContent = d.round.rightLabel;
  } else {
    $("guess-your-hint-from").textContent = giver ? "Your hint" : "The hint";
    $("guess-your-hint").textContent = d.round.hint || "…";
    $("guess-left-2").textContent = d.round.leftLabel;
    $("guess-right-2").textContent = d.round.rightLabel;
    const total = d.guesserIds.length;
    const done = d.players.filter((p) => d.guesserIds.includes(p.id) && p.hasGuessed).length;
    $("guess-wait-text").textContent = giver
      ? `Waiting for the guess… (${done}/${total})`
      : `Locked in. Waiting for others… (${done}/${total})`;
  }
}

function renderReveal(d) {
  showScreen("reveal");
  const r = d.round;
  $("reveal-turn").textContent = "Turn " + d.turnNumber;
  $("reveal-score").textContent = d.totalScore;
  $("reveal-hint-from").textContent = `${d.clueGiverName}'s hint`;
  $("reveal-hint").textContent = r.hint || "—";
  $("reveal-left").textContent = r.leftLabel;
  $("reveal-right").textContent = r.rightLabel;

  $("target-marker").style.left = pct(r.target) + "%";
  $("target-flag").textContent = "★ " + r.target;

  $("guess-markers").innerHTML = (r.results || [])
    .map(
      (res) => `<div class="guess-marker" style="left:${pct(res.guess)}%" title="${escapeHtml(res.name)}: ${res.guess}">
          <span class="gm-name">${escapeHtml(firstName(res.name))}</span>
        </div>`
    )
    .join("");

  $("turn-score").textContent = "+" + r.turnScore;
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

  state.lockedTurn = null;
  state.submittedTurn = null;
  $("reveal-next-info").textContent = "Anyone can tap Next turn — the clue-giver role swaps.";
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

/* ---- utils ------------------------------------------------------------ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function firstName(n) { return String(n).split(" ")[0].slice(0, 8); }
