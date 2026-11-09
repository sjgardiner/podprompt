// Unit tests for the autonomy gate (§10).
//
// Run: node viewer/autonomy.test.mjs
//
// Written to try to BREAK the design rather than confirm it — the same
// discipline chains.test.mjs used, and for the same reason: every bug this
// project has actually shipped was found by a test built to contradict an
// assumption and missed by one built to demonstrate it.
//
// The assumptions under attack here:
//   * that the counter advances while uncapped (the whole "until 8 AM"
//     mechanism rests on it, and it is the easiest thing to "tidy away");
//   * that an EXPIRED lift parks immediately, while a HUMAN cap-now does not;
//   * that a corrupt or hostile state file cannot resurrect an indefinite
//     lift across a restart;
//   * that nothing can raise its own budget.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createAutonomy, DEFAULT_PAUSE_AFTER } from "./autonomy.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, got, want) {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const dir = mkdtempSync(nodePath.join(tmpdir(), "autonomy-test-"));
let clock = 1_800_000_000_000;
const now = () => clock;
let n = 0;
const fresh = (opts = {}) =>
  createAutonomy({ file: nodePath.join(dir, `a${++n}.json`), now, ...opts });

// ── The basic gate ────────────────────────────────────────────────────────
{
  const a = fresh();
  eq("default pauseAfter", a.status().pauseAfter, DEFAULT_PAUSE_AFTER);
  eq("starts open", a.status().state, "open");

  let allowed = 0;
  for (let i = 0; i < 25; i++) if (a.chargeAutomaticTurn().ok) allowed++;
  eq("allows exactly pauseAfter turns", allowed, DEFAULT_PAUSE_AFTER);
  eq("then paused", a.status().state, "paused");
  eq("remaining floors at 0", a.status().remaining, 0);
  eq("refusal names itself", a.chargeAutomaticTurn().reason, "autonomy-paused");
}

// ── Human action resets; that is the only reset ───────────────────────────
{
  const a = fresh();
  for (let i = 0; i < DEFAULT_PAUSE_AFTER; i++) a.chargeAutomaticTurn();
  check("paused before input", a.status().paused);
  a.noteHumanAction();
  eq("human input resets the counter", a.status().count, 0);
  check("open again", a.chargeAutomaticTurn().ok);

  // Time alone must NOT reset it. The unit is turns, deliberately: a design
  // that healed with the clock would let a slow loop run forever.
  const b = fresh();
  for (let i = 0; i < DEFAULT_PAUSE_AFTER; i++) b.chargeAutomaticTurn();
  clock += 24 * 60 * 60 * 1000;
  check("time alone does not un-pause", !b.chargeAutomaticTurn().ok);
}

// ── The override, and the mechanism that makes "until 8 AM" work ──────────
{
  const a = fresh();
  const until = clock + 60_000;
  check("lift accepted", a.liftCap({ until }).ok);
  eq("state is uncapped", a.status().state, "uncapped");

  // 500 turns under the lift — far past pauseAfter.
  for (let i = 0; i < 500; i++) check("uncapped turn allowed", a.chargeAutomaticTurn().ok);

  // THE load-bearing assertion. If the counter were frozen while uncapped,
  // expiry would leave count < pauseAfter and the night's work would simply
  // carry on past the deadline the user set.
  check("counter advanced while uncapped", a.status().count >= 500, `count=${a.status().count}`);
  eq("remaining is null while uncapped", a.status().remaining, null);

  clock = until + 1;
  eq("lapsed lift returns to a real state", a.status().state, "paused");
  check("lapsed lift parks IMMEDIATELY", !a.chargeAutomaticTurn().ok);
}

{
  // Brief lift, few turns: on expiry the normal rule resumes and has NOT
  // been breached, so work continues. The symmetric case to the one above.
  const a = fresh();
  const until = clock + 10_000;
  a.liftCap({ until });
  for (let i = 0; i < 3; i++) a.chargeAutomaticTurn();
  clock = until + 1;
  eq("3 < pauseAfter so still open", a.status().state, "open");
  check("work continues after a brief lift", a.chargeAutomaticTurn().ok);
}

