// Unit tests for per-session auto-delivery (MD9).
//
// Run: node viewer/autodeliver.test.mjs
//
// MD1 holds incoming mail while you are looking at a session, on the premise
// that delivering it would spend the turn you were about to type into. That
// premise conflates PARTICIPATING (about to type — holding is right) with
// SPECTATING (watching a worker run — holding is perverse, because the agent
// then stalls precisely BECAUSE you are watching it). Auto-delivery names
// the difference.
//
// The resolution is TRI-STATE and deliberately computed at read time:
//
//     explicit ?? (childKind === "delegated")
//
// Stamping `autoDeliver: true` onto delegated children at creation would
// have been simpler and is the thing to resist: dropping the default later
// would then leave every existing delegated session auto-delivering forever,
// needing a migration. Deriving it keeps "remove the default" a one-line
// change that applies retroactively — which is the only reason it was safe
// to adopt the default at all.
//
// Reads the functions out of driver.mjs at run time, so there is no copy to
// drift from the shipped code.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
function bodyOf(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`driver.mjs no longer defines ${name}()`);
  const start = src.slice(Math.max(0, i - 6), i) === "async " ? i - 6 : i;
  // Walk the parameter list first: a destructured parameter contains braces,
  // and stopping at the first "{" would yield a body of just the signature.
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

function fresh(relations = {}, prefs = {}) {
  // Only the module globals the two functions actually close over.
  const sandbox = `
    const sessionRelations = arguments[0];
    const sessionPrefs = arguments[1];
    const calls = { saves: 0, released: [] };
    const saveSessionPrefs = () => { calls.saves++; };
    const releaseWatchedFor = (id) => { calls.released.push(id); return []; };
    ${bodyOf("autoDeliverFor")}
    ${bodyOf("setAutoDeliver")}
    return { autoDeliverFor, setAutoDeliver, prefs: sessionPrefs, calls };
  `;
  return new Function(sandbox)(relations, prefs);
}

const DELEGATED = { kid: { childKind: "delegated" } };
const NATIVE = { kid: { childKind: "native-task" } };

// ── The derived default (decision D) ──────────────────────────────────────
{
  const d = fresh(DELEGATED);
  check("a delegated session auto-delivers by default", d.autoDeliverFor("kid") === true);

  const n = fresh(NATIVE);
  check("a native-task child does not", n.autoDeliverFor("kid") === false);

  const r = fresh({});
  check("a root session with no relation does not", r.autoDeliverFor("kid") === false);
  check("an unknown session does not", r.autoDeliverFor("nobody") === false);
  check("a null session id is safe", r.autoDeliverFor(null) === false);
}

// ── An explicit choice beats the default, in BOTH directions ──────────────
//
// The off-on-a-delegated-session case is the one that matters: you opened a
// worker to converse with it, so holding is correct again, and the default
// must not override you.
{
  const off = fresh(DELEGATED, { kid: { autoDeliver: false } });
  check("explicit false overrides the delegated default", off.autoDeliverFor("kid") === false);

  const on = fresh(NATIVE, { kid: { autoDeliver: true } });
  check("explicit true overrides a non-delegated default", on.autoDeliverFor("kid") === true);
}

// ── Setting, clearing, persisting ─────────────────────────────────────────
{
  const d = fresh(DELEGATED);
  check("turning it off returns the new effective value", d.setAutoDeliver("kid", false) === false);
  check("...and is recorded", d.prefs.kid?.autoDeliver === false, d.prefs);
  check("...and persisted", d.calls.saves === 1, d.calls);
  check("...and survives a re-read", d.autoDeliverFor("kid") === false);

  // null clears the pin rather than meaning "false" — the distinction is the
  // whole point of a tri-state, and losing it would make the derived default
  // unreachable once touched.
  check("clearing returns to the derived default", d.setAutoDeliver("kid", null) === true);
  check("...and removes the entry entirely", d.prefs.kid === undefined, d.prefs);
  check("...rather than leaving an empty husk", !("kid" in d.prefs), d.prefs);
}

