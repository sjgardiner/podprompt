// Unit tests for durable delegation expectations and the staleness watchdog.
//
// Run: node viewer/expectations.test.mjs
//
// THE TWO DEFECTS THIS GUARDS, both measured before the fix:
//
//   1. THE PREMATURE REPORT. The delegated-work reporter fired on a child's
//      FIRST turn end, whatever ended it. `error`, `stalled` and `restart`
//      are all in AUTO_RESUME_REASONS, so a child that hit a rate limit was
//      reported to its parent as "ended with no output (error)" while
//      autoResumeSweep was, correctly, about to retry it. The retry then
//      succeeded and the real answer had nowhere to go, because
//      resolveTurnWaiters() deletes the whole waiter list on its first fire.
//      The parent was not stalled; it had been told the opposite of the
//      truth. No crash was needed -- an ordinary 429 was enough.
//
//   2. THE LOST WATCHER. The watcher was a bare in-memory Map. A driver
//      restart dropped every pending delegation silently; the child was
//      auto-resumed, finished, and nobody was told.
//
// The driver-side functions are read out of the shipped driver.mjs at run
// time, so there is no copy here to drift from the code -- the same idiom
// delegate.test.mjs uses. The retry policy is imported from the real
// limits.mjs for the same reason.

import { readFileSync, rmSync, existsSync } from "node:fs";
import { createExpectations } from "./expectations.mjs";
import { CATEGORY, NO_RETRY } from "./limits.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");

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
function constSource(name) {
  const m = src.match(new RegExp(`^const ${name} = [^;]+;`, "m"));
  if (!m) throw new Error(`driver.mjs no longer defines const ${name}`);
  return m[0];
}

// ── harness ────────────────────────────────────────────────────────────────
const TMP = "/tmp/pp-expectations-test.json";
if (existsSync(TMP)) rmSync(TMP);

const state = {
  turnState: {},
  sessions: new Map(),
  pendingKind: {},            // sessionId -> "permission" | "question" | null
  transcripts: {},            // sessionId -> final assistant text
  delivered: [],              // what parents actually received
  logs: [],
};

const expectations = createExpectations({ file: TMP, onError: (e) => { throw e; } });

const deps = {
  turnState: state.turnState,
  sessions: state.sessions,
  expectations,
  NO_RETRY,
  peers: { get: (id) => ({ handle: id.replace(/[^a-z0-9]/gi, "") }) },
  localPrincipal: (id) => ({ realm: "local", id }),
  pendingKindForSession: (id) => state.pendingKind[id] || null,
  finalAssistantText: async (id) => state.transcripts[id] ?? null,
  // ASYNC, because deliver() is: folding a message into a running turn can
  // mean an HTTP round trip to a backend. A synchronous stub would let a
  // missing await pass here and only fail in production.
  deliver: async (to, body, opts) => {
    state.delivered.push({ to, body, kind: opts?.kind });
    return { ok: true };
  },
  console: { log: (...a) => state.logs.push(a.join(" ")), error: (...a) => state.logs.push(a.join(" ")) },
};

const M = new Function("deps", `
  const { turnState, sessions, expectations, NO_RETRY, peers, localPrincipal,
          pendingKindForSession, finalAssistantText, deliver, console } = deps;
  ${constSource("AUTO_RESUME_REASONS")}
  ${constSource("AUTO_RESUME_MAX_STRIKES")}
  ${constSource("EXPECTATION_STALE_MS")}
  ${fnSource("willAutoResume")}
  ${fnSource("deliverDelegateReport")}
  ${fnSource("reportDelegateIfTerminal")}
  ${fnSource("expectationSweep")}
  return { willAutoResume, reportDelegateIfTerminal, expectationSweep,
           AUTO_RESUME_REASONS, AUTO_RESUME_MAX_STRIKES, EXPECTATION_STALE_MS };
`)(deps);

// Mirrors driver.mjs's own end-of-turn ordering closely enough for these
// questions: the resumable record is written, then the reporter is asked.
function endTurn(id, outcome) {
  const prev = state.turnState[id] || {};
  const bad = ["error", "aborted", "stalled"].includes(outcome.reason);
  state.turnState[id] = {
    inFlight: false,
    ...(bad && prev.autoResume ? { autoResume: prev.autoResume } : {}),
    ...(bad ? { resumable: { reason: outcome.reason, category: outcome.category || null, at: new Date().toISOString() } } : {}),
  };
  return M.reportDelegateIfTerminal(id, outcome);
}

// ── 1 · the store itself ───────────────────────────────────────────────────
expectations.record("c1", "p1");
check("record() stores a row keyed by child", expectations.get("c1")?.parentId === "p1");
check("a fresh row is not yet notified", expectations.get("c1")?.notified === false);
expectations.markNotified("c1");
check("markNotified() does not remove the row (parent still has no answer)",
  expectations.get("c1")?.notified === true && expectations.get("c1") !== null);
expectations.clear("c1");
check("clear() removes it", expectations.get("c1") === null);

expectations.record("c2", "pX");
expectations.record("c3", "pX");
check("forgetFor() drops every row for a parent", expectations.forgetFor("pX").length === 2);