{
  // Indefinite lift never expires on its own.
  const a = fresh();
  a.liftCap({ until: null });
  clock += 365 * 24 * 60 * 60 * 1000;
  eq("indefinite lift survives a year", a.status().state, "uncapped");
  check("still allowed", a.chargeAutomaticTurn().ok);
}

// ── Cap-now is a HUMAN action; expiry is not. They must differ ────────────
{
  const a = fresh();
  a.liftCap({ until: null });
  for (let i = 0; i < 400; i++) a.chargeAutomaticTurn();
  a.capNow();
  eq("cap-now clears the lift", a.status().state, "open");
  eq("cap-now resets the counter", a.status().count, 0);
  check("cap-now does not instantly re-park", a.chargeAutomaticTurn().ok);
}

// ── Nothing can raise its own budget ──────────────────────────────────────
{
  const a = fresh();
  check("pauseAfter rejects 0", !a.setPauseAfter(0).ok);
  check("pauseAfter rejects negatives", !a.setPauseAfter(-5).ok);
  check("pauseAfter rejects NaN", !a.setPauseAfter(NaN).ok);
  check("pauseAfter rejects Infinity", !a.setPauseAfter(Infinity).ok);
  eq("unchanged after bad input", a.status().pauseAfter, DEFAULT_PAUSE_AFTER);

  // A past `until` is a lift that would be live for zero time but, if
  // accepted and then read before expireOverride ran, could read as uncapped.
  check("lift rejects a past deadline", !a.liftCap({ until: clock - 1 }).ok);
  check("lift rejects a non-number", !a.liftCap({ until: "tomorrow" }).ok);
  eq("still capped after bad lifts", a.status().state, "open");
}

// ── Restart survival, including hostile state ─────────────────────────────
{
  const f = nodePath.join(dir, "restart.json");
  const a = createAutonomy({ file: f, now });
  for (let i = 0; i < 12; i++) a.chargeAutomaticTurn();
  a.setPauseAfter(15);

  const b = createAutonomy({ file: f, now });
  eq("counter survives restart", b.status().count, 12);
  eq("pauseAfter survives restart", b.status().pauseAfter, 15);
  // A crash loop must not be able to reset its way past the gate.
  let left = 0;
  while (b.chargeAutomaticTurn().ok) left++;
  eq("only the remaining turns are left", left, 3);
}
{
  const f = nodePath.join(dir, "corrupt.json");
  writeFileSync(f, "{ this is not json");
  const a = createAutonomy({ file: f, now });
  eq("corrupt file starts CAPPED, not uncapped", a.status().state, "open");
  eq("corrupt file starts at zero", a.status().count, 0);
}
{
  // The dangerous direction: a hand-edited or corrupted file claiming an
  // indefinite lift and an absurd budget. `until: null` is legitimate, so the
  // guard that matters is on pauseAfter — it must not be possible to smuggle
  // in an unbounded one.
  const f = nodePath.join(dir, "hostile.json");
  writeFileSync(f, JSON.stringify({ count: -999, pauseAfter: Infinity, override: { until: "forever" } }));
  const a = createAutonomy({ file: f, now });
  eq("negative count rejected", a.status().count, 0);
  eq("infinite pauseAfter rejected", a.status().pauseAfter, DEFAULT_PAUSE_AFTER);
  eq("malformed override rejected", a.status().state, "open");
}

// ── A lift persisted across restart stays live (AD5: absolute instant) ────
{
  const f = nodePath.join(dir, "lift-restart.json");
  const until = clock + 5 * 60 * 60 * 1000;
  createAutonomy({ file: f, now }).liftCap({ until });
  clock += 60 * 60 * 1000;                       // a 3 AM driver restart
  const b = createAutonomy({ file: f, now });
  eq("lift survives a restart mid-window", b.status().state, "uncapped");
  eq("and keeps its absolute deadline", b.status().uncappedUntil, until);

  // The rest of the night's work runs under the restored lift — which is what
  // makes the expiry below mean anything. (Asserting "expires to paused"
  // WITHOUT charging turns first was a test bug: nothing had been breached,
  // so "open" was the correct answer and the test was wrong, not the code.)
  for (let i = 0; i < 300; i++) b.chargeAutomaticTurn();
  clock = until + 1;
  eq("and parks on expiry, having run past the cap", b.status().state, "paused");
}
{
  // The companion case, now asserted explicitly rather than by accident: a
  // lift that expires with nothing having run returns to NORMAL, not paused.
  const f = nodePath.join(dir, "lift-idle.json");
  const until = clock + 60_000;
  const a = createAutonomy({ file: f, now });
  a.liftCap({ until });
  clock = until + 1;
  eq("an unused lift expires to open", a.status().state, "open");
  check("and work may continue", a.chargeAutomaticTurn().ok);
}

