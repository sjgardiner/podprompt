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
  const parkAt = src.indexOf('inbox.park(e.id, "watched")');
  const gate = parkAt < 0 ? "" : src.slice(Math.max(0, parkAt - 300), parkAt);
  check("the watched gate still exists",
    /if \(!userDirected && isWatched\(sessionId\)/.test(gate), gate.slice(-120));
  check("...and consults autoDeliverFor", /!autoDeliverFor\(sessionId\)/.test(gate), gate.slice(-120));

  // The autonomy gate must NOT be bypassed by it: the user asked for
  // visibility-gating to be skippable, explicitly keeping the budget as the
  // remaining brake. If autoDeliverFor ever appears in the autonomy branch,
  // a spectated session could run unbounded.
  const autonomyBranch = src.slice(src.indexOf('inbox.park(e.id, "watched")'));
  const autonomyGate = autonomyBranch.slice(0, autonomyBranch.indexOf('inbox.park(e.id, "autonomy")'));
  check("auto-delivery does not weaken the autonomy gate",
    !/autoDeliverFor/.test(autonomyGate), autonomyGate.slice(0, 200));

  // And the browser has to be able to see the resolved value, because it is
  // derived and cannot be recomputed client-side.
  check("the resolved value is reported to the browser",
    /autoDeliver: autoDeliverFor\(sessionId\)/.test(src));
  check("a route exists to change it", /path === "\/auto-deliver"/.test(src));
}

console.log(`auto-delivery (MD9): ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
