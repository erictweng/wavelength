// End-to-end test: round-robin, per-player + clue-giver scoring, fixed rounds,
// persistent spectrum, target hidden from guessers. Uses 3 players, 1 round.
const { io } = require("socket.io-client");
const assert = require("assert");
const URL = "http://localhost:3000";
const once = (s, e) => new Promise((r) => s.once(e, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const expectedScore = (t, g) => {
  const d = Math.abs(t - g);
  return d === 0 ? 4 : d === 1 ? 3 : d === 2 ? 2 : d === 3 ? 1 : 0;
};

(async () => {
  // --- Player cap: room holds up to 10, rejects the 11th ---
  const capHost = io(URL);
  await once(capHost, "connect");
  const capCreated = await new Promise((r) => capHost.emit("createRoom", { name: "P1" }, r));
  const capCode = capCreated.code;
  const extras = [];
  for (let i = 2; i <= 10; i++) {
    const s = io(URL);
    await once(s, "connect");
    const res = await new Promise((r) => s.emit("joinRoom", { code: capCode, name: "P" + i }, r));
    assert(res.ok, "player " + i + " should join");
    extras.push(s);
  }
  const eleventh = io(URL);
  await once(eleventh, "connect");
  const full = await new Promise((r) => eleventh.emit("joinRoom", { code: capCode, name: "P11" }, r));
  assert.strictEqual(full.ok, false, "11th player should be rejected");
  assert(/full/i.test(full.error), "expected a 'full' error, got: " + full.error);
  console.log("Player cap: 10 joined, 11th rejected ✓");
  [capHost, eleventh, ...extras].forEach((s) => s.close());
  await sleep(80);

  const socks = [io(URL), io(URL), io(URL)];
  await Promise.all(socks.map((s) => once(s, "connect")));
  const st = [null, null, null];
  const chat = [[], [], []]; // chat now arrives on its own events, not in state
  socks.forEach((s, i) => {
    s.on("state", (x) => (st[i] = x));
    s.on("chatHistory", (msgs) => (chat[i] = msgs.slice()));
    s.on("chatMessage", (m) => chat[i].push(m));
  });
  const names = ["Alice", "Bob", "Cara"];

  const created = await new Promise((r) => socks[0].emit("createRoom", { name: names[0] }, r));
  const code = created.code;
  await new Promise((r) => socks[1].emit("joinRoom", { code, name: names[1] }, r));
  await new Promise((r) => socks[2].emit("joinRoom", { code, name: names[2] }, r));
  await sleep(140);
  assert.strictEqual(st[0].phase, "lobby");
  assert.strictEqual(st[0].players.length, 3);
  console.log("Lobby: 3 players ✓");

  // Host starts a 1-round game.
  const started = await new Promise((r) => socks[0].emit("startGame", { rounds: 1 }, r));
  assert(started.ok, JSON.stringify(started));
  await sleep(140);
  assert.strictEqual(st[0].phase, "compose");
  assert.strictEqual(st[0].roundsTarget, 1);

  const giverIdx = (s) => socks.findIndex((_, i) => st[i] && st[i].youAreGiver);
  const sockById = (id) => socks[st.findIndex((x) => x && x.you === id)];

  // Play one full round = 3 turns (each player clue-gives once).
  let firstSpectrum = null;
  for (let turn = 0; turn < 3; turn++) {
    assert.strictEqual(st[0].phase, "compose", "expected compose at turn " + turn);
    const gi = giverIdx();
    const gState = st[gi];
    const target = gState.round.target;
    assert(target >= 1 && target <= 20, "bad target");

    // Every non-giver must NOT see the target.
    st.forEach((s, i) => {
      if (i !== gi) assert.strictEqual(s.round.target, undefined, "target leaked to " + names[i]);
    });

    // On turn 2 (spectrum persists), test that a stuck clue-giver can change it
    // mid-compose: it clears, the phase stays compose, and they rewrite the ends.
    if (turn === 1) {
      assert.deepStrictEqual(st[0].spectrum, firstSpectrum, "spectrum should persist into turn 2");
      socks[gi].emit("changeSpectrum");
      await sleep(120);
      assert.strictEqual(st[0].spectrum, null, "compose-time change should clear spectrum");
      assert.strictEqual(st[0].phase, "compose", "should stay in compose after change");
      console.log("Compose-time spectrum change works ✓");
    }

    // Submit: write spectrum only on a setup turn (none set); it persists after.
    const payload = { hint: "hint-" + turn };
    if (!st[gi].spectrum) { payload.leftLabel = "Cold"; payload.rightLabel = "Hot"; }
    const sub = await new Promise((r) => socks[gi].emit("submitRound", payload, r));
    assert(sub.ok, "submit failed turn " + turn + ": " + JSON.stringify(sub));
    await sleep(120);
    assert.strictEqual(st[0].phase, "guess");

    if (turn === 0) { firstSpectrum = st[0].spectrum; assert.deepStrictEqual(firstSpectrum, { leftLabel: "Cold", rightLabel: "Hot" }); }
    else assert.deepStrictEqual(st[0].spectrum, firstSpectrum, "spectrum should persist across turns");

    // The two guessers lock: one exact (+4, counts for giver), one far (+0).
    const guessers = st[gi].guesserIds;
    await new Promise((r) => sockById(guessers[0]).emit("lockGuess", { value: target }, r));      // exact
    const far = target <= 10 ? 20 : 1;
    await new Promise((r) => sockById(guessers[1]).emit("lockGuess", { value: far }, r));          // miss
    await sleep(160);
    assert.strictEqual(st[0].phase, "reveal", "expected reveal turn " + turn);

    const r = st[0].round;
    assert.strictEqual(r.results.length, 2, "expected 2 guesser results");
    // Giver earns +1 per guesser who scored. Exact scores, far (>=4 off) scores 0.
    const expGiver = r.results.filter((x) => x.score > 0).length;
    assert.strictEqual(r.giverScore, expGiver, "giverScore wrong");
    assert.strictEqual(r.giverScore, 1, "exactly one guesser should have scored");
    console.log(`Turn ${turn + 1}: giver ${gState.clueGiverName} target ${target} -> giver +${r.giverScore}, results ok ✓`);

    if (turn < 2) {
      socks[0].emit("nextTurn");
      await sleep(150);
    }
  }

  // After the 3rd turn of round 1, advancing should end the game.
  socks[0].emit("nextTurn");
  await sleep(160);
  assert.strictEqual(st[0].phase, "gameover", "game should be over after 1 round");
  console.log("Game over after 1 full round ✓");

  // Score check: each player clue-gave once (+1) and guessed twice.
  // Over 3 turns: each turn one exact (+4) and one miss (+0); giver +1.
  // Total points distributed = 3 turns * (4 + 0 + 1) = 15.
  const total = st[0].players.reduce((a, p) => a + p.score, 0);
  assert.strictEqual(total, 15, "total points mismatch: " + total);
  const sorted = st[0].players.slice().sort((a, b) => b.score - a.score);
  console.log("Final standings:", sorted.map((p) => `${p.name}:${p.score}`).join(", "), "✓");

  // Chat now flows via dedicated events; a long message (> old 200 cap) is fine.
  const longMsg = "g".repeat(300);
  socks[1].emit("chat", { text: longMsg });
  await sleep(120);
  assert.strictEqual(chat[2].at(-1).text, longMsg, "long message should pass (raised limit)");
  assert.strictEqual(chat[2].at(-1).name, "Bob");
  assert.strictEqual(st[2].messages, undefined, "chat should NOT be bundled in game state");
  console.log("Chat via dedicated event ✓ (300-char message delivered, not in state)");

  // Play again resets to lobby with zeroed scores.
  socks[0].emit("newGame");
  await sleep(150);
  assert.strictEqual(st[0].phase, "lobby");
  assert.strictEqual(st[0].players.reduce((a, p) => a + p.score, 0), 0);
  assert.strictEqual(st[0].spectrum, null);
  console.log("Play again resets ✓");

  console.log("\nALL TESTS PASSED ✅");
  socks.forEach((s) => s.close());
  process.exit(0);
})().catch((e) => { console.error("TEST FAILED ❌", e); process.exit(1); });
