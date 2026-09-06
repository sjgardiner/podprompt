#!/usr/bin/env node
// Bidirectional, multi-session, multi-backend driver for the Claude Code
// viewer.
//
// Backend-agnostic shell: HTTP routes, the per-session `sessions` Map, the
// shared `pendingApprovals` map, and all broadcast plumbing to server.py
// live here. Every backend-specific concern — how a turn is actually run,
// how sessions/history are listed, how permissions are asked — is delegated
// to a `Backend` object (see backends/claude-code.mjs for the reference
// implementation). A session picks its backend once, at creation, and keeps
// it for its whole lifetime; `--backend` (or per-request `backend` field on
// a brand-new session) chooses the default for new sessions.
//
// Backend contract (an object with these methods/fields; all async methods
// may be sync — always awaited either way):
//   id                                                 -- short string, e.g. "claude-code"
//   runTurn(sessionId, promptText, state)              -- drives one turn; must itself call
//                                                          broadcast()/broadcastStatus() as things happen
//   abort(sessionId, state)                            -- best-effort stop an in-flight turn
//   getKnownCommands()                                 -- -> {slash_commands, terminal_slash_commands, skills}
//   cwdForSession(sessionId, fallbackCwd)               -- best-known cwd for a session this process
//                                                          may not have touched itself yet
//   resolveValidCwd(candidate)                          -- validate+register a browser-supplied cwd, or null
//   listProjects()                                      -- -> {projects: [{cwd,label}], root}
//   rescanProjects()                                     -- -> same shape + unreachableCount
//   listSessions({includeUnreachable}, sessionsIndex, pendingKindForSession)
//                                                        -- -> {sessions, unreachableCount, unreachableSessions}
//   getSessionHistory(sessionId, fallbackCwd)            -- -> {role,text,id,ts}[]
//   archiveSession / unarchiveSession / deleteSession / renameSession(sessionId, ..., fallbackCwd)
//   listModes(sessionId)   [optional]                    -- -> {current, available: [{id,label}]} or null
//   setMode(sessionId, mode) [optional]                  -- switch a session's agent/mode; no-op if absent
//   listModels(sessionId)   [optional]                    -- -> {current, available: [{id,label,description?}]} or null
//   setModel(sessionId, modelId) [optional]               -- switch a session's model; no-op if absent
//   refreshAccountUsage()   [optional]                     -- account-scoped, NOT per-session (single-flight;
//                                                              fetches+caches, returns {subscription_type,
//                                                              rate_limits} or null) — see the plan/usage
//                                                              polling block just above runTurn() for who calls this
//   getCachedAccountUsage() [optional]                     -- synchronous read of the last value
//                                                              refreshAccountUsage() cached, or null
//
// Status payload types broadcast via broadcastStatus (beyond the older
// turn_start/turn_end/thinking_tokens/tool_progress/stream_start/
// stream_delta set): context_usage {percentage,totalTokens,maxTokens},
// compacting {active,result?,error?}, plan_usage {subscription_type,
// rate_limits} (Claude Code only — null/null when not on a real
// subscription-backed session, e.g. LiteLLM/API-key/Bedrock/Vertex; account-
// scoped, not session-scoped — see refreshAccountUsage() above and the
// polling block just above runTurn() for the full mechanism), and spend
// {totalCostUsd} (OpenCode's analogue of plan_usage — no plan/quota concept
// exists there, just a running cost accumulator).
//
// Multi-session concurrency: every piece of turn-related state (bootstrap
// status, in-flight flag, abort controller, cwd, backend) is keyed by
// session id in the `sessions` Map below, instead of being a single set of
// module-level variables — this is what lets turns in different sessions
// run fully concurrently regardless of backend.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { createClaudeCodeBackend } from "./backends/claude-code.mjs";
import { createOpenCodeBackend } from "./backends/opencode.mjs";

function parseArgs(argv) {
  const args = {
    port: 7844, viewerPort: 7843, cwd: "/workspace", backend: "claude-code",
    opencodePort: 7845,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--viewer-port") args.viewerPort = Number(argv[++i]);
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--backend") args.backend = argv[++i];
    else if (a === "--opencode") args.backend = "opencode";
    else if (a === "--opencode-port") args.opencodePort = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const VIEWER_MESSAGE_URL = `http://127.0.0.1:${args.viewerPort}/message`;
const VIEWER_STATUS_URL = `http://127.0.0.1:${args.viewerPort}/status`;

function nowIso() {
  return new Date().toISOString();
}

// Per-session send queue for broadcast()/broadcastStatus() below. Neither is
// awaited by most callers (a backend's per-event handler fires several of
// these in a tight synchronous loop — see opencode.mjs's onEvent, which can
// process a dozen `message.part.delta`s back to back), so without this,
// several fetch()es to server.py can be in flight at once for the same
// session. server.py is a ThreadingHTTPServer — one thread per connection —
// and nothing guarantees those threads enqueue onto the browser's SSE queue
// in the order the requests were issued, only in whatever order the OS
// scheduler happens to run them. A later, longer stream_delta can then land
// in the browser before an earlier, shorter one, which looks exactly like
// the bubble's text rolling backward and re-advancing (confirmed empirically:
// a raw `opencode serve` /event capture for a turn was perfectly monotonic
// while the driver-relayed /events copy of the SAME turn showed the
// cumulative text length repeatedly regress — opencode's dense small-delta
// bursts hit this far more than Claude Code's cadence does, which is why it
// only ever showed up as "opencode rendering is choppy").
//
// Chaining every session's sends through one tail Promise makes the race
// impossible rather than just unlikely: send N+1's fetch is never even
// issued until send N's has settled, so there is never more than one
// in-flight request per session for server.py's threads to reorder. A
// failure in one send can't wedge the chain for later ones (the `.catch`
// below swallows it — broadcast()/broadcastStatus() already log their own
// fetch failures).
const sendQueues = new Map(); // sessionId -> tail Promise of that session's send chain

function enqueueSend(sessionId, doSend) {
  const prev = sendQueues.get(sessionId) || Promise.resolve();
  const next = prev.then(doSend, doSend).catch(() => {});
  sendQueues.set(sessionId, next);
  return next;
}

async function broadcast(sessionId, role, text, id, ts, model) {
  return enqueueSend(sessionId, async () => {
    try {
      await fetch(VIEWER_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, role, text, id, ts: ts || nowIso(), model }),
      });
    } catch (e) {
      console.error("[driver] failed to broadcast to viewer:", e.message);
    }
  });
}

