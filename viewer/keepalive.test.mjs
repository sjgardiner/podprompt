// Unit tests for the keep-alive supervisor (auto-resume).
//
// Run: node viewer/keepalive.test.mjs
//
// WHAT THIS GUARDS. A turn can end badly with nobody watching — the
// environment restarted, a backend process crashed, a provider stopped
// answering — and until now the only recovery was a human clicking Continue.
//
// The trap worth stating loudly, because the obvious implementation walks
// straight into it: /continue and startTurn(source:"resume") both call
// autonomy.noteHumanAction(), which ZEROES the global turn counter. A
// supervisor built on that path would not SPEND the budget, it would RESET
// it on every tick — and the counter is global, so one crash-looping session
// would hand every other session a fresh twenty turns, repeatedly, forever.
// Hence a distinct source that falls through to chargeAutomaticTurn().
//
// Reads the sweep out of driver.mjs at run time, so there is no copy to
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

const AGO = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3600000;

function fresh(state, { startOk = true, idle = true } = {}) {
  const sandbox = `
    // Silenced: the sweep logs each resume, which would bury the results.
    const console = { log() {}, error() {} };
    const turnState = arguments[0];
    const calls = { started: [], saves: 0 };
    const nowIso = () => new Date().toISOString();
    const saveTurnState = () => { calls.saves++; };
    const sessionIsIdle = () => arguments[2];
    const resumePromptFor = (r, opts) => "PROMPT:" + r.reason + (opts?.automatic ? ":auto" : "");
    const startTurn = (sessionId, prompt, opts) => {
      calls.started.push({ sessionId, prompt, ...opts });
      return arguments[1] ? { ok: true } : { ok: false, reason: "autonomy-paused" };
    };
    const AUTO_RESUME_REASONS = new Set(["restart", "stalled", "error"]);
    const AUTO_RESUME_MAX_STRIKES = 3;
    const AUTO_RESUME_BACKOFF_MS = [60000, 300000, 900000];
    ${bodyOf("autoResumeSweep")}
    return { autoResumeSweep, turnState, calls };
  `;
  return new Function(sandbox)(state, startOk, idle);
}

const resumable = (reason, atMsAgo = HOUR) => ({ reason, error: null, lastTool: null, at: AGO(atMsAgo) });

// ── Which reasons are eligible ────────────────────────────────────────────
{
  const d = fresh({
    a: { inFlight: false, resumable: resumable("restart") },
    b: { inFlight: false, resumable: resumable("stalled") },
    c: { inFlight: false, resumable: resumable("error") },
    d: { inFlight: false, resumable: resumable("aborted") },
  });
  d.autoResumeSweep();
  const ids = d.calls.started.map((s) => s.sessionId);

  check("restart is resumed", ids.includes("a"), ids);
  check("stalled is resumed", ids.includes("b"), ids);
  // Included because it is frequently a crashed backend process where one
  // retry works; bounded by the strike cap for when it is not.
  check("error is resumed", ids.includes("c"), ids);
  // The one that must never happen: the user stopped this on purpose.
  check("aborted is NEVER resumed", !ids.includes("d"), ids);
}

// ── It must charge the budget, not reset it ───────────────────────────────
//
// The single most important assertion in this file. source:"resume" would
// call noteHumanAction() and zero a GLOBAL counter.
{
  const d = fresh({ a: { inFlight: false, resumable: resumable("restart") } });
  d.autoResumeSweep();
  const call = d.calls.started[0];
  check("a distinct source is used", call?.source === "auto-resume", call?.source);
  check("...and it is NOT the human-crediting one",
    call?.source !== "resume" && call?.source !== "human", call?.source);
  check("the origin records why it was resumed",
    call?.origin === "auto-resume:restart", call?.origin);
  check("the prompt says it was automatic", /:auto$/.test(call?.prompt || ""), call?.prompt);
}

// ── Nothing is resumed while it is running ────────────────────────────────
{
  const d = fresh({ a: { inFlight: true, resumable: resumable("error") } });
  d.autoResumeSweep();
  check("an in-flight session is left alone", d.calls.started.length === 0);

  const busy = fresh({ a: { inFlight: false, resumable: resumable("error") } }, { idle: false });
  busy.autoResumeSweep();
  check("a session that is not idle is left alone", busy.calls.started.length === 0);

  const none = fresh({ a: { inFlight: false } });
  none.autoResumeSweep();
  check("a session with nothing to resume is left alone", none.calls.started.length === 0);
}

