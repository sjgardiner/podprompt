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
import {
  CATEGORY, NO_RETRY, LADDER, RESET_PAD_MS, nextAttemptAt, createLimitRegistry,
} from "./limits.mjs";

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

// The scheduling half now lives in limits.mjs (§15/KD3), and the REAL
// implementations are injected rather than stubbed. Stubbing them would let
// the two halves drift: the sweep's whole job is now "ask limits.mjs when,
// then act", and a fake clock-oracle would assert only the acting.
function fresh(state, { startOk = true, idle = true, backend = "claude-code", limitInfo = null, relations = null, knownBackends = true } = {}) {
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
    const { CATEGORY, NO_RETRY, nextAttemptAt } = arguments[3];
    const sessionIdToBackend = arguments[4];
    const limitRegistry = arguments[5];
    const sessionRelations = arguments[6];
    const sessions = new Map();
    const unresolvedBackendWarned = new Set();
    ${bodyOf("resolvedBackendId")}
    const AUTO_RESUME_REASONS = new Set(["restart", "stalled", "error"]);
    const AUTO_RESUME_MAX_STRIKES = 3;
    // The sweep's own "will this ever run again?" test. Shared with the
    // delegated-work reporter so the two cannot disagree about whether a
    // child is finished — which is precisely how a child being retried came
    // to be reported to its parent as failed.
    ${bodyOf("willAutoResume")}
    ${bodyOf("plannedWakeFor")}
    ${bodyOf("autoResumeSweep")}
    ${bodyOf("describeWake")}
    return { autoResumeSweep, describeWake, plannedWakeFor, turnState, calls };
  `;
  const registry = createLimitRegistry();
  if (limitInfo) registry.note(backend, limitInfo);
  const backendMap = knownBackends
    ? new Map(Object.keys(state).map((id) => [id, backend]))
    : new Map();
  return new Function(sandbox)(
    state, startOk, idle,
    { CATEGORY, NO_RETRY, nextAttemptAt },
    backendMap, registry, relations || {},
  );
}

const resumable = (reason, atMsAgo = HOUR, extra = {}) =>
  ({ reason, error: null, lastTool: null, at: AGO(atMsAgo), ...extra });

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

// ── §15: a quota wall is never retried ────────────────────────────────────
//
// The failure mode this prevents: treating "out of credits until a human
// buys more" exactly like "the process crashed" — burning all three strikes
// against an immovable wall inside the first three minutes, then declaring
// the session beyond help for a reason that had nothing to do with it.
{
  const wall = fresh({ a: {
    inFlight: false,
    resumable: resumable("error", HOUR, { category: CATEGORY.QUOTA_EXHAUSTED }),
  } });
  wall.autoResumeSweep();
  check("a quota-exhausted turn is never retried", wall.calls.started.length === 0);
  check("...and does not even spend a strike", wall.turnState.a.autoResume === undefined);
  check("...and says so rather than going quiet",
    wall.describeWake("a").resumeBlocked === CATEGORY.QUOTA_EXHAUSTED, wall.describeWake("a"));

  // Every other category still retries — the point is discrimination, not
  // a new way to refuse.
  for (const category of [CATEGORY.TRANSIENT, CATEGORY.RATE_LIMITED, CATEGORY.OVERLOADED]) {
    const d = fresh({ a: {
      inFlight: false, resumable: resumable("error", 2 * HOUR, { category }),
    } });
    d.autoResumeSweep();
    check(`${category} is still retried`, d.calls.started.length === 1, category);
  }
}

// ── §15: a known reset time replaces the ladder ───────────────────────────
{
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const waiting = fresh({ a: {
    inFlight: false,
    resumable: resumable("error", HOUR, { category: CATEGORY.RATE_LIMITED, retryAt: soon }),
  } });
  waiting.autoResumeSweep();
  // The ladder alone would have fired an hour ago. The reset has not
  // arrived, so nothing should happen — and this is the assertion that
  // proves the horizon actually overrides the ladder rather than racing it.
  check("a session waiting on a future reset is not retried",
    waiting.calls.started.length === 0, waiting.calls.started);

  const w = waiting.describeWake("a");
  check("...but it reports WHEN it will resume", !!w.resumeAt, w);
  check("...marked as scheduled, not guessed", w.scheduled !== false && w.resumeScheduled === true, w);
  // A five-hour limit means a correct five-hour sleep. §13e trained everyone
  // to read a silent session as broken, so this must not be silent.
  check("...which is past the reset, not before it",
    new Date(w.resumeAt).getTime() >= new Date(soon).getTime() + RESET_PAD_MS, w);

  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const ready = fresh({ a: {
    inFlight: false,
    resumable: resumable("error", HOUR, { category: CATEGORY.RATE_LIMITED, retryAt: past }),
  } });
  ready.autoResumeSweep();
  check("an elapsed reset falls back to the ladder and fires",
    ready.calls.started.length === 1, ready.calls.started);
}

// ── §15: the account-wide registry can move a session's wake ──────────────
//
// KD4. A limit belongs to the ACCOUNT. A session that failed BEFORE anyone
// knew the reset time must still pick it up from whichever session
// discovered it — otherwise each one learns the horizon only by failing
// against the wall itself.
{
  const resetsAt = Date.now() + 40 * 60 * 1000;
  const d = fresh(
    { a: { inFlight: false, resumable: resumable("error", 2 * HOUR, { category: CATEGORY.RATE_LIMITED }) } },
    { backend: "claude-code", limitInfo: { status: "rejected", resetsAt } },
  );
  d.autoResumeSweep();
  check("a limit learned elsewhere defers this session's retry",
    d.calls.started.length === 0, d.calls.started);
  check("...to just after that reset",
    new Date(d.describeWake("a").resumeAt).getTime() >= resetsAt + RESET_PAD_MS,
    d.describeWake("a"));

  // Only when the registry says we are actually blocked: an "allowed"
  // snapshot must not park a session that simply crashed.
  const allowed = fresh(
    { a: { inFlight: false, resumable: resumable("error", 2 * HOUR, { category: CATEGORY.RATE_LIMITED }) } },
    { limitInfo: { status: "allowed", resetsAt } },
  );
  allowed.autoResumeSweep();
  check("an 'allowed' snapshot does not defer anything",
    allowed.calls.started.length === 1, allowed.calls.started);
}

// ── §15: the wake must be STABLE across sweeps ────────────────────────────
//
// The sweep recomputes the wake every minute and compares it to the clock.
// With Math.random() jitter the same session would get a different deadline
// each tick — sometimes already past, sometimes not — and the retry would
// fire on whichever sweep happened to roll low. That is a race, not a
// schedule.
{
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const d = fresh({ a: {
    inFlight: false,
    resumable: resumable("error", HOUR, { category: CATEGORY.RATE_LIMITED, retryAt: soon }),
  } });
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    d.autoResumeSweep();
    seen.add(d.describeWake("a").resumeAt);
  }
  check("the reported wake does not move between sweeps", seen.size === 1, [...seen]);
  check("...and none of those sweeps fired early", d.calls.started.length === 0);
}

// ── §15: an exhausted session reports why, rather than going silent ───────
{
  const spent = fresh({ a: {
    inFlight: false, resumable: resumable("error"),
    autoResume: { strikes: 3, lastAt: AGO(HOUR) },
  } });
  check("a strike-exhausted session says so",
    spent.describeWake("a").resumeBlocked === "strikes-exhausted", spent.describeWake("a"));

  const running = fresh({ a: { inFlight: true, resumable: resumable("error") } });
  check("a running session advertises no wake",
    running.describeWake("a").resumeAt === undefined, running.describeWake("a"));

  const aborted = fresh({ a: { inFlight: false, resumable: resumable("aborted") } });
  check("a deliberately stopped session advertises no wake",
    aborted.describeWake("a").resumeAt === undefined, aborted.describeWake("a"));
  check("...and is not flagged as blocked either",
    aborted.describeWake("a").resumeBlocked === undefined, aborted.describeWake("a"));
}

// ── REGRESSION: never guess a backend for an unattended resume ───────────
//
// SHIPPED AND CAUGHT LIVE. sessionIdToBackend is populated only as a side
// effect of gatherAllSessions(), and opencode's /sessions poll reliably
// fails for the first seconds after a restart while its server comes up. So
// at the exact moment the first sweep ran, no opencode session was in the
// map and the resolver fell through to defaultBackendId() — handing two
// `oc-...` sessions to the CLAUDE-CODE backend, which rejected them with
// "Invalid session ID. Must be a valid UUID." and burned a strike each.
//
// A human starting a new chat can survive a wrong default; they see it and
// pick again. Nobody is watching here.
{
  const unknown = fresh(
    { "oc-x": { inFlight: false, resumable: resumable("error") } },
    { knownBackends: false },
  );
  unknown.autoResumeSweep();
  check("a session with no known backend is not resumed",
    unknown.calls.started.length === 0, unknown.calls.started);
  // Deferring must not cost an attempt: the backend map fills in within a
  // poll or two, and burning strikes while waiting would exhaust the cap
  // before the system was even ready to try.
  check("...and deferring does not spend a strike",
    unknown.turnState["oc-x"].autoResume === undefined, unknown.turnState["oc-x"]);

  // The durable relation index is the fix: it is written when the child is
  // created and survives both a restart and an unreachable backend.
  const viaRelation = fresh(
    { "oc-x": { inFlight: false, resumable: resumable("error") } },
    { knownBackends: false, relations: { "oc-x": { backend: "opencode", childKind: "delegated" } } },
  );
  viaRelation.autoResumeSweep();
  check("a relation-index backend is enough to resume",
    viaRelation.calls.started.length === 1, viaRelation.calls.started);

  // And once the poll succeeds, the live map alone is enough.
  const viaMap = fresh({ "oc-x": { inFlight: false, resumable: resumable("error") } });
  viaMap.autoResumeSweep();
  check("a listed backend is enough to resume", viaMap.calls.started.length === 1);
}

// ── The relation index outranks the live map ──────────────────────────────
//
// The map is a cache of whatever answered a poll; the relation row is a fact
// recorded when the child was created. A stale or wrong cache entry must not
// beat it.
{
  const src2 = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
  const fn = bodyOf("resolvedBackendId");
  check("the durable relation is consulted first",
    fn.indexOf("sessionRelations") < fn.indexOf("sessionIdToBackend"),
    [fn.indexOf("sessionRelations"), fn.indexOf("sessionIdToBackend")]);
  // Both turn-path resolvers must route through it, or the fix only covers
  // whichever one happened to be tested.
  check("getSessionState resolves through it",
    /explicitBackendId \|\| resolvedBackendId\(sessionId\) \|\| defaultBackendId\(\)/.test(src2));
  check("backendFor resolves through it",
    (src2.match(/resolvedBackendId\(sessionId\) \|\| defaultBackendId\(\)/g) || []).length >= 2,
    (src2.match(/resolvedBackendId\(sessionId\) \|\| defaultBackendId\(\)/g) || []).length);
}

// ── Deleting a session must drop its turn state ──────────────────────────
//
// FOUND BY PURGING 50 SESSIONS AT ONCE: 24 of the 25 remaining turn-state
// rows belonged to sessions that no longer existed. /delete-session cleaned
// relation rows and orphaned mail and forgot this one index entirely, so the
// file grew monotonically and autoResumeSweep walked every dead row once a
// minute, forever.
//
// Harmless until now only by luck: every orphan carrying a resumable said
// "aborted", which is the one reason the sweep never acts on. One saying
// "error" would have had the supervisor repeatedly trying to resurrect a
// session with no transcript and no relation row to resolve a backend from.
{
  const del = src.slice(src.indexOf('path === "/delete-session"'));
  const body = del.slice(0, del.indexOf('path === "/rename-session"'));
  check("the delete route drops turn state", /delete turnState\[id\]/.test(body), body.slice(-900));
  check("...for the cascaded children as well as the target",
    /for \(const id of \[\.\.\.gone, body\.sessionId\]\)/.test(body), body.slice(-900));
  check("...and persists the removal", /if \(droppedTurnState\) saveTurnState\(\);/.test(body));
  // Reported back, so a caller can tell a clean delete from one that left
  // something behind.
  check("...and reports what it dropped", /droppedTurnState,/.test(body));
  // It must use `gone` (what ACTUALLY deleted), not `doomed` (what was
  // attempted) — otherwise a child whose delete failed loses the turn state
  // that would let it be resumed, while the session itself survives.
  check("it drops state only for sessions that really went",
    !/for \(const id of \[\.\.\.doomed/.test(body), body.slice(-900));
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