// Monotonic counter assigned to every stream_start/stream_delta payload, in
// the exact order broadcastStatus() was called (a plain synchronous
// increment, so it reflects true production order regardless of anything
// that happens to the request afterward). This is the second, independent
// layer against the same reordering the send queue above already prevents
// at the source: viewer.html tracks the highest seq it has applied per
// bubble id and drops anything that doesn't move it forward. Belt and
// suspenders — the queue above should make this redundant in practice, but
// it's cheap insurance against any other reordering source (a dropped/
// replayed SSE connection, or some future broadcast path that forgets to go
// through enqueueSend).
let streamSeq = 0;

async function broadcastStatus(sessionId, payload) {
  if (payload.type === "stream_start" || payload.type === "stream_delta") {
    payload = { ...payload, seq: ++streamSeq };
  }
  return enqueueSend(sessionId, async () => {
    try {
      await fetch(VIEWER_STATUS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload }),
      });
    } catch (e) {
      console.error("[driver] failed to broadcast status:", e.message);
    }
  });
}

// ── Pending permission/question approvals, keyed by request id ────────────
// Flat and global (not nested under per-session state) since request ids
// are already globally unique — but each entry also carries its sessionId,
// both so the resolved-decision rebroadcast can be tagged correctly and so
// /sessions can report which sessions currently have a decision waiting on
// the user (the sessions-panel badge). Shared across every backend — a
// backend never touches this map directly, only through requestApproval()
// (to create an entry) and the /permission-response route (to resolve one).
const pendingApprovals = new Map(); // id -> { resolve, sessionId, kind, toolName, toolInput }

// Called by a backend when it needs the browser to approve/answer something.
// Returns a Promise that resolves with whatever /permission-response passed:
// a plain {allow, message} decision for a permission ask, or
// {text, structured} for a question — `text` is the joined human-readable
// answer string (Claude Code's own plain-text protocol just wants this),
// `structured` is a per-question {header, answer} array when the viewer sent
// one (answer is a string, or an array of strings for a multiSelect
// question) — OpenCode's replyQuestion uses this instead of re-parsing
// `text`. The backend decides which half it needs.
function requestApproval(sessionId, kind, toolName, toolInput) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pendingApprovals.set(id, { resolve, sessionId, kind, toolName, toolInput });
    broadcast(sessionId, "permission", JSON.stringify({ kind, toolName, toolInput }), id);
  });
}

// Returns which *kind* of decision (if any) is waiting on the user for this
// session — 'permission' (a tool call) or 'question' (AskUserQuestion) —
// rather than a flat boolean, so the sessions panel can badge them
// distinctly instead of showing the same "permission" indicator for a
// question that isn't a permission at all. If a session somehow has more
// than one pending entry at once, 'question' wins (AskUserQuestion pauses
// the whole turn on an answer either way, so there's no meaningful
// "more urgent" ordering here — this just picks one deterministically).
function pendingKindForSession(sessionId) {
  let kind = null;
  for (const p of pendingApprovals.values()) {
    if (p.sessionId !== sessionId) continue;
    if (p.kind === "question") return "question";
    kind = p.kind;
  }
  return kind;
}

// Any permission/question a turn asked but never got an answer for (the turn
// ended — aborted, or the backend threw — before /permission-response was
// ever called for it) would otherwise orphan in pendingApprovals forever:
// nothing else ever deletes an entry except that one handler, so the
// session's badge would stay lit indefinitely with no way to tell a
// genuinely-live request apart from an abandoned one. Found via TRUMPET, an
// old test session whose "waiting on an answer" badge stayed lit long after
// nothing was running for it — the actual root cause turned out to be this
// leak, not any client-side rendering bug (which was verified correct
// multiple times over). Broadcasting a resolved:true rebroadcast (same shape
// /permission-response itself sends) rather than a silent delete, so any
// permission/question card still shown live in a browser (Allow/Deny
// buttons that would otherwise just 404 if clicked) updates to reflect that
// it expired, instead of sitting there looking actionable forever. Backend-
// agnostic: called from the shared runTurn wrapper below regardless of
// which backend ran the turn.
function expirePendingApprovals(sessionId) {
  for (const [id, pending] of pendingApprovals) {
    if (pending.sessionId !== sessionId) continue;
    pendingApprovals.delete(id);
    broadcast(sessionId, "permission", JSON.stringify({
      kind: pending.kind, toolName: pending.toolName, toolInput: pending.toolInput,
      resolved: true, resolvedText: "This request expired (the turn ended without an answer).",
    }), id);
  }
}

// ── Backend registry ─────────────────────────────────────────────────────
// One instance per backend id, constructed once at startup and shared by
// every session that picks it — a backend instance holds no per-session
// state itself (that all lives in each session's own entry in `sessions`
// below), so there's no problem with many sessions sharing one instance.
const backendHooks = { cwdRoot: args.cwd, broadcast, broadcastStatus, requestApproval };
const backends = {
  "claude-code": createClaudeCodeBackend(backendHooks),
  // driver.mjs itself spawns and supervises a headless `opencode serve`
  // (see the process-ownership block after this map) regardless of which
  // backend is the default — baseUrl here just needs to agree with the port
  // that child is started on (--opencode-port).
  "opencode": createOpenCodeBackend({ ...backendHooks, baseUrl: `http://127.0.0.1:${args.opencodePort}` }),
};

function getBackend(id) {
  const b = backends[id];
  if (b) return b;
  console.error(`[driver] unknown backend "${id}", falling back to claude-code`);
  return backends["claude-code"];
}

