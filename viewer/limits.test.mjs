// Unit tests for usage-limit classification and retry horizons — §15.
//
// Run: node viewer/limits.test.mjs
//
// THE BUG THIS GUARDS. A turn killed by a usage limit was recorded as a
// clean completion: claude-code's result handler was literally `continue;`
// and opencode's parent event handler ignored session.status and
// session.error. No failure recorded means no `resumable` record, which
// means the keep-alive supervisor never saw it — an agent stopped by a
// billing limit looked identical to one that had finished its job.
//
// THE TRAP, which the obvious implementation walks straight into: on
// claude-code a usage-limit ending arrives labelled subtype:"success" while
// carrying is_error:true and terminal_reason:"blocking_limit". Those fields
// live on the SUCCESS result type. Switching on subtype — the natural thing
// to write — passes every test that does not involve a real limit and
// catches none of them in production. Asserted explicitly below.

import { readFileSync } from "node:fs";
import {
  CATEGORY, NO_RETRY, LADDER, RESET_PAD_MS, JITTER_MS,
  classifyFailure, nextAttemptAt, normalizeResetMs, resetFromHeaders,
  createLimitRegistry, spread,
} from "./limits.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const MIN = 60 * 1000;

// ── normalizeResetMs: the seconds-vs-milliseconds ambiguity ──────────────
//
// The SDK declares resetsAt as a bare `number`. Guessing wrong is a factor
// of 1000 IN EITHER DIRECTION: a seconds value read as ms lands in 1970
// (retry instantly, defeating the point), an ms value read as seconds lands
// tens of thousands of years out (never retry at all).
{
  const inMs = NOW + 30 * MIN;
  check("a millisecond timestamp passes through", normalizeResetMs(inMs, NOW) === inMs);
  check("a second timestamp is scaled up",
    normalizeResetMs(Math.floor(inMs / 1000), NOW) === Math.floor(inMs / 1000) * 1000);
  check("a numeric string is accepted", normalizeResetMs(String(inMs), NOW) === inMs);

  // CAUGHT BY A TEST, NOT BY REVIEW. The horizon is PERSISTED as an ISO
  // string — markTurnEnded writes toISOString so turn state stays readable
  // on disk — and then read back by the sweep. Accepting only numbers meant
  // Number("2026-...") was NaN, the horizon was silently dropped, and the
  // session fell back to a ladder guess. Every scheduled wait would have
  // survived exactly as long as the process did.
  check("an ISO string is accepted", normalizeResetMs(new Date(inMs).toISOString(), NOW) === inMs);
  check("a Date is accepted", normalizeResetMs(new Date(inMs), NOW) === inMs);
  check("an empty string is still rejected", normalizeResetMs("", NOW) === null);
  check("whitespace is still rejected", normalizeResetMs("   ", NOW) === null);

  // Each of these must degrade to "unknown horizon" — which falls back to
  // the ladder — rather than throwing or scheduling nonsense.
  check("a past reset is rejected", normalizeResetMs(NOW - MIN, NOW) === null);
  check("now itself is rejected", normalizeResetMs(NOW, NOW) === null);
  check("zero is rejected", normalizeResetMs(0, NOW) === null);
  check("negative is rejected", normalizeResetMs(-5, NOW) === null);
  check("null is rejected", normalizeResetMs(null, NOW) === null);
  check("undefined is rejected", normalizeResetMs(undefined, NOW) === null);
  check("NaN is rejected", normalizeResetMs(NaN, NOW) === null);
  check("garbage text is rejected", normalizeResetMs("soon", NOW) === null);
  // The one that would park a session forever.
  check("an implausibly distant reset is rejected",
    normalizeResetMs(NOW + 400 * 24 * 3600 * 1000, NOW) === null);
  check("48h out is still rejected", normalizeResetMs(NOW + 49 * 3600 * 1000, NOW) === null);
  check("...but 5 hours is fine", normalizeResetMs(NOW + 5 * 3600 * 1000, NOW) !== null);
}

