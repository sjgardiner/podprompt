// Mid-turn delivery and send-side metering.
//
// Run: node viewer/mail-routing.test.mjs
//
// TWO CHANGES GUARDED HERE.
//
// 1. DELIVERY NO LONGER MEANS STARTING A TURN. Mail for a session that is
//    already working is folded into the turn in progress and picked up at its
//    next step boundary. Busy used to be a wall; it is a routing decision.
//
// 2. THE BUDGET IS CHARGED AT THE SEND, NOT THE RECEIPT. It used to be
//    charged in startTurn and nowhere else, which meant the SENDER's
//    initiative cost the RECIPIENT's budget -- flood a session with peer mail
//    and it was the recipient that got paused, punished for someone else's
//    behaviour. It also simply stopped working once a delivery could start no
//    turn at all: nothing would ever charge, and the dead-man's switch would
//    never trip.
//
// ONE CHARGE POINT PER EVENT CLASS is the invariant that keeps this safe, and
// it is the one most likely to be broken by a later edit, because charging at
// send was tried once before and backed out for double-spending. Hence the
// structural assertions below: the peer/delegate branch must stay free, and
// the send surfaces must stay charged.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
// Borrowed verbatim from autodeliver.test.mjs, including the reason: a
// destructured parameter contains braces, so stopping at the first "{" after
// the name yields a "body" consisting only of the signature.
function bodyOf(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`driver.mjs no longer defines ${name}()`);
  const start = src.slice(Math.max(0, i - 6), i) === "async " ? i - 6 : i;
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

// ── metering: who pays ─────────────────────────────────────────────────────
{
  const start = bodyOf("startTurnInner");

  check("a peer/delegate turn is NOT charged (the send already paid)",
    /source === "peer" \|\| source === "delegate"/.test(start),
    start.slice(start.indexOf("userDirected) {"), start.indexOf("userDirected) {") + 200));

  // The branch has to be genuinely empty of a charge, not merely mention the
  // sources: a charge that survived inside it would double-bill every message.
  const branchAt = start.indexOf('source === "peer" || source === "delegate"');
  const nextElse = start.indexOf("} else {", branchAt);
  const branch = start.slice(branchAt, nextElse > 0 ? nextElse : branchAt + 2000);
  check("...and that branch really does not charge",
    !/chargeAutomaticTurn\(/.test(branch), branch.slice(0, 160));

  check("auto-resume IS still charged (a disjoint path a send cannot trigger)",
    /chargeAutomaticTurn\(\)/.test(start.slice(nextElse)), start.slice(nextElse, nextElse + 200));

  check("a human turn still resets the counter rather than spending",
    /if \(source === "human" \|\| source === "resume"\) \{\s*\n\s*autonomy\.noteHumanAction\(\);/.test(start));
}

{
  const msg = bodyOf("toolMessage");
  check("toolMessage charges the sender", /autonomy\.chargeAutomaticTurn\(\)/.test(msg));
  // Breadth must still be checked BEFORE anything is spent: the counter
  // bounds how long a cascade runs, not how wide one turn fans out, and
  // width is where the expensive failure lives.
  check("...after the fan-out cap, not before",
    msg.indexOf("noteFanout(") < msg.indexOf("chargeAutomaticTurn("),
    [msg.indexOf("noteFanout("), msg.indexOf("chargeAutomaticTurn(")]);
  // A shut gate must not swallow the message: deliver() parks it so the user
  // can release it, and their release resets the counter anyway.
  check("...and only when the gate is open, so a release is never double-charged",
    /if \(!autonomy\.status\(\)\.paused\) autonomy\.chargeAutomaticTurn\(\);/.test(msg));
}

{
  const del = bodyOf("toolDelegate");
  check("toolDelegate charges the delegator", /const charged = autonomy\.chargeAutomaticTurn\(\);/.test(del));
  check("...and refuses up front when the gate is shut",
    /if \(!charged\.ok\) \{\s*\n\s*return \{ ok: false, reason: charged\.reason/.test(del),
    del.slice(del.indexOf("chargeAutomaticTurn"), del.indexOf("chargeAutomaticTurn") + 260));
  check("...checking depth and breadth before spending",
    del.indexOf("creationDepthExceeded(") < del.indexOf("chargeAutomaticTurn("));
}

// ── routing: busy is no longer a wall ──────────────────────────────────────
{
  const drain = bodyOf("maybeDrainInbox");
  const fold = bodyOf("foldIntoRunningTurn");

  check("a fold is attempted only for a session with a live turn",
    /if \(running\) \{/.test(drain));
  check("the fold is refused unless the backend implements it",
    /typeof backend\?\.injectIntoTurn !== "function"/.test(fold));
  check("...and a backend throwing is treated as a refusal, not a crash",
    /catch \(e\) \{[\s\S]*?return false;/.test(fold));
  // Awaited, because a backend may answer over HTTP (opencode v2 posts a
  // steer). Still compared with === true: a promise, a truthy string or an
  // undefined from a backend that does not implement it must all read as
  // "not taken", or mail would be marked delivered on a guess.
  check("the backend's answer is awaited and must be exactly true to count",
    /\(await backend\.injectIntoTurn\(sessionId, state, body\)\) === true/.test(fold), fold.slice(0, 400));

  // C10: the transcript must never be ambiguous about who said something.
  check("a folded message still produces a user bubble",
    /broadcastUserPrompt\(sessionId, body, randomUUID\(\), originLabel\)/.test(fold));

  check("a folded delivery is reported as 'folded', not merely true",
    /return "folded";/.test(drain));
  check("a started turn is reported as 'started'", /return "started";/.test(drain));
}

// ── receipts: the sender is told WHICH kind of delivery happened ───────────
{
  const deliver = bodyOf("deliver");
  check("the receipt carries `folded`", /folded: deliveredNow === "folded"/.test(deliver));
  check("`delivered` stays a boolean for existing callers",
    /delivered: !!deliveredNow/.test(deliver));
  check("`queued` is still the negation", /queued: !deliveredNow/.test(deliver));
}

// describeReceipt is pure, so it is exercised rather than pattern-matched.
{
  const describeReceipt = new Function(`${bodyOf("describeReceipt")}; return describeReceipt;`)();
  const folded = describeReceipt({ ok: true, delivered: true, folded: true, remaining: 7 }, "@x");
  const now = describeReceipt({ ok: true, delivered: true, folded: false, remaining: 7 }, "@x");
  const queued = describeReceipt({ ok: true, delivered: false, folded: false, remaining: 7 }, "@x");

  check("a folded delivery says the recipient will see it mid-turn",
    /already running/.test(folded) && /next step/.test(folded), folded);
  check("...and is distinguishable from a plain immediate delivery",
    folded !== now, [folded, now]);
  check("...and from a queued one", folded !== queued, [folded, queued]);
  check("a queued message explains WHEN it will be seen",
    /current turn ends/.test(queued), queued);
  check("all three still report the remaining budget",
    [folded, now, queued].every((s) => /7 steps left/.test(s)));
}

console.log(`\nmail-routing.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