// ── Enabling must free what the old setting was holding ───────────────────
//
// Otherwise the first thing you see after switching it on is the mail it was
// supposed to stop holding, still sitting there.
{
  const d = fresh(NATIVE);
  d.setAutoDeliver("kid", true);
  check("enabling releases mail parked for that session",
    d.calls.released.includes("kid"), d.calls.released);

  const off = fresh(DELEGATED);
  off.setAutoDeliver("kid", false);
  check("disabling releases nothing", off.calls.released.length === 0, off.calls.released);

  // Clearing back to a default that is ON is still an enable.
  const back = fresh(DELEGATED, { kid: { autoDeliver: false } });
  back.setAutoDeliver("kid", null);
  check("clearing to an ON default also releases",
    back.calls.released.includes("kid"), back.calls.released);
}

// ── Other preferences on the same session must survive ────────────────────
{
  const d = fresh(DELEGATED, { kid: { somethingElse: 7 } });
  d.setAutoDeliver("kid", false);
  check("an unrelated preference is preserved", d.prefs.kid.somethingElse === 7, d.prefs);
  d.setAutoDeliver("kid", null);
  check("clearing keeps the row when other keys remain",
    d.prefs.kid?.somethingElse === 7 && d.prefs.kid.autoDeliver === undefined, d.prefs);
}

// ── A null session id must not create junk ────────────────────────────────
{
  const d = fresh({});
  check("setting on a null id is inert", d.setAutoDeliver(null, true) === false);
  check("...and writes nothing", Object.keys(d.prefs).length === 0, d.prefs);
  check("...and saves nothing", d.calls.saves === 0, d.calls);
}