// ── opencode serve process ownership + crash recovery ────────────────────
// driver.mjs owns the `opencode serve` child both backends talk to. This
// responsibility used to live in start-viewer.sh (an independent background
// job with nobody supervising it), so if `opencode serve` crashed or wedged,
// nothing ever brought it back and every opencode session's model picker /
// history / turns just went dead until the container restarted.
//
// Self-healing, three pieces:
//   1. ensureOpencodeRunning() spawns the child, single-flight guarded so two
//      near-simultaneous callers can't both spawn a competing process on the
//      same port (JS's single-threaded execution means a synchronous guard
//      before any await closes that cross-tab/cross-session race without any
//      file lock — ownership lives in exactly this one process).
//   2. Two independent death detectors, because neither alone is sufficient:
//      (a) child.on("exit") for an actual crash (event-driven, immediate) and
//      (b) a periodic liveness poll against a cheap endpoint to catch a
//      *wedged-but-still-running* process, which never emits "exit" at all.
//   3. Capped exponential backoff on repeated restart failures (2s -> 4s ->
//      8s -> ... -> 60s ceiling), retried indefinitely — so this self-heals
//      whenever the underlying issue clears, without tight-crash-looping if
//      `opencode serve` is fundamentally broken (bad config, port taken).
//
// All genuine session state (realToClient/clientToReal id maps, in-flight
// turns) lives in this process's memory or in opencode's on-disk store —
// never inside the serve child — so a child restart needs no reconciliation
// beyond bringing the process back; a pre-existing session's history and id
// mapping are untouched by it. The backend's own shared SSE connection
// (ensureSse() in backends/opencode.mjs) already reconnects every 1s
// indefinitely when the stream dies — this block just makes sure there is
// actually something alive for that retry loop to reconnect *to*.
const OPENCODE_BACKOFF_BASE_MS = 2000;
const OPENCODE_BACKOFF_CEILING_MS = 60000;
const OPENCODE_LIVENESS_INTERVAL_MS = 20000;
const OPENCODE_LIVENESS_TIMEOUT_MS = 5000;

let opencodeChild = null;         // ChildProcess | null
let restartPromise = null;        // in-flight ensure/recover op (single-flight lock)
let restartAttempts = 0;          // consecutive start/restart failures, for backoff
let livenessTimer = null;

function nextRestartDelayMs() {
  if (restartAttempts <= 0) return 0;
  return Math.min(OPENCODE_BACKOFF_BASE_MS * 2 ** (restartAttempts - 1), OPENCODE_BACKOFF_CEILING_MS);
}

function spawnOpencode() {
  const args_ = ["serve", "--hostname", "127.0.0.1", "--port", String(args.opencodePort)];
  console.log(`[driver] spawning opencode serve on port ${args.opencodePort}`);
  const child = spawn("opencode", args_, { stdio: ["ignore", "pipe", "pipe"] });
  opencodeChild = child;
  let stderrTail = [];
  child.stderr.on("data", (d) => {
    for (const line of d.toString().split("\n")) {
      const t = line.trim();
      if (t) {
        stderrTail.push(t);
        if (stderrTail.length > 20) stderrTail.shift();
      }
    }
  });
  child.stdout.on("data", () => {});
  child.on("error", (err) => {
    // Spawn-level failure (binary missing, EACCES, ...) — 'exit' may not fire.
    console.error(`[driver] failed to spawn opencode serve: ${err.message}`);
    if (opencodeChild === child) opencodeChild = null;
    restartAttempts++;
    ensureOpencodeRunning();
  });
  child.on("exit", (code, signal) => {
    if (opencodeChild === child) opencodeChild = null;
    restartAttempts++;
    if (code === 0 || signal) {
      console.log(`[driver] opencode serve stopped (code=${code} signal=${signal}); scheduling restart`);
    } else {
      console.error(
        `[driver] opencode serve exited unexpectedly (code=${code} signal=${signal}); scheduling restart` +
        (stderrTail.length ? `\n--- last opencode serve stderr lines ---\n${stderrTail.slice(-15).join("\n")}\n---` : "")
      );
    }
    ensureOpencodeRunning();
  });
  return child;
}

function ensureOpencodeRunning() {
  const child = opencodeChild;
  if (child && child.exitCode === null) return child;
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    const delay = nextRestartDelayMs();
    if (delay > 0) {
      console.log(`[driver] opencode serve restart in ${delay}ms (attempt ${restartAttempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
    restartPromise = null;
    return spawnOpencode();
  })();
  return restartPromise;
}

// True once the child process exists and hasn't exited — NOT the same as
// "accepting HTTP connections yet" (a cold start binds the port only after
// ~4-8s; see start-viewer.sh). That gap is intentional: during a cold start
// this reports "up" and /models falls through to the normal empty-cache
// retry path (backend genuinely reachable, just not populated yet), while
// the gap between a crash and the backoff-guarded respawn — where this
// reports false — is the one /models surfaces as "server_unreachable".
function isOpencodeUp() {
  return !!(opencodeChild && opencodeChild.exitCode === null);
}

function startOpencodeLivenessPoll() {
  if (livenessTimer) return;
  livenessTimer = setInterval(async () => {
    const child = opencodeChild;
    if (!child || child.exitCode !== null) {
      ensureOpencodeRunning();
      return;
    }
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), OPENCODE_LIVENESS_TIMEOUT_MS);
      const res = await fetch(`http://127.0.0.1:${args.opencodePort}/doc`, { method: "HEAD", signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        // Healthy — reset the backoff so a later crash restarts fast again.
        restartAttempts = 0;
        return;
      }
      throw new Error(`status ${res.status}`);
    } catch (e) {
      // Wedged-but-still-running: no "exit" event will ever fire for it. Kill
      // it hard — the exit handler then schedules the (single-flight)
      // restart with backoff. Log before killing so the tail is attributable.
      console.error(`[driver] opencode liveness probe failed (${e.message}) — killing wedged serve to trigger restart`);
      try {
        child.kill("SIGKILL");
      } catch (killErr) {
        if (opencodeChild === child) opencodeChild = null;
        ensureOpencodeRunning();
      }
    }
  }, OPENCODE_LIVENESS_INTERVAL_MS);
}