// ── resetFromHeaders: whatever the provider happened to send ─────────────
{
  check("retry-after as delay seconds becomes an instant",
    resetFromHeaders({ "retry-after": "60" }, NOW) === NOW + 60000);
  check("...case-insensitively",
    resetFromHeaders({ "Retry-After": "60" }, NOW) === NOW + 60000);
  check("retry-after as an HTTP date is parsed",
    resetFromHeaders({ "retry-after": new Date(NOW + 10 * MIN).toUTCString() }, NOW)
      === NOW + 10 * MIN);
  check("an ISO ratelimit reset header is parsed",
    resetFromHeaders({ "anthropic-ratelimit-tokens-reset": new Date(NOW + 7 * MIN).toISOString() }, NOW)
      === NOW + 7 * MIN);

  // Longest wait wins: retrying when the EARLIEST of several dimensions
  // lifts just fails again on the others.
  const multi = resetFromHeaders({
    "x-ratelimit-requests-reset": new Date(NOW + 2 * MIN).toISOString(),
    "x-ratelimit-tokens-reset": new Date(NOW + 9 * MIN).toISOString(),
  }, NOW);
  check("the longest of several resets wins", multi === NOW + 9 * MIN, multi);

  check("no headers is null", resetFromHeaders(null, NOW) === null);
  check("empty headers is null", resetFromHeaders({}, NOW) === null);
  check("a non-object is null", resetFromHeaders("x", NOW) === null);
  check("unrelated headers are ignored",
    resetFromHeaders({ "content-type": "application/json" }, NOW) === null);
  check("a retry-after far beyond the window is rejected",
    resetFromHeaders({ "retry-after": String(72 * 3600) }, NOW) === null);
}

// ── classifyFailure: claude-code ─────────────────────────────────────────
{
  // THE CENTRAL ASSERTION OF THIS FILE. subtype says "success".
  const limit = classifyFailure({
    terminalReason: "blocking_limit",
    text: "Claude usage limit reached",
    now: NOW,
  });
  check("blocking_limit is rate-limited", limit.category === CATEGORY.RATE_LIMITED, limit);

  const refill = classifyFailure({ terminalReason: "rapid_refill_breaker", now: NOW });
  check("rapid_refill_breaker is rate-limited", refill.category === CATEGORY.RATE_LIMITED, refill);

  // A wall a human must clear. Retrying is pure waste.
  const budget = classifyFailure({ terminalReason: "budget_exhausted", now: NOW });
  check("budget_exhausted is quota-exhausted", budget.category === CATEGORY.QUOTA_EXHAUSTED, budget);

  const credits = classifyFailure({ rateLimitInfo: { errorCode: "credits_required" }, now: NOW });
  check("credits_required is quota-exhausted", credits.category === CATEGORY.QUOTA_EXHAUSTED, credits);

  const noCredit = classifyFailure({
    rateLimitInfo: { overageDisabledReason: "out_of_credits" }, now: NOW,
  });
  check("out_of_credits is quota-exhausted", noCredit.category === CATEGORY.QUOTA_EXHAUSTED, noCredit);

  // errorCode outranks a reset time: no amount of waiting buys credits.
  const both = classifyFailure({
    rateLimitInfo: { errorCode: "credits_required", status: "rejected", resetsAt: NOW + 20 * MIN },
    now: NOW,
  });
  check("credits_required outranks a reset time", both.category === CATEGORY.QUOTA_EXHAUSTED, both);
  check("...and no horizon is scheduled for it", both.retryAt === null, both);

  const rejected = classifyFailure({
    rateLimitInfo: { status: "rejected", resetsAt: NOW + 20 * MIN, rateLimitType: "five_hour" },
    now: NOW,
  });
  check("a rejected rate-limit status is rate-limited",
    rejected.category === CATEGORY.RATE_LIMITED, rejected);
  check("...and carries the reset", rejected.retryAt === NOW + 20 * MIN, rejected);
  check("...labelled with where it came from",
    rejected.horizonSource === "resetsAt", rejected.horizonSource);

  // Running ON overage: the base window's resetsAt is the wrong answer,
  // because what is actually blocking us is the overage balance.
  const overage = classifyFailure({
    rateLimitInfo: {
      status: "rejected", resetsAt: NOW + 5 * 3600 * 1000,
      overageStatus: "rejected", overageResetsAt: NOW + 12 * MIN,
    },
    now: NOW,
  });
  check("an overage reset outranks the base window",
    overage.retryAt === NOW + 12 * MIN, overage);
  check("...and says so", overage.horizonSource === "overageResetsAt", overage.horizonSource);

  check("api_error_status 429 is rate-limited",
    classifyFailure({ apiErrorStatus: 429, now: NOW }).category === CATEGORY.RATE_LIMITED);
}