rmSync(dir, { recursive: true, force: true });
// ── AD6: the autonomy setting has a UI at all ────────────────────────────
//
// THE HOLE THIS CLOSES. The driver has always had setPauseAfter and a
// liftCap that accepts `until: null`, both validated and routed. The browser
// called NEITHER. pauseAfter appeared in viewer.html exactly twice: once as
// a hard-coded default of 20 in local state, once to label a button. So the
// cap was effectively a compile-time constant.
//
// Worse, renderAutonomyStrip() returns early unless the state is paused or
// uncapped, so in normal operation it renders nothing — not even
// "Don't pause". Unattended work was therefore impossible to ARRANGE: you
// had to start, wait however many automatic turns it took to hit the wall,
// lift the cap, and only then walk away.
{
  const html = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");

  check("the panel exposes an autonomy control", /id="autonomy-mode"/.test(html));
  check("...with a supervised half", /<optgroup label="Supervised">/.test(html));
  check("...and an unattended half", /<optgroup label="Unattended">/.test(html));

  // ONE control, not two. A budget and a time window presented as separate
  // settings read as contradictory and needed prose to explain that they
  // are not; they are one choice with two modes, which is what the store
  // already says (pauseAfter is not consulted while an override is live).
  check("it is a single select, so the two modes cannot conflict",
    (html.match(/id="autonomy-mode"/g) || []).length === 1);

  // The previously unreachable states.
  check("an arbitrary turn count is reachable", /id="autonomy-turns"/.test(html));
  check("an arbitrary deadline is reachable", /id="autonomy-until"/.test(html));
  check("indefinite is reachable", /value="t:never"/.test(html));

  // Wiring to the routes the driver already had.
  check("it sets pauseAfter", /autonomyPost\(\{ pauseAfter: n \}\)/.test(html));
  check("it lifts with a deadline", /lift: true, until: ms/.test(html));
  check("it lifts indefinitely", /lift: true, until: null/.test(html));
  // Choosing supervision must also END an unattended window, or the control
  // would show a budget while the override silently kept overriding it.
  check("a supervised choice cancels an unattended window",
    /autonomyPost\(\{ pauseAfter: n \}\)\.then\(\(\) => autonomyPost\(\{\}\)\)/.test(html));

  // Reflects live state: a window can lapse by itself and other tabs can
  // change it, so the control is rendered from /autonomy rather than from
  // whatever was last clicked.
  check("the control re-renders from live state",
    /renderAutonomySetting\(\);/.test(html) && /function renderAutonomySetting/.test(html));
  check("...without stomping a field being edited",
    /document\.activeElement === autonomyTurns/.test(html));
  // Committing per keystroke would post a budget of 2 en route to 200.
  check("custom fields commit on change, not on input",
    /autonomyTurns\.addEventListener\('change'/.test(html));

  // AD5: the container is on UTC; a wall-clock time must be resolved by the
  // BROWSER and sent as epoch ms.
  check("the deadline is resolved browser-side to epoch ms",
    /function toLocalInputValue/.test(html) && /new Date\(autonomyUntil\.value\)\.getTime\(\)/.test(html));
  check("a deadline in the past is refused", /ms <= Date\.now\(\)\) return/.test(html));

  // Three columns, right-anchored so the panel grows leftwards and its right
  // edge stays flush with the chat area.
  check("the panel has three columns", /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(html));
  check("...and stays right-anchored", /#settings-panel \{[\s\S]*?right: 20px;/.test(html));
  check("...stepping down on narrow windows",
    /max-width: 740px/.test(html) && /max-width: 520px/.test(html));
}

console.log(`autonomy.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