// Clean up the child on the way out so nothing is orphaned by a driver exit.
process.on("exit", () => {
  if (opencodeChild && opencodeChild.exitCode === null) {
    try {
      opencodeChild.kill("SIGTERM");
    } catch { /* already dead */ }
  }
});

// Ensure the opencode serve child is up before firing warm-up fetches at it,
// then start the liveness poll that catches a wedged-but-running process.
// Spawning is sync and fire-and-forget here — the child may take several
// seconds to accept connections on a cold start, but every fetch below
// retries until it does.
ensureOpencodeRunning();
startOpencodeLivenessPoll();

// Eagerly warm each backend's model/command cache right now, rather than
// waiting for the first browser-triggered call. For claude-code, listModels()
// now runs its own throwaway-query warm-up (see
// backends/claude-code.mjs's ensureModelsWarmed) so the model list is ready
// before any real turn has run; getKnownCommands() is still a no-op until a
// turn's system/init message, which is a known CLI limitation documented in
// that file. For opencode it's a real improvement: GET /config/providers and
// GET /command need no session/turn to exist, only a reachable `opencode
// serve`, so firing them now means a session that never sends a single
// message can still see a populated model/command picker. Safe to fire
// before `opencode serve` has come up (which, note, takes ~4-8s on a cold
// start, not the "~1 second" the old comments claimed — the litellm plugin's
// live provider discovery gates /config/providers, see
// backends/opencode.mjs) because both fetch functions now retry-on-failure
// (they clear their own "started" guard in the catch block) rather than
// permanently caching a transient connection failure — see
// fetchProviderListInBackground/fetchKnownCommandsInBackground in
// backends/opencode.mjs.
for (const backend of Object.values(backends)) {
  if (typeof backend.getKnownCommands === "function") backend.getKnownCommands();
  if (typeof backend.listModels === "function") backend.listModels();
}

// Tracks which backend ids are currently failing /sessions, so the poll
// loop below (the sessions panel refetches every few seconds) logs a
// transition — "started failing" / "recovered" — exactly once each, instead
// of the same "fetch failed" line once per poll forever. Both backends are
// expected to be reachable in a normal deployment (driver.mjs supervises its
// own `opencode serve` child now — see the process-ownership block above), so
// a *sustained* failure here usually means something genuinely worth looking
// at — a manual/non-standard launch that skipped the supervision, or the
// child crash-looping on bad config — not a permanently-expected condition to
// just ignore; a brief failure right at container startup (before the freshly
// spawned `opencode serve` finishes its ~4-8s cold start) is the one benign
// case and is exactly what the log-once-on-transition behavior below is for.
const backendSessionsFailing = new Set();

// ── Per-session state ────────────────────────────────────────────────────
// Lazily created on first use (a fresh client-minted id for "new chat", or
// the first time this process is asked to run a turn in a pre-existing
// session it hasn't touched yet). Nothing pre-seeds this at startup — every
// prompt names its own target explicitly. cwd defaults via
// backend.cwdForSession() — the backend's own discovery index if this is a
// pre-existing session in a known sub-project, else the root — but a
// brand-new session can override that with an explicit, already-validated
// cwd (see /prompt). `backend` is fixed at creation and never changes for
// the life of the session.
const sessions = new Map(); // sessionId -> SessionState

// Pre-prompt picker changes for sessions that have no driver state yet (the
// "new chat" case, or a session this process hasn't touched this run). A
// real SessionState must never be created just to remember a model/mode
// choice — state creation pins cwd and backend (see /prompt), which we
// don't want to do from a mere /set-model or /set-mode. Instead the choice
// is parked here and merged into the state the first time something that
// genuinely needs state (a prompt) creates it; seeded entries are consumed
// and removed at that moment, so an abandoned pick can never leak into a
// later session with the same id.
const preSeeds = new Map(); // sessionId -> { model?, mode? }

// Explicit /set-model picks, persisted to disk so they survive a driver.mjs
// restart — in-memory `state.model`/`preSeeds` alone do not, and a session's
// own transcript can't always answer "which alias did the user actually
// pick" on its own: Claude Code's resolved `message.model` is genuinely
// ambiguous whenever two aliases currently resolve to the same underlying
// model (e.g. `default` and `sonnet`, if the account's current default
// happens to be Sonnet) — see backends/claude-code.mjs's
// aliasForResolvedModel(), which has to guess in exactly that case and
// deliberately (and sometimes wrongly) prefers `default`. An explicit user
// pick should never be silently reinterpreted as "the default" (or vice
// versa) just because a driver restart happened to land in between. Loaded
// once at startup into `preSeeds` below (same mechanism, and same "consumed
// on first real prompt" lifetime, as an ordinary pre-prompt pick — this is
// just a restart-safe way of arriving at one); every /set-model call updates
// this file in addition to whatever in-memory state it already updates.
// Applies to both backends uniformly, even though only Claude Code has the
// alias-ambiguity problem above — OpenCode's own composite providerID/
// modelID ids aren't ambiguous, but an explicit pick made just before a
// restart, with no turn run yet to record it, is exactly the same kind of
// fact this exists to not lose regardless of backend.
//
// Lives in PodPrompt's own XDG state directory, NOT under CLAUDE_CONFIG_DIR
// (see podprompt.sh's PODPROMPT_STATE_DIR) — this is PodPrompt's own
// bookkeeping, not Claude Code's, and CLAUDE_CONFIG_DIR now points at the
// user's real, shared ~/.claude (also used by any native install on the
// host), which should never end up with PodPrompt-internal files in it.
// Same reasoning as backends/claude-code.mjs's SESSION_HOSTS_FILE.
const MODEL_PICKS_FILE = nodePath.join(
  process.env.PODPROMPT_STATE_DIR || nodePath.join(os.homedir(), ".local", "state", "podprompt"),
  "viewer-model-picks.json"
);

function loadPersistedModelPicks() {
  try {
    return JSON.parse(readFileSync(MODEL_PICKS_FILE, "utf8"));
  } catch {
    return {}; // missing or corrupt — start fresh rather than fail startup over this
  }
}