// ── classifyFailure: opencode ────────────────────────────────────────────
{
  const retryable = classifyFailure({
    statusCode: 429, isRetryable: true,
    headers: { "retry-after": "120" },
    now: NOW,
  });
  check("429 is rate-limited", retryable.category === CATEGORY.RATE_LIMITED, retryable);
  check("...with the header's horizon", retryable.retryAt === NOW + 120000, retryable);
  check("...sourced from retry-after", retryable.horizonSource === "retry-after");

  // opencode's own verdict, from the component closest to the provider and
  // AFTER its internal retries. Honoured rather than overruled.
  const fatal = classifyFailure({ statusCode: 400, isRetryable: false, now: NOW });
  check("isRetryable:false is not retried", fatal.category === CATEGORY.QUOTA_EXHAUSTED, fatal);
  check("...and NO_RETRY agrees", NO_RETRY.has(fatal.category));

  // ...but not when the evidence says it is a limit, which DOES clear.
  const limitAnyway = classifyFailure({ statusCode: 429, isRetryable: false, now: NOW });
  check("a 429 is rate-limited even when flagged unretryable",
    limitAnyway.category === CATEGORY.RATE_LIMITED, limitAnyway);

  check("529 is overloaded",
    classifyFailure({ statusCode: 529, now: NOW }).category === CATEGORY.OVERLOADED);
  check("503 is overloaded",
    classifyFailure({ statusCode: 503, now: NOW }).category === CATEGORY.OVERLOADED);
  check("402 is quota-exhausted",
    classifyFailure({ statusCode: 402, now: NOW }).category === CATEGORY.QUOTA_EXHAUSTED);

  // session.status.next — opencode telling us when it would have retried.
  const next = classifyFailure({ statusCode: 429, nextRetryAt: NOW + 4 * MIN, now: NOW });
  check("session.status.next is used as a horizon",
    next.retryAt === NOW + 4 * MIN, next);

  // Several providers behind opencode report a quota wall as a bare 400
  // with prose, which no status code reveals.
  for (const text of [
    "Insufficient credits", "insufficient_quota", "Your credit balance is too low",
    "You exceeded your current quota", "payment required",
  ]) {
    const t = classifyFailure({ text, now: NOW });
    check(`"${text}" reads as quota-exhausted`, t.category === CATEGORY.QUOTA_EXHAUSTED, t);
  }
  for (const text of ["Rate limit exceeded", "too many requests", "usage limit reached"]) {
    const t = classifyFailure({ text, now: NOW });
    check(`"${text}" reads as rate-limited`, t.category === CATEGORY.RATE_LIMITED, t);
  }
  check('"Overloaded" reads as overloaded',
    classifyFailure({ text: "Overloaded", now: NOW }).category === CATEGORY.OVERLOADED);
}

