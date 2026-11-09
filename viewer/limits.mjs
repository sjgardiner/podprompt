// Usage limits and retry horizons — §15 (KD1–KD4).
//
// WHAT THIS IS FOR. The keep-alive supervisor retries a turn that ended
// badly. To do that well it needs two things the driver did not previously
// record: WHY the turn died, and WHEN it is worth trying again. This module
// owns both answers, as pure functions, so they can be tested without a
// backend, a socket or a clock.
//
// THE BUG THAT MOTIVATED IT. A turn killed by a usage limit was recorded as
// a clean completion, because claude-code's `result` handler was literally
// `continue;` and opencode's parent event handler ignored session.status and
// session.error. No failure was recorded, so no `resumable` record was
// written, so the supervisor never saw it. An agent stopped by a billing
// limit looked exactly like one that had finished its job.
//
// THE TRAP, stated loudly because the obvious implementation walks into it:
// a usage-limit ending arrives on claude-code labelled
//
//     subtype: "success"
//
// while carrying is_error:true and terminal_reason:"blocking_limit". Those
// three fields live on the SUCCESS result type, not the error one. Switching
// on `subtype` — the natural thing to write — passes every test that does
// not involve a real limit and catches none of them in production.

// ── Categories ───────────────────────────────────────────────────────────
//
// Four, because the correct RESPONSE differs for each. Collapsing them was
// the old behaviour and it meant "out of credits until the limit resets" was
// retried on the same 1/5/15-minute ladder as "the process crashed" — three
// strikes burned against an immovable wall inside three minutes, after which
// the session was declared beyond help.
export const CATEGORY = {
  TRANSIENT: "transient",         // socket died, process crashed, no status code
  OVERLOADED: "overloaded",       // 529/503 — the provider is busy
  RATE_LIMITED: "rate_limited",   // 429 / blocking_limit — comes back on its own
  QUOTA_EXHAUSTED: "quota_exhausted", // credits required — a human must act
};

// Retries are HOPELESS for this one. Not "unlikely to work": the condition
// cannot clear without a human buying credits or an org lifting a block, so
// every attempt is pure waste and the strike cap would merely decide how
// much.
export const NO_RETRY = new Set([CATEGORY.QUOTA_EXHAUSTED]);

// Spacing by strike when no reset time is known.
//
// Two ladders, not one. The slow ladder exists because of a real asymmetry:
// opencode's `retry` session status IS its own internal retry loop, so by
// the time it reports session.error it has ALREADY waited and ALREADY given
// up. Our attempt is a second layer on top of a failed first one, and
// retrying it in sixty seconds repeats a wait that just demonstrably failed.
export const LADDER = {
  fast: [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000],
  slow: [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000],
};

export const LADDER_FOR = {
  [CATEGORY.TRANSIENT]: "fast",
  [CATEGORY.OVERLOADED]: "slow",
  [CATEGORY.RATE_LIMITED]: "slow",
  [CATEGORY.QUOTA_EXHAUSTED]: "slow", // unused — NO_RETRY short-circuits first
};

// Added to a known reset time. A limit that resets "at" an instant is not
// reliably open AT that instant — clock skew between us and the provider is
// unbounded and in the wrong direction half the time — and being one second
// early costs a whole strike plus another full wait.
export const RESET_PAD_MS = 45 * 1000;

// Spread added to every scheduled wake. KD4: a usage limit belongs to the
// ACCOUNT, so when it lifts, EVERY session waiting on it is eligible at the
// same instant. Ten sessions firing together at the boundary is a thundering
// herd that re-triggers the limit they were waiting out — the one failure
// mode this feature could plausibly create on its own.
export const JITTER_MS = 20 * 1000;

// Bounds for sanity-checking a reset timestamp from a backend. Below the
// floor it is not a timestamp at all; above the ceiling something has been
// misread (a seconds value treated as milliseconds lands ~50,000 years out)
// and sleeping on it would park the session forever.
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);
const MAX_AHEAD_MS = 48 * 60 * 60 * 1000;

/**
 * Normalise a backend's reset timestamp to epoch-milliseconds, or null.
 *
 * The SDK declares `resetsAt` as a bare `number`, which is ambiguous between
 * seconds and milliseconds — and guessing wrong is a factor of 1000 in
 * either direction: a seconds value read as ms lands in 1970 (retry
 * immediately, defeating the point), an ms value read as seconds lands tens
 * of thousands of years out (never retry at all). Rather than assume, decide
 * from magnitude: anything below the year-2286 boundary in ms is far too
 * small to BE a millisecond timestamp today, so it must be seconds.
 *
 * Deliberately returns null rather than throwing on nonsense. A garbled
 * timestamp must degrade to "unknown horizon" — which falls back to the
 * ladder — not take down the sweep.
 */