function persistModelPick(sessionId, model) {
  let data = {};
  try {
    data = JSON.parse(readFileSync(MODEL_PICKS_FILE, "utf8"));
  } catch {
    // missing or corrupt — start fresh rather than fail the request over this
  }
  data[sessionId] = model;
  // Write via a temp file + atomic rename so a crash mid-write can't tear
  // the JSON and leave a corrupt bookkeeping file for the next startup.
  try {
    writeFileSync(`${MODEL_PICKS_FILE}.tmp`, JSON.stringify(data));
    renameSync(`${MODEL_PICKS_FILE}.tmp`, MODEL_PICKS_FILE);
  } catch (e) {
    console.error("[driver] failed to write model-picks file:", e.message);
  }
}

for (const [seedSessionId, seedModel] of Object.entries(loadPersistedModelPicks())) {
  preSeeds.set(seedSessionId, { ...(preSeeds.get(seedSessionId) || {}), model: seedModel });
}

function getSessionState(sessionId, explicitCwd, explicitBackendId) {
  let s = sessions.get(sessionId);
  if (!s) {
    const backend = getBackend(explicitBackendId || args.backend);
    const cwd = explicitCwd || backend.cwdForSession(sessionId, null);
    s = { bootstrapped: false, turnInFlight: false, abortController: null, cwd, backend };
    const pre = preSeeds.get(sessionId);
    if (pre) {
      if (pre.model) s.model = pre.model;
      if (pre.mode) s.mode = pre.mode;
      preSeeds.delete(sessionId);
    }
    sessions.set(sessionId, s);
    // Hand a brand-new session the current best-known account usage right
    // away, instead of leaving its bar blank until the next global timer
    // tick (up to PLAN_USAGE_POLL_INTERVAL_MS away, see below) or this
    // session's own first turn completes. Synchronous cache read only —
    // never triggers a fetch from here, so creating session state (cheap,
    // frequent) never gains a network round-trip.
    if (typeof backend.getCachedAccountUsage === "function") {
      const usage = backend.getCachedAccountUsage();
      if (usage) {
        broadcastStatus(sessionId, { type: "plan_usage", subscription_type: usage.subscription_type, rate_limits: usage.rate_limits });
      }
    }
  }
  return s;
}

// Backend resolution for routes that must NOT create session state (pure
// reads like /modes & /models, and session-management calls): the pinned
// state backend wins once a session has been touched this run, otherwise an
// explicit backend from the caller (the viewer relays what it learned from
// /sessions), otherwise the CLI default. Crucially this never creates a
// SessionState, so a resumed session can't get its cwd/backend pinned by a
// mere /models or /session-history call.
function backendFor(sessionId, explicitBackendId) {
  const state = sessionId ? sessions.get(sessionId) : null;
  return state?.backend || getBackend(explicitBackendId || args.backend);
}

// ── Account-wide plan/usage polling (backend-agnostic; currently only
// claude-code.mjs implements refreshAccountUsage()/getCachedAccountUsage() —
// see the "Account-wide plan usage" section near the top of that file for
// the full investigation this is built on). Usage turned out to be
// account-scoped, not session-scoped (verified 2026-09-06: the SDK's usage
// control-request resolves fine on a throwaway, never-run Query, no
// `resume`/session id needed at all) — so one fetch per backend answers for
// every session sharing it, and lives here (not per-session, not inside the
// backend module) purely because only this module knows every currently
// live session id to fan the result out to. A backend that doesn't
// implement these two methods (OpenCode, whose analogous "spend" figure is
// a genuine per-session running cost, not an account-wide quota) is simply
// skipped — feature-detected the same way listModels()/getKnownCommands()
// already are above.
const PLAN_USAGE_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min: the fetch itself
// is cheap (~1.6s, one throwaway CLI subprocess) but the 5-hour/7-day
// rate-limit windows this reports don't move fast enough to need finer
// resolution — polling harder would just be needless subprocess churn.

async function pollAccountUsage(backend) {
  if (typeof backend.refreshAccountUsage !== "function") return;
  let usage;
  try {
    usage = await backend.refreshAccountUsage();
  } catch (e) {
    // refreshAccountUsage() itself already retries/logs on failure and
    // resolves to its last-known-good cache rather than rejecting — a
    // throw here would mean something unexpected slipped past that, so it's
    // worth its own log line rather than silently swallowing it.
    console.error("[driver] refreshAccountUsage() threw unexpectedly:", e.message);
    return;
  }
  if (!usage) return; // never fetched successfully yet, or this account has no plan/quota (API-key/Bedrock/Vertex)
  for (const [sid, state] of sessions) {
    if (state.backend !== backend) continue; // don't send claude-code's plan_usage to an opencode session
    broadcastStatus(sid, { type: "plan_usage", subscription_type: usage.subscription_type, rate_limits: usage.rate_limits });
  }
}

function pollAccountUsageForAllBackends() {
  for (const backend of Object.values(backends)) {
    pollAccountUsage(backend).catch((e) => console.error("[driver] pollAccountUsage failed:", e.message));
  }
}

// Kick one off immediately at startup (don't wait for the first timer tick
// or the first turn) so a browser tab opened before any prompt is sent
// still sees a populated bar shortly after boot, same spirit as the
// eager listModels()/getKnownCommands() warm-up above — then keep it moving
// on its own regardless of turn activity, which is the entire point of this
// mechanism over the old per-turn-only refresh.
pollAccountUsageForAllBackends();
setInterval(pollAccountUsageForAllBackends, PLAN_USAGE_POLL_INTERVAL_MS);