// ── The strike cap: a crash loop must stop ────────────────────────────────
{
  for (const strikes of [0, 1, 2]) {
    const d = fresh({ a: {
      inFlight: false, resumable: resumable("error"),
      autoResume: { strikes, lastAt: AGO(HOUR) },
    } });
    d.autoResumeSweep();
    check(`strike ${strikes} still retries`, d.calls.started.length === 1, strikes);
    check(`...and increments to ${strikes + 1}`,
      d.turnState.a.autoResume.strikes === strikes + 1, d.turnState.a.autoResume);
  }
  const spent = fresh({ a: {
    inFlight: false, resumable: resumable("error"),
    autoResume: { strikes: 3, lastAt: AGO(HOUR) },
  } });
  spent.autoResumeSweep();
  check("at the cap it stops and waits for a human", spent.calls.started.length === 0);
  check("...and does not keep counting", spent.turnState.a.autoResume.strikes === 3);
}

// ── Backoff: do not burn the cap in three seconds ─────────────────────────
{
  const tooSoon = fresh({ a: {
    inFlight: false, resumable: resumable("error", 1000),
    autoResume: { strikes: 1, lastAt: AGO(1000) },
  } });
  tooSoon.autoResumeSweep();
  check("a retry inside the backoff window is skipped", tooSoon.calls.started.length === 0);

  const ready = fresh({ a: {
    inFlight: false, resumable: resumable("error"),
    autoResume: { strikes: 1, lastAt: AGO(10 * 60 * 1000) },
  } });
  ready.autoResumeSweep();
  check("...and taken once the window has passed", ready.calls.started.length === 1);

  // Backoff lengthens with each strike: 10 minutes is enough after one
  // failure but not after two.
  const second = fresh({ a: {
    inFlight: false, resumable: resumable("error"),
    autoResume: { strikes: 2, lastAt: AGO(10 * 60 * 1000) },
  } });
  second.autoResumeSweep();
  check("the window grows with each strike", second.calls.started.length === 0);
}

// ── A refused turn must not consume an attempt ────────────────────────────
//
// The autonomy gate being shut is the system working, not a failure. If a
// refusal burned a strike, three closed-gate sweeps would exhaust the cap
// and the session would never be resumed even after the user lifts it.
{
  const d = fresh({ a: { inFlight: false, resumable: resumable("restart") } },
    { startOk: false });
  d.autoResumeSweep();
  check("a refused start does not leave a strike behind",
    d.turnState.a.autoResume === undefined, d.turnState.a);

  const withPrior = fresh({ a: {
    inFlight: false, resumable: resumable("restart"),
    autoResume: { strikes: 1, lastAt: AGO(HOUR) },
  } }, { startOk: false });
  withPrior.autoResumeSweep();
  check("...and restores the previous count exactly",
    withPrior.turnState.a.autoResume.strikes === 1, withPrior.turnState.a.autoResume);
}

// ── Strike bookkeeping survives the turn it provokes ──────────────────────
//
// markTurnStarted and markTurnEnded both REPLACE the turnState row, so the
// counter has to be carried explicitly through each. If it were not, a
// session failing on every attempt would reset its own counter each time and
// retry forever — the exact loop the cap exists to stop.
{
  check("markTurnStarted carries the strike count",
    /\.\.\.\(prev\?\.autoResume \? \{ autoResume: prev\.autoResume \} : \{\}\)/.test(src));
  check("markTurnEnded carries it only while the session keeps failing",
    /\.\.\.\(bad && rec\.autoResume \? \{ autoResume: rec\.autoResume \} : \{\}\)/.test(src));
  // Dropping it on success is what resets the count.
  const ended = bodyOf("markTurnEnded");
  check("...so a clean turn clears it", /bad && rec\.autoResume/.test(ended), ended.slice(0, 200));
}

// ── Wiring ────────────────────────────────────────────────────────────────
{
  check("the sweep is actually scheduled", /autoResumeSweep\(\);/.test(src) && /AUTO_RESUME_SWEEP_MS\)/.test(src));
  check("a sweep failure cannot kill the driver",
    /try \{ autoResumeSweep\(\); \} catch/.test(src));
  check("the timer does not hold the process open", /AUTO_RESUME_SWEEP_MS\)\.unref/.test(src));
  check("aborted is excluded at the source",
    !/AUTO_RESUME_REASONS = new Set\(\[[^\]]*aborted/.test(src));
}

console.log(`keep-alive supervisor: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