// Durability: a second store over the same file sees the same rows.
expectations.record("c4", "p4");
const reopened = createExpectations({ file: TMP });
check("rows survive a process restart (the lost-watcher defect)",
  reopened.get("c4")?.parentId === "p4");
expectations.clear("c4");

// ── 2 · willAutoResume: the shared predicate ───────────────────────────────
check("'error' is auto-resumable per the shipped constant", M.AUTO_RESUME_REASONS.has("error"));
check("rate_limited is NOT in NO_RETRY", !NO_RETRY.has(CATEGORY.RATE_LIMITED));

state.turnState.w = { resumable: { reason: "error", category: CATEGORY.RATE_LIMITED } };
check("a rate-limited failure will be retried", M.willAutoResume("w") === true);
state.turnState.w = { resumable: { reason: "error", category: CATEGORY.QUOTA_EXHAUSTED } };
check("a quota-exhausted failure will NOT (KD2: hopeless without a human)",
  M.willAutoResume("w") === false);
state.turnState.w = { resumable: { reason: "aborted" } };
check("a human abort will NOT be retried", M.willAutoResume("w") === false);
state.turnState.w = { resumable: { reason: "error" }, autoResume: { strikes: M.AUTO_RESUME_MAX_STRIKES } };
check("a spent strike count will NOT be retried", M.willAutoResume("w") === false);
state.turnState.w = {};
check("a clean finish is not 'resumable' at all", M.willAutoResume("w") === false);

// ── 3 · DEFECT 1: no report while a child is still going to be retried ────
expectations.record("kid", "mum");
state.transcripts.kid = null;
state.turnState.kid = { autoResume: { strikes: 1 } };
await endTurn("kid", { reason: "error", category: CATEGORY.RATE_LIMITED });

check("a retryable failure reports NOTHING to the parent",
  state.delivered.length === 0, state.delivered.map((d) => d.body?.slice(0, 50)));
check("…and the expectation is kept, so the real answer can still arrive",
  expectations.get("kid")?.parentId === "mum");

// The retry succeeds.
state.transcripts.kid = "The actual finished analysis.";
await endTurn("kid", { reason: "completed" });

check("the successful retry IS reported", state.delivered.length === 1);
check("…with the real content, not a failure notice",
  /actual finished analysis/.test(state.delivered[0]?.body || ""),
  state.delivered[0]?.body?.slice(0, 60));
check("…and the expectation is cleared once reported",
  expectations.get("kid") === null);

// Exhausted retries ARE terminal and must be reported, or a dead child is
// never reported at all.
state.delivered.length = 0;
expectations.record("doomed", "mum");
state.transcripts.doomed = null;
state.turnState.doomed = { autoResume: { strikes: M.AUTO_RESUME_MAX_STRIKES } };
await endTurn("doomed", { reason: "error", category: CATEGORY.RATE_LIMITED });
check("a child with its strikes spent IS reported (death is terminal)",
  state.delivered.length === 1 && /ended with no output/.test(state.delivered[0].body));

// ── 4 · the watchdog ───────────────────────────────────────────────────────
state.delivered.length = 0;
const OLD = Date.now() - M.EXPECTATION_STALE_MS - 60000;

// Busy child: never stale, however long it has been.
expectations.record("busy", "mum");
expectations._store.expectations.busy.since = OLD;
state.sessions.set("busy", { turnInFlight: true });
check("a WORKING child is never stale, at any age", M.expectationSweep().length === 0);

// About to be retried: also not stale.
state.sessions.set("busy", { turnInFlight: false });
state.turnState.busy = { resumable: { reason: "error", category: CATEGORY.RATE_LIMITED } };
check("a child pending a retry is not stale either", M.expectationSweep().length === 0);
delete state.turnState.busy;
expectations.clear("busy");

// Young expectation: not stale.
expectations.record("young", "mum");
state.sessions.set("young", { turnInFlight: false });
check("a recent expectation is not stale", M.expectationSweep().length === 0);
expectations.clear("young");

// Idle and old: stale.
expectations.record("quiet", "mum");
expectations._store.expectations.quiet.since = OLD;
state.sessions.set("quiet", { turnInFlight: false });
const fired = M.expectationSweep();
check("an idle, old expectation fires", fired.includes("quiet"));
check("…and the parent is told", state.delivered.length === 1);
check("…with wording about not reporting back",
  /has not reported back/.test(state.delivered[0]?.body || ""),
  state.delivered[0]?.body?.slice(0, 70));
check("fires at most ONCE per expectation", M.expectationSweep().length === 0);
check("…but the row survives, so a late finish can still be reported",
  expectations.get("quiet") !== null);

// Blocked on a human: different wording, because this is not a malfunction.
state.delivered.length = 0;
expectations.record("asking", "mum");
expectations._store.expectations.asking.since = OLD;
state.sessions.set("asking", { turnInFlight: false });
state.pendingKind.asking = "permission";
M.expectationSweep();
check("a child blocked on approval fires", state.delivered.length === 1);
check("…and says a human is needed, not that something broke",
  /waiting for a human/.test(state.delivered[0]?.body || "")
  && !/has not reported back/.test(state.delivered[0]?.body || ""),
  state.delivered[0]?.body?.slice(0, 90));

// ── report ─────────────────────────────────────────────────────────────────
if (existsSync(TMP)) rmSync(TMP);
console.log(`\nexpectations.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
