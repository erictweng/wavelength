// End-to-end test for written-spectrum / 1-20 target mode. 2 players:
// start -> A composes spectrum + hint (sees target) -> B guesses -> reveal ->
// swap roles -> new game. Verifies target is sent ONLY to the clue-giver.
const { io } = require("socket.io-client");
const assert = require("assert");
const URL = "http://localhost:3000";
const once = (s, e) => new Promise((r) => s.once(e, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expectedScore(target, guess) {
  const d = Math.abs(target - guess);
  if (d === 0) return 4; if (d === 1) return 3; if (d === 2) return 2; if (d === 3) return 1;
  return 0;
}

(async () => {
  const A = io(URL), B = io(URL);
  await Promise.all([once(A, "connect"), once(B, "connect")]);
  let sa = null, sb = null;
  A.on("state", (s) => (sa = s));
  B.on("state", (s) => (sb = s));

  const created = await new Promise((r) => A.emit("createRoom", { name: "Alice" }, r));
  assert(created.ok); const code = created.code;
  const joined = await new Promise((r) => B.emit("joinRoom", { code, name: "Bob" }, r));
  assert(joined.ok, JSON.stringify(joined));
  await sleep(120);
  assert.strictEqual(sa.phase, "lobby");
  console.log("Lobby ready ✓");

  // Start the game (any player).
  const started = await new Promise((r) => B.emit("startGame", {}, r));
  assert(started.ok, JSON.stringify(started));
  await sleep(120);
  assert.strictEqual(sa.phase, "compose");

  const giverIsA = sa.youAreGiver;
  const giverState = giverIsA ? sa : sb;
  const guesserState = giverIsA ? sb : sa;
  const giverSock = giverIsA ? A : B;
  const guesserSock = giverIsA ? B : A;

  // Target must be 1-20 and visible only to the clue-giver.
  const target = giverState.round.target;
  assert(Number.isInteger(target) && target >= 1 && target <= 20, "bad target " + target);
  assert.strictEqual(guesserState.round.target, undefined, "TARGET LEAKED to guesser!");
  console.log("Compose: clue-giver is", giverState.clueGiverName, "| secret target", target, "(hidden from guesser ✓)");

  // Guesser shouldn't even have the spectrum ends yet (giver still composing).
  assert.strictEqual(guesserState.round.leftLabel, null, "spectrum leaked before submit");

  // Clue-giver submits spectrum + hint.
  const sub = await new Promise((r) =>
    giverSock.emit("submitRound", { leftLabel: "Cold", rightLabel: "Hot", hint: "a warm mug" }, r)
  );
  assert(sub.ok, JSON.stringify(sub));
  await sleep(120);
  assert.strictEqual(sa.phase, "guess");
  const gs = giverIsA ? sb : sa; // guesser state now
  assert.strictEqual(gs.round.leftLabel, "Cold");
  assert.strictEqual(gs.round.rightLabel, "Hot");
  assert.strictEqual(gs.round.hint, "a warm mug");
  assert.strictEqual(gs.round.target, undefined, "target leaked during guess!");
  console.log("Spectrum + hint delivered, target still hidden ✓");

  // Guesser locks a number; test exact-hit scoring.
  await new Promise((r) => guesserSock.emit("lockGuess", { value: target }, r));
  await sleep(150);
  assert.strictEqual(sa.phase, "reveal");
  const r = sa.round;
  assert.strictEqual(r.results.length, 1);
  assert.strictEqual(r.results[0].score, expectedScore(target, target)); // exact = 4
  assert.strictEqual(r.results[0].score, 4, "exact guess should be 4 points");
  assert.strictEqual(sa.totalScore, 4);
  assert.strictEqual(sb.round.target, target, "everyone sees target at reveal");
  console.log("Reveal: exact guess scored +4, total", sa.totalScore, "✓");

  // Verify the score curve directly.
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4].map((d) => expectedScore(10, 10 + d)),
    [4, 3, 2, 1, 0],
    "score curve mismatch"
  );
  console.log("Score curve 0/1/2/3/4 off -> 4/3/2/1/0 ✓");

  // Next turn -> roles swap, fresh target, guesser can't see it.
  A.emit("nextTurn");
  await sleep(150);
  assert.strictEqual(sa.phase, "compose");
  assert.strictEqual(sa.turnNumber, 2);
  assert.notStrictEqual(sa.youAreGiver, giverIsA, "roles did not swap");
  const newGuesser = sa.youAreGiver ? sb : sa;
  assert.strictEqual(newGuesser.round.target, undefined, "target leaked after swap");
  console.log("Turn 2: roles swapped, new secret target hidden ✓ (giver now", sa.clueGiverName + ")");

  // New game resets everything.
  B.emit("newGame");
  await sleep(150);
  assert.strictEqual(sa.phase, "lobby");
  assert.strictEqual(sa.totalScore, 0);
  assert.strictEqual(sa.turnNumber, 0);
  console.log("New game resets to lobby ✓");

  console.log("\nALL TESTS PASSED ✅");
  A.close(); B.close(); process.exit(0);
})().catch((e) => { console.error("TEST FAILED ❌", e); process.exit(1); });
