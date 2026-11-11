// Unit tests for the Claude Code turn input queue — mid-turn delivery.
//
// Run: node viewer/input-queue.test.mjs
//
// WHAT THIS PROTECTS
//
// A turn's input used to be exactly one message followed by a park. It is now
// a queue, so the driver can hand a running turn a message that the model
// picks up at its next step boundary. That is the whole mechanism behind
// mid-turn mail delivery, and it has one property that genuinely matters:
//
//     PUSH MUST NOT LIE.
//
// The driver re-queues whatever push() refuses. So a message accepted here
// and then silently dropped is a message lost outright — exactly the failure
// the delivery core is built to prevent ("a silently dropped message is
// indistinguishable to a model from a peer that chose not to answer, and it
// responds to that by retrying"). The dangerous moment is a close landing
// between the caller's check and the push, which is why `closed` is set
// synchronously and why anything already queued is drained anyway.
//
// makeInputQueue is read out of the shipped backend at run time, so there is
// no copy here to drift from the code.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const src = readFileSync(new URL("./backends/claude-code.mjs", import.meta.url), "utf8");
function fnSource(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`source no longer defines ${name}()`);
  const start = src.slice(Math.max(0, i - 6), i) === "async " ? i - 6 : i;
  // Walk the parameter list first: a destructured parameter contains braces,
  // and stopping at the first "{" would yield a body of just the signature --
  // which would then match nothing and let every assertion pass vacuously.
  let parens = 0, open = -1;
  for (let k = src.indexOf("(", i); k < src.length; k++) {
    if (src[k] === "(") parens++;
    else if (src[k] === ")" && --parens === 0) { open = src.indexOf("{", k); break; }
  }
  if (open < 0) throw new Error(`could not find the body of ${name}()`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

const BIND_UUID = "binding-uuid-0001";
const build = new Function("deps", `
  const { modelPrompt, userMsgUuid, randomUUID } = deps;
  ${fnSource("makeInputQueue")}
  return makeInputQueue;
`)({ modelPrompt: "FIRST", userMsgUuid: BIND_UUID, randomUUID });

// Drain a generator to completion with a hard stop, so a bug that leaves the
// stream parked forever fails the test instead of hanging the suite.
async function drain(q, ms = 2000) {
  const out = [];
  const deadline = Date.now() + ms;
  const it = q.stream[Symbol.asyncIterator]();
  for (;;) {
    if (Date.now() > deadline) { out.push({ TIMEOUT: true }); break; }
    const { value, done } = await Promise.race([
      it.next(),
      new Promise((r) => setTimeout(() => r({ value: { TIMEOUT: true }, done: false }), ms)),
    ]);
    if (done) break;
    if (value?.TIMEOUT) { out.push(value); break; }
    out.push(value);
  }
  return out;
}

// ── the opening prompt ─────────────────────────────────────────────────────
{
  const q = build();
  q.open();
  const msgs = await drain(q);
  check("yields the opening prompt", msgs[0]?.message?.content === "FIRST", msgs[0]);
  check("…carrying the turn's binding uuid", msgs[0]?.uuid === BIND_UUID, msgs[0]?.uuid);
  check("…and ends once closed", msgs.length === 1, msgs.length);
}

// ── pushing into a live turn ───────────────────────────────────────────────
{
  const q = build();
  check("a fresh queue is accepting", q.accepting() === true);
  check("push into a live turn is accepted", q.push("INJECTED") === true);
  q.open();
  const msgs = await drain(q);
  check("the injected message is yielded", msgs.length === 2 && msgs[1].message.content === "INJECTED",
    msgs.map((m) => m?.message?.content));
  check("…after the opening prompt, in order", msgs[0].message.content === "FIRST");
  check("…with its own uuid, not the turn's binding uuid",
    msgs[1].uuid !== BIND_UUID && typeof msgs[1].uuid === "string" && msgs[1].uuid.length > 0,
    msgs[1]?.uuid);
}

// ── PUSH MUST NOT LIE ──────────────────────────────────────────────────────
{
  const q = build();
  q.open();
  check("accepting() is false the instant the turn closes", q.accepting() === false);
  check("push after close is REFUSED, not silently dropped", q.push("TOO LATE") === false);
  const msgs = await drain(q);
  check("…and the refused message never appears in the stream",
    !msgs.some((m) => m?.message?.content === "TOO LATE"),
    msgs.map((m) => m?.message?.content));
}

// The race that matters: accepted first, closed immediately after, before the
// generator has had any chance to run. An accepted message must still be
// delivered — otherwise push() told the driver a lie it cannot detect.
{
  const q = build();
  const accepted = q.push("ACCEPTED BEFORE CLOSE");
  q.open();                       // close lands before the stream is ever read
  const msgs = await drain(q);
  check("a message accepted before close is accepted", accepted === true);
  check("…and is STILL delivered despite the close racing it",
    msgs.some((m) => m?.message?.content === "ACCEPTED BEFORE CLOSE"),
    msgs.map((m) => m?.message?.content));
}

// Several injections keep their order.
{
  const q = build();
  q.push("A"); q.push("B"); q.push("C");
  q.open();
  const msgs = await drain(q);
  check("multiple injections keep their order",
    msgs.map((m) => m.message.content).join("") === "FIRSTABC",
    msgs.map((m) => m.message.content));
}

// ── the park: the generator must not finish early ──────────────────────────
// If it returns before the turn ends, the SDK closes stdin to the CLI and the
// permission channel dies mid-turn, looking entirely healthy. That cost a day
// on 2026-11-10 and is the reason this parks at all.
{
  const q = build();
  const it = q.stream[Symbol.asyncIterator]();
  await it.next();                                    // the opening prompt
  // ONE pending next() held across both checks. An async generator queues
  // next() calls, so asking twice would hand the first asker the message and
  // park the second — which looks exactly like "the push never arrived".
  const parked = it.next();
  const raced = await Promise.race([
    parked.then(() => "yielded-or-ended"),
    new Promise((r) => setTimeout(() => r("still-parked"), 250)),
  ]);
  check("the stream PARKS while the turn is open (does not end early)",
    raced === "still-parked", raced);

  // and a later push wakes that same parked read
  q.push("LATE");
  const woken = await Promise.race([
    parked.then((r) => r.value?.message?.content),
    new Promise((r) => setTimeout(() => r("never-woke"), 1000)),
  ]);
  check("…and a push wakes the parked stream", woken === "LATE", woken);
  q.open();
}

// ── report ─────────────────────────────────────────────────────────────────
console.log(`\ninput-queue.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