export function normalizeResetMs(value, now = Date.now()) {
  let n = value;
  if (value instanceof Date) n = value.getTime();
  else if (typeof value === "string") {
    // ISO strings matter as much as numbers here: the horizon is PERSISTED
    // as one (markTurnEnded writes toISOString so turn state stays readable
    // on disk) and then read back by the sweep. Parsing only numbers meant
    // every reset survived exactly as long as the process did, and a
    // restart silently downgraded a scheduled wait to a ladder guess.
    const asNumber = Number(value);
    n = Number.isFinite(asNumber) && value.trim() !== "" ? asNumber : Date.parse(value);
  }
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) n *= 1000; // seconds, not milliseconds
  if (n < MIN_PLAUSIBLE_MS) return null;
  // Already past: the limit has lifted while we were deciding, so there is
  // nothing to wait for. Null (not zero) so the caller falls to the ladder
  // rather than scheduling a wake in the past.
  if (n <= now) return null;
  if (n > now + MAX_AHEAD_MS) return null;
  return n;
}

/**
 * Pull a reset instant out of raw provider response headers.
 *
 * OpenCode hands us whatever the provider sent, verbatim, so this is
 * deliberately permissive: `retry-after` is the HTTP standard (RFC 9110) and
 * carries EITHER a delay in seconds OR an HTTP-date, and providers also ship
 * their own `*-ratelimit-*-reset` variants carrying an ISO timestamp.
 *
 * Header names are matched case-insensitively because header casing is not
 * guaranteed by anything.
 */
export function resetFromHeaders(headers, now = Date.now()) {
  if (!headers || typeof headers !== "object") return null;
  const lower = new Map();
  for (const [k, v] of Object.entries(headers)) lower.set(String(k).toLowerCase(), v);

  const retryAfter = lower.get("retry-after");
  if (retryAfter != null) {
    const secs = Number(retryAfter);
    // A bare number is a DELAY, not an instant — the one case where the
    // value is relative. Capped by the same plausibility window as any
    // absolute answer.
    if (Number.isFinite(secs) && secs >= 0) {
      const at = now + secs * 1000;
      return at > now && at <= now + MAX_AHEAD_MS ? at : null;
    }
    const dated = Date.parse(String(retryAfter));
    if (Number.isFinite(dated)) return normalizeResetMs(dated, now);
  }

  // Longest-wait-wins: a provider that rate-limits on several dimensions at
  // once (requests, input tokens, output tokens) reports a reset for each,
  // and retrying when the EARLIEST lifts just fails again on the others.
  let best = null;
  for (const [k, v] of lower) {
    if (!/ratelimit.*reset|reset.*(?:at|seconds|time)$/.test(k)) continue;
    const parsed = Number.isFinite(Number(v))
      ? normalizeResetMs(Number(v), now)
      : normalizeResetMs(Date.parse(String(v)), now);
    if (parsed && (best === null || parsed > best)) best = parsed;
  }
  return best;
}

// Horizon sources that came from THIS failure rather than from ambient
// account telemetry. Only these may be used as evidence that a failure WAS
// a limit; the others may only say WHEN an already-identified limit lifts.
const FAILURE_SCOPED_HORIZONS = new Set(["retry-after", "session.status.next"]);

// Text matching is the LAST resort, used only when no structured field
// answered. Providers behind opencode are not uniform and several report a
// quota wall as a bare 400 with prose, which no status code would reveal.
const QUOTA_TEXT = /insufficient[ _-]?(?:credit|balance|quota|fund)|out of credit|no credit|credit[ _-]?balance|payment required|billing|purchase more|quota exceeded|exceeded your current quota/i;
const LIMIT_TEXT = /rate[ _-]?limit|usage limit|too many requests|limit reached|resets at|try again later/i;
const OVERLOAD_TEXT = /overloaded|capacity|server[ _-]?busy|temporarily unavailable/i;