// ── REGRESSION: ambient telemetry must not invent a rate limit ───────────
//
// SHIPPED AND CAUGHT LIVE. rate_limit_event is telemetry that fires whenever
// limit info CHANGES — including status:"allowed" — and it always carries
// the next window boundary. Taking resetsAt unconditionally gave every
// unrelated failure a horizon, and the "a horizon implies a limit" fallback
// then relabelled it rate_limited.
//
// The observed case: a session was handed to the wrong backend and died with
// "Invalid session ID. Must be a valid UUID."; it was recorded as
// rate_limited with a four-hour wait. Because a subscription account
// essentially always has a resetsAt, this silently disabled auto-resume for
// EVERY transient failure on claude-code.
{
  const healthy = { status: "allowed", resetsAt: NOW + 4 * 3600 * 1000, rateLimitType: "five_hour", utilization: 0.3 };

  const v = classifyFailure({
    text: "Invalid session ID. Must be a valid UUID.",
    rateLimitInfo: healthy,
    now: NOW,
  });
  check("a healthy snapshot does not make a crash a rate limit",
    v.category === CATEGORY.TRANSIENT, v);
  check("...and hands it no horizon at all", v.retryAt === null, v);

  // The warning state is still not a block: it means "getting close", and
  // parking a crashed session for hours on a warning would be the same bug
  // wearing a different status string.
  const warned = classifyFailure({
    text: "socket hang up",
    rateLimitInfo: { ...healthy, status: "allowed_warning", utilization: 0.95 },
    now: NOW,
  });
  check("an allowed_warning snapshot does not either",
    warned.category === CATEGORY.TRANSIENT, warned);
  check("...and still no horizon", warned.retryAt === null, warned);

  // The reset IS used once the snapshot actually says we are blocked.
  const real = classifyFailure({
    text: "something failed",
    rateLimitInfo: { ...healthy, status: "rejected" },
    now: NOW,
  });
  check("a rejected snapshot still supplies the horizon",
    real.category === CATEGORY.RATE_LIMITED && real.retryAt === healthy.resetsAt, real);

  // ...and a genuine limit is still caught even alongside healthy ambient
  // info, because the terminal reason is failure-scoped evidence.
  const genuine = classifyFailure({
    terminalReason: "blocking_limit", rateLimitInfo: healthy, now: NOW,
  });
  check("a real limit is still caught with healthy ambient info",
    genuine.category === CATEGORY.RATE_LIMITED, genuine);
}

// ── The default must be the cautious one ─────────────────────────────────
//
// An unrecognised failure has to retry, or a real crash is silently
// abandoned — the opposite of what this whole feature is for. TRANSIENT
// retries on the fast ladder, bounded by the existing strike cap.
{
  for (const [label, input] of [
    ["an empty failure", {}],
    ["a bare fetch error", { text: "fetch failed" }],
    ["an unknown status", { statusCode: 418 }],
    ["an unrecognised terminal reason", { terminalReason: "model_error" }],
  ]) {
    const v = classifyFailure({ ...input, now: NOW });
    check(`${label} degrades to transient`, v.category === CATEGORY.TRANSIENT, v);
    check(`...and ${label} is still retried`, !NO_RETRY.has(v.category));
  }

  // A horizon with no category still means SOMETHING told us to wait, and
  // only limits do that — better than calling it transient and throwing
  // away the reset time we were handed.
  const horizonOnly = classifyFailure({ headers: { "retry-after": "30" }, now: NOW });
  check("a bare retry-after implies a limit",
    horizonOnly.category === CATEGORY.RATE_LIMITED, horizonOnly);
}

// ── A horizon is only kept where it means something ──────────────────────
{
  const quota = classifyFailure({
    terminalReason: "budget_exhausted", headers: { "retry-after": "60" }, now: NOW,
  });
  check("a quota wall carries no horizon", quota.retryAt === null, quota);

  const transient = classifyFailure({ text: "socket hang up", now: NOW });
  check("a transient failure carries no horizon", transient.retryAt === null, transient);
}