// ── The gate is actually wired into delivery ──────────────────────────────
//
// All of the above is inert unless maybeDrainInbox consults it. That call
// site is the feature; assert it against source, since the surrounding
// function cannot be unit-tested in isolation.
{
  // Asserted against the whole function rather than a fixed-size window
  // before the park call: the gate's operands are now hoisted into locals,
  // and a byte-distance assertion broke the moment a comment grew. What
  // must hold is that the decision still READS both inputs and that the
  // park happens only when they say so — not where the characters sit.
  const drain = bodyOf("maybeDrainInbox");
  check("the hold decision reads isWatched", /isWatched\(sessionId\)/.test(drain));
  check("the hold decision reads autoDeliverFor", /autoDeliverFor\(sessionId\)/.test(drain));
  check("mail is parked as 'watched' only behind that decision",
    /if \(!running && watched && !auto\) group = parkUnapproved\(sessionId, group, "watched", approved\);/.test(drain),
    drain.slice(drain.indexOf("watched && !auto") - 60, drain.indexOf("watched && !auto") + 120));

  // THE HOLD IS NARROWED TO IDLE SESSIONS, and that `!running` is the whole
  // narrowing. The hold exists because a delivery SPENDS the turn the user
  // was about to type into -- true only when nothing is running. If a turn is
  // already going, the message folds into it, costs no turn, and a prompt the
  // user typed would have queued behind that turn anyway.
  //
  // If `!running` is ever dropped from this condition, a watched session goes
  // back to holding mail it could simply have been handed, which is the
  // "the agent stalls BECAUSE you are watching it" failure in a new place.
  check("the watched hold applies only to a session with no turn running",
    /if \(!running &&/.test(drain), drain.slice(drain.indexOf("watched && !auto") - 80, drain.indexOf("watched && !auto") + 60));
  check("...and `running` means a live turn, not merely 'not idle'",
    /const running = !!state\?\.turnInFlight;/.test(drain));

  // The autonomy gate must NOT be bypassed by it: the user asked for
  // visibility-gating to be skippable, explicitly keeping the budget as the
  // remaining brake. If autoDeliverFor (or its local `auto`) ever appears in
  // the autonomy branch, a spectated session could run unbounded.
  //
  // THE ANCHORS ARE ASSERTED BEFORE THEY ARE USED. The previous version
  // sliced between two literals that a refactor removed; indexOf returned
  // -1, the slice came out empty, and the test went on passing while
  // testing nothing at all. A string-anchored test that cannot find its
  // anchor must FAIL, not shrug.
  const watchedAt = drain.indexOf('"watched", approved');
  const autonomyAt = drain.indexOf('"autonomy", approved');
  check("the watched park is still findable", watchedAt > 0, watchedAt);
  check("the autonomy park is still findable", autonomyAt > watchedAt, [watchedAt, autonomyAt]);
  const autonomyGate = drain.slice(watchedAt, autonomyAt);
  check("auto-delivery does not weaken the autonomy gate",
    !/autoDeliverFor|!auto\b/.test(autonomyGate), autonomyGate);
  check("...and the gate is still the autonomy status",
    /autonomy\.status\(\)\.paused/.test(autonomyGate), autonomyGate);

  // Approval is PER MESSAGE: a call-level override would re-open the leak
  // where approving two messages also delivered anything that arrived
  // afterwards and was never seen.
  check("the hold respects per-entry approval",
    /const approved = \(e\) => userDirected \|\| e\.approved === true;/.test(drain), drain.slice(0, 400));
  check("only unapproved entries are parked",
    /const toPark = group\.filter\(\(e\) => !approved\(e\)\);/.test(bodyOf("parkUnapproved")));

  // Busy is still the LAST gate. If it climbs back above the hold decision,
  // mid-turn mail becomes invisible again — the bug this all came from.
  //
  // Anchored on the CALL, not the name. The name now also appears in a
  // comment near the top explaining how `running` differs from it, and
  // matching that made this assertion pass or fail on prose.
  const idleCallAt = drain.search(/if \(!sessionIsIdle\(sessionId\)\)/);
  check("the busy check is still findable", idleCallAt > 0, idleCallAt);
  check("the busy check comes after the hold decision",
    idleCallAt > drain.indexOf('"watched", approved'),
    [idleCallAt, drain.indexOf('"watched", approved')]);

  // A running turn is now fed rather than made to wait, and the fold must be
  // reached BEFORE the idle check — otherwise a busy session falls through to
  // "not ready" and the message queues despite being deliverable.
  const foldAt = drain.indexOf("foldIntoRunningTurn(");
  check("a running turn is offered the fold", foldAt > 0, foldAt);
  check("...before the busy check turns it away", foldAt < idleCallAt, [foldAt, idleCallAt]);

  // The fold's answer is load-bearing: a refusal must leave the mail QUEUED,
  // never marked delivered, or the message is lost outright.
  check("mail is only marked delivered when the fold is actually taken",
    /if \(await foldIntoRunningTurn\([^)]*\)\) \{\s*\n\s*inbox\.markDelivered/.test(drain),
    drain.slice(foldAt - 40, foldAt + 200));

  // And the browser has to be able to see the resolved value, because it is
  // derived and cannot be recomputed client-side.
  check("the resolved value is reported to the browser",
    /autoDeliver: autoDeliverFor\(sessionId\)/.test(src));
  check("a route exists to change it", /path === "\/auto-deliver"/.test(src));
}

// ── MD14: a backend's auto-title must never move a handle ────────────────
//
// SHIPPED AND CAUGHT BY LIVE PROBES. Re-derivation was gated on
// `!!s_.customTitle`, on the assumption that a custom title meant the user
// had set one. BOTH BACKENDS AUTO-TITLE THEIR OWN SESSIONS into that field.
//
// Measured on six delegated probes: every one carried a machine-generated
// customTitle, and @probe2-oc2 — a handle its parent chose — was silently
// re-derived to @podprompt-messaging-connectivity. A sibling with the
// identical auto-title kept its handle only because the derived name was
// already taken and the collision refusal fired; a third escaped on poll
// timing. So the naming was NONDETERMINISTIC, which is worse than being
// consistently wrong.
//
// The /sessions poll cannot tell a backend's guess from a human's intent,
// so it must not claim to.
{
  const poll = src.slice(src.indexOf("for (const s_ of allSessions)"));
  const ensure = poll.slice(0, poll.indexOf("}", poll.indexOf("peers.ensure(")) + 1);
  check("the sessions poll never claims a title is user-set",
    /titleIsCustom: false/.test(ensure), ensure.slice(0, 300));
  check("...and specifically not from customTitle",
    !/titleIsCustom: !!s_\.customTitle/.test(src));

  // The routes the USER actually drives must still say so, or a rename
  // stops moving the handle at all and MD14 does nothing.
  const rename = src.slice(src.indexOf('path === "/rename-session"'));
  check("a rename still counts as user intent",
    /titleIsCustom: !!body\.title/.test(rename.slice(0, 1200)), rename.slice(0, 600));
  const prefs = src.slice(src.indexOf('peers.ensure(body.sessionId, { title: body.title'));
  check("peer-settings still counts as user intent",
    /titleIsCustom: !!body\.title/.test(prefs.slice(0, 300)), prefs.slice(0, 200));
}

// ── MD10: one grace period, every way of looking away ─────────────────────
//
// There used to be two release paths that drifted apart by design: an
// explicit "tab hidden" report released held mail after a 4s debounce, while
// a tab that simply stopped reporting waited out a 45s TTL plus a 15s sweep.
// So a glance at another window dumped mail you were deliberately holding,
// and lengthening the obvious knob would have fixed only one path.
{
  const sandbox = `
    const lastSeenWatching = new Map();
    const VIEWING_GRACE_MS = 120000;
    ${bodyOf("noteViewing")}
    ${bodyOf("isWatched")}
    return { noteViewing, isWatched, map: lastSeenWatching };
  `;
  const d = new Function(sandbox)();

  check("an unseen session is not watched", d.isWatched("s") === false);
  d.noteViewing("s", true);
  check("a visible report marks it watched", d.isWatched("s") === true);

  // The heart of it: going hidden must NOT end the hold. Only time does.
  d.noteViewing("s", false);
  check("a hidden report does not end the hold", d.isWatched("s") === true);
  check("...and does not erase the timestamp", d.map.has("s") === true);

  // Coming back refreshes it, so a quick switch away and back is free.
  d.map.set("s", Date.now() - 119000);
  check("just inside the window it is still watched", d.isWatched("s") === true);
  d.noteViewing("s", true);
  d.map.set("s", Date.now() - 119000);
  check("...and a fresh visible report restarts the clock",
    d.isWatched("s") === true);

  d.map.set("s", Date.now() - 121000);
  check("past the grace it lapses", d.isWatched("s") === false);
  check("...and is forgotten rather than re-checked forever", d.map.has("s") === false);

  check("a null session id is inert", d.isWatched(null) === false);
  d.noteViewing(null, true);
  check("...and cannot be recorded", d.map.has(null) === false);
}

// ── The eager release is gone from the route ──────────────────────────────
{
  const viewing = src.slice(src.indexOf('path === "/viewing"'));
  const body = viewing.slice(0, viewing.indexOf("\n  }") + 4);
  check("the /viewing route no longer releases held mail",
    !/releaseWatchedFor/.test(body), body.slice(-200));
  check("the old TTL constant is gone", !/VIEWING_TTL_MS/.test(src));
  check("the grace is 120s", /VIEWING_GRACE_MS = 120 \* 1000/.test(src));
  // The sweep is still what ends a hold — just on the single condition now.
  check("the sweep still walks the watched map", /for \(const \[sessionId\] of lastSeenWatching\)/.test(src));

  const vh = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
  check("the browser no longer debounces a hidden report", !/hiddenTimer/.test(vh));
  check("...and still reports while visible", /if \(viewingIsVisible\(\)\) reportViewing\(true\);/.test(vh));
}

console.log(`auto-delivery (MD9): ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
