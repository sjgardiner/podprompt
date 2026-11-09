// Unit tests for the delegate_session bubble — §13d.
//
// Run: node viewer/delegate.test.mjs
//
// THE BUG THIS GUARDS. The bubble's entire status vocabulary was
//
//     running | idle | waiting for your answer | waiting for your approval
//
// which has no way to say "this died" or "this is waiting out a usage
// limit". A delegated child whose turn was KILLED therefore rendered as
// `idle` — character-for-character identical to one that had finished its
// work. That is §15's bug one level up: we stopped RECORDING a killed turn
// as finished and then went on DISPLAYING it as finished.
//
// THE SECOND BUG, which is why §13d deferred the collapse control rather
// than building it: refreshDelegateBubbles() ran `entry.el.innerHTML = ''`
// on every sessions poll. The delegation prompt appeared and then vanished a
// second later, and any expand state would have reset every few seconds. A
// periodic refresh that destroys user-facing state is a bug on its own.
//
// Both halves are read out of the shipped files at run time, so there is no
// copy to drift.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const html = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");

function bodyOf(text, name) {
  const i = text.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`no longer defines ${name}()`);
  let parens = 0, open = -1;
  for (let k = text.indexOf("(", i); k < text.length; k++) {
    if (text[k] === "(") parens++;
    else if (text[k] === ")" && --parens === 0) { open = text.indexOf("{", k); break; }
  }
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === "{") depth++;
    else if (text[k] === "}" && --depth === 0) return text.slice(i, k + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

const delegateStatus = new Function(`${bodyOf(html, "delegateStatus")}; return delegateStatus;`)();

const AT = (mins) => new Date(Date.now() + mins * 60000).toISOString();

// ── The states that already worked ───────────────────────────────────────
{
  check("a running child says so",
    delegateStatus({ inFlight: true }).text === "running");
  check("a child blocked on a question says so",
    delegateStatus({ pendingKind: "question" }).text === "waiting for your answer");
  check("a child blocked on a permission says so",
    delegateStatus({ pendingKind: "permission" }).text === "waiting for your approval");
  // Both blocked states are the user's cue to act, so neither may render as
  // ordinary.
  check("...and both are highlighted",
    delegateStatus({ pendingKind: "question" }).sev === "warn"
    && delegateStatus({ pendingKind: "permission" }).sev === "warn");

  // Blocking outranks running: a child awaiting approval is technically
  // still in its turn, and reporting "running" would hide the one state
  // that needs a human.
  check("blocked outranks running",
    delegateStatus({ inFlight: true, pendingKind: "permission" }).text
      === "waiting for your approval");

  check("a healthy finished child is idle",
    delegateStatus({}).text === "idle");
  check("...and is not highlighted", delegateStatus({}).sev === "");
}

// ── THE REGRESSION: a dead child must not read as idle ───────────────────
{
  const dead = delegateStatus({ turnHealth: { reason: "error" } });
  check("a failed child does NOT say idle", dead.text !== "idle", dead);
  check("...it says it failed", /failed/.test(dead.text), dead);
  check("...and is marked as bad", dead.sev === "bad", dead);

  const exhausted = delegateStatus({
    turnHealth: { reason: "error", resumeBlocked: "strikes-exhausted" },
  });
  check("a child past its retry cap asks for a human",
    /needs you/.test(exhausted.text), exhausted);
  check("...and is marked as bad", exhausted.sev === "bad", exhausted);

  const broke = delegateStatus({
    turnHealth: { reason: "error", resumeBlocked: "quota_exhausted" },
  });
  check("an out-of-credit child says so", /credit/.test(broke.text), broke);
  check("...and is marked as bad", broke.sev === "bad", broke);
}

// ── A scheduled wait is not a failure ────────────────────────────────────
//
// §15/KD3: a five-hour limit means a correct five-hour sleep. Colouring that
// as a fault would train the user to ignore the colour that matters.
{
  const waiting = delegateStatus({
    turnHealth: { reason: "error", category: "rate_limited", resumeAt: AT(40), resumeScheduled: true },
  });
  check("a rate-limited child names the limit",
    /usage limit/.test(waiting.text), waiting);
  check("...and says when it resumes", /resuming/.test(waiting.text), waiting);
  check("...and is a warning, not a failure", waiting.sev === "warn", waiting);

  // An unscheduled retry IS a failure that happens to be retrying.
  const retrying = delegateStatus({
    turnHealth: { reason: "error", resumeAt: AT(5), resumeScheduled: false },
  });
  check("an unscheduled retry still reads as failed",
    /failed/.test(retrying.text), retrying);
  check("...but says it is retrying", /retrying/.test(retrying.text), retrying);
}

// ── Time wording ─────────────────────────────────────────────────────────
//
// "in ~3m" is actionable for a short wait; a wall-clock time is what you
// want for a long one, because the question becomes "should I go and do
// something else".
{
  const soon = delegateStatus({ turnHealth: { reason: "error", resumeAt: AT(3), resumeScheduled: true } });
  check("a short wait is relative", /~3m/.test(soon.text), soon);

  const later = delegateStatus({ turnHealth: { reason: "error", resumeAt: AT(240), resumeScheduled: true } });
  check("a long wait is a clock time", /at \d/.test(later.text), later);

  const due = delegateStatus({ turnHealth: { reason: "error", resumeAt: AT(-5), resumeScheduled: true } });
  check("an elapsed wait does not show negative minutes",
    !/-\d/.test(due.text) && /any moment/.test(due.text), due);
}

// ── A human stop is not a fault ──────────────────────────────────────────
//
// It is the one "down" state the user created on purpose. Reporting it in
// the failure colour would be crying wolf at the user's own action.
{
  const stopped = delegateStatus({ turnHealth: { reason: "aborted", stopped: true } });
  check("a stopped child says the user stopped it",
    /stopped by you/.test(stopped.text), stopped);
  check("...and is not flagged as a failure", stopped.sev === "", stopped);

  // Live state still outranks it: once it is running again, say running.
  const back = delegateStatus({ inFlight: true, turnHealth: { reason: "aborted", stopped: true } });
  check("a restarted child reports running, not stopped",
    back.text === "running", back);
}

// ── The poll must stop destroying the bubble ─────────────────────────────
{
  const fn = bodyOf(html, "refreshDelegateBubbles");
  check("the per-poll rebuild is gone", !/innerHTML\s*=\s*''/.test(fn), fn.slice(0, 200));
  // The prompt is MOVED into the collapsible half, not re-rendered or
  // dropped — it is the one piece of content the driver cannot reproduce.
  check("existing content is moved, not discarded",
    /while \(entry\.el\.firstChild\) detail\.appendChild\(entry\.el\.firstChild\)/.test(fn), fn);
  check("the bubble is built once and cached",
    /delegateUI\.get\(entry\.el\)/.test(fn) && /delegateUI\.set\(entry\.el/.test(fn));
  check("the per-poll update only writes text",
    /ui\.status\.textContent =/.test(fn) && /ui\.title\.textContent =/.test(fn));
  check("the header toggles the fold",
    /head\.addEventListener\('click', \(\) => entry\.el\.classList\.toggle\('expanded'\)\)/.test(fn));
  // Without stopPropagation the open-session click also folds the bubble.
  check("opening the session does not toggle the fold",
    /e\.stopPropagation\(\)/.test(fn), fn);
  // A WeakMap keyed on the element, so a bubble that leaves the DOM is not
  // retained by its own cache.
  check("the cache cannot leak bubbles", /const delegateUI = new WeakMap\(\)/.test(html));
}

// ── Collapsed by default, and visible when expanded ──────────────────────
{
  check("the detail half is hidden by default",
    /\.delegate-detail \{[^}]*display: none/.test(html));
  check("...and shown when expanded",
    /\.delegate\.expanded \.delegate-detail \{ display: block; \}/.test(html));
  check("the header shows a fold caret", /\.delegate-head::before \{ content: '▸'/.test(html));
  check("...which flips when open", /\.delegate\.expanded \.delegate-head::before \{ content: '▾'/.test(html));
  check("a bad status is visually distinct", /\.delegate-status\.bad \{[^}]*--danger/.test(html));
  check("a warning status is visually distinct", /\.delegate-status\.warn \{[^}]*--warn/.test(html));
}

// ── The driver must actually supply the data ─────────────────────────────
//
// All of the above renders "idle" forever unless turnHealth reaches the
// browser, so the wiring is asserted too.
{
  check("the driver defines one shape for turn health",
    /function describeTurnHealth\(sessionId\)/.test(src));
  check("the delegate payload carries it",
    /turnHealth: describeTurnHealth\(childId\)/.test(src));
  check("the session list carries it too",
    /s_\.turnHealth = describeTurnHealth\(s_\.sessionId\)/.test(src));
  // One function for peers and humans, so a parent agent and the user are
  // never told different things about the same session.
  check("the peer listing uses the SAME shape",
    /stalled: describeTurnHealth\(s\.sessionId\)/.test(src));

  const h = bodyOf(src, "describeTurnHealth");
  check("a healthy session reports nothing", /if \(!r\) return null;/.test(h), h);
  check("a human stop is distinguishable from a failure",
    /stopped: r\.reason === "aborted"/.test(h), h);
  check("the scheduled wake is included", /\.\.\.describeWake\(sessionId\)/.test(h), h);
}

console.log(`delegate bubble (§13d): ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