// ── nextAttemptAt: scheduling ────────────────────────────────────────────
{
  const noRetry = nextAttemptAt({ category: CATEGORY.QUOTA_EXHAUSTED, now: NOW });
  check("a quota wall schedules nothing", noRetry.at === null, noRetry);
  check("...and says why", noRetry.reason === "no-retry");

  const reset = NOW + 30 * MIN;
  const sched = nextAttemptAt({
    category: CATEGORY.RATE_LIMITED, retryAt: reset, now: NOW, jitter: 0,
  });
  check("a known reset is waited out", sched.at === reset + RESET_PAD_MS, sched);
  check("...and is marked as scheduled", sched.scheduled === true);
  // The pad is not decoration: clock skew is unbounded and being one second
  // early costs a strike plus another full wait.
  check("...with a pad past the reset", sched.at > reset);

  const ladder = nextAttemptAt({
    category: CATEGORY.TRANSIENT, strikes: 0, failedAt: new Date(NOW).toISOString(),
    now: NOW, jitter: 0,
  });
  check("no reset falls back to the ladder", ladder.at === NOW + LADDER.fast[0], ladder);
  check("...and is NOT marked scheduled", ladder.scheduled === false);

  // The slow ladder exists because opencode already retried internally
  // before telling us: retrying in 60s repeats a wait that just failed.
  const slow = nextAttemptAt({
    category: CATEGORY.OVERLOADED, strikes: 0, failedAt: new Date(NOW).toISOString(),
    now: NOW, jitter: 0,
  });
  check("overloaded uses the slow ladder", slow.at === NOW + LADDER.slow[0], slow);
  check("...which is genuinely slower", LADDER.slow[0] > LADDER.fast[0]);

  for (const s of [0, 1, 2, 3, 9]) {
    const step = nextAttemptAt({
      category: CATEGORY.TRANSIENT, strikes: s, failedAt: new Date(NOW).toISOString(),
      now: NOW, jitter: 0,
    });
    const expected = LADDER.fast[Math.min(s, LADDER.fast.length - 1)];
    check(`strike ${s} waits ${expected / 60000}m`, step.at === NOW + expected, step);
  }

  // A reset that has already passed is not an error — time simply moved.
  // Falls back to the ladder rather than firing instantly, because "the
  // window reopened" and "it is safe to hammer it now" differ.
  const stale = nextAttemptAt({
    category: CATEGORY.RATE_LIMITED, retryAt: NOW - MIN, strikes: 0,
    failedAt: new Date(NOW).toISOString(), now: NOW, jitter: 0,
  });
  check("an elapsed reset falls back to the ladder", stale.reason === "ladder", stale);
  check("...and is not marked scheduled", stale.scheduled === false);
}

// ── Jitter must be DETERMINISTIC, not random ─────────────────────────────
//
// The supervisor recomputes the wake on every sweep and compares it to the
// clock. A Math.random() offset would give the same session a different
// deadline each minute — sometimes already past, sometimes not — and the
// retry would fire on whichever sweep happened to roll low.
{
  const args = {
    category: CATEGORY.RATE_LIMITED, retryAt: NOW + 10 * MIN, now: NOW, jitterSeed: "sess-a",
  };
  const a1 = nextAttemptAt(args).at;
  const a2 = nextAttemptAt(args).at;
  const a3 = nextAttemptAt(args).at;
  check("the same session gets the same wake every time",
    a1 === a2 && a2 === a3, [a1, a2, a3]);

  // KD4: the limit belongs to the ACCOUNT, so every waiting session becomes
  // eligible at the same instant. Firing together re-triggers the very
  // limit they were waiting out.
  const b = nextAttemptAt({ ...args, jitterSeed: "sess-b" }).at;
  const c = nextAttemptAt({ ...args, jitterSeed: "sess-c" }).at;
  check("different sessions are spread apart", new Set([a1, b, c]).size === 3, [a1, b, c]);

  check("jitter is bounded by the window", spread(JITTER_MS, "anything") < JITTER_MS);
  // Never negative: a negative offset could pull a wake BEFORE the reset
  // that the pad exists to clear.
  for (const seed of ["a", "zzz", "sess-1", "", "ÿ"]) {
    check(`jitter for "${seed}" is non-negative`, spread(JITTER_MS, seed) >= 0);
  }
  check("zero jitter is exactly zero", spread(0, "x") === 0);
}

// ── The registry is per BACKEND, not per session (KD4) ───────────────────
{
  const reg = createLimitRegistry();
  check("an unknown backend is null", reg.get("claude-code") === null);

  reg.note("claude-code", { status: "rejected", resetsAt: NOW });
  check("what one session learned is readable by all",
    reg.get("claude-code")?.status === "rejected");
  check("backends do not bleed into each other", reg.get("opencode") === null);

  reg.note("claude-code", { status: "allowed" });
  check("the latest wins", reg.get("claude-code")?.status === "allowed");

  // An hour-old snapshot describes a window that has almost certainly
  // turned over; keeping it would let a long-finished limit classify an
  // unrelated failure as rate-limited.
  check("a stale entry expires",
    reg.get("claude-code", Date.now() + 2 * 3600 * 1000) === null);
  check("...and is dropped, not re-checked forever", reg.size() === 0);

  reg.note(null, { status: "rejected" });
  reg.note("x", null);
  check("junk is not recorded", reg.size() === 0);
}