/**
 * Decide what kind of failure this was, and when it is worth retrying.
 *
 * Every input is optional, because the two backends answer different subsets
 * and a given failure may answer almost none of them. The contract is that
 * an unrecognised failure degrades to TRANSIENT — the category with the most
 * cautious consequences, since it retries (so nothing is silently abandoned)
 * on the fast ladder bounded by the existing strike cap.
 *
 * @param {object}  s
 * @param {number=} s.statusCode        HTTP status, either backend
 * @param {boolean=} s.isRetryable      opencode's OWN verdict — see below
 * @param {string=} s.terminalReason    claude-code TerminalReason
 * @param {object=} s.rateLimitInfo     claude-code SDKRateLimitInfo (stashed)
 * @param {object=} s.headers           opencode ApiError.responseHeaders
 * @param {number=} s.nextRetryAt       opencode session.status `next`
 * @param {string=} s.text              free-text error message
 * @param {number=} s.now
 * @returns {{category: string, retryAt: number|null, horizonSource: string|null, detail: string|null}}
 */
export function classifyFailure(s = {}) {
  const now = s.now ?? Date.now();
  const info = s.rateLimitInfo || null;
  const text = typeof s.text === "string" ? s.text : "";

  // ── Where a horizon could come from, most trustworthy first ───────────
  let retryAt = null;
  let horizonSource = null;
  const take = (value, source) => {
    if (retryAt !== null || value == null) return;
    const ms = normalizeResetMs(value, now);
    if (ms) { retryAt = ms; horizonSource = source; }
  };

  // ONLY when the limit info says we are actually blocked.
  //
  // THIS GUARD IS THE WHOLE POINT, and leaving it out shipped a real bug:
  // rate_limit_event is ambient telemetry that fires whenever limit info
  // CHANGES, including status:"allowed", and it always carries the next
  // window boundary. Taking resetsAt unconditionally meant a perfectly
  // healthy snapshot handed every unrelated failure a horizon — and the
  // "a horizon implies a limit" fallback at the bottom then relabelled it
  // rate_limited. Live, a plain "Invalid session ID. Must be a valid UUID."
  // became a rate limit with a four-hour wait. Since a subscription account
  // essentially always has a resetsAt, that silently disabled auto-resume
  // for EVERY transient failure on claude-code.
  const blocked = info?.status === "rejected";
  // Overage first: when an account is RUNNING ON overage, the base window's
  // resetsAt is the wrong answer — it may be hours away while the thing
  // actually blocking us is the overage balance.
  if (info?.overageStatus === "rejected") take(info.overageResetsAt, "overageResetsAt");
  if (blocked) take(info.resetsAt, "resetsAt");
  take(s.nextRetryAt, "session.status.next");
  if (retryAt === null && s.headers) {
    const h = resetFromHeaders(s.headers, now);
    if (h) { retryAt = h; horizonSource = "retry-after"; }
  }

  // ── Category, most specific evidence first ────────────────────────────

  // A human must act. errorCode is the SDK saying so in a single field, and
  // it outranks everything below because no amount of waiting changes it.
  if (info?.errorCode === "credits_required") {
    return done(CATEGORY.QUOTA_EXHAUSTED, "credits_required");
  }
  // "Out of credits" with no way to buy more is the same wall. If the user
  // CAN purchase, it is still a wall — waiting does not open it either.
  if (info?.overageDisabledReason === "out_of_credits") {
    return done(CATEGORY.QUOTA_EXHAUSTED, "out_of_credits");
  }
  if (s.terminalReason === "budget_exhausted") {
    return done(CATEGORY.QUOTA_EXHAUSTED, "budget_exhausted");
  }

  // opencode's own verdict, from the component closest to the provider and
  // after its internal retries have run. Honoured rather than overruled —
  // but NOT used to force a retry, only to forbid one: isRetryable:true on a
  // failure opencode nonetheless gave up on tells us nothing new.
  if (s.isRetryable === false && !looksLikeLimit(s, text)) {
    return done(CATEGORY.QUOTA_EXHAUSTED, "opencode: not retryable");
  }

  if (s.terminalReason === "blocking_limit" || s.terminalReason === "rapid_refill_breaker") {
    return done(CATEGORY.RATE_LIMITED, s.terminalReason);
  }
  if (info?.status === "rejected") return done(CATEGORY.RATE_LIMITED, "rate limit rejected");

  const code = numeric(s.statusCode) ?? numeric(s.apiErrorStatus);
  if (code === 429) return done(CATEGORY.RATE_LIMITED, "429");
  if (code === 529 || code === 503) return done(CATEGORY.OVERLOADED, String(code));
  if (code === 402) return done(CATEGORY.QUOTA_EXHAUSTED, "402");

  if (QUOTA_TEXT.test(text)) return done(CATEGORY.QUOTA_EXHAUSTED, "message text");
  if (LIMIT_TEXT.test(text)) return done(CATEGORY.RATE_LIMITED, "message text");
  if (OVERLOAD_TEXT.test(text)) return done(CATEGORY.OVERLOADED, "message text");

  // A horizon with no category still means something told us to wait, and
  // the only things that do are limits — but ONLY from a source tied to
  // THIS failure. The allow-list is explicit rather than "retryAt is set"
  // so that adding a future horizon source cannot silently re-open the bug
  // described above: ambient account telemetry must never be able to
  // relabel an unrelated crash as a rate limit.
  if (retryAt !== null && FAILURE_SCOPED_HORIZONS.has(horizonSource)) {
    return done(CATEGORY.RATE_LIMITED, horizonSource);
  }

  return done(CATEGORY.TRANSIENT, null);

  function done(category, detail) {
    // A horizon is only meaningful for conditions that lift on their own. On
    // anything else it would schedule a confident wake for a wall that is
    // still there.
    const keep = category === CATEGORY.RATE_LIMITED || category === CATEGORY.OVERLOADED;
    return {
      category,
      retryAt: keep ? retryAt : null,
      horizonSource: keep ? horizonSource : null,
      detail: detail || null,
    };
  }
}