// ── Drive one turn (backend-agnostic wrapper) ───────────────────────────
// Delegates the actual work to state.backend.runTurn — this wrapper only
// owns the bookkeeping that must happen identically regardless of which
// backend ran: broadcasting turn_start/turn_end is left to the backend
// itself (it already knows the precise moments that matter for its own
// process/request model), but expiring orphaned approvals on the way out is
// generic enough to live here once instead of duplicated in every backend.
async function runTurn(sessionId, promptText) {
  const state = getSessionState(sessionId);
  try {
    await state.backend.runTurn(sessionId, promptText, state);
  } catch (e) {
    console.error(`[driver] runTurn failed for session ${sessionId}:`, e.message);
  } finally {
    expirePendingApprovals(sessionId);
    // Opportunistic refresh after every turn, any session, any backend —
    // piggybacks on refreshAccountUsage()'s own single-flight cache, so a
    // turn ending right as the timer above is about to tick just collapses
    // into the same fetch instead of stacking a redundant one. Deliberately
    // not awaited: a slow/failed usage poll must never delay the turn's own
    // completion being reported back to the browser.
    pollAccountUsage(state.backend).catch((e) => console.error("[driver] post-turn pollAccountUsage failed:", e.message));
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────
function sendCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  sendCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/commands") {
    // Deliberately reads from the DEFAULT backend's known-commands, not any
    // one session's — matches the pre-refactor behavior (this was already a
    // single shared module-level value, not per-session) and is good enough
    // until a per-backend commands panel is worth building.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getBackend(args.backend).getKnownCommands()));
    return;
  }

  // Resync point for the browser: turn_start/turn_end are ephemeral SSE
  // broadcasts, not replayed on reconnect, so a client that misses one (a
  // reconnect landing mid-turn, a dropped event) could otherwise get
  // permanently stuck showing Stop with no way to recover short of a page
  // reload. Called on every SSE reconnect, scoped to the session that tab
  // is actually viewing.
  if (req.method === "GET" && path === "/turn-status") {
    const sessionId = url.searchParams.get("sessionId");
    const state = sessionId ? sessions.get(sessionId) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ inFlight: !!state?.turnInFlight, autoApprove: !!state?.autoApprove }));
    return;
  }

  // Full persisted history for a session, converted to the browser's
  // {role, text, id, ts} shape. Pulled by server.py the first time a tab
  // asks to view a session it has no live log for yet — not pushed by this
  // driver (an unknown/brand-new session id, e.g. one just minted
  // client-side for "new chat", legitimately has no history yet; that's not
  // an error, just an empty array).
  if (req.method === "GET" && path === "/session-history") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    const state = sessions.get(sessionId);
    const backend = backendFor(sessionId, url.searchParams.get("backend"));
    let history;
    try {
      history = await backend.getSessionHistory(sessionId, state?.cwd);
    } catch (e) {
      // /modes and /models already fail with 502 rather than killing the
      // driver; history must behave the same so server.py's _fetch_session_history
      // sees a clean failure and can leave the session unseeded for the next
      // connect (an empty 200 here would permanently blank a real session).
      console.error("[driver] /session-history failed:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(history));
    return;
  }

  // Reachable sessions are always fetched (one listSessions() call per known
  // project per backend, merged) — that's the normal, cheap case. The
  // unreachable bucket (sessions whose recorded cwd no longer resolves) is
  // only actually assembled when asked for via ?includeUnreachable=1, since
  // producing it means reading raw transcript files directly for backends
  // that support it at all.
  if (req.method === "GET" && path === "/sessions") {
    try {
      const includeUnreachable = url.searchParams.get("includeUnreachable") === "1";
      // allSettled, not all: each backend is queried independently (e.g. an
      // opencode backend hits a separate `opencode serve` process that may
      // simply not be running if the user never opted into it), so one
      // unreachable/misbehaving backend must not take down the whole
      // response for every other backend that's working fine.
      const backendIds = Object.keys(backends);
      const settled = await Promise.allSettled(
        Object.values(backends).map((backend) =>
          backend.listSessions({ includeUnreachable }, sessions, pendingKindForSession)
        )
      );
      const perBackend = [];
      settled.forEach((r, i) => {
        const id = backendIds[i];
        if (r.status === "fulfilled") {
          perBackend.push(r.value);
          // Only worth a line when it flips back from failing — a backend
          // that's simply never had a problem stays silent, same as before.
          if (backendSessionsFailing.delete(id)) {
            console.log(`[driver] /sessions: backend "${id}" recovered`);
          }
        } else if (!backendSessionsFailing.has(id)) {
          // First failure for this backend since it last worked (or since
          // startup) — log it once, then stay quiet on every subsequent poll
          // for as long as it keeps failing the same way (see
          // backendSessionsFailing above).
          backendSessionsFailing.add(id);
          console.error(`[driver] /sessions: backend "${id}" failed:`, r.reason?.message);
        }
      });
      const allSessions = perBackend.flatMap((r) => r.sessions);
      const unreachableCount = perBackend.reduce((sum, r) => sum + (r.unreachableCount || 0), 0);
      const unreachableSessions = includeUnreachable
        ? perBackend.flatMap((r) => r.unreachableSessions || [])
        : undefined;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        // Promise.all resolves in request order, so a naive .flat() would
        // chunk all of one backend/project's sessions before another's,
        // regardless of actual recency — merge by lastModified instead so
        // "flat, sorted by recency" is true globally, not just per source.
        sessions: allSessions.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)),
        unreachableCount,
        unreachableSessions,
      }));
    } catch (e) {
      console.error("[driver] /sessions failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to list sessions"}');
    }
    return;
  }

  if (req.method === "GET" && path === "/backends") {
    // Lets the browser's "+ New chat" picker offer a real backend choice
    // (see viewer.html's openNewChatPicker) instead of silently always
    // using args.backend — every registered backend is always a valid
    // explicit choice for a new session (see /prompt's body.backend),
    // regardless of which one is the default.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: Object.keys(backends), default: args.backend }));
    return;
  }

  if (req.method === "GET" && path === "/projects") {
    // Multi-project discovery is currently Claude-Code-only (see
    // backends/claude-code.mjs) — reported against the default backend
    // until it's generalized. Deliberately not per-backend-merged yet: an
    // OpenCode backend has no equivalent scan to contribute.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getBackend(args.backend).listProjects()));
    return;
  }

  if (req.method === "POST" && path === "/rescan-projects") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getBackend(args.backend).rescanProjects()));
    return;
  }

  if (req.method === "GET" && path === "/modes") {
    const sessionId = url.searchParams.get("sessionId");
    const state = sessionId ? sessions.get(sessionId) : null;
    const backend = backendFor(sessionId, url.searchParams.get("backend"));
    if (typeof backend.listModes !== "function") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("null"); // no mode concept for this backend (e.g. Claude Code)
      return;
    }
    let modes;
    try {
      modes = await backend.listModes(sessionId);
    } catch (e) {
      // A backend error must never kill the process: the async handler's
      // rejection would otherwise surface as an unhandled rejection and node
      // exits, which is exactly what leaves the whole viewer "unusable" when
      // /modes races `opencode serve`'s ~4-8s cold-start window. viewer.html
      // swallow-errors this response and retries on the next status event.
      console.error("[driver] /modes backend call failed:", e.message);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end('{"error":"backend failed to list modes"}');
      return;
    }
    if (modes) {
      // Prefer a real in-run choice over the backend-derived value — but a
      // choice made while this session has no `state` yet (viewing a resumed
      // session that hasn't had a prompt run through THIS driver process) was
      // parked in preSeeds by /set-mode instead (see getSessionState()/
      // /set-mode), not on `state`, since `state` doesn't exist to hold it
      // yet. Check both, or a pick made in that exact window (silently)
      // reverts on the next poll once state.mode turns out to never have
      // been set.
      const pendingMode = state?.mode || preSeeds.get(sessionId)?.mode || null;
      modes.current = pendingMode || modes.current || null;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(modes));
    return;
  }

  if (req.method === "POST" && path === "/set-mode") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const state = sessions.get(body.sessionId);
    const backend = backendFor(body.sessionId, body.backend);
    if (typeof backend.setMode !== "function") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"this backend has no mode concept"}');
      return;
    }
    if (state) {
      // Best-effort: the backend call is an optimization (opencode applies
      // mode via the per-message `agent` field anyway), so it must never
      // fail the request or drop the recorded choice.
      try {
        await backend.setMode(body.sessionId, body.mode);
      } catch (e) {
        console.error("[driver] set-mode backend call failed (ignoring):", e.message);
      }
      state.mode = body.mode;
    } else {
      // No state yet (pre-prompt "new chat") — park the choice; it merges
      // into state the first time a prompt creates it.
      const pre = preSeeds.get(body.sessionId) || {};
      preSeeds.set(body.sessionId, { ...pre, mode: body.mode });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === "GET" && path === "/models") {
    const sessionId = url.searchParams.get("sessionId");
    const state = sessionId ? sessions.get(sessionId) : null;
    const backend = backendFor(sessionId, url.searchParams.get("backend"));
    if (typeof backend.listModels !== "function") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("null"); // no model concept for this backend
      return;
    }
    // OpenCode specifically: its serve process can be down for real between a
    // crash/wedge and driver.mjs's backoff-guarded restart (see the
    // process-ownership block above) — surface that distinctly from "backend
    // reachable, model cache just not populated yet" so viewer.html can block
    // the textarea with an honest "can't send right now" state instead of
    // showing an empty/hidden picker that looks identical to ordinary
    // cold-start warm-up.
    if (backend === backends.opencode && !isOpencodeUp()) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "server_unreachable" }));
      return;
    }
    let models;
    try {
      models = await backend.listModels(sessionId);
    } catch (e) {
      // Same resilience rationale as /modes above: no backend can take the
      // driver down with an unhandled rejection. Neither backend's
      // listModels is expected to actually throw (both swallow their own
      // fetch/query failures internally and report an empty cache instead),
      // but report it the same way as a known-down server if one somehow
      // does, rather than a raw error blob the frontend can't parse.
      console.error("[driver] /models backend call failed:", e.message);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, reason: "server_unreachable" }));
      return;
    }
    if (models) {
      // An explicit in-run picker choice always wins over the derived value.
      // Check preSeeds as well as state.model: a pick made while viewing a
      // resumed session that hasn't had a prompt run through THIS driver
      // process yet (exactly the "model unavailable" scenario this exists
      // for) has no `state` to land on — /set-model parks it in preSeeds
      // instead (see getSessionState()/ /set-model) — and without this
      // fallback that pick would silently revert to the old unconfirmed
      // value on the very next poll, flipping back to "unavailable" and
      // re-disabling the textarea underneath whatever the user was
      // mid-typing.
      const pendingModel = state?.model || preSeeds.get(sessionId)?.model || null;
      if (pendingModel) {
        models.current = pendingModel;
        // NOT unconditionally true: the picker only offers currently-
        // confirmed options at the moment of picking, but "confirmed then"
        // doesn't mean "confirmed now" — right after a driver restart,
        // `available` can genuinely still be empty (knownModels/provider-list
        // warm-up hasn't finished yet), and reporting confirmed=true in that
        // window would wrongly skip past viewer.html's "Model unavailable,
        // please wait" state straight to its emptier "nothing known yet, hide
        // the picker" one instead — actively hiding the one piece of
        // information (which specific model this session is pinned to) that
        // state exists to surface. Recompute for real against whatever
        // `available` actually is right now.
        models.currentConfirmed = (models.available || []).some((m) => m.id === pendingModel);
      }
    }
    if (models) models.ok = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(models));
    return;
  }

  if (req.method === "POST" && path === "/set-model") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const state = sessions.get(body.sessionId);
    const backend = backendFor(body.sessionId, body.backend);
    if (typeof backend.setModel !== "function") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"this backend has no model concept"}');
      return;
    }
    if (state) {
      // Both backends treat setModel as a no-op (the model travels on the
      // per-message body instead), so there's nothing to fail here; the
      // choice is recorded regardless.
      try {
        await backend.setModel(body.sessionId, body.model);
      } catch (e) {
        console.error("[driver] set-model backend call failed (ignoring):", e.message);
      }
      state.model = body.model;
    } else {
      // Pre-prompt "new chat": park the choice for when state is created.
      const pre = preSeeds.get(body.sessionId) || {};
      preSeeds.set(body.sessionId, { ...pre, model: body.model });
    }
    // Persist regardless of the state/preSeeds branch above, so this choice
    // is still known after a driver.mjs restart (see loadPersistedModelPicks/
    // persistModelPick's comment by preSeeds' declaration) — not just for the
    // rest of this process's life.
    persistModelPick(body.sessionId, body.model);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // Driver-owned flag, not delegated to any backend: both backends' canUseTool/
  // onPermission equivalents read state.autoApprove directly (see
  // backends/claude-code.mjs's makeCanUseTool and backends/opencode.mjs's
  // onPermission) to short-circuit-allow tool permission asks for this
  // session until turned back off. AskUserQuestion-equivalents are
  // deliberately NOT covered by this — those still always reach the browser.
  if (req.method === "POST" && path === "/auto-approve") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const state = sessions.get(body.sessionId);
    if (!state) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"unknown session"}');
      return;
    }
    state.autoApprove = !!body.enabled;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, autoApprove: state.autoApprove }));
    return;
  }

  if (req.method === "POST" && path === "/archive-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const targetId = body.sessionId;
    if (!targetId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    // No "move away from the currently-active session" special case — there
    // is no single active session. Archiving doesn't disable resume, so a
    // tab that's still viewing/prompting an archived session keeps working
    // exactly as before; it just shows under "Archived" in any sessions
    // panel that refreshes its list.
    try {
      const state = sessions.get(targetId);
      const backend = backendFor(targetId, body.backend);
      await backend.archiveSession(targetId, state?.cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] archive-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to archive session"}');
    }
    return;
  }

  if (req.method === "POST" && path === "/unarchive-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    try {
      const state = sessions.get(body.sessionId);
      const backend = backendFor(body.sessionId, body.backend);
      await backend.unarchiveSession(body.sessionId, state?.cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] unarchive-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to unarchive session"}');
    }
    return;
  }

  if (req.method === "POST" && path === "/delete-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    if (sessions.get(body.sessionId)?.turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is in progress in this session — stop it first"}');
      return;
    }
    try {
      const state = sessions.get(body.sessionId);
      const backend = backendFor(body.sessionId, body.backend);
      await backend.deleteSession(body.sessionId, state?.cwd);
      sessions.delete(body.sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] delete-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to delete session"}');
    }
    return;
  }

  if (req.method === "POST" && path === "/rename-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    try {
      const state = sessions.get(body.sessionId);
      const backend = backendFor(body.sessionId, body.backend);
      await backend.renameSession(body.sessionId, body.title, state?.cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] rename-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to rename session"}');
    }
    return;
  }

  if (req.method === "POST" && path === "/prompt") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const sessionId = body.sessionId;
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    // Only meaningful for a brand-new session (the "new chat" project/backend
    // picker) — an already-known session just keeps whatever cwd/backend it
    // was first created with, below. cwd is validated up front rather than
    // silently substituted, so a bad path is a clear error instead of a
    // session quietly landing somewhere the user didn't ask for.
    let explicitCwd;
    if (body.cwd) {
      const backend = getBackend(body.backend || args.backend);
      explicitCwd = backend.resolveValidCwd(body.cwd);
      if (!explicitCwd) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"cwd must be an existing directory under the workspace root"}');
        return;
      }
    }
    if (getSessionState(sessionId, explicitCwd, body.backend).turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is already in progress in this session"}');
      return;
    }
    const text = body.text || "";
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    // Fire-and-forget: the actual reply streams via server.py's SSE feed,
    // not this HTTP response. Different sessions' calls run fully
    // concurrently — only a second prompt to the SAME session is rejected
    // above.
    runTurn(sessionId, text).catch((e) => console.error("[driver] runTurn failed:", e.message));
    return;
  }

  if (req.method === "POST" && path === "/permission-response") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const pending = pendingApprovals.get(body.id);
    if (!pending) {
      res.writeHead(404);
      res.end('{"error":"no such pending approval"}');
      return;
    }
    pendingApprovals.delete(body.id);

    // Persist the resolution server-side, not just in whichever browser tab
    // clicked the button: the original permission bubble's "resolved"/
    // "resolvedText" state would otherwise live only in that tab's in-memory
    // JS object, so a reload would have no way to know it was already
    // answered and would re-render live Allow/Deny buttons for it.
    // Broadcasting an updated 'permission' message under the same id, with
    // the decision baked in, means the next history replay renders it
    // resolved.
    const resolvedText = typeof body.answer === "string"
      ? `Answered: ${body.answer}`
      : (body.allow ? "Allowed" : "Denied");
    broadcast(pending.sessionId, "permission", JSON.stringify({
      kind: pending.kind, toolName: pending.toolName, toolInput: pending.toolInput,
      resolved: true, resolvedText,
    }), body.id);

    if (typeof body.answer === "string") {
      // Question answers now carry both the human-readable joined string
      // (`text` — what Claude Code's plain-text protocol wants, and what
      // resolvedText above already displays) and, when the viewer sent one,
      // a per-question structured array (`structured` — {header, answer}
      // per question, answer itself a string or an array of strings for a
      // multiSelect question). Added so backends/opencode.mjs's
      // replyQuestion can consume each question's answer directly instead
      // of re-parsing the joined string by splitting on "; " and stripping
      // a header prefix — fragile once free-typed "Other" text can contain
      // either of those. `structured` is null whenever the caller didn't
      // send one (older client, or a plain permission decision never hits
      // this branch at all since body.answer wouldn't be a string then).
      pending.resolve({
        text: body.answer,
        structured: Array.isArray(body.answers) ? body.answers : null,
      });
    } else {
      pending.resolve({ allow: !!body.allow, message: body.message });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === "POST" && path === "/abort") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const state = sessions.get(body.sessionId);
    if (state) state.backend.abort(body.sessionId, state);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(args.port, "0.0.0.0", () => {
  console.log(`[driver] listening on port ${args.port}, forwarding to viewer at ${VIEWER_MESSAGE_URL}`);
  console.log(`[driver] default backend: ${args.backend}`);
  console.log("[driver] multi-session — no pinned session id; each request names its own target");
});