// ── The agent must be told WHICH thing happened ──────────────────────────
//
// From inside its own transcript a limit is indistinguishable from being cut
// off mid-thought, and an agent that assumes it did something wrong will
// redo work that actually succeeded. The category outranks the reason here
// because a usage limit arrives under BOTH "error" and "stalled", and both
// of those wordings would misdescribe it as a fault.
{
  const driver = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
  const body = driver.slice(driver.indexOf("function resumePromptFor"));
  const fn = body.slice(0, body.indexOf("\n}\n") + 2);
  check("the resume wording branches on category at all",
    /resumable\.category === CATEGORY\./.test(fn));
  check("...for a rate limit", /RATE_LIMITED/.test(fn));
  check("...for an overload", /OVERLOADED/.test(fn));
  check("...and for a quota wall", /QUOTA_EXHAUSTED/.test(fn));
  // Checked BEFORE the reason branches, or "stalled" would claim an
  // infrastructure fault and "error" a system error.
  check("the category branch precedes the reason branches",
    fn.indexOf("CATEGORY.RATE_LIMITED") < fn.indexOf('resumable.reason === "stalled"'),
    [fn.indexOf("CATEGORY.RATE_LIMITED"), fn.indexOf('resumable.reason === "stalled"')]);
  check("...and says the fault was not the agent's",
    /Nothing was wrong with your\s*\n?\s*\+? ?" ?work/.test(fn) || /nothing was wrong with your/i.test(fn));
}

// ── Wiring: all of the above is inert unless it is called ────────────────
{
  const driver = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
  const cc = readFileSync(new URL("./backends/claude-code.mjs", import.meta.url), "utf8");
  const oc = readFileSync(new URL("./backends/opencode.mjs", import.meta.url), "utf8");

  // THE ORIGINAL BUG: the result handler was one word.
  check("claude-code's result handler is no longer a bare continue",
    /msg\.type === "result"[\s\S]{0,4000}?is_error/.test(cc));
  check("...and reads terminal_reason", cc.includes("terminal_reason"));
  check("...and api_error_status", cc.includes("api_error_status"));
  // The trap. If this ever becomes the ONLY check, every usage limit goes
  // back to being invisible.
  check("...and does not rely on subtype alone",
    /msg\.is_error === true/.test(cc));
  check("claude-code stashes rate_limit_event", cc.includes('"rate_limit_event"'));
  check("...and handles api_retry", cc.includes('"api_retry"'));

  // OpenCode's side of this is thinner than Claude Code's, and deliberately
  // so for now. The 1.x server published a retry horizon and the provider's
  // response headers on session.status/session.error, and that backend read
  // both. OpenCode 2 reports a failure as session.execution.failed carrying
  // an error type and message, with no horizon attached — so classification
  // happens from the message in classifyFailure (a free-tier exhaustion does
  // come back as rate_limited, verified live) but there is nothing richer to
  // read yet. Asserted at the level that is actually true, rather than
  // asserting a horizon that is not there.
  check("opencode reports a failed turn rather than hanging",
    oc.includes('case "session.execution.failed"'));
  check("...and carries the provider's error through to classification",
    /reason: "error", error: d\.error\?\.message/.test(oc));

  check("the driver classifies failed turns", /classifyFailure\(\{/.test(driver));
  check("...and records the category", /outcome\.category = verdict\.category/.test(driver));
  check("...and persists it on the resumable record", /category: outcome\.category/.test(driver));
  check("...and persists the horizon", /retryAt: new Date\(outcome\.retryAt\)/.test(driver));
  check("the sweep refuses to retry a quota wall",
    /NO_RETRY\.has\(resumable\.category\)/.test(driver));
  check("the sweep schedules from limits.mjs", /plannedWakeFor\(/.test(driver));
  check("the old single ladder constant is gone", !/AUTO_RESUME_BACKOFF_MS/.test(driver));
  check("raw evidence is stripped before it reaches the browser",
    /delete outcome\[k\]/.test(driver));
  // Stale evidence would explain an unrelated failure as a rate limit and
  // schedule a long confident wait for a wall that was never there.
  check("per-turn evidence is cleared at turn start",
    /state\.lastApiError = null/.test(driver) && /state\.lastRetryStatus = null/.test(driver));
  check("the wake time is reported to the browser", /resumeAt:/.test(driver));
}

console.log(`usage limits & retry horizons (§15): ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
