// Robust test suite for the chat system (dedicated chatMessage/chatHistory events).
// Boot the server first (npm start), then: node test-chat.js
const { io } = require("socket.io-client");
const assert = require("assert");
const URL = "http://localhost:3000";
const once = (s, e) => new Promise((r) => s.once(e, r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(msg) { passed++; console.log("  ✓ " + msg); }

// A connected client that records its own chat stream + latest game state.
async function client() {
  const s = io(URL);
  await once(s, "connect");
  const c = { s, msgs: [], history: null, state: null };
  s.on("chatHistory", (m) => { c.history = m.slice(); c.msgs = m.slice(); });
  s.on("chatMessage", (m) => c.msgs.push(m));
  s.on("state", (x) => (c.state = x));
  return c;
}
const create = (c, name) => new Promise((r) => c.s.emit("createRoom", { name }, r));
const join = (c, code, name) => new Promise((r) => c.s.emit("joinRoom", { code, name }, r));
const say = (c, text) => c.s.emit("chat", { text });
const last = (c) => c.msgs[c.msgs.length - 1];

(async () => {
  console.log("CHAT TEST SUITE\n");

  /* 1. Broadcast to all members + sender identity + consistent ordering --- */
  console.log("1. Broadcast, identity, ordering");
  {
    const a = await client(), b = await client();
    const { code } = await create(a, "Alice");
    await join(b, code, "Bob");
    await sleep(80);

    // Strict per-sender ordering: send sequentially from one socket, awaiting.
    for (let i = 1; i <= 4; i++) { say(a, "A" + i); await sleep(25); }
    // Interleave a message from the other sender too.
    say(b, "B1");
    await sleep(200);

    assert.strictEqual(a.msgs.length, 5, "sender sees all 5");
    assert.strictEqual(b.msgs.length, 5, "other sees all 5");
    // Everyone sees the SAME transcript in the SAME order (server is the order of record).
    assert.deepStrictEqual(a.msgs.map((m) => m.text), b.msgs.map((m) => m.text), "both clients agree on order");
    // A single sender's messages keep their relative order.
    const aOnly = a.msgs.filter((m) => m.name === "Alice").map((m) => m.text);
    assert.deepStrictEqual(aOnly, ["A1", "A2", "A3", "A4"], "one sender's order preserved");
    // Identity + metadata.
    const bMsg = a.msgs.find((m) => m.text === "B1");
    assert.strictEqual(bMsg.name, "Bob", "sender name correct");
    assert.strictEqual(bMsg.id, b.state.you, "carries sender socket id");
    assert(typeof a.msgs[0].ts === "number", "message has a timestamp");
    ok("all members get every message; consistent global order; per-sender order; name+id+ts");
    a.s.close(); b.s.close();
  }

  /* 2. History delivered to a late joiner --------------------------------- */
  console.log("2. History on join");
  {
    const a = await client();
    const { code } = await create(a, "Alice");
    say(a, "msg before bob");
    say(a, "another one");
    await sleep(120);

    const b = await client();
    const res = await join(b, code, "Bob");
    assert(res.ok);
    await sleep(120);

    assert(Array.isArray(b.history), "joiner got a chatHistory event");
    assert.strictEqual(b.history.length, 2, "history has the 2 prior messages");
    assert.deepStrictEqual(b.history.map((m) => m.text), ["msg before bob", "another one"]);
    // And a message sent after join reaches Bob live.
    say(a, "live one");
    await sleep(100);
    assert.strictEqual(last(b).text, "live one", "live message after join");
    ok("late joiner receives full prior history, then live messages");
    a.s.close(); b.s.close();
  }

  /* 3. Empty / whitespace messages are rejected --------------------------- */
  console.log("3. Empty + whitespace handling");
  {
    const a = await client();
    const { code } = await create(a, "Alice");
    await sleep(60);
    say(a, "");
    say(a, "   ");
    say(a, "\n\t  ");
    await sleep(120);
    assert.strictEqual(a.msgs.length, 0, "blank messages produce nothing");
    // Whitespace around real text is trimmed.
    say(a, "   padded text   ");
    await sleep(100);
    assert.strictEqual(a.msgs.length, 1, "one real message");
    assert.strictEqual(last(a).text, "padded text", "leading/trailing whitespace trimmed");
    ok("blank messages dropped; surrounding whitespace trimmed");
    a.s.close();
  }

  /* 4. Length: up to 500 ok, longer truncated to 500 ---------------------- */
  console.log("4. Length limit (500)");
  {
    const a = await client();
    const { code } = await create(a, "Alice");
    await sleep(60);
    say(a, "x".repeat(500));
    await sleep(80);
    assert.strictEqual(last(a).text.length, 500, "exactly 500 passes intact");
    say(a, "y".repeat(650));
    await sleep(80);
    assert.strictEqual(last(a).text.length, 500, "650 truncated to 500");
    assert(/^y+$/.test(last(a).text), "truncated content preserved");
    ok("messages capped at 500 chars (500 ok, longer truncated)");
    a.s.close();
  }

  /* 5. History cap at 1000 (oldest dropped) ------------------------------- */
  console.log("5. History cap (1000)");
  {
    const a = await client();
    const { code } = await create(a, "Alice");
    await sleep(60);
    const TOTAL = 1010;
    for (let i = 1; i <= TOTAL; i++) say(a, "m" + i);
    await sleep(1200); // let the server process the burst

    const b = await client();
    await join(b, code, "Bob");
    await sleep(200);
    assert.strictEqual(b.history.length, 1000, "history capped at 1000, got " + b.history.length);
    assert.strictEqual(b.history[0].text, "m11", "oldest 10 dropped (first kept is m11)");
    assert.strictEqual(b.history[999].text, "m" + TOTAL, "newest kept");
    ok("history holds at most 1000; oldest evicted in order");
    a.s.close(); b.s.close();
  }

  /* 6. Chat works in every game phase ------------------------------------- */
  console.log("6. Cross-phase delivery (lobby/compose/guess/reveal/gameover)");
  {
    const a = await client(), b = await client();
    const { code } = await create(a, "Alice");
    await join(b, code, "Bob");
    await sleep(80);

    const phasesSeen = {};
    function note(tag) { phasesSeen[tag] = a.state.phase; }

    say(a, "lobby-chat"); await sleep(60); note("lobby");
    await new Promise((r) => a.s.emit("startGame", { rounds: 1 }, r));
    await sleep(120); // compose
    say(b, "compose-chat"); await sleep(60); note("compose");

    const giver = a.state.youAreGiver ? a : b;
    const guesser = a.state.youAreGiver ? b : a;
    await new Promise((r) => giver.s.emit("submitRound", { leftLabel: "Cold", rightLabel: "Hot", hint: "warm" }, r));
    await sleep(120); // guess
    say(guesser, "guess-chat"); await sleep(60); note("guess");

    await new Promise((r) => guesser.s.emit("lockGuess", { value: 10 }, r));
    await sleep(150); // reveal
    say(a, "reveal-chat"); await sleep(60); note("reveal");

    a.s.emit("nextTurn"); // Bob's turn (round 1 of 1 -> after his turn, game over)
    await sleep(150);
    // play Bob's turn quickly to reach gameover
    const g2 = a.state.youAreGiver ? a : b;
    const gu2 = a.state.youAreGiver ? b : a;
    await new Promise((r) => g2.s.emit("submitRound", { hint: "still warm" }, r));
    await sleep(120);
    await new Promise((r) => gu2.s.emit("lockGuess", { value: 12 }, r));
    await sleep(150);
    a.s.emit("nextTurn");
    await sleep(150);
    assert.strictEqual(a.state.phase, "gameover", "should be game over");
    say(a, "gameover-chat"); await sleep(80);

    assert(b.msgs.some((m) => m.text === "lobby-chat"), "lobby chat delivered");
    assert(a.msgs.some((m) => m.text === "compose-chat"), "compose chat delivered");
    assert(a.msgs.some((m) => m.text === "guess-chat"), "guess chat delivered");
    assert(b.msgs.some((m) => m.text === "reveal-chat"), "reveal chat delivered");
    assert(b.msgs.some((m) => m.text === "gameover-chat"), "gameover chat delivered");
    ok("chat delivered in lobby, compose, guess, reveal, and gameover");
    a.s.close(); b.s.close();
  }

  /* 7. Chat is NOT bundled into game state -------------------------------- */
  console.log("7. Separation from game state");
  {
    const a = await client();
    await create(a, "Alice");
    say(a, "hi");
    await sleep(100);
    assert.strictEqual(a.state.messages, undefined, "game state must not carry chat");
    ok("game-state payload contains no chat");
    a.s.close();
  }

  /* 8. Special characters / emoji / XSS transported verbatim -------------- */
  console.log("8. Special content passthrough");
  {
    const a = await client(), b = await client();
    const { code } = await create(a, "Alice");
    await join(b, code, "Bob");
    await sleep(80);
    const tricky = '<script>alert("x")</script> & émoji 😄 "quotes"';
    say(a, tricky);
    await sleep(120);
    assert.strictEqual(last(b).text, tricky, "raw text transported unchanged (client escapes on render)");
    ok("HTML/emoji/quotes delivered verbatim for client-side escaping");
    a.s.close(); b.s.close();
  }

  /* 9. Non-member chat is safely ignored ---------------------------------- */
  console.log("9. Non-member safety");
  {
    const stray = await client();
    say(stray, "i am not in a room"); // should be a no-op, no crash
    await sleep(100);
    assert.strictEqual(stray.msgs.length, 0, "no echo for a socket in no room");
    // server still alive:
    const a = await client();
    const { code } = await create(a, "Alice");
    say(a, "still working");
    await sleep(100);
    assert.strictEqual(last(a).text, "still working", "server unaffected");
    ok("chat from a socket not in a room is ignored without breaking the server");
    stray.s.close(); a.s.close();
  }

  /* 10. Concurrent senders + fairness ------------------------------------- */
  console.log("10. Concurrent senders");
  {
    const a = await client(), b = await client(), c = await client();
    const { code } = await create(a, "Alice");
    await join(b, code, "Bob");
    await join(c, code, "Cara");
    await sleep(80);
    for (let i = 0; i < 20; i++) { say(a, "a" + i); say(b, "b" + i); say(c, "c" + i); }
    await sleep(400);
    assert.strictEqual(a.msgs.length, 60, "A sees all 60");
    assert.strictEqual(b.msgs.length, 60, "B sees all 60");
    assert.strictEqual(c.msgs.length, 60, "C sees all 60");
    // Everyone sees the SAME ordered transcript.
    assert.deepStrictEqual(a.msgs.map((m) => m.text), b.msgs.map((m) => m.text), "A and B agree on order");
    assert.deepStrictEqual(b.msgs.map((m) => m.text), c.msgs.map((m) => m.text), "B and C agree on order");
    ok("60 interleaved messages delivered identically and in one consistent order");
    a.s.close(); b.s.close(); c.s.close();
  }

  console.log(`\nALL CHAT TESTS PASSED ✅  (${passed} checks)`);
  process.exit(0);
})().catch((e) => { console.error("\nCHAT TEST FAILED ❌\n", e); process.exit(1); });