function numeric(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function looksLikeLimit(s, text) {
  const code = numeric(s.statusCode) ?? numeric(s.apiErrorStatus);
  return code === 429 || LIMIT_TEXT.test(text || "");
}

/**
 * When may this session be retried, given how it failed and how many times
 * we have already tried?
 *
 * Returns the ABSOLUTE instant, so the caller compares against a clock
 * rather than tracking elapsed time itself — the supervisor sweeps on a
 * timer and a relative answer would drift with it.
 *
 * `scheduled` distinguishes "a backend told us when" from "we guessed".
 * The caller uses it for two things: not charging a strike for a wait that
 * was scheduled (nothing failed — we were told to wait), and telling the
 * user WHEN rather than leaving a long sleep looking like a hang.
 */
export function nextAttemptAt({ category, retryAt, strikes = 0, failedAt, now = Date.now(), jitter = JITTER_MS, jitterSeed = "" }) {
  if (NO_RETRY.has(category)) return { at: null, scheduled: false, reason: "no-retry" };

  // DETERMINISTIC, from the session id — not Math.random(). The supervisor
  // recomputes this on every sweep and compares it against the clock, so a
  // random offset would hand the same session a different deadline each
  // minute: sometimes already past, sometimes not, with the retry firing on
  // whichever sweep happened to roll low. Seeding from the session id keeps
  // the answer stable for a session while still spreading sessions apart,
  // which is the only property KD4 actually needs.
  const offset = spread(jitter, `${jitterSeed}|${strikes}`);

  if (retryAt) {
    const ms = normalizeResetMs(retryAt, now);
    // A reset that has already passed is not an error — time simply moved
    // while we waited. Fall through to the ladder rather than firing
    // instantly, because "the window reopened" and "it is safe to hammer it
    // immediately" are not the same claim.
    if (ms) return { at: ms + RESET_PAD_MS + offset, scheduled: true, reason: "reset" };
  }

  const ladder = LADDER[LADDER_FOR[category] || "fast"];
  const step = ladder[Math.min(strikes, ladder.length - 1)];
  const base = new Date(failedAt || 0).getTime() || now;
  return { at: base + step + offset, scheduled: false, reason: "ladder" };
}

// Positive-only: a negative offset could pull a wake BEFORE a reset the pad
// exists to clear.
export function spread(jitter, seed = "") {
  if (!(jitter > 0)) return 0;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % jitter;
}

/**
 * Per-BACKEND record of a limit we have been told about (KD4).
 *
 * Deliberately not per session. A rate limit belongs to the account, so if
 * one claude-code session is limited then all of them are; storing it per
 * session would have each one rediscover the same wall independently, and
 * each one would learn the reset time only by failing against it first.
 */
export function createLimitRegistry() {
  const byBackend = new Map();
  return {
    /** Record the latest limit info seen for a backend. */
    note(backendId, info) {
      if (!backendId || !info) return;
      byBackend.set(backendId, { info, at: Date.now() });
    },
    /** The most recent info, or null. Stale entries are dropped on read. */
    get(backendId, now = Date.now()) {
      const rec = byBackend.get(backendId);
      if (!rec) return null;
      // An hour-old snapshot describes a window that has almost certainly
      // turned over. Keeping it would let a long-finished limit classify an
      // unrelated failure as rate-limited.
      if (now - rec.at > 60 * 60 * 1000) { byBackend.delete(backendId); return null; }
      return rec.info;
    },
    /** Visible for tests and for reporting. */
    size() { return byBackend.size; },
  };
}
