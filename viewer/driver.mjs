#!/usr/bin/env node
// Bidirectional, multi-session, multi-backend driver for the PodPrompt
// viewer.
//
// Backend-agnostic shell: HTTP routes, the per-session `sessions` Map, the
// shared `pendingApprovals` map, and all broadcast plumbing to server.py
// live here. Every backend-specific concern — how a turn is actually run,
// how sessions/history are listed, how permissions are asked — is delegated
// to a `Backend` object (see backends/claude-code.mjs for the reference
// implementation). A session picks its backend once, at creation, and keeps
// it for its whole lifetime — either explicitly (the new-chat picker's own
// backend row, or per-request `backend` field on a brand-new session) or, for
// a pre-existing session this process hasn't touched yet, resolved from
// sessionIdToBackend (never guessed — see the comment above that Map).
// There is no more CLI-level "default backend" for --viewer: defaultBackendId()
// below just remembers whichever backend the new-chat picker was last used
// with, for its own pre-selected radio button, falling back to the first
// registered backend on a fresh install with no history yet.
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
// turn_start/thinking_tokens/tool_progress/stream_start/stream_delta set):
// turn_end {reason:"completed"|"aborted"|"error", error?} — broadcast by
// runTurn()'s own finally rather than by either backend, so the three
// outcomes are classified identically no matter which one ran,
// context_usage {percentage,totalTokens,maxTokens},
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import { createClaudeCodeBackend } from "./backends/claude-code.mjs";
import { createOpenCodeBackend } from "./backends/opencode.mjs";
import {
  createAutonomy, FANOUT_CAP_PER_TURN, MAX_CREATION_DEPTH, DEFAULT_PAUSE_AFTER,
} from "./autonomy.mjs";
import { createPeers, createInbox, LOCAL_REALM } from "./messaging.mjs";

function parseArgs(argv) {
  const args = {
    port: 7844, viewerPort: 7843, cwd: "/workspace",
    opencodePort: 7845,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--viewer-port") args.viewerPort = Number(argv[++i]);
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--opencode-port") args.opencodePort = Number(argv[++i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
// PodPrompt's own bookkeeping directory (podprompt.sh's PODPROMPT_STATE_DIR)
// — deliberately NOT under either backend's own config directory (see
// MODEL_PICKS_FILE/LAST_BACKEND_FILE/SESSION_HOSTS_FILE below), since those
// are shared with native, non-Docker installs on the same host and should
// never gain PodPrompt-internal files.
const PODPROMPT_STATE_DIR = process.env.PODPROMPT_STATE_DIR
  || nodePath.join(os.homedir(), ".local", "state", "podprompt");
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

// `origin` records WHO caused this message to exist: "human" for something
// typed in the browser, "parent" for a prompt a parent session delegated,
// later "peer" if sessions ever message each other directly. Absent means
// human, so every existing call site keeps its meaning. It matters for two
// things that are hard to retrofit: a transcript that cannot distinguish
// human input from agent input is ambiguous to read, and any future loop
// detection between sessions has nothing to key on without it.
async function broadcast(sessionId, role, text, id, ts, model, origin) {
  // Cheapest place to learn what was running when a turn died: every tool
  // bubble passes through here already.
  if (role === "tool") {
    const m = /^`([^`\n]+)`/.exec(text || "");
    if (m) noteTurnTool(sessionId, m[1]);
  }
  return enqueueSend(sessionId, async () => {
    try {
      await fetch(VIEWER_MESSAGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId, role, text, id, ts: ts || nowIso(), model,
          ...(origin && origin !== "human" ? { origin } : {}),
        }),
      }).then(noteViewerLiveness);
    } catch (e) {
      console.error("[driver] failed to broadcast to viewer:", e.message);
    }
  });
}

// ── Viewer liveness ──────────────────────────────────────────────────────
// server.py reports its subscriber count on every /message and /status POST
// we already make (see its handler), so this is free to keep current — no
// polling, no extra request. It exists because the driver can otherwise park
// a permission request on a browser that closed hours ago and never know.
// Deliberately a last-seen timestamp rather than a bare boolean: "no viewer
// for the last N minutes" is the useful question, and a momentary gap while
// a tab reconnects should not read as absence.
const viewerLiveness = { viewers: 0, lastSeenWithViewer: Date.now(), lastCheck: 0 };

async function noteViewerLiveness(res) {
  try {
    if (!res || !res.ok) return;
    const data = await res.json();
    if (typeof data?.viewers !== "number") return;
    viewerLiveness.viewers = data.viewers;
    viewerLiveness.lastCheck = Date.now();
    if (data.viewers > 0) viewerLiveness.lastSeenWithViewer = Date.now();
  } catch {
    // A malformed or truncated body is not worth a log line here; the
    // previous reading simply stands until the next broadcast refreshes it.
  }
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
  // Observed here rather than tracked in runTurn because turn_start is the
  // backend's to emit, at whatever moment suits its own process/request
  // model. runTurn's finally reads this to avoid announcing the END of a
  // turn the browser was never told had STARTED — which happens when a
  // backend throws during setup (e.g. opencode's ensureSession when its
  // server is unreachable), and would otherwise flip a Stop button back to
  // Send in a tab that is legitimately mid-turn on the same session.
  if (payload.type === "turn_start") {
    const s = sessions.get(sessionId);
    if (s) s.turnAnnounced = true;
  }
  return enqueueSend(sessionId, async () => {
    try {
      await fetch(VIEWER_STATUS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...payload }),
      }).then(noteViewerLiveness);
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
// `suggestions` is the backend's offer of a broader rule that would stop this
// particular ask recurring — claude-code supplies PermissionUpdate[] on
// canUseTool's options, opencode expresses the same idea as a reply scope.
// Passing it through is what lets the card offer "Always allow" instead of
// forcing a choice between answering every single prompt and auto-approving
// everything, which is the only middle ground a tool-heavy sub-agent run
// makes bearable.
// The two backends arrive at the same capability differently, so it is
// declared rather than inferred: claude-code only supports it when the SDK
// actually suggested rules for this call, while opencode supports it for
// every ask (its reply takes a scope). Inferring from `suggestions` alone
// would silently hide the button on every opencode permission.
function requestApproval(sessionId, kind, toolName, toolInput, opts = {}) {
  const { suggestions = null, canAlwaysAllow = false, agentType = null } = opts;
  const id = randomUUID();
  return new Promise((resolve) => {
    pendingApprovals.set(id, {
      resolve, sessionId, kind, toolName, toolInput,
      suggestions: suggestions || null,
      canAlwaysAllow: !!canAlwaysAllow,
      askedAt: nowIso(),
    });
    persistPendingApprovals();
    // Recorded on the sub-agent's roster entry so its row and its Agent
    // bubble can say "waiting" rather than "running" — those are different
    // states, and only one of them resolves without you. The approval's own
    // id rides along so a link can jump straight to that card rather than
    // just to the session containing it.
    if (isRosterChild(sessionId)) {
      upsertSubAgent(sessionId, { awaiting: kind, awaitingId: id });
    }
    // A turn parked on a human is NOT a turn that is working, and the
    // browser has had no way to tell the two apart — both looked like
    // turnInFlight, so the UI spun a "thinking" indicator at a session that
    // was in fact waiting on the user. Announced explicitly so the state is
    // visible without inferring it from the presence of a card.
    broadcastStatus(sessionId, { type: "awaiting_input", kind, toolName });
    broadcast(sessionId, "permission", JSON.stringify({
      kind, toolName, toolInput,
      ...(canAlwaysAllow ? { canAlwaysAllow: true } : {}),
      // Present only when the ask came from a sub-agent we could not pin to
      // its own child session — the card then says which KIND of sub-agent
      // is asking rather than silently implying the main thread asked.
      ...(agentType ? { agentType } : {}),
    }), id);
  });
}

// ── Pending-approval sidecar ─────────────────────────────────────────────
// Not a resume mechanism: when the driver dies so does the promise the tool
// call is parked on, and so does the CLI subprocess that cared about the
// answer — neither backend can resume a turn mid-tool-call, so the turn is
// genuinely lost. This exists so the loss is EXPLICABLE. The permission card
// is PodPrompt-synthesized and lives only in server.py's in-memory log, so
// without this a reloaded session shows a tool bubble that simply stops,
// which reads as a bug rather than as "you were asked something and never
// answered".
const PENDING_APPROVALS_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-pending-approvals.json");

function persistPendingApprovals() {
  const out = {};
  for (const [id, p] of pendingApprovals) {
    out[id] = { sessionId: p.sessionId, kind: p.kind, toolName: p.toolName, askedAt: p.askedAt };
  }
  try {
    writeFileSync(`${PENDING_APPROVALS_FILE}.tmp`, JSON.stringify(out));
    renameSync(`${PENDING_APPROVALS_FILE}.tmp`, PENDING_APPROVALS_FILE);
  } catch (e) {
    console.error("[driver] failed to write pending-approvals file:", e.message);
  }
}

// Read once at startup: anything still recorded belongs to a turn that died
// with the previous process, so it is reported to the browser as abandoned
// and then cleared. Doing this eagerly (rather than lazily on first connect)
// keeps the file honest about the CURRENT process's state.
function reportAbandonedApprovals() {
  let prior;
  try {
    prior = JSON.parse(readFileSync(PENDING_APPROVALS_FILE, "utf8"));
  } catch {
    return; // nothing recorded, or unreadable — nothing to explain
  }
  const entries = Object.entries(prior || {});
  if (!entries.length) return;
  for (const [, p] of entries) {
    if (!p?.sessionId) continue;
    broadcast(p.sessionId, "tool",
      `*(a ${p.kind === "question" ? "question" : "permission request"}${p.toolName ? ` for \`${p.toolName}\`` : ""} was still waiting when this session ended — the turn did not complete)*`,
      randomUUID(), null, null);
  }
  console.log(`[driver] reported ${entries.length} abandoned approval(s) from a previous process`);
  try {
    writeFileSync(`${PENDING_APPROVALS_FILE}.tmp`, "{}");
    renameSync(`${PENDING_APPROVALS_FILE}.tmp`, PENDING_APPROVALS_FILE);
  } catch { /* best effort */ }
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
  let expired = 0;
  for (const [id, pending] of pendingApprovals) {
    if (pending.sessionId !== sessionId) continue;
    pendingApprovals.delete(id);
    expired += 1;
    broadcast(sessionId, "permission", JSON.stringify({
      kind: pending.kind, toolName: pending.toolName, toolInput: pending.toolInput,
      resolved: true, resolvedText: "This request expired (the turn ended without an answer).",
    }), id);
  }
  if (expired) {
    persistPendingApprovals();
    if (isRosterChild(sessionId)) {
      upsertSubAgent(sessionId, { awaiting: null, awaitingId: null });
    }
    // Nothing is waiting on the user here any more, whatever the UI last
    // heard. Sent unconditionally rather than only when a card was visible,
    // so a stale "waiting on you" indicator can't outlive the turn.
    broadcastStatus(sessionId, { type: "awaiting_input", kind: null });
  }
}

// ── Backend registry ─────────────────────────────────────────────────────
// One instance per backend id, constructed once at startup and shared by
// every session that picks it — a backend instance holds no per-session
// state itself (that all lives in each session's own entry in `sessions`
// below), so there's no problem with many sessions sharing one instance.
// registerChild/autoApproveForSession are what let a backend surface a child
// session without knowing anything about the relation index or how
// auto-approve is resolved across a tree it cannot see.
const backendHooks = {
  cwdRoot: args.cwd, broadcast, broadcastStatus, requestApproval,
  registerChild: registerChildSession,
  autoApproveForSession,
  updateSubAgent: upsertSubAgent,
  // The messaging surface, handed to each backend so it can expose the SAME
  // tools in whatever shape its runtime wants. The logic stays here; a
  // backend only supplies identity it can vouch for.
  messaging: {
    message: (fromSessionId, args) => toolMessage(fromSessionId, args),
    listPeers: (fromSessionId, opts) => toolListPeers(fromSessionId, opts),
    delegate: (fromSessionId, args) => toolDelegate(fromSessionId, args),
    describeReceipt,
    backendIds: () => Object.keys(backends),
    systemPrompt: () => messagingSystemPrompt({ prefix: "mcp__podprompt__" }),
    readSession: (fromSessionId, args) => toolReadSession(fromSessionId, args),
    renderReadSession,
  },
};
const backends = {
  "claude-code": createClaudeCodeBackend(backendHooks),
  // driver.mjs itself spawns and supervises a headless `opencode serve`
  // (see the process-ownership block after this map) regardless of which
  // backend is the default — baseUrl here just needs to agree with the port
  // that child is started on (--opencode-port).
  "opencode": createOpenCodeBackend({
    noteDelegateAnchor, noteRealSessionId,
    ...backendHooks, baseUrl: `http://127.0.0.1:${args.opencodePort}` }),
};

function getBackend(id) {
  const b = backends[id];
  if (b) return b;
  console.error(`[driver] unknown backend "${id}", falling back to claude-code`);
  return backends["claude-code"];
}

// ── Default backend for a brand-new session's picker only ───────────────
// There is no more CLI-level "default backend" for --viewer (podprompt.sh's
// --claude/--opencode only ever govern the non-viewer direct-TUI launch
// path now — see its own header comment). Every *session* either already
// has a fixed backend (existing/resumed — resolved via sessionIdToBackend
// below, never guessed) or gets one explicitly from the new-chat picker's
// backend row. The only thing left needing an answer with no session in
// play at all is that picker's pre-selected radio button, and the two
// backend-agnostic /commands, /projects fallbacks (no session to resolve
// from) — both just want "whichever backend the user was using last,"
// which this remembers across restarts, falling back to the first
// registered backend (claude-code) on a fresh install with no history yet.
const LAST_BACKEND_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-last-backend.json");

function loadLastBackend() {
  try {
    return JSON.parse(readFileSync(LAST_BACKEND_FILE, "utf8"))?.backend || null;
  } catch {
    return null; // missing or corrupt — no persisted choice yet
  }
}

// Written exactly once per genuinely brand-new session (see getSessionState
// below) — never for a pre-existing session this process is merely
// resolving the backend of for the first time this run, which would corrupt
// this into reflecting resume order instead of deliberate new-chat choices.
function persistLastBackend(backendId) {
  try {
    writeFileSync(`${LAST_BACKEND_FILE}.tmp`, JSON.stringify({ backend: backendId }));
    renameSync(`${LAST_BACKEND_FILE}.tmp`, LAST_BACKEND_FILE);
  } catch (e) {
    console.error("[driver] failed to write last-backend file:", e.message);
  }
}

// Read lazily rather than cached in memory: written rarely (only on a new
// session) and read rarely (picker pre-selection, two fallback routes), so
// there's no hot path here worth optimizing a file read away from.
function defaultBackendId() {
  const last = loadLastBackend();
  if (last && backends[last]) return last;
  return Object.keys(backends)[0];
}

// ── Which host path a session was last touched from ─────────────────────
// podprompt.sh threads its own $(pwd) at launch through as HOST_WORKSPACE_PATH
// — nothing inside the container can otherwise ever learn the host-side path
// a Docker bind mount came from. Generic across both backends (stamped once
// per turn from the shared runTurn() wrapper below, not per-backend) since
// the concept — "where do I need to point the launch script to get back to
// this" — has nothing backend-specific about it. Two things read this:
// buildUnreachableItem's "relaunch from X" hint in viewer.html (a session
// already known unreachable by the plain path-resolvability check), and the
// hostMismatch check in the /sessions handler below, which catches sessions
// that check does NOT: CLAUDE_CONFIG_DIR/OPENCODE_DATA_DIR are both single,
// global-per-user host directories, and every container run mounts whatever
// host directory is current at the *same* container path (cwdRoot, normally
// /workspace) — so a session recorded at exactly cwdRoot from a totally
// unrelated host checkout can never fail a realpath check (cwdRoot always
// resolves to *something*) and would otherwise look like a perfectly normal,
// current session. Comparing the host path actually catches that, at the
// cost of also firing when you've simply relocated your own checkout to a
// new folder and relaunched from there — deliberately surfaced as a soft
// `hostMismatch` flag on an otherwise-ordinary (still reachable, still
// resumable) session rather than folded into the harder `unreachable`
// bucket, since "might be a different project" is a heads-up, not a block.
const SESSION_HOSTS_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-session-hosts.json");

function loadSessionHosts() {
  try {
    return JSON.parse(readFileSync(SESSION_HOSTS_FILE, "utf8"));
  } catch {
    return {}; // missing or corrupt — start fresh rather than fail over this
  }
}

function stampSessionHost(sessionId, cwd) {
  const hostPath = process.env.HOST_WORKSPACE_PATH;
  if (!hostPath) return; // older launch script, or non-docker dev usage — nothing to record
  const data = loadSessionHosts();
  data[sessionId] = { hostPath, cwd, lastSeen: new Date().toISOString() };
  try {
    // Temp file + atomic rename so a crash mid-write can't leave a torn
    // JSON that throws on the next read.
    writeFileSync(`${SESSION_HOSTS_FILE}.tmp`, JSON.stringify(data));
    renameSync(`${SESSION_HOSTS_FILE}.tmp`, SESSION_HOSTS_FILE);
  } catch (e) {
    console.error("[driver] failed to write session-hosts file:", e.message);
  }
}

// ── Per-session preferences (MD9) ────────────────────────────────────────
// Durable, unlike autoApprove — which lives on the in-memory session state
// and so resets every restart. That is tolerable for a permission flag the
// user re-grants while sitting there; it is not tolerable for auto-delivery,
// whose whole purpose is to let a session run unattended. A setting that
// silently reverts on restart would strand the very worker it was turned on
// for, with no visible cause.
//
// Deliberately its own tiny file rather than a field on the relation index
// or the session-hosts record: the relation index only has rows for sessions
// with a parent (so no root session could hold a preference), and
// stampSessionHost() rewrites its whole record on every touch, which would
// silently drop anything stored alongside it.
const SESSION_PREFS_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-session-prefs.json");

let sessionPrefs = loadSessionPrefs();

function loadSessionPrefs() {
  try {
    const raw = JSON.parse(readFileSync(SESSION_PREFS_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // missing or corrupt — defaults are safe, so start fresh
  }
}

function saveSessionPrefs() {
  try {
    writeFileSync(`${SESSION_PREFS_FILE}.tmp`, JSON.stringify(sessionPrefs));
    renameSync(`${SESSION_PREFS_FILE}.tmp`, SESSION_PREFS_FILE);
  } catch (e) {
    console.error("[driver] failed to write session-prefs file:", e.message);
  }
}

// ── Session relation index + sub-agent registry ──────────────────────────
// A sub-agent is modelled as a CHILD SESSION: it gets a PodPrompt-minted
// session id of its own, so opening one reuses /events?session=X, the
// history path and the renderer unchanged, rather than needing a parallel
// "nested transcript" mechanism inside the parent's feed.
//
// Two structures, deliberately separate because their lifetimes differ:
//
//   relations  — durable (this sidecar). Who is whose child, on which
//                backend, and of which kind. Survives restarts because the
//                sessions it describes do.
//   subAgents  — live (memory only). Status, current tool, usage counters.
//                Rebuilt from backend events; meaningless across a restart,
//                since the processes it described are gone.
//
// Three rules this file has to keep, because breaking them is cheap now and
// expensive later (see the design doc's forward constraints):
//
//   * Child ids are OURS. Backend-native identities (claude-code's task id
//     and agent id, opencode's `ses_…`) are recorded as attributes, never
//     used as the key — otherwise a child could never run on a different
//     backend from its parent.
//   * Relations are TYPED, and only `parent` cascades. A future peer edge
//     between two sessions must not inherit archive/delete semantics.
//   * Depth is computed from the chain here, never taken from a backend's
//     own count, which only knows about its own nesting.
const SESSION_TREE_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-session-tree.json");

// childSessionId -> { rel, parent, backend, childKind, subagentType,
//                     description, native: {...}, createdAt }
// `rel` is always "parent" today; it exists so a later peer relation can
// live in the same file without the cascade walkers silently picking it up.
let sessionRelations = loadSessionRelations();

// OpenCode sessions are keyed throughout PodPrompt by a minted client id
// ("oc-<uuid>"), while OpenCode itself knows them by a "ses_..." id it
// assigns at creation. That pairing lives in the backend's in-memory maps
// and so dies with the process — which is fine for everything EXCEPT a
// restart, where the session then lists under its real id while its relation
// row, turn state and resumable record all still sit under the client id.
// The symptom is a delegated child reappearing detached from its parent with
// no Continue bar, which is exactly the state a crashed session must not be
// in. Seeded here, before the first listSessions, from the durable index.
function seedOpenCodeRealIds() {
  const pairs = [];
  for (const [clientId, rel] of Object.entries(sessionRelations)) {
    if (rel?.native?.realSessionId) pairs.push([clientId, rel.native.realSessionId]);
  }
  const n = backends.opencode?.seedRealIds?.(pairs) || 0;
  if (n) console.log(`[driver] restored ${n} opencode session id mapping(s) from the relation index`);
}
seedOpenCodeRealIds();

// Durable half of the pairing above: called by the opencode backend the
// moment it creates a real session for a minted id. Only sessions with a
// relation row are recorded — a plain top-level session has nothing keyed to
// its client id worth preserving, and reappearing under its real id after a
// restart costs it nothing.
function noteRealSessionId(clientId, realId) {
  if (!clientId || !realId) return;
  const rel = sessionRelations[clientId];
  if (!rel || rel.native?.realSessionId === realId) return;
  rel.native = { ...(rel.native || {}), realSessionId: realId };
  saveSessionRelations();
}

function loadSessionRelations() {
  try {
    const raw = JSON.parse(readFileSync(SESSION_TREE_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {}; // missing or corrupt — start fresh rather than fail over this
  }
}

function saveSessionRelations() {
  try {
    // Temp file + atomic rename, same as the session-hosts file above: a
    // crash mid-write must not leave torn JSON that throws on next read.
    writeFileSync(`${SESSION_TREE_FILE}.tmp`, JSON.stringify(sessionRelations));
    renameSync(`${SESSION_TREE_FILE}.tmp`, SESSION_TREE_FILE);
  } catch (e) {
    console.error("[driver] failed to write session-tree file:", e.message);
  }
}

// `native` carries whatever the backend calls this thing. For claude-code
// that is { toolUseId, agentId, taskId } — toolUseId being the one id present
// BOTH in the live task_started event and in the on-disk
// subagents/agent-<id>.meta.json, which is what lets a live view and a
// replayed view agree on which child they are looking at.
function registerChildSession(childId, info) {
  if (!childId || !info?.parent) return;
  const prev = sessionRelations[childId] || {};
  sessionRelations[childId] = {
    rel: "parent",
    parent: info.parent,
    backend: info.backend || prev.backend || null,
    // "native-task" (both backends) | "delegated" (toolDelegate) | null
    // (legacy rows predating the field). HD1's isRosterChild/isTreeChild
    // split keys off this, and the ONLY value either tests for is
    // "native-task" — so a null or unrecognised kind lands on the tree side,
    // which is the recoverable direction.
    childKind: info.childKind || prev.childKind || null,
    subagentType: info.subagentType ?? prev.subagentType ?? null,
    description: info.description ?? prev.description ?? null,
    native: { ...(prev.native || {}), ...(info.native || {}) },
    // HD2/HD3. Carried explicitly because this function builds its row field
    // by field — anything merely passed in `info` is dropped, silently, with
    // no error anywhere. (That is how these two were lost the first time.)
    parentTurnId: info.parentTurnId ?? prev.parentTurnId ?? null,
    awaitedByParentTurn: info.awaitedByParentTurn ?? prev.awaitedByParentTurn ?? false,
    // HD4. Never reset by re-registration: a child that a human has typed
    // into stays typed-into, and this flag only ever travels one way.
    hadUserTurn: prev.hadUserTurn || info.hadUserTurn || false,
    createdAt: prev.createdAt || nowIso(),
    // Written once, never rewritten — not even by promotion, which clears
    // the parent edge. This is what the depth guard counts along, so if
    // promotion could reset it, promote→delegate→promote would recurse
    // unbounded with depth never climbing past one.
    createdBy: prev.createdBy || info.createdBy || info.parent,
  };
  saveSessionRelations();
  // A brand-new sub-agent is exactly when the roster button should appear,
  // and registration can happen before any status update would have nudged
  // the browser.
  if (!prev.parent) broadcastStatus(info.parent, { type: "sub_agents_changed" });
}

// A promoted sub-agent reports NO parent: it has been detached deliberately,
// so it is promptable, listed on its own, and out of its old parent's cascade
// — while the row itself survives, because it still holds the backend ids
// that locate this session's transcript on disk.
function parentOfSession(sessionId) {
  const r = sessionRelations[sessionId];
  return r && r.rel === "parent" && !r.promoted ? r.parent : null;
}

// HD1: surfaces are assigned by ROLE, not by implementation. These two
// predicates are the whole of that decision, and they are deliberately NOT
// "is this a child" — that question (parentOfSession) is still the right one
// for the cascade walkers, the depth guard and auto-approve inheritance,
// because those are about the durable relationship, which all children share.
//
//   ROSTER child  — a native sub-agent, on EITHER backend. Turn-scoped work
//                   its parent is blocked on. Read-only, roster-only, never
//                   listed as a session of its own. OpenCode implements these
//                   as real ses_... sessions, which is exactly the
//                   implementation detail HD1 refuses to leak: what it IS to
//                   the user is a sub-agent, so it belongs in the roster.
//
//   TREE child    — a delegated session. A real conversation the user asked
//                   for, so it is listed, nested under its parent, and
//                   promptable like any other session.
//
// Unknown childKind (a legacy row from before the field existed) counts as a
// TREE child. That is the safe direction: the failure mode HD1 exists to
// prevent is a session becoming unreachable, and a stray visible row is
// recoverable where an invisible one is not.
function isRosterChild(sessionId) {
  const r = sessionRelations[sessionId];
  return !!(r && r.rel === "parent" && !r.promoted && r.childKind === "native-task");
}

function isTreeChild(sessionId) {
  const r = sessionRelations[sessionId];
  return !!(r && r.rel === "parent" && !r.promoted && r.childKind !== "native-task");
}

function childrenOfSession(parentId) {
  return Object.entries(sessionRelations)
    .filter(([, r]) => r.rel === "parent" && !r.promoted && r.parent === parentId)
    .map(([childId]) => childId);
}

// Every descendant, breadth-first, following ONLY parent edges. This is the
// cascade walker — archive/unarchive/delete/abort all use it — so it must
// never traverse a non-parent relation. Guarded against cycles, which a
// corrupt sidecar could otherwise turn into a hang.
function descendantsOfSession(parentId) {
  const out = [];
  const seen = new Set([parentId]);
  let frontier = [parentId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const child of childrenOfSession(id)) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return out;
}

// Computed from the chain, never from a backend's own spawn_depth: in a
// mixed-backend tree each backend can only count its own nesting. 0 = a
// top-level session.
function depthOfSession(sessionId) {
  let depth = 0;
  let cur = sessionId;
  const seen = new Set([cur]);
  while (true) {
    const parent = parentOfSession(cur);
    if (!parent || seen.has(parent)) return depth;
    seen.add(parent);
    cur = parent;
    depth += 1;
  }
}

function rootOfSession(sessionId) {
  let cur = sessionId;
  const seen = new Set([cur]);
  while (true) {
    const parent = parentOfSession(cur);
    if (!parent || seen.has(parent)) return cur;
    seen.add(parent);
    cur = parent;
  }
}

// Live sub-agent status. Keyed by the child session id (the same key the
// relations index uses), so a roster row and a session view are talking
// about the same thing without translation.
const subAgents = new Map();

function upsertSubAgent(childId, patch) {
  const prev = subAgents.get(childId) || {};
  const next = { ...prev, ...patch, agentId: childId, updatedAt: Date.now() };
  subAgents.set(childId, next);
  // Tell the parent's browser that its roster changed. Without this the
  // viewer only re-read /sub-agents when something ELSE happened to fire —
  // a tool_progress, a turn ending — so a sub-agent could run for a while
  // with no roster button at all, and a reload was the reliable way to see
  // it. Level-triggered on purpose: the payload says "go look", not what
  // changed, so a missed event cannot leave the roster stale.
  const parentId = parentOfSession(childId);
  if (parentId) broadcastStatus(parentId, { type: "sub_agents_changed" });
  return next;
}

// Terminal states are final: a sub-agent that finished, failed or was killed
// is not a candidate for stopping, and must not be re-labelled by a later
// cascade. No live entry at all means the same thing — the work it described
// is not running in this process.
const TERMINAL_SUBAGENT_STATES = new Set(["completed", "failed", "killed"]);

function isSubAgentRunning(childId) {
  if (sessions.get(childId)?.turnInFlight) return true;
  const live = subAgents.get(childId);
  if (!live || !live.status) return false;
  return !TERMINAL_SUBAGENT_STATES.has(live.status);
}

// HD1: the roster holds native sub-agents only. Before this filter it mapped
// EVERY child relation, so a delegated session appeared both here and as a
// row in the session list — two surfaces with different affordances, fed by
// different code paths, free to disagree about the same session.
function subAgentsForParent(parentId) {
  return childrenOfSession(parentId).filter(isRosterChild).map((childId) => {
    const rel = sessionRelations[childId] || {};
    const live = subAgents.get(childId) || {};
    return {
      agentId: childId,
      parentSessionId: parentId,
      backend: rel.backend || null,
      childKind: rel.childKind || null,
      subagentType: rel.subagentType || null,
      description: rel.description || null,
      // The spawning tool_use id is also the Task bubble's own id in the
      // parent's feed (broadcast() keys tool bubbles by it), so the browser
      // can attach live status to that bubble without any extra bookkeeping.
      toolUseId: rel.native?.toolUseId || null,
      summary: live.summary || null,
      depth: depthOfSession(childId),
      status: live.status || "completed", // nothing live on this process ⇒ it is not running
      lastTool: live.lastTool || null,
      // Set while this sub-agent is blocked on a human. awaitingId is the
      // approval card's own message id, so a link can scroll to it.
      awaiting: live.awaiting || null,
      awaitingId: live.awaitingId || null,
      usage: live.usage || null,
      startedAt: live.startedAt || null,
    };
  });
}

// HD2's rule, in one place so /abort and anything later cannot drift. Applied
// recursively: stopping a child applies the same test inside it.
function abortCascadeTargets(sessionId, seen = new Set()) {
  if (seen.has(sessionId)) return [];
  seen.add(sessionId);
  const out = [];
  const parentTurnId = sessions.get(sessionId)?.turnId || null;
  for (const childId of childrenOfSession(sessionId)) {
    const rel = sessionRelations[childId] || {};
    // A roster child is this turn's own work, by definition.
    let blocking = isRosterChild(childId);
    // A delegated child only counts while its parent's CURRENT turn is the
    // one waiting on it. Both halves matter: awaitedByParentTurn rules out
    // async delegations, and the turn-id match rules out an awaited one from
    // an earlier turn. After a restart no id matches, so nothing is killed —
    // the safe direction, deliberately.
    if (!blocking && rel.awaitedByParentTurn && rel.parentTurnId
        && parentTurnId && rel.parentTurnId === parentTurnId) {
      blocking = true;
    }
    if (!blocking) continue;
    out.push(childId);
    out.push(...abortCascadeTargets(childId, seen));
  }
  return out;
}

// The tree-side counterpart to subAgentsForParent. Status comes from the
// session's own live state rather than the subAgents registry, because a
// delegated child IS a session — the registry only ever described work
// running inside somebody else's turn.
function delegatedChildrenForParent(parentId) {
  return childrenOfSession(parentId).filter(isTreeChild).map((childId) => {
    const rel = sessionRelations[childId] || {};
    const state = sessions.get(childId);
    return {
      sessionId: childId,
      backend: rel.backend || sessionIdToBackend.get(childId) || null,
      title: peers.get(childId)?.title || rel.description || null,
      // Null on OpenCode (no per-call id in its ToolContext), in which case
      // the browser leaves that bubble's default rendering alone.
      toolUseId: rel.native?.toolUseId || null,
      inFlight: !!state?.turnInFlight,
      pendingKind: pendingKindForSession(childId),
    };
  });
}

// ── Chains, budgets & pause ──────────────────────────────────────────────
// The store itself lives in autonomy.mjs so it can be unit-tested without
// starting a server or spawning `opencode serve`. This is the code where a
// quiet logic error costs real money, so it is the code that most needs
// tests that do not depend on a running system.
const autonomy = createAutonomy({
  file: nodePath.join(PODPROMPT_STATE_DIR, "viewer-autonomy.json"),
  onError: (e) => console.error("[driver] failed to write autonomy file:", e.message),
});

// ── Deep-history display setting ─────────────────────────────────────────
// Lives server-side rather than in the browser's localStorage, unlike every
// other viewer setting. Those are render-time preferences and per-tab is
// fine; this one decides what server.py FETCHES into a log shared by every
// tab, so two tabs disagreeing would fight over one cache. Persisting here
// also makes it per-install rather than per-browser.
//
// Claude Code only. OpenCode's API already returns its full history (its
// compaction adds messages and deletes nothing — verified by forcing one),
// so there is nothing for this to turn on there.
const DEEP_HISTORY_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-deep-history.json");

let deepHistoryEnabled = (() => {
  try {
    return !!JSON.parse(readFileSync(DEEP_HISTORY_FILE, "utf8"))?.enabled;
  } catch {
    return false;
  }
})();

function setDeepHistory(enabled) {
  deepHistoryEnabled = !!enabled;
  try {
    writeFileSync(`${DEEP_HISTORY_FILE}.tmp`, JSON.stringify({ enabled: deepHistoryEnabled }));
    renameSync(`${DEEP_HISTORY_FILE}.tmp`, DEEP_HISTORY_FILE);
  } catch (e) {
    console.error("[driver] failed to persist deep-history setting:", e.message);
  }
  return deepHistoryEnabled;
}

// ── Resuming a turn that ended badly ────────────────────────────────────
// Turns die in three ways, and only two of them announce it:
//
//   error    — the backend failed; turn_end carries the reason and message
//   aborted  — the user pressed Stop; turn_end says so
//   restart  — the driver or container died mid-turn. NOTHING is broadcast,
//              because the thing that would broadcast it is gone.
//
// That third case is the common one in practice and the only one where the
// user has certainly reloaded the page, so this state is durable: a marker
// is written when a turn starts and cleared when it ends cleanly. Any
// marker still present at startup belonged to a turn that died with the
// process.
const TURN_STATE_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-turn-state.json");

let turnState = loadTurnState();

function loadTurnState() {
  try {
    const raw = JSON.parse(readFileSync(TURN_STATE_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveTurnState() {
  try {
    writeFileSync(`${TURN_STATE_FILE}.tmp`, JSON.stringify(turnState));
    renameSync(`${TURN_STATE_FILE}.tmp`, TURN_STATE_FILE);
  } catch (e) {
    console.error("[driver] failed to write turn-state file:", e.message);
  }
}

// Anything still marked in-flight when this process starts was killed with
// the previous one. Promote those to a resumable "restart" outcome.
function reconcileTurnStateOnStartup() {
  let changed = false;
  for (const [sessionId, rec] of Object.entries(turnState)) {
    if (!rec?.inFlight) continue;
    turnState[sessionId] = {
      inFlight: false,
      resumable: { reason: "restart", lastTool: rec.lastTool || null, at: nowIso() },
    };
    changed = true;
  }
  if (changed) {
    saveTurnState();
    console.log("[driver] marked turns interrupted by restart as resumable");
  }
}

// HD3: every turn gets an id. Three things read it, and all three were
// previously guessing:
//   * awaitTurnEnd binds a waiter to THE turn it meant, not to the session;
//   * toolDelegate stamps parentTurnId on its child, which is what HD2's
//     Stop cascade reads to know what this turn is actually blocked on;
//   * nothing has to CLEAR any of it — a new turn overwrites the id, and
//     after a restart no id matches, so stranded state is inert rather than
//     dangerous. That asymmetry is the whole argument for an id over a flag:
//     a stale flag causes a wrongful kill, a stale id causes nothing.
function markTurnStarted(sessionId) {
  const turnId = randomUUID();
  turnState[sessionId] = { inFlight: true, startedAt: nowIso(), lastTool: null, turnId };
  const state = sessions.get(sessionId);
  if (state) state.turnId = turnId;
  saveTurnState();
  return turnId;
}

// HD4 needs this to survive a restart: the family-delete dialog pre-checks
// children with no user turns, and state.turnOrigin is in-memory only. Written
// at most once per child, and only ever flipped true.
function noteUserTurn(sessionId) {
  const rel = sessionRelations[sessionId];
  if (!rel || rel.hadUserTurn) return;
  rel.hadUserTurn = true;
  saveSessionRelations();
}

function noteTurnTool(sessionId, toolName) {
  const rec = turnState[sessionId];
  if (!rec?.inFlight || !toolName) return;
  rec.lastTool = toolName;
  // Not saved on every tool call — this only matters if the process dies, and
  // a crash loses at most the last tool name, which is a far better trade
  // than a disk write per tool bubble.
}

function markTurnEnded(sessionId, outcome) {
  const rec = turnState[sessionId] || {};
  const bad = outcome?.reason === "error" || outcome?.reason === "aborted";
  turnState[sessionId] = {
    inFlight: false,
    // Carried across so a reader of turnState can still say WHICH turn this
    // record describes. Nothing depends on it today; leaving it out made the
    // record silently lossy.
    ...(rec.turnId ? { turnId: rec.turnId } : {}),
    ...(bad ? { resumable: {
      reason: outcome.reason,
      error: outcome.error || null,
      lastTool: rec.lastTool || null,
      at: nowIso(),
    } } : {}),
  };
  saveTurnState();
}

function clearResumable(sessionId) {
  if (!turnState[sessionId]?.resumable) return;
  delete turnState[sessionId].resumable;
  saveTurnState();
}

function resumableFor(sessionId) {
  return turnState[sessionId]?.resumable || null;
}

// The wording lives here, not in the browser: both backends and any future
// caller should say the same thing, and only the driver knows the error text
// and which tool was running.
//
// Every variant says "do not start over" in some form, because restarting
// from scratch is the expensive failure — far worse than doing nothing.
function resumePromptFor(resumable) {
  if (!resumable) return null;
  const tool = resumable.lastTool
    ? ` You were interrupted while running ${resumable.lastTool}; its result is unknown,`
      + ` so check the current state before assuming it succeeded or failed.`
    : "";
  if (resumable.reason === "restart") {
    // Deliberately makes NO claim about what survived. Whether files persist
    // depends entirely on where they were written, and a confident wrong
    // claim here is worse than silence.
    return "Your previous turn was interrupted when the environment restarted."
      + " Resume from where you left off; don't assume prior files, processes, etc. survived;"
      + " attempt to re-establish the prior setup for things that were lost, and pause to"
      + " alert me if this cannot be done easily." + tool;
  }
  if (resumable.reason === "aborted") {
    return "Your previous turn was interrupted before it finished. Resume from where you"
      + " left off, keeping what was already completed. Do not restart from the beginning."
      + tool;
  }
  return "Your previous turn was cut short by a system error"
    + (resumable.error ? `: ${resumable.error}` : "")
    + ". Everything above is what actually happened. Resume from where you left off — keep"
    + " work that is already complete, and do not start over." + tool;
}

// Provenance survives a live turn (broadcast carries `origin`, and server.py
// stores it on the log entry) but NOT a rebuild of that log from the backend
// transcript — which is exactly what a restart or a reseed forces. The
// symptom: a PEER bubble silently becomes YOU after a refresh, claiming the
// user typed something they never typed. C10 says a transcript must never be
// ambiguous about that, so it has to be recoverable, not just live.
//
// It IS recoverable, because the text the driver wrote into the transcript
// still carries its own marker — the same "[message from @x]" prefix that
// applyOrigin() strips in the browser, and the fixed resume wording from
// resumePromptFor(). Inferring from those is honest: they are the artefacts
// the driver itself produced, not a guess about user intent.
//
// Deliberately NOT stored as a sidecar keyed by message id: that would be a
// second source of truth which could disagree with the transcript, and the
// transcript is the thing the user actually reads.
function inferOriginFromText(role, text) {
  if (role !== "user" || typeof text !== "string") return null;
  // Peer and delegated-result deliveries both render as "Peer" (a settled UI
  // decision), and both are written by composeDelivery, so one pattern does
  // for both. Multi-message deliveries open with the coalesced header, which
  // names no single sender — honest to report as peer with no handle.
  const m = text.match(/^\[message from ([^\]]+)\]/);
  if (m) return `peer:${m[1]}`;
  if (/^You have \d+ messages waiting\./.test(text)) return "peer";
  // The three fixed openings from resumePromptFor(). Matched on the opening
  // clause only, because each continues with a variable tool-name tail.
  if (text.startsWith("Your previous turn was interrupted when the environment restarted.")) return "resume:restart";
  if (text.startsWith("Your previous turn was interrupted before it finished.")) return "resume:aborted";
  if (text.startsWith("Your previous turn was cut short by a system error")) return "resume:error";
  return null;
}

// ── Delivery core ────────────────────────────────────────────────────────
// One internal entry point that both surfaces sit on: `delegate` (which
// creates its target) and `message` (which addresses an existing one). The
// core owns authorization, provenance and limits; the surfaces own only
// what differs between them.
//
// Built against peer messaging's requirements first, deliberately. Peer
// messaging is the harder caller — it makes a DIFFERENT session spend tokens
// and run tools under ITS permissions — and a core shaped around the easier
// caller would have to be bent back later.
const peers = createPeers({
  file: nodePath.join(PODPROMPT_STATE_DIR, "viewer-peers.json"),
  onError: (e) => console.error("[driver] failed to write peers file:", e.message),
});
const inbox = createInbox({
  file: nodePath.join(PODPROMPT_STATE_DIR, "viewer-inbox.json"),
  onError: (e) => console.error("[driver] failed to write inbox file:", e.message),
});

// Who the driver believes the caller is. Local shims supply an identity
// their runtime guarantees — a per-turn closure on Claude Code, OpenCode's
// own `context.sessionID` — so a model never gets to assert who it is.
// A future host/remote realm plugs in here rather than anywhere else.
function localPrincipal(sessionId) {
  return { realm: LOCAL_REALM, id: sessionId };
}

// A caller id as supplied by a backend's runtime, translated into the id
// PodPrompt keys its own state by. Only OpenCode needs this: its plugin is
// handed OpenCode's own `ses_...` id, while chains, peers and relations are
// all keyed by the client id PodPrompt minted (C1). Claude Code's shim
// closes over the PodPrompt id directly, so it passes through untouched.
function podSessionIdFor(rawId) {
  if (!rawId) return null;
  if (sessions.has(rawId)) return rawId;
  const translated = backends.opencode?.clientIdForReal?.(rawId);
  return translated || rawId;
}

// Evaluated at DELIVERY time against the TARGET, never captured when the
// sender decided to send: the user may have changed the target's settings
// in between, and the newer intent is the real one.
function authorizeDelivery(from, to) {
  if (!from?.id || !to?.id) return { allowed: false, reason: "bad-principal" };
  // Fails closed. Today only local→local exists, but this stays a real
  // chokepoint so that adding a policy for other realms later is a change
  // to one function rather than a refactor.
  if (from.realm !== LOCAL_REALM || to.realm !== LOCAL_REALM) {
    return { allowed: false, reason: "realm-unreachable" };
  }
  if (from.realm === to.realm && from.id === to.id) {
    return { allowed: false, reason: "self-message" };
  }
  const peer = peers.get(to.id);
  if (peer && peer.messageable === false) return { allowed: false, reason: "not-messageable" };
  // NOTE what is deliberately absent: nothing here grants the target any of
  // the sender's privilege. A peer edge never cascades auto-approve, so the
  // target runs under exactly the posture it would have if the user had
  // typed the same text into its own box.
  return { allowed: true };
}

// A session is ready to receive only when it is doing nothing AND is not
// blocked on a human. Draining into a session that is sitting on a
// permission card would bury the card under a new turn.
function sessionIsIdle(sessionId) {
  const s = sessions.get(sessionId);
  if (s?.turnInFlight) return false;
  if (pendingKindForSession(sessionId)) return false;
  return true;
}

function describeSender(entry) {
  const handle = entry.fromHandle || peers.get(entry.from?.id)?.handle || null;
  if (handle) return entry.from?.realm === LOCAL_REALM ? `@${handle}` : `@${entry.from.realm}/${handle}`;
  return entry.from?.id || "unknown";
}

// Coalesced: N queued messages become ONE turn listing each with its
// origin. Otherwise three senders cost the target three full turns, and the
// third one answers a question the first already answered.
function composeDelivery(entries) {
  if (entries.length === 1) {
    const e = entries[0];
    return `[message from ${describeSender(e)}]\n\n${e.text}`;
  }
  const parts = entries.map((e) => `[message from ${describeSender(e)}]\n${e.text}`);
  return `You have ${entries.length} messages waiting.\n\n${parts.join("\n\n---\n\n")}`;
}

function maybeDrainInbox(sessionId, { userDirected = false } = {}) {
  if (!sessionIsIdle(sessionId)) {
    // Mail that arrives mid-turn is left QUEUED and retried when the turn
    // ends, so it never reaches the hold decision below on this pass. That
    // is correct, but it is also a second silent state — logged so the
    // timeline reads continuously rather than skipping from "sent" to
    // "delivered" with an unexplained gap in between.
    const waiting = inbox.pendingFor(sessionId).length;
    if (waiting) console.log(`[driver] mail ${sessionId}: ${waiting} msg(s) queued, session busy`);
    return false;
  }
  // Everything pending, not a per-chain slice. nextDrainGroup existed solely
  // so one chain's budget could not pay for another's work; with a single
  // global counter (AD2) there is nothing left to keep apart, and coalescing
  // the lot into one turn is strictly cheaper than one turn per sender.
  const group = inbox.pendingFor(sessionId);
  if (!group.length) return false;
  // MD1: the user is looking at this conversation, so this message would
  // spend the turn they were about to use. Held for them to decide.
  // Checked BEFORE the gate because it is the more specific condition —
  // and skipped entirely for a delivery the user explicitly asked for,
  // which is the whole point of the button.
  // Every input to the hold decision, logged once, at the point of decision.
  //
  // This exists because the logging used to be one-sided: a DELIVERY logged
  // ("drain -> ..."), a HOLD logged nothing. So the system recorded the
  // outcome you can already see on screen and stayed silent about the one
  // that needs explaining, and "why was that delivered when I was watching?"
  // could only be answered by archaeology — twice, at length, wrongly.
  // Cheap: one line per arrival of mail, not per message.
  const watched = isWatched(sessionId);
  const auto = autoDeliverFor(sessionId);
  console.log(
    `[driver] mail ${sessionId}: ${group.length} msg(s), watched=${watched}`
    + ` autoDeliver=${auto} userDirected=${userDirected}`
    + ` -> ${!userDirected && watched && !auto ? "HOLD" : "deliver"}`);
  if (!userDirected && watched && !auto) {
    for (const e of group) inbox.park(e.id, "watched");
    broadcastStatus(sessionId, { type: "inbox_changed" });
    return false;
  }
  // Parked rather than left queued, so the strip can show it as stuck. A
  // queued message is merely waiting its turn; a parked one is waiting on
  // the USER, and those must not look alike.
  if (!userDirected && autonomy.status().paused) {
    for (const e of group) inbox.park(e.id, "autonomy");
    broadcastStatus(sessionId, { type: "inbox_changed" });
    return false;
  }
  // One sender gets named; several become "peer" without a handle, since no
  // single name would be honest about a coalesced delivery.
  const senders = new Set(group.map((e) => describeSender(e)));
  const originLabel = senders.size === 1
    ? `${group[0].kind === "result" ? "result" : "peer"}:${[...senders][0]}`
    : "peer";
  const started = startTurn(sessionId, composeDelivery(group), {
    source: "peer",
    origin: originLabel,
    userDirected,
  });
  console.log(`[driver] drain -> ${sessionId}: ${group.length} msg(s), startTurn=${JSON.stringify(started)}`);
  if (!started.ok) {
    // Left queued on purpose. A refusal here is transient — the session
    // became busy between the idle check and the call — and the next idle
    // moment retries. The one NON-transient refusal, the gate being shut,
    // was already handled above by parking.
    return false;
  }
  inbox.markDelivered(group.map((e) => e.id));
  return true;
}

function drainAllInboxes() {
  for (const sessionId of inbox.sessionsWithPending()) maybeDrainInbox(sessionId);
}

// There is now exactly ONE condition a user can lift, so this is a set of
// one rather than four. Kept as a named set because the distinction it draws
// still matters: a parkable reason is something the user can press a button
// about, and anything else must fail outright rather than become permanently
// stuck garbage inflating a badge the user is supposed to trust.
const PARKABLE_REASONS = new Set(["autonomy"]);

// Releasing no longer charges anything. Under §10 the ONLY place an
// automatic turn is charged is startTurn, which every delivery goes through
// — so a release path can no longer start a turn for free, structurally,
// rather than because this function remembered to re-attempt a spend. (That
// bug was real: the first cut of /extend-chain did exactly that.)
function releaseParked(entry) {
  if (autonomy.status().paused) return { ok: false, reason: "autonomy-paused" };
  inbox.release(entry.id);
  return { ok: true };
}

// Every parked entry this condition was blocking. Used on resume and on
// extend, so a lifted condition actually moves the mail it was holding.
function releaseParkedFor(predicate) {
  const released = [];
  for (const e of inbox.stuck()) {
    if (!predicate(e)) continue;
    if (releaseParked(e).ok) released.push(e.id);
  }
  if (released.length) drainAllInboxes();
  return released;
}

// The single delivery path. Returns a RECEIPT in every case — the sender is
// always told what happened, because a silently dropped message is
// indistinguishable to a model from a peer that chose not to answer, and it
// responds to that by retrying.
function deliver(toAddr, text, { from, kind = "peer" }) {
  const resolved = peers.resolve(toAddr);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, to: toAddr };
  const to = resolved.ref;

  const auth = authorizeDelivery(from, to);
  if (!auth.allowed) return { ok: false, reason: auth.reason, to };

  const entry = inbox.enqueue({
    to, from, fromHandle: peers.get(from.id)?.handle || null, text, kind,
  });

  // Deliberately NOT charged here. §10 charges in startTurn and nowhere
  // else, which matters because sending a message and running a turn are
  // different events: the old design charged at send time for a turn that
  // might never happen, and then had to be careful not to charge again at
  // release. One charge point removes the whole class of double-spend.
  if (autonomy.status().paused) {
    // PARKED, not failed. The sender is still told immediately so it can
    // wrap up rather than wait on a reply that is not coming yet.
    inbox.park(entry.id, "autonomy");
    broadcastStatus(to.id, { type: "inbox_changed" });
    return { ok: false, reason: "autonomy-paused", parked: true, entryId: entry.id };
  }
  const deliveredNow = maybeDrainInbox(to.id);
  broadcastStatus(to.id, { type: "inbox_changed" });
  return {
    ok: true,
    entryId: entry.id,
    delivered: deliveredNow,
    queued: !deliveredNow,
    remaining: autonomy.status().remaining,
    to,
  };
}

// Every surface that represents THE USER ACTING has to do two things, not
// one: reset the counter (startTurn does that) and MOVE the mail the gate was
// holding. Splitting them was a real bug — typing a prompt opened the gate but
// left parked mail sitting there, so the system looked unblocked while the
// messages it was blocking stayed stuck. Kept out of startTurn deliberately:
// releasing drains, draining calls startTurn, and that is a loop.
function releaseAutonomyParked() {
  const released = releaseParkedFor((e) => e.parkedReason === "autonomy");
  if (released.length) drainAllInboxes();
  return released;
}

// One shape for every autonomy response, so a caller can read any of them
// the same way. /presence and /autonomy-cap previously returned a strict
// subset of /autonomy, which is the kind of difference nothing notices until
// something indexes the missing field.
function autonomySnapshot() {
  const stuck = inbox.stuck();
  return {
    ...autonomy.status(),
    defaultPauseAfter: DEFAULT_PAUSE_AFTER,
    fanoutCap: FANOUT_CAP_PER_TURN,
    maxCreationDepth: MAX_CREATION_DEPTH,
    parked: stuck.length,
    parkedSessions: [...new Set(stuck.map((e) => e.to?.id).filter(Boolean))].length,
  };
}

// ── MD1: which sessions a human is LOOKING at ───────────────────────────
// Reported by the browser per session, not inferred. Deliberately a
// heartbeat with a TTL rather than a sticky flag: a tab that crashes, is
// closed, or loses its network must not be able to hold a session's mail
// hostage forever. If the reports stop, the hold lapses and delivery
// resumes — holding is a deferral, never a state mail can die in.
//
// NOT the same thing as §10 presence, and deliberately not wired to it
// (MD2). Visibility answers "is the user looking at THIS conversation";
// the gate answers "has the user been steering anything at all". Letting a
// visible tab reset the autonomy counter would gut the gate in exactly the
// case it exists for — a browser left open on a second monitor.
const VIEWING_TTL_MS = 45 * 1000;
const viewingUntil = new Map(); // sessionId -> epoch ms

function noteViewing(sessionId, visible) {
  if (!sessionId) return;
  if (visible) viewingUntil.set(sessionId, Date.now() + VIEWING_TTL_MS);
  else viewingUntil.delete(sessionId);
}

function isWatched(sessionId) {
  const until = viewingUntil.get(sessionId);
  if (!until) return false;
  if (Date.now() > until) { viewingUntil.delete(sessionId); return false; }
  return true;
}

// MD9: does mail for this session bypass the watched gate?
//
// MD1 holds mail while you are looking at a session, on the premise that it
// would spend the turn you were about to type into. That premise conflates
// two postures: PARTICIPATING (you are about to type — holding is right) and
// SPECTATING (you are watching a worker run — holding is perverse, because
// the agent then stalls BECAUSE you are watching it). This names the
// difference. Autonomy still applies either way: an auto-delivering session
// accrues automatic turns and still pauses at the cap, and viewing is not in
// noteUserDirectedAction()'s list, so spectating never refills the budget.
//
// TRI-STATE, and resolved at read time rather than stamped at creation. A
// delegated session IS an autonomous worker, so it defaults on; an explicit
// choice either way wins. Deriving the default here (rather than writing
// `autoDeliver: true` onto new delegated children) is what makes dropping
// the default later a one-line change that applies retroactively, instead of
// leaving every existing delegated session auto-delivering forever.
function autoDeliverFor(sessionId) {
  if (!sessionId) return false;
  const explicit = sessionPrefs[sessionId]?.autoDeliver;
  if (explicit === true || explicit === false) return explicit;
  return sessionRelations[sessionId]?.childKind === "delegated";
}

// value: true | false to pin, null to clear back to the derived default.
// Returns the effective setting afterwards.
function setAutoDeliver(sessionId, value) {
  if (!sessionId) return false;
  if (value === null || value === undefined) {
    if (sessionPrefs[sessionId]) {
      delete sessionPrefs[sessionId].autoDeliver;
      if (!Object.keys(sessionPrefs[sessionId]).length) delete sessionPrefs[sessionId];
      saveSessionPrefs();
    }
  } else {
    sessionPrefs[sessionId] = { ...(sessionPrefs[sessionId] || {}), autoDeliver: !!value };
    saveSessionPrefs();
  }
  // Turning it on must free what the old setting is already holding —
  // otherwise the first thing the user sees after enabling it is the mail it
  // was supposed to stop holding, still sitting there.
  if (autoDeliverFor(sessionId)) releaseWatchedFor(sessionId);
  return autoDeliverFor(sessionId);
}

// MD7: the complete list of things that count as the user DIRECTING the
// system. Everything here is an action with intent behind it; scrolling,
// expanding a bubble and alt-tabbing are deliberately absent. Replaces the
// old blanket keydown/mousedown/focus ping, which was the weakest possible
// signal doing nearly all the work.
function noteUserDirectedAction() {
  autonomy.noteHumanAction();
  return releaseAutonomyParked();
}

// MD3. Mail held for a watcher that has gone away must move on its own —
// a closed tab or a crashed browser cannot be allowed to strand it.
function releaseWatchedFor(sessionId) {
  const released = [];
  for (const e of inbox.stuck()) {
    if (e.parkedReason !== "watched") continue;
    if (sessionId && e.to?.id !== sessionId) continue;
    if (inbox.release(e.id).ok) released.push(e.id);
  }
  if (released.length) {
    for (const id of new Set(inbox.open().map((e) => e.to?.id).filter(Boolean))) maybeDrainInbox(id);
  }
  return released;
}

// The TTL half of the same rule: a tab that simply stops reporting (closed,
// asleep, network gone) releases its hold when the heartbeat lapses. Cheap
// and only does work when something is actually held.
setInterval(() => {
  for (const [sessionId] of viewingUntil) {
    if (!isWatched(sessionId)) releaseWatchedFor(sessionId);
  }
}, 15 * 1000).unref?.();

// ── Delegation anchors: where in the parent the delegation happened ─────
// The child's "Delegated" label links back to the exact bubble in the
// parent's feed that created it. Both backends key that bubble by the
// tool call's own id, so the anchor is the same kind of thing either way —
// what differs is WHEN it can be learned.
//
//   claude-code: captured at call time from _meta["claudecode/toolUseId"].
//   opencode:    its ToolContext exposes sessionID and messageID but NO
//                per-call id, so the plugin cannot know it. The driver
//                recovers it downstream instead, by matching the delegate
//                tool part streaming back from the parent against the
//                prompt we delegated with. Deterministic, not timing-based.
//
// Doing the work here rather than accepting a degraded OpenCode path is
// deliberate: a link that silently behaves differently depending on which
// backend the parent happens to run is the kind of inconsistency that makes
// a feature feel unreliable rather than merely limited.
const pendingDelegateAnchors = new Map(); // parentSessionId -> [{ childId, prompt }]

function expectDelegateAnchor(parentSessionId, childId, prompt) {
  if (!parentSessionId || !childId) return;
  const list = pendingDelegateAnchors.get(parentSessionId) || [];
  list.push({ childId, prompt: String(prompt || "").slice(0, 400) });
  // Bounded: a parent that somehow never emits a matching part must not
  // grow this list forever.
  while (list.length > 16) list.shift();
  pendingDelegateAnchors.set(parentSessionId, list);
}

// Called by the opencode backend for every tool part it renders. Cheap: one
// map lookup, and an immediate return when this session has no delegation
// waiting to be matched.
function noteDelegateAnchor(parentSessionId, part) {
  const list = pendingDelegateAnchors.get(parentSessionId);
  if (!list?.length || !part?.id) return;
  const prompt = part.state?.input?.prompt;
  if (typeof prompt !== "string") return;
  const key = prompt.slice(0, 400);
  const i = list.findIndex((e) => e.prompt === key);
  if (i === -1) return;
  const { childId } = list[i];
  list.splice(i, 1);
  if (!list.length) pendingDelegateAnchors.delete(parentSessionId);
  const rel = sessionRelations[childId];
  if (!rel) return;
  sessionRelations[childId] = { ...rel, native: { ...(rel.native || {}), toolUseId: part.id } };
  saveSessionRelations();
}

// What the child's Delegated label needs: which session to open, and which
// bubble to land on. Returned by /turn-status — a DIRECT driver-to-browser
// route — rather than threaded through the transcript, server.py's seed and
// the SSE replay, which are precisely the hops that have silently dropped a
// new field twice in this branch.
function delegationAnchorFor(sessionId) {
  const rel = sessionRelations[sessionId];
  if (!rel || rel.childKind !== "delegated") return null;
  const parentSessionId = rel.createdBy || rel.parent;
  if (!parentSessionId) return null;
  return { parentSessionId, bubbleId: rel.native?.toolUseId || null };
}

// ── Tool logic, shared by both backends ──────────────────────────────────
// ONE implementation. Claude Code reaches these through an in-process SDK
// MCP server built per turn; the OpenCode plugin reaches the same functions
// over HTTP. Two thin shims, not two implementations — the alternative is
// the drift this project keeps getting bitten by.
function relationTo(fromSessionId, otherId) {
  if (parentOfSession(otherId) === fromSessionId) return "child";
  if (parentOfSession(fromSessionId) === otherId) return "parent";
  return "none";
}

async function toolListPeers(fromSessionId, { search = null, limit = null, all = false } = {}) {
  const { allSessions } = await gatherAllSessions(false);
  // The caller needs a handle too, so its name is already correct in the
  // provenance of anything it sends.
  peers.ensure(fromSessionId, { backend: sessionIdToBackend.get(fromSessionId) || null });
  const rows = [];
  for (const s of allSessions) {
    if (s.archived || s.unreachable) continue;
    if (s.sessionId === fromSessionId) continue; // no self-addressing
    const rec = peers.ensure(s.sessionId, {
      title: s.customTitle || s.summary || s.firstPrompt || null,
      backend: s.backend,
    });
    rows.push({
      handle: `@${rec.handle}`,
      realm: rec.realm,
      backend: s.backend,
      title: rec.title,
      lastModified: s.lastModified || null,
      messageable: rec.messageable !== false,
      // Lets a model knowingly choose to queue rather than discover the
      // target was busy only from a receipt.
      state: s.inFlight ? "in-turn" : (s.pendingKind ? "blocked-on-approval" : "idle"),
      relation: relationTo(fromSessionId, s.sessionId),
      // A peer whose last turn died. Surfaced because the most useful thing
      // a parent can do with a stalled child is restart it, and it cannot
      // decide to do that without knowing.
      stalled: (() => {
        const r = resumableFor(s.sessionId);
        return r ? { reason: r.reason, at: r.at, lastTool: r.lastTool || null } : null;
      })(),
      // Addressable, but marked: a sub-agent its parent is blocking on will
      // queue your message behind that delegation, and what the parent
      // receives is unaffected by it.
      subAgent: isRosterChild(s.sessionId),
    });
  }
  // Most recently active first: a live container can easily hold dozens of
  // sessions — the first real run of this returned 45 — and the handful
  // worth talking to are almost always the recent ones.
  rows.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

  const total = rows.length;
  const needle = search ? String(search).toLowerCase() : null;
  const matched = needle
    ? rows.filter((r) => r.handle.toLowerCase().includes(needle)
        || (r.title || "").toLowerCase().includes(needle))
    : rows;

  // PAGING, not truncation. The default keeps the common call cheap, but
  // every peer stays reachable through `search` or `all` — and the result
  // always says how many were held back. A model that cannot see a peer
  // cannot decide to talk to it, and would have no idea it was missing.
  const cap = all ? matched.length : Math.max(1, Math.min(limit || PEER_LIST_DEFAULT, PEER_LIST_MAX));
  const shown = matched.slice(0, cap);
  return {
    peers: shown,
    shown: shown.length,
    matched: matched.length,
    total,
    truncated: shown.length < matched.length,
    search: search || null,
  };
}

const PEER_LIST_DEFAULT = 20;
const PEER_LIST_MAX = 200;

function toolMessage(fromSessionId, { to, text, kind = "peer", resume = false }) {
  const state = sessions.get(fromSessionId);
  // No chain check any more: §10 asks "is this turn allowed to start" in
  // startTurn, once, for every automatic turn however it arises. Guarding
  // here as well would have been a second gate measuring a different thing.
  //
  // Breadth is still checked here, and still BEFORE anything is charged: the
  // counter bounds how long a cascade runs, not how wide a single turn fans
  // out, and width is where the expensive failure lives.
  const fan = noteFanout(state);
  if (!fan.ok) return { ok: false, reason: fan.reason, cap: fan.cap };
  // A session's FIRST outbound message necessarily happens before it has a
  // title, so its handle would otherwise be the provisional fallback and the
  // recipient would see "@session". The prompt that started this work is the
  // same string a chain used to be named after, and is exactly the kind of
  // name a session title would have ended up with anyway.
  peers.ensure(fromSessionId, {
    backend: sessionIdToBackend.get(fromSessionId) || null,
    title: peers.get(fromSessionId)?.title || state?.rootPromptText || null,
  });
  let body = text;
  if (resume) {
    // The same wording the Continue button uses, chosen from the TARGET's
    // own failure — a parent should not have to invent it, and a generic
    // "carry on" loses the part that matters (what actually went wrong).
    const resolved = peers.resolve(to);
    const targetId = resolved.ok ? resolved.ref.id : null;
    const resumable = targetId ? resumableFor(targetId) : null;
    if (!resumable) return { ok: false, reason: "not-stalled", to };
    const canned = resumePromptFor(resumable);
    // Custom text is preserved, not replaced: the parent usually knows
    // something the boilerplate does not.
    body = text && text.trim() ? `${canned}\n\n${text}` : canned;
  }
  return deliver(to, body, {
    from: localPrincipal(fromSessionId),
    kind,
  });
}

// The steer, owned here so both backends say the same thing. Only the tool
// NAMES differ between them — Claude Code sees mcp__podprompt__ prefixes,
// OpenCode sees bare names — so the prefix is a parameter rather than an
// excuse to keep two copies of the paragraph.
//
// Why it exists at all: Claude Code ships always-present SendMessage and
// ListAgents addressing the HARNESS's agents, and MCP tools sit behind tool
// search, so without this the model never saw ours to choose them. OpenCode
// has no such competitor and its tools are always visible, but it gets the
// same text for symmetry and for the delegate_session steer.
function messagingSystemPrompt({ prefix = "" } = {}) {
  const t = (name) => `${prefix}${name}`;
  return [
    "PodPrompt environment.",
    "",
    "This session runs inside PodPrompt, which shows the user a list of chat sessions."
    + " Other sessions are reachable from here and are addressed by @handle.",
    "",
    "Four tools act on PodPrompt sessions:",
    `  ${t("list_sessions")}    — find another session's @handle`,
    `  ${t("message_session")}  — send a message to one`,
    `  ${t("delegate_session")} — create a NEW session on a chosen backend`
    + " (claude-code or opencode) and give it work",
    `  ${t("read_session")}     — read a session's transcript, including your own`,
    "",
    // Framed by WHEN each route is right, never by what each is not. An
    // earlier draft said "a PodPrompt session is not a sub-agent", which
    // breaks on the entirely natural "spawn a DeepSeek sub-agent using
    // OpenCode" — there the user says sub-agent and means this tool.
    `Prefer ${t("delegate_session")} for work you would otherwise hand to a sub-agent. It can`
    + " run on a different backend or model than yours, and it is asynchronous by default:"
    + " your turn ends immediately and the result arrives later as a message, so neither you"
    + " nor the user waits on it. Spawn an ordinary sub-agent with your usual tools instead"
    + " when the work is quick and you need its answer within this turn;"
    + ` ${t("delegate_session")} also accepts await=true for that case. If the user says`
    + ' "sub-agent" while naming another backend or model, they mean'
    + ` ${t("delegate_session")}.`,
    "",
    "When the user refers to another session or chat, mentions an @handle, or asks you to"
    + ` message, ask or tell one, use ${t("list_sessions")} to find it and`
    + ` ${t("message_session")} to reach it. If your harness provides its own tools for`
    + " listing or messaging ITS agents, those are unrelated to PodPrompt sessions and are"
    + " not a substitute for these.",
    "",
    // Answers "must it look up every time?" — no. Re-listing per send would
    // cost a round trip each time, and caching is safe because a stale
    // handle fails loudly: delivery returns unknown-handle, which says to
    // list again.
    "You only need to look a handle up once per conversation. Reuse handles you have already"
    + " looked up; if one stops resolving, list again to get the current set.",
    "",
    // The one case the free mechanisms cannot reach. delegate_session's own
    // output advertises read_session for inspecting a CHILD, which is where
    // that need arises — but nothing advertises reading your OWN transcript,
    // and a model asked to recall something from earlier will reach for
    // files or its context rather than suspect a transcript tool exists.
    `${t("read_session")} also reads THIS session: if you need something said earlier that you`
    + " no longer have — because the conversation is long or was compacted — read your own"
    + ' transcript with session="me" and a search term rather than guessing or asking again.',
  ].join("\n");
}

function parentBackendId(sessionId) {
  return sessionIdToBackend.get(sessionId) || null;
}

// Resolve a requested model id against a backend's real list, for
// delegation's SELF-TEACHING rejection. Nothing in this environment tells a
// model what ids a backend accepts: there is no list_models tool, no mention
// of the driver or its /models route in any system prompt, and the two
// backends' id shapes do not rhyme ("sonnet" vs "opencode/iceman-free"), so
// guessing from training priors cannot work. Rather than add a tool nobody
// would think to call, the FIRST wrong guess is answered with the whole list
// — the error message is the documentation, and it arrives exactly when it is
// needed.
//
// Matching is case-insensitive and returns the canonical id, because "Sonnet"
// is a typo rather than a thing worth teaching.
//
// Fails OPEN when the backend cannot answer: an unreachable `opencode serve`
// or an unwarmed model cache is a backend problem, and refusing a delegation
// over it would be a worse failure than forwarding an id the backend will
// judge for itself.
async function resolveModelId(backendId, wanted) {
  const backend = backends[backendId];
  if (!backend || typeof backend.listModels !== "function") return { ok: true, id: wanted };
  let available = [];
  try {
    const info = await backend.listModels(null);
    available = (info?.available || []).map((m) => m && m.id).filter(Boolean);
  } catch {
    return { ok: true, id: wanted };
  }
  if (!available.length) return { ok: true, id: wanted };
  const exact = available.find((id) => id === wanted);
  if (exact) return { ok: true, id: exact };
  const ci = available.find((id) => id.toLowerCase() === wanted.toLowerCase());
  if (ci) return { ok: true, id: ci };
  return { ok: false, available };
}

// delegate: create a child session on a named backend and give it work.
// Always CREATES — addressing an existing session is `message`. Keeping that
// boundary sharp is what stops the parent-edge semantics from going
// ambiguous, since a parent edge grants privilege and a peer edge does not.
// awaitResult defaults to FALSE — amends PD5, which chose blocking because it
// matched native Task and the models are trained on that shape. Two things
// changed the balance: the parent's turn ending immediately means the user is
// not held hostage to a child's runtime, and a blocking delegate's waiter is
// IN-MEMORY, so a driver restart loses the result entirely while the async
// path returns it through the durable inbox. Async is the more robust default,
// not merely the more parallel one.
async function toolDelegate(fromSessionId, { backend, prompt, title, awaitResult = false, model = null, toolUseId = null }) {
  const state = sessions.get(fromSessionId);
  if (!backends[backend]) return { ok: false, reason: "unknown-backend", backend };
  if (!String(prompt || "").trim()) return { ok: false, reason: "empty-prompt" };

  // Checked against the TARGET backend (a model id means nothing to the
  // other one) and BEFORE noteFanout, so a wrong guess costs nothing but the
  // round trip — the whole point is that guessing is the intended way to
  // find out, so it must be cheap to be wrong. See resolveModelId.
  let wantModel = model === null || model === undefined ? "" : String(model).trim();
  if (wantModel) {
    const resolved = await resolveModelId(backend, wantModel);
    if (!resolved.ok) {
      return {
        ok: false, reason: "unknown-model",
        backend, model: wantModel, available: resolved.available,
      };
    }
    wantModel = resolved.id;
  }

  // Breadth before depth: the counter bounds how long a cascade runs, not
  // how wide it goes, and width is where the expensive failure lives.
  const fan = noteFanout(state);
  if (!fan.ok) return { ok: false, reason: fan.reason, cap: fan.cap };
  // Counted along creation lineage, so detaching cannot reset it (HD6).
  if (creationDepthExceeded(fromSessionId)) {
    return { ok: false, reason: "depth-cap", max: MAX_CREATION_DEPTH };
  }
  // Checked, not charged. The child's turn is charged by its own startTurn
  // below — charging here too would bill one delegation twice. Reported up
  // front anyway so the model is told plainly rather than having the child
  // silently fail to start.
  if (autonomy.status().paused) {
    return { ok: false, reason: "autonomy-paused" };
  }

  // PodPrompt mints the id (C1). The opencode backend expects its client
  // ids to be distinguishable from its own ses_... ids.
  const childId = backend === "opencode" ? `oc-${randomUUID()}` : randomUUID();
  const childTitle = String(title || prompt).slice(0, 80);

  // The parent has to be addressable for its own child's report to reach
  // it in the async case.
  peers.ensure(fromSessionId, {
    backend: parentBackendId(fromSessionId),
    title: peers.get(fromSessionId)?.title || state?.rootPromptText || null,
  });
  registerChildSession(childId, {
    parent: fromSessionId,
    backend,
    // Distinct from "native-task": a delegated child is a REAL session on
    // its backend, which is why promotion needs no seeding for it.
    childKind: "delegated",
    description: childTitle,
    createdBy: fromSessionId,
    // HD2/HD3: which of the PARENT's turns this delegation belongs to, and
    // whether that turn is blocked on it. Only an awaited delegation is
    // something the parent's Stop should reach — an async one outlives the
    // turn that made it, which is precisely the Monday-delegation/
    // Tuesday-Stop failure HD2 exists to remove.
    parentTurnId: awaitResult ? (state?.turnId || null) : null,
    awaitedByParentTurn: !!awaitResult,
    // Null on OpenCode, which has no per-call id to give us. Stored under
    // `native` alongside the backends' own ids because it is exactly that:
    // the spawning call's identity in the parent's transcript.
    ...(toolUseId ? { native: { toolUseId } } : {}),
  });
  peers.ensure(childId, { title: childTitle, backend });
  // OpenCode cannot tell us the call id up front, so arm the match now and
  // let noteDelegateAnchor() fill it in when the part streams back.
  if (!toolUseId) expectDelegateAnchor(fromSessionId, childId, prompt);

  // C7: a model id means nothing to another backend, so it is only carried
  // across when the backends match. Otherwise the child takes its own
  // backend's default.
  const parentBackend = sessionIdToBackend.get(fromSessionId) || null;
  const inherited = (!wantModel && parentBackend === backend) ? state?.model : null;
  const chosenModel = wantModel || inherited || null;
  if (chosenModel) preSeeds.set(childId, { ...(preSeeds.get(childId) || {}), model: chosenModel });

  // Auto-approve is NOT set here: it resolves through the parent edge at
  // decision time (autoApproveForSession), so a child is exactly as
  // privileged as its parent and follows it if the user changes their mind
  // mid-task.
  // Registered BEFORE the turn starts, for both paths. Attaching afterwards
  // races a child that finishes quickly: the waiter would be added after
  // the resolve had already fired, and a blocking delegate would hang
  // forever on a turn that was already over.
  // Unbound on purpose: registered BEFORE startTurn, so the turn it wants
  // has no id yet. See awaitTurnEnd — "the next turn for this session" is
  // the only thing that can be meant at this point, and it is correct here
  // because the child session is brand new and cannot already be running.
  const waiter = awaitTurnEnd(childId);
  const started = startTurn(childId, prompt, {
    source: "delegate",
    origin: `delegate:@${peers.get(fromSessionId)?.handle || fromSessionId}`,
    backendId: backend,
  });
  if (!started.ok) {
    return { ok: false, reason: started.reason, childId };
  }

  const handle = `@${peers.get(childId)?.handle || childId}`;
  if (!awaitResult) {
    // Async: the parent's turn ends now and the child's report arrives later
    // as an ordinary inbox delivery. This costs almost nothing because peer
    // messaging already built that wake path.
    watchDelegateForReport(waiter, childId, fromSessionId);
    return { ok: true, handle, childId, awaited: false, remaining: autonomy.status().remaining };
  }

  const outcome = await waiter;
  const text = await finalAssistantText(childId);
  return {
    ok: true, handle, childId, awaited: true,
    outcome: outcome?.reason || "completed",
    text, remaining: autonomy.status().remaining,
  };
}

// Reads the child's own transcript rather than tapping the stream: the
// backends already store it, and whatever is on disk is what the user will
// see when they open the child, so the parent cannot be told something the
// transcript disagrees with.
async function finalAssistantText(childId) {
  try {
    const st = sessions.get(childId);
    const backend = st?.backend || getBackend(sessionIdToBackend.get(childId) || "claude-code");
    const history = await backend.getSessionHistory(childId, st?.cwd, sessionRelations[childId] || null);
    if (!Array.isArray(history)) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === "assistant" && history[i].text) return history[i].text;
    }
    return null;
  } catch (e) {
    console.error(`[driver] could not read delegated child ${childId} transcript:`, e.message);
    return null;
  }
}

// Async delegation: when the child finishes, its report is delivered to the
// parent as an ordinary inbox entry — kind "result" rather than "peer", so
// the two stay distinguishable in storage even though they render alike.
function watchDelegateForReport(waiter, childId, parentId) {
  waiter.then(async (outcome) => {
    const text = await finalAssistantText(childId);
    const handle = peers.get(childId)?.handle || childId;
    // Advertises read_session exactly where it becomes relevant: the parent
    // has just received a summary and may want the working that produced it.
    // Cheaper and better targeted than a system-prompt clause.
    const body = (text
      ? `Delegated work finished (${outcome?.reason || "completed"}):\n\n${text}`
      : `Delegated work ended with no output (${outcome?.reason || "completed"}).`)
      + `\n\n(For detail it left out, read its transcript: read_session session="@${handle}",`
      + ` search="...".)`;
    const receipt = deliver(parentId, body, {
      from: localPrincipal(childId),
      kind: "result",
    });
    if (!receipt.ok) {
      console.error(`[driver] delegated report from @${handle} not delivered: ${receipt.reason}`);
    }
  }).catch((e) => console.error(`[driver] delegate watcher failed for ${childId}:`, e.message));
}

// read_session: retrospective access to a session's transcript, including
// the caller's own.
//
// Why it exists: the only information a parent gets back from a delegated
// child is its FINAL reply, and the only thing a peer gets is what was
// messaged. Anything learned along the way is lost unless it was anticipated
// when the prompt was written — which is exactly when it is not. Search
// after the fact is the fix.
//
// Why search rather than citation: a model never sees its own message ids,
// so it cannot say "see message 7 of mine". It can only describe what it
// did, and the reader greps for it.
const READ_DEFAULT_LIMIT = 10;
const READ_MAX_LIMIT = 25;
const READ_ENTRY_CHARS = 1500;

async function historyFor(sessionId) {
  const st = sessions.get(sessionId);
  const backend = st?.backend
    || getBackend(sessionIdToBackend.get(sessionId) || defaultBackendId());
  // ALWAYS deep, regardless of the viewer's display setting. This is the
  // tool whose whole purpose is recovering what was lost; a version of it
  // that silently answers "nothing found" when the answer exists would be
  // worse than not having it. The setting governs rendering, not retrieval.
  const hist = await backend.getSessionHistory(
    sessionId, st?.cwd, sessionRelations[sessionId] || null, { deep: true });
  return Array.isArray(hist) ? hist : [];
}

async function toolReadSession(fromSessionId, {
  session, search = null, from = null, last = null, role = null, limit = null,
} = {}) {
  // "me" is the compaction-repair path: a session re-reading its own earlier
  // turns after they have been summarised away.
  const self = !session || session === "me" || session === "self";
  let targetId = fromSessionId;
  if (!self) {
    const resolved = peers.resolve(session);
    if (!resolved.ok) return { ok: false, reason: resolved.reason, session };
    if (resolved.ref.realm !== LOCAL_REALM) return { ok: false, reason: "realm-unreachable" };
    targetId = resolved.ref.id;
    // Reading is interaction, so the same fence applies. A user who turned a
    // session off from other sessions did not mean "except for reading".
    const peer = peers.get(targetId);
    if (peer && peer.messageable === false) return { ok: false, reason: "not-messageable", session };
  }

  let history;
  try {
    history = await historyFor(targetId);
  } catch (e) {
    return { ok: false, reason: "unreadable", error: e.message };
  }

  // Numbered over the FULL history before any filtering, so an index means
  // the same thing across calls with different filters — otherwise `from=12`
  // would silently refer to a different entry each time.
  const all = history.map((h, i) => ({
    n: i + 1,
    role: h.role || "assistant",
    ts: h.ts || null,
    text: String(h.text ?? ""),
  })).filter((e) => e.text.trim());

  let rows = all;
  if (role) rows = rows.filter((e) => e.role === role);
  const needle = search ? String(search).toLowerCase() : null;
  if (needle) rows = rows.filter((e) => e.text.toLowerCase().includes(needle));

  const matched = rows.length;
  const cap = Math.max(1, Math.min(Number(limit) || READ_DEFAULT_LIMIT, READ_MAX_LIMIT));

  let shown;
  if (from !== null && from !== undefined) {
    const start = Math.max(1, Number(from) || 1);
    shown = rows.filter((e) => e.n >= start).slice(0, cap);
  } else if (last !== null && last !== undefined) {
    shown = rows.slice(-Math.max(1, Math.min(Number(last), READ_MAX_LIMIT)));
  } else {
    // No position given: the tail, which is the right guess for "what just
    // happened" and the WRONG one for "what did they say at the start" —
    // hence the header below, which hands the caller the coordinates to ask
    // again properly.
    shown = rows.slice(-cap);
  }
  shown = shown.map((e) => ({
    ...e,
    text: e.text.length > READ_ENTRY_CHARS
      ? `${e.text.slice(0, READ_ENTRY_CHARS)}\n… [entry truncated]`
      : e.text,
  }));

  return {
    ok: true,
    session: self ? "me" : session,
    handle: peers.get(targetId)?.handle || null,
    total: all.length,
    matched,
    shown: shown.length,
    firstShown: shown.length ? shown[0].n : null,
    lastShown: shown.length ? shown[shown.length - 1].n : null,
    search: search || null,
    role: role || null,
    entries: shown,
  };
}

// Rendered once, here, so both shims print the same thing. The header is the
// load-bearing part: it gives the caller the coordinate system, which is what
// makes a second, targeted call possible instead of blind paging.
function renderReadSession(result) {
  if (!result.ok) {
    return ({
      "unknown-handle": `No session called ${result.session}. Use list_sessions to see who exists.`,
      "unknown-realm": `No such realm in ${result.session}.`,
      "bad-address": `"${result.session}" is not a valid session address.`,
      "not-messageable": `${result.session} has inter-session access turned off.`,
      "realm-unreachable": "Only local sessions can be read.",
      unreadable: `Could not read that session: ${result.error}`,
    })[result.reason] || `Could not read that session (${result.reason}).`;
  }
  const who = result.session === "me" ? "This session" : `@${result.handle || result.session}`;
  if (!result.total) return `${who} has no readable transcript yet.`;
  if (!result.shown) {
    return result.search
      ? `${who}: nothing matches "${result.search}" in ${result.total} entries.`
      : `${who}: nothing to show.`;
  }
  // Filters are named, and the count is stated separately from the entry
  // RANGE: with a filter applied the two differ (entries 1 and 3 are "2
  // entries, numbers 1–3"), and printing only the range reads as a count.
  const filters = [];
  if (result.search) filters.push(`matching "${result.search}"`);
  if (result.role) filters.push(`of kind ${result.role}`);
  const scope = filters.length
    ? `${result.matched} of ${result.total} entries ${filters.join(", ")}`
    : `${result.total} entries`;
  const range = result.firstShown === result.lastShown
    ? `entry ${result.firstShown}`
    : `entries ${result.firstShown}–${result.lastShown}`;
  const header = `${who}: ${scope}. Showing ${result.shown} (${range}).`
    + `\nNumbers are positions in the full transcript. Use from= to read earlier,`
    + ` search= to find specific text, role= to filter.`;
  const body = result.entries
    .map((e) => `\n[${e.n}] ${e.role}${e.ts ? ` · ${e.ts}` : ""}\n${e.text}`)
    .join("\n");
  return `${header}\n${body}`;
}

// What the model actually reads back. Every outcome is stated plainly,
// including the refusals: a receipt a model cannot interpret gets retried.
function describeReceipt(receipt, to) {
  if (receipt.ok) {
    const where = receipt.delivered ? "delivered now" : "queued (recipient is busy)";
    const left = receipt.remaining === null ? "no step limit" : `${receipt.remaining} steps left`;
    return `Message ${where} to ${to}. ${left}.`;
  }
  if (receipt.reason === "depth-cap") {
    return `Delegation refused: already ${receipt.max} levels deep. Do the work here instead.`;
  }
  if (receipt.reason === "unknown-backend") {
    return `No backend called "${receipt.backend}". Use "claude-code" or "opencode".`;
  }
  if (receipt.reason === "empty-prompt") return "Delegation needs a prompt describing the work.";
  // The one rejection that is meant to be USEFUL rather than merely correct:
  // the valid ids are not discoverable anywhere else, so they ride back on
  // the error. Phrased as a retry instruction because the caller is a model
  // that just guessed and can immediately guess right.
  if (receipt.reason === "unknown-model") {
    const list = (receipt.available || []).join(", ");
    return `No model called "${receipt.model}" on ${receipt.backend}.`
      + (list
        ? ` The ids it accepts are: ${list}. Call delegate_session again with one of those`
          + ` as model, or omit model to use the default.`
        : ` Omit model to use the default.`);
  }
  const why = {
    "unknown-handle": `No peer called ${to} in this realm. Use list_sessions to see who exists.`,
    "unknown-realm": `No such realm in ${to}. Only local peers are reachable right now.`,
    "bad-address": `"${to}" is not a valid address. Use a handle like @researcher.`,
    "self-message": "A session cannot message itself.",
    "not-messageable": `${to} has messaging turned off.`,
    "no-chain": "This turn has no budget to spend, so it cannot cause other sessions to run.",
    "not-stalled": `${to} did not end abnormally, so there is nothing to resume. Send it instructions instead.`,
    "fanout-cap": `Too many messages and delegations in one turn (limit ${receipt.cap}).`,
    "no-such-chain": "The work this turn belongs to no longer exists.",
    steps: `Out of steps. The message is parked; the user can extend the budget to release it. Do not retry.`,
    deadline: `Past the deadline for this work. The message is parked; the user can extend it to release it. Do not retry.`,
    global: `Automatic delivery is paused. The message is parked and will be delivered when the user resumes. Do not retry.`,
    chain: `This piece of work is paused. The message is parked until the user resumes it. Do not retry.`,
  }[receipt.reason];
  return why || `Message not delivered (${receipt.reason}).`;
}

// ── Creation lineage ─────────────────────────────────────────────────────
// Deliberately separate from parentOfSession/depthOfSession. The parent edge
// describes what a session may INHERIT (privilege, cascade) and promotion
// severs it on purpose. createdBy describes where a session CAME FROM, and
// nothing severs that.
//
// Promotion changes what a session may inherit, not where it came from.
function createdByOfSession(sessionId) {
  const r = sessionRelations[sessionId];
  if (!r) return null;
  // Records written before createdBy existed: a parent-edge child was, by
  // definition, created by its parent.
  return r.createdBy || (r.rel === "parent" ? r.parent : null);
}

function creationDepthOfSession(sessionId) {
  let depth = 0;
  let cur = sessionId;
  const seen = new Set([cur]);
  while (true) {
    const origin = createdByOfSession(cur);
    if (!origin || seen.has(origin)) return depth;
    seen.add(origin);
    cur = origin;
    depth += 1;
    if (depth > 1000) return depth; // corrupt sidecar; do not hang
  }
}

function creationDepthExceeded(parentSessionId) {
  return creationDepthOfSession(parentSessionId) + 1 > MAX_CREATION_DEPTH;
}

// Per-TURN fan-out, tracked on the session's live state rather than the
// chain: it bounds breadth at the moment of spawning, which is a different
// question from how much a chain has left overall.
function noteFanout(state) {
  if (!state) return { ok: false, reason: "no-session" };
  state.fanoutThisTurn = (state.fanoutThisTurn || 0) + 1;
  if (state.fanoutThisTurn > FANOUT_CAP_PER_TURN) {
    return { ok: false, reason: "fanout-cap", cap: FANOUT_CAP_PER_TURN };
  }
  return { ok: true, used: state.fanoutThisTurn, cap: FANOUT_CAP_PER_TURN };
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

// Minted per driver start, never written to disk, rotating on every restart.
// It is how the OpenCode plugin identifies itself as a local-realm caller —
// see PD10: the driver's routes are otherwise reachable by anything in the
// container, including the agents those routes are meant to restrain.
const PODPROMPT_TOKEN = randomUUID();

// OpenCode only auto-discovers plugins from its own plugin directories —
// verified live (1.18.30): a plugin listed in the config `plugin` array is
// reported back by /config but never actually loaded, and its tools never
// reach the model. OPENCODE_CONFIG does merge with the user's own config
// (their providers and plugins survive), but merging a path in is not the
// same as loading it.
//
// So the plugin is INSTALLED into OpenCode's global plugin directory. That
// directory is shared with the user's own OpenCode, including native
// non-Docker installs on this host, which is why the plugin registers no
// tools at all unless PODPROMPT_DRIVER_URL is set below. Outside PodPrompt
// it is inert.
function opencodeConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR
    || nodePath.join(process.env.XDG_CONFIG_HOME || nodePath.join(os.homedir(), ".config"), "opencode");
}
const OPENCODE_PLUGIN_SRC = nodePath.join(
  nodePath.dirname(new URL(import.meta.url).pathname), "opencode-plugin.ts");
const OPENCODE_PLUGIN_DEST = nodePath.join(opencodeConfigDir(), "plugin", "podprompt.ts");

function installOpencodePlugin() {
  try {
    if (!existsSync(OPENCODE_PLUGIN_SRC)) {
      // Deploy skew: an older viewer/ copy without the plugin. Say so once
      // and carry on — opencode still works, it just has no peer tools.
      console.error(`[driver] opencode plugin missing at ${OPENCODE_PLUGIN_SRC};`
        + " opencode sessions will have no messaging tools (re-run --deploy-viewer)");
      return false;
    }
    const src = readFileSync(OPENCODE_PLUGIN_SRC, "utf8");
    let current = null;
    try { current = readFileSync(OPENCODE_PLUGIN_DEST, "utf8"); } catch { /* not installed yet */ }
    if (current === src) return true; // already current; don't churn the file
    mkdirSync(nodePath.dirname(OPENCODE_PLUGIN_DEST), { recursive: true });
    writeFileSync(`${OPENCODE_PLUGIN_DEST}.tmp`, src);
    renameSync(`${OPENCODE_PLUGIN_DEST}.tmp`, OPENCODE_PLUGIN_DEST);
    console.log(`[driver] installed opencode messaging plugin -> ${OPENCODE_PLUGIN_DEST}`);
    return true;
  } catch (e) {
    console.error("[driver] failed to install opencode plugin:", e.message);
    return false;
  }
}

function spawnOpencode() {
  const args_ = ["serve", "--hostname", "127.0.0.1", "--port", String(args.opencodePort)];
  console.log(`[driver] spawning opencode serve on port ${args.opencodePort}`);
  installOpencodePlugin();
  const child = spawn("opencode", args_, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Both of these are what switch the plugin on. Without them it
      // registers nothing, which is what keeps the user's own OpenCode
      // unaffected by a file PodPrompt put in their config directory.
      PODPROMPT_DRIVER_URL: `http://127.0.0.1:${args.port}`,
      PODPROMPT_TOKEN,
    },
  });
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

// Any turn still marked in-flight belonged to the previous process and died
// with it. Promote those to resumable BEFORE anything can start a new turn
// and overwrite the marker.
reconcileTurnStateOnStartup();

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

// ── Session → backend resolution (no more guessing) ──────────────────────
// A session's backend is fixed for its whole lifetime, but `sessions` above
// only knows about sessions THIS process has itself touched since it
// started — every pre-existing session (the common case after any container
// restart) needs its real backend resolved some other way, or every
// session-scoped route risks silently guessing wrong. This used to fall
// back to the CLI's --backend default when neither the in-memory state nor
// the caller's request happened to know better — exactly the bug behind the
// "restarted container, existing session shows the wrong backend" reports:
// a resumed session could get permanently mis-pinned to that guess the
// moment anything (e.g. /prompt racing the browser's own not-yet-loaded
// /sessions data) called getSessionState() before ever passing an explicit
// backend, with no way to correct it short of a full container restart.
//
// Fixed by resolving instead of guessing: every backend's listSessions()
// already tags each session with its real owning backend (that's how
// /sessions merges them for the browser's own sessionBackends map) — this
// is just a cache of that same data, so a session's backend is *known*, not
// inferred, the moment it's ever been listed once. Warmed eagerly at
// startup below and refreshed on every real /sessions poll, so it's
// normally populated well before the first request that needs it —
// including through opencode's several-second cold start, the likeliest
// real trigger for the old bug. A session id that's in neither `sessions`
// nor this cache is either brand new (always arrives with an explicit
// backend from the new-chat picker — see getSessionState) or has never once
// been listed by anything this driver has done — the only remaining case
// that still falls through to defaultBackendId().
const sessionIdToBackend = new Map(); // sessionId -> backend id

// Shared by the /sessions route and the cache warm-up/refresh below — one
// place that fans out to every backend's listSessions() and folds the
// per-backend-failure bookkeeping (backendSessionsFailing) in, so neither
// caller has to duplicate it.
async function gatherAllSessions(includeUnreachable) {
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
      backendSessionsFailing.add(id);
      console.error(`[driver] /sessions: backend "${id}" failed:`, r.reason?.message);
    }
  });
  const allSessions = perBackend.flatMap((r) => r.sessions);
  for (const s of allSessions) sessionIdToBackend.set(s.sessionId, s.backend);
  const unreachableCount = perBackend.reduce((sum, r) => sum + (r.unreachableCount || 0), 0);
  const unreachableSessions = includeUnreachable
    ? perBackend.flatMap((r) => r.unreachableSessions || [])
    : undefined;
  return { allSessions, unreachableCount, unreachableSessions };
}

// Eager warm-up so the cache is populated before the first browser-driven
// /sessions call, not just after it — closes the exact race the old bug
// lived in. Unawaited: a slow/failing backend at startup must not delay the
// server binding its port; gatherAllSessions already treats a failing
// backend as a normal, self-healing, log-once condition.
gatherAllSessions(false).catch((e) => console.error("[driver] startup session-backend warm-up failed:", e.message));

// Pre-prompt picker changes for sessions that have no driver state yet (the
// "new chat" case, or a session this process hasn't touched this run). A
// real SessionState must never be created just to remember a model/mode/
// auto-approve choice — state creation pins cwd and backend (see /prompt),
// which we don't want to do from a mere /set-model, /set-mode or
// /auto-approve. Instead the choice is parked here and merged into the state
// the first time something that genuinely needs state (a prompt) creates it;
// seeded entries are consumed and removed at that moment, so an abandoned
// pick can never leak into a later session with the same id.
//
// autoApprove joined model/mode here as a bug fix: /auto-approve used to
// 404 outright when no state existed, which is the overwhelmingly common
// case for the checkbox's most natural use — tick it on a brand-new chat
// *before* sending the first prompt (state is only ever created by /prompt),
// or on a pre-existing session reopened after a driver restart. The browser
// didn't check the response status, so the box stayed visibly checked while
// the driver had no record of it, and every tool call still prompted until
// the user unchecked and rechecked it. Unlike model picks this is
// deliberately NOT persisted to disk across a driver restart: a bypass of
// every tool-permission prompt should have to be re-armed by a human, not
// silently restored by a process coming back up.
const preSeeds = new Map(); // sessionId -> { model?, mode?, autoApprove? }

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
// Lives in PodPrompt's own XDG state directory (PODPROMPT_STATE_DIR above),
// NOT under CLAUDE_CONFIG_DIR — this is PodPrompt's own bookkeeping, not
// Claude Code's, and CLAUDE_CONFIG_DIR points at the user's real, shared
// ~/.claude (also used by any native install on the host), which should
// never end up with PodPrompt-internal files in it. Same reasoning as
// LAST_BACKEND_FILE/SESSION_HOSTS_FILE below.
const MODEL_PICKS_FILE = nodePath.join(PODPROMPT_STATE_DIR, "viewer-model-picks.json");

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
    // Resolve, don't guess: an explicit backend from the caller wins, else
    // this session's real backend if it's ever been listed before (see
    // sessionIdToBackend above), else — genuinely never seen anywhere —
    // defaultBackendId(). That last case should only ever be reached for a
    // session this driver has never listed AND that arrived with no
    // explicit backend, which the new-chat picker never does.
    const backendId = explicitBackendId || sessionIdToBackend.get(sessionId) || defaultBackendId();
    const backend = getBackend(backendId);
    const cwd = explicitCwd || backend.cwdForSession(sessionId, null);
    // turnOutcome/abortRequested are the turn_end classification scratchpad
    // runTurn() reads and clears on the way out (see its finally) — a backend
    // sets turnOutcome from its own catch, /abort sets abortRequested.
    s = { bootstrapped: false, turnInFlight: false, abortController: null, turnOutcome: null, abortRequested: false, turnAnnounced: false, cwd, backend };
    // Remember this as the new-chat picker's next pre-selected choice — but
    // only when this really is a brand-new session (explicitCwd is the
    // established signal for that; see /prompt) with a deliberate backend
    // pick, not a pre-existing session whose backend this call merely
    // resolved for the first time this run via sessionIdToBackend above.
    if (explicitCwd && explicitBackendId) persistLastBackend(explicitBackendId);
    // A child session inherits its parent's working directory — it is doing
    // that parent's work, and its transcript is resolved relative to the same
    // project — but NEVER the parent's model. Model ids are backend-scoped,
    // so handing a claude-code model id to a child running on opencode would
    // simply fail to start. Auto-approve does inherit, but through the
    // relation index at decision time (autoApproveForSession) rather than by
    // being copied here, so that un-ticking it on the parent takes effect
    // immediately rather than only for sub-agents spawned afterwards.
    // A child's backend-native id lives in the relation index, which
    // outlives the process — unlike the backend's own in-memory translation
    // maps. Without this a child session resolved to nothing after a
    // restart: its transcript came back empty, and prompting a promoted one
    // created a brand-new session instead of resuming the real one.
    const rel = sessionRelations[sessionId];
    if (rel?.native?.realSessionId) s.nativeSessionId = rel.native.realSessionId;
    const parentId = parentOfSession(sessionId);
    if (parentId && !explicitCwd) {
      const parentState = sessions.get(parentId);
      if (parentState?.cwd) s.cwd = parentState.cwd;
    }
    const pre = preSeeds.get(sessionId);
    if (pre) {
      if (pre.model) s.model = pre.model;
      if (pre.mode) s.mode = pre.mode;
      if (pre.autoApprove) s.autoApprove = true;
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

// Is auto-approve on for this session, counting a still-parked pre-prompt
// choice as on? Live state wins when it exists (it's what the backends
// actually read), otherwise fall back to preSeeds. Never creates state, so
// it's safe from any read-only route. `state` is an optional
// already-looked-up SessionState, purely to save a second Map lookup.
// Auto-approve inherits down the tree: ticking it on a parent means its
// sub-agents are covered too. That matches what the flag means — it is an
// accept-the-risk setting for a line of work, and a sub-agent's tool calls
// are that work. On claude-code this is already true for free, since a
// sub-agent's tool calls reach canUseTool on the parent's own state; opencode
// gives each child session its own state, so the inheritance has to be
// resolved explicitly. Walks the relation index, so it works just as well
// when parent and child are on different backends.
// Apply a session operation to every descendant as well as the target.
// A sub-agent's transcript is hidden behind its parent, so a child left
// behind by an archive or delete becomes unreachable rather than merely
// untidy. Each child is dispatched through ITS OWN backend, never the
// parent's — in a mixed tree they differ, and using the parent's would
// silently no-op. Children first, so a failure part-way leaves the parent
// (the thing the user can still see and retry from) untouched.
async function cascadeToDescendants(parentId, op, label) {
  const kids = descendantsOfSession(parentId);
  for (const childId of kids.reverse()) {
    try {
      const rel = sessionRelations[childId] || {};
      const backend = getBackend(rel.backend || sessionIdToBackend.get(childId) || defaultBackendId());
      await op(backend, childId, sessions.get(childId));
    } catch (e) {
      // Best effort: one unreachable child must not block the parent's own
      // operation, which is what the user actually asked for.
      console.error(`[driver] ${label} cascade failed for child ${childId}:`, e.message);
    }
  }
  return kids.length;
}

function forgetSessionRelations(ids) {
  let changed = false;
  for (const id of ids) {
    if (sessionRelations[id]) { delete sessionRelations[id]; changed = true; }
    subAgents.delete(id);
  }
  if (changed) saveSessionRelations();
  // The autonomy gate holds no per-session state at all — one global counter
  // — so there is nothing here to forget for it. That absence is the point
  // of AD2, not an omission.
  peers.forget(ids);
  inbox.forgetSessions(ids);
}

function autoApproveForSession(sessionId) {
  let cur = sessionId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (effectiveAutoApprove(cur, sessions.get(cur))) return true;
    cur = parentOfSession(cur);
  }
  return false;
}

function effectiveAutoApprove(sessionId, state) {
  const s = state !== undefined ? state : (sessionId ? sessions.get(sessionId) : null);
  if (s) return !!s.autoApprove;
  return !!(sessionId && preSeeds.get(sessionId)?.autoApprove);
}

// Backend resolution for routes that must NOT create session state (pure
// reads like /modes, /models & /commands, and session-management calls):
// the pinned state backend wins once a session has been touched this run,
// otherwise an explicit backend from the caller, otherwise this session's
// real backend from sessionIdToBackend if it's ever been listed, otherwise
// defaultBackendId(). Crucially this never creates a SessionState, so a
// resumed session can't get its cwd/backend pinned by a mere /models or
// /session-history call.
function backendFor(sessionId, explicitBackendId) {
  const state = sessionId ? sessions.get(sessionId) : null;
  if (state) return state.backend;
  const backendId = explicitBackendId || (sessionId && sessionIdToBackend.get(sessionId)) || defaultBackendId();
  return getBackend(backendId);
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

// Anything still recorded as pending belongs to a turn that died with the
// previous process. Reported now so a reloaded session explains itself
// instead of showing a tool bubble that simply stops. Deliberately after the
// backends exist, so the broadcast path is live.
reportAbandonedApprovals();

// ── Drive one turn (backend-agnostic wrapper) ───────────────────────────
// Delegates the actual work to state.backend.runTurn — this wrapper only
// owns the bookkeeping that must happen identically regardless of which
// backend ran. turn_START is still the backend's to broadcast (it alone
// knows the precise moment that matters for its own process/request model),
// but turn_END is broadcast here, once, for both backends: the browser now
// distinguishes a clean finish from an error from a deliberate Stop, and
// deriving that in one place beats duplicating the classification in every
// backend — especially since opencode has no way to recognise its own
// aborts at all (its abort() is a fire-and-forget POST), whereas /abort
// below passes through this process for BOTH backends and can simply say so.
// Expiring orphaned approvals on the way out is generic for the same reason.
//
// startTurn() is the single entry point. POST /prompt calls it, and so will
// anything else that ever needs to begin a turn — a parent delegating to
// another backend, or (if sessions ever message each other) a peer delivery.
// Keeping one path matters because each of those would otherwise grow its
// own copy of the in-flight check, the host stamp and the broadcast order,
// and the copies would drift. `source` rides through to the user bubble's
// `origin` so a transcript can say who actually asked.
function startTurn(sessionId, promptText, {
  source = "human", explicitCwd, backendId, origin = null, userDirected = false,
} = {}) {
  const state = getSessionState(sessionId, explicitCwd, backendId);
  if (state.turnInFlight) {
    return { ok: false, reason: "busy" };
  }
  // §10 — the whole of the autonomy gate, in one place, precisely BECAUSE
  // this is the single entry point. The chain machinery this replaced needed
  // a mint path, a lookup path, a status check and a chainId threaded through
  // every caller; the question it was really asking was only ever "is this
  // turn allowed to start".
  //
  // A human turn is never gated: "resume" counts as human alongside "human"
  // because clicking Continue IS the user acting. Both also RESET the
  // counter, since typing and clicking are exactly the input events the gate
  // measures absence of — and that unifies what used to be two concepts
  // (minting a fresh budget vs. spending from one).
  if (source === "human" || source === "resume") {
    autonomy.noteHumanAction();
    // What a chain's `rootPrompt` used to supply: a human-meaningful name
    // for this line of work, available before the session has a title. Its
    // one consumer is the peer-handle fallback, so a session's first
    // outbound message is not labelled "@session". Only human turns set it —
    // an automatic turn's text is a delivery envelope, not a name.
    if (promptText && String(promptText).trim()) state.rootPromptText = String(promptText);
    // HD4: durable evidence that a human has typed into this session, which
    // is what the family-delete dialog pre-checks on. Must be persisted —
    // state.turnOrigin is in-memory and would be gone after a restart.
    noteUserTurn(sessionId);
  } else if (userDirected) {
    // MD8: the user clicked Deliver. That is not autonomous work, so it
    // neither needs the gate open nor counts against it. Turns this message
    // then provokes ARE automatic and do count, so the cascade it starts
    // stays bounded exactly as before.
  } else {
    const charged = autonomy.chargeAutomaticTurn();
    if (!charged.ok) {
      return {
        ok: false,
        reason: charged.reason,
        count: charged.count,
        pauseAfter: charged.pauseAfter,
      };
    }
  }
  state.fanoutThisTurn = 0;
  // A new turn by ANY route — typed, Continue, or a peer message — retires
  // the old failure. One rule rather than three separate clearing paths.
  clearResumable(sessionId);
  markTurnStarted(sessionId);
  // C10: who caused this turn to exist. Carried onto the user bubble so a
  // transcript can never be ambiguous about whether a human typed something
  // — which matters most for turns that begin with no user input at all.
  state.turnOrigin = origin || (source === "human" ? null : source);
  // Deliberately not awaited: a turn runs for minutes and the caller (an
  // HTTP handler, a delegating tool) must not be held open for it.
  runTurn(sessionId, promptText, { source }).catch((e) =>
    console.error(`[driver] startTurn failed for session ${sessionId}:`, e.message));
  return { ok: true };
}

// Promotion detaches a sub-agent's RECORD, but on claude-code there is no
// conversation to detach: the sub-agent ran as a Task inside its parent's
// process, so a promoted session starts with an empty context and the
// transcript above it is something the model has never read. That makes
// promotion no better than copying the markdown out by hand.
//
// So the first prompt after promotion carries the sub-agent's own transcript
// with it. Kept off the user's bubble (see state.pendingSeed in the backends)
// so the feed still shows what the user typed, not a wall of replayed
// context.
const PROMOTED_SEED_BUDGET = 24000; // characters; a long sub-agent is easily larger

// Only where there is no conversation behind the id to resume. That is the
// real distinction, not "is a sub-agent": a claude-code sub-agent ran as a
// Task inside its parent's process, so its PodPrompt session id is
// synthesized and the CLI has never heard of it — prompting it starts an
// empty session. An opencode sub-agent is a genuine session on the opencode
// server with its own stored history, so prompting it simply continues that
// conversation; seeding there would replay the whole transcript as text on
// top of history the server already holds, paying twice for it and showing
// the model everything twice. The same reasoning covers a future
// cross-backend delegated child, which is likewise a real session.
function needsPromotionSeed(rel) {
  return rel.backend === "claude-code" && rel.childKind === "native-task";
}

async function buildPromotedSeed(sessionId, state) {
  const rel = sessionRelations[sessionId];
  if (!rel || !rel.promoted || rel.seeded) return null;
  if (!needsPromotionSeed(rel)) return null;
  let history;
  try {
    history = await state.backend.getSessionHistory(sessionId, state.cwd, rel);
  } catch (e) {
    console.error(`[driver] could not read transcript to seed promoted session ${sessionId}:`, e.message);
    return null;
  }
  if (!Array.isArray(history) || !history.length) return null;

  const lines = [];
  for (const h of history) {
    const who = h.role === "user" ? "Prompt"
      : h.role === "assistant" ? "Sub-agent"
      : h.role === "thinking" ? "Sub-agent (reasoning)"
      : h.role === "tool" ? "Tool" : h.role;
    lines.push(`### ${who}\n${h.text}`);
  }
  let body = lines.join("\n\n");
  // Oldest content is dropped first: a sub-agent's conclusions are at the
  // end, and those matter most to whoever is carrying the work on.
  let truncated = false;
  if (body.length > PROMOTED_SEED_BUDGET) {
    body = body.slice(body.length - PROMOTED_SEED_BUDGET);
    truncated = true;
  }
  const label = rel.description ? `"${rel.description}"` : "a sub-agent";
  return [
    `The following is the full transcript of ${label}, a sub-agent whose work you are`,
    "taking over. It ran separately and you have not seen it before now.",
    truncated ? "(Earlier parts were dropped to fit; this is the most recent portion.)" : "",
    "",
    "<sub-agent-transcript>",
    body,
    "</sub-agent-transcript>",
    "",
    "Continue from that work. The user's message follows.",
  ].filter(Boolean).join("\n");
}

async function runTurn(sessionId, promptText, { source = "human" } = {}) {
  const state = getSessionState(sessionId);
  // Once only: the seed is the handover, not a preamble on every turn.
  const seed = await buildPromotedSeed(sessionId, state);
  if (seed) {
    state.pendingSeed = seed;
    sessionRelations[sessionId] = { ...sessionRelations[sessionId], seeded: true, seededAt: nowIso() };
    saveSessionRelations();
  }
  // Generic across both backends (see stampSessionHost's own comment) —
  // every turn, any session, any backend, records which host path was
  // actually backing /workspace just now.
  stampSessionHost(sessionId, state.cwd);
  state.turnAnnounced = false;
  state.turnSource = source;
  try {
    await state.backend.runTurn(sessionId, promptText, state);
  } catch (e) {
    // Both backends normally swallow their own turn errors (broadcasting an
    // *(error: ...)* bubble and returning), so this catch is the belt to
    // their braces: anything that DOES escape still has to end up classified
    // as an error rather than silently reported to the browser as a clean
    // finish.
    console.error(`[driver] runTurn failed for session ${sessionId}:`, e.message);
    if (!state.turnOutcome) state.turnOutcome = { reason: "error", error: e.message };
  } finally {
    // Ordering matters: this runs after the backend's own finally has
    // finalized any still-streaming bubbles and cleared turnInFlight, so
    // turn_end is the last word on the turn rather than racing that cleanup.
    // abortRequested is checked FIRST, ahead of any error the backend
    // recorded: opencode surfaces a Stop as a thrown error (its SSE waiter
    // rejects when generation is cut short), so trusting turnOutcome here
    // would report a deliberate Stop as reason:"error" on that backend while
    // claude-code — which classifies its own aborts — correctly said
    // "aborted". The user's stated intent outranks the symptom it produced.
    const outcome = state.abortRequested
      ? { reason: "aborted" }
      : (state.turnOutcome || { reason: "completed" });
    const announced = state.turnAnnounced;
    state.turnOutcome = null;
    state.abortRequested = false;
    state.turnAnnounced = false;
    // Paired strictly with turn_start (see broadcastStatus): a turn that
    // failed before the backend ever announced it never reached the browser
    // as "running", so telling it the turn ENDED would be news about
    // something it never heard begin.
    markTurnEnded(sessionId, outcome);
    if (announced) broadcastStatus(sessionId, { type: "turn_end", ...outcome });
    expirePendingApprovals(sessionId);
    // Opportunistic refresh after every turn, any session, any backend —
    // piggybacks on refreshAccountUsage()'s own single-flight cache, so a
    // turn ending right as the timer above is about to tick just collapses
    // into the same fetch instead of stacking a redundant one. Deliberately
    // not awaited: a slow/failed usage poll must never delay the turn's own
    // completion being reported back to the browser.
    pollAccountUsage(state.backend).catch((e) => console.error("[driver] post-turn pollAccountUsage failed:", e.message));
    // A session that just went idle is exactly when queued mail can move.
    // Deliberately after turn_end: the browser sees the turn finish, then
    // sees the next one begin, rather than the two racing.
    try {
      maybeDrainInbox(sessionId);
    } catch (e) {
      console.error(`[driver] inbox drain failed for session ${sessionId}:`, e.message);
    }
    // Wake anything blocking on this session's turn — a parent holding a
    // delegate() call open. Resolved AFTER turn_end and the drain, so a
    // waiter never observes a turn that the browser has not been told about
    // yet. Always resolved, including on error and abort, because a waiter
    // that only hears about success waits forever on failure.
    // Read from the SESSION state, not turnState: markTurnEnded replaces
    // turnState[sessionId] wholesale and runs before this, so turnState has
    // no turnId left by now. That would not have thrown — it would have
    // quietly passed null and un-bound every waiter, restoring exactly the
    // behaviour HD3 exists to remove.
    resolveTurnWaiters(sessionId, outcome, sessions.get(sessionId)?.turnId || null);
  }
}

// sessionId -> [resolve]. Deliberately a list: nothing stops two callers
// awaiting the same session.
const turnWaiters = new Map();

// `turnId` may be null, which means "the next turn, whichever it is". That
// is NOT a loophole, it is the only correct answer for toolDelegate: it has
// to register the waiter BEFORE startTurn (attaching afterwards races a child
// that finishes fast), and at that moment the turn it wants does not exist
// yet. The waiter latches onto the first turn to end for that session and
// every later turn finds nothing — which is exactly the old behaviour, now
// confined to the one case that needs it instead of being universal.
function awaitTurnEnd(sessionId, turnId = null) {
  return new Promise((resolve) => {
    const list = turnWaiters.get(sessionId) || [];
    list.push({ turnId, resolve });
    turnWaiters.set(sessionId, list);
  });
}

function resolveTurnWaiters(sessionId, outcome, turnId = null) {
  const list = turnWaiters.get(sessionId);
  if (!list?.length) return;
  // Keep only waiters bound to a DIFFERENT, still-possible turn. A waiter
  // naming the turn that just ended fires; an unbound one fires; one naming
  // some other turn is stale by definition, because a session runs one turn
  // at a time — so it is dropped rather than left to fire on an unrelated
  // turn later.
  const firing = list.filter((w) => !w.turnId || !turnId || w.turnId === turnId);
  turnWaiters.delete(sessionId);
  for (const w of firing) {
    try { w.resolve(outcome); } catch { /* a waiter's own failure is not ours */ }
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

// §11 — PD10 is DEFERRED, against a named condition rather than a queue
// position: it is required before the first non-local realm becomes
// reachable, and not before. Verified in code, not assumed — KNOWN_REALMS
// rejects any non-local realm, authorizeDelivery refuses unless BOTH ends are
// LOCAL_REALM, and toolMessage returns realm-unreachable. There is exactly
// one principal today, so authenticating would be distinguishing nothing from
// nothing.
//
// This stub exists so that deferring stays cheap. The expensive part of the
// retrofit is not the token; it is re-deciding, route by route, which of ~30
// handlers is control plane and which is agent plane. That judgement is
// cheapest while a route is being written, so every route added by §9 and §10
// is classified NOW by routing through here. Turning it on later is a change
// in this one function instead of an audit of thirty.
//
// Note what it cannot buy even then: agent Bash runs as the same uid as this
// process, so any container-local secret is readable from /proc. A token
// raises the bar against a confused agent and does nothing against a
// determined one. A real boundary needs uid separation — see §11.
// eslint-disable-next-line no-unused-vars
function requireControl(req) {
  return true;
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
    // Session-scoped, same as /modes & /models below — an opencode session's
    // palette must show opencode's own commands, not whichever backend
    // happens to be "the default" (this used to be pinned to a single
    // shared default regardless of which session was open, which was
    // silently wrong for any session on the non-default backend). Falls
    // back to backendFor()'s own default-backend answer only when no
    // sessionId is given at all.
    const sessionId = url.searchParams.get("sessionId");
    const backend = backendFor(sessionId, url.searchParams.get("backend"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(backend.getKnownCommands()));
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
    // autoApprove falls back to the parked pre-prompt value (see preSeeds):
    // this is the *only* thing that repopulates the browser's checkbox —
    // resetBackendControlsDisplay() clears it on every session switch, and
    // resyncTurnStatus() rearms it from here. Reading just `sessions` would
    // report false for a session whose flag is still parked, silently
    // un-ticking a box the user already ticked (and confirmed) the moment
    // they switched away and back, or on any SSE reconnect.
    // awaitingInput is reported alongside inFlight, not folded into it: a
    // turn parked on a permission is in flight but is not working, and the
    // browser needs to say "waiting for you" rather than spin a thinking
    // indicator. Also the resync path for the same reason autoApprove is —
    // awaiting_input is an ephemeral status event, so a tab that connects
    // mid-park would otherwise never learn about it.
    res.end(JSON.stringify({
      inFlight: !!state?.turnInFlight,
      awaitingInput: sessionId ? pendingKindForSession(sessionId) : null,
      // HD1: named for what it actually gates — the read-only chrome — not
      // for "has a parent". A delegated child HAS a parent and is still
      // promptable, so the old `isChild` would now be a lie for it.
      rosterChild: sessionId ? isRosterChild(sessionId) : false,
      // Where this session was delegated from, for the Delegated label's
      // link. Null for anything that was not delegated.
      delegationAnchor: sessionId ? delegationAnchorFor(sessionId) : null,
      parentSessionId: sessionId ? parentOfSession(sessionId) : null,
      autoApprove: effectiveAutoApprove(sessionId, state),
      // MD9. Same resync reasoning as autoApprove above: the browser clears
      // its controls on every session switch, so this is what rearms the
      // checkbox — and because the value is DERIVED for delegated sessions,
      // the browser cannot work it out locally.
      autoDeliver: autoDeliverFor(sessionId),
    }));
    return;
  }

  // Every outstanding ask across every session, for a global "N waiting on
  // you" indicator. Without it the browser can only discover a parked
  // approval by already looking at that session — which is exactly the case
  // that goes unnoticed, since a sub-agent's card lives in a child session
  // the user may never have opened.
  // The roster for one session: every sub-agent it has spawned, with live
  // status where this process has it. Promoted children are excluded — once
  // promoted a session stands on its own and is no longer anyone's sub-agent.
  if (req.method === "GET" && path === "/sub-agents") {
    const sessionId = url.searchParams.get("sessionId");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      subAgents: sessionId ? subAgentsForParent(sessionId) : [],
      // HD1: delegated children are NOT sub-agents and deliberately do not
      // appear above — they are real sessions, listed and promptable. They
      // ride along on this response purely because the browser already
      // refreshes it at the two moments that matter (session switch, and
      // sub_agents_changed), which is what lets a delegate_session bubble
      // show live status without a second endpoint or a second poll.
      delegatedChildren: sessionId ? delegatedChildrenForParent(sessionId) : [],
    }));
    return;
  }

  // Stop ONE sub-agent, leaving its siblings and the parent turn running.
  // Dispatched through the child's own backend, which in a mixed tree is not
  // the parent's.
  if (req.method === "POST" && path === "/abort-subagent") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const childId = body.sessionId;
    const rel = childId ? sessionRelations[childId] : null;
    if (!rel || rel.rel !== "parent") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not a known sub-agent"}');
      return;
    }
    // Same guard as the cascade: stopping something already finished must
    // not rewrite its outcome to "killed". Reported rather than silently
    // ignored, so a stale Stop button says why nothing happened.
    if (!isSubAgentRunning(childId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "that sub-agent is no longer running", reason: "not-running" }));
      return;
    }
    try {
      const childState = sessions.get(childId);
      const backend = getBackend(rel.backend || sessionIdToBackend.get(childId) || defaultBackendId());
      // A native claude-code sub-agent has no session, process or
      // abortController of its own — it is a Task inside its parent's
      // query, so the only way to stop it alone is the stopTask control on
      // that parent's live query. Everything else (an opencode child, a
      // future delegated session) IS a real session and aborts normally.
      // Chosen by capability, not by trying one and falling back: abort()
      // returns nothing on either backend, so "did it work" cannot be read
      // from it — an earlier version treated undefined as success and made
      // the unsupported path unreachable.
      let stopped;
      if (typeof backend.stopSubAgent === "function" && rel.childKind === "native-task" && rel.parent) {
        // The only mechanism that can reach a Task inside its parent's
        // query. There is nothing to fall back to: abort() here would target
        // a child session that does not exist and silently do nothing.
        stopped = await backend.stopSubAgent(rel.parent, sessions.get(rel.parent), rel.native?.taskId);
      } else {
        // A real session of its own (an opencode child, or a delegated one),
        // so the ordinary abort path applies.
        if (childState?.turnInFlight) childState.abortRequested = true;
        backend.abort(childId, childState);
        stopped = true;
      }
      if (!stopped) {
        // Said plainly rather than reporting a stop that did not happen —
        // a roster row returning to "running" after a successful-looking
        // click is worse than being told it is not supported here.
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "this backend cannot stop a single sub-agent", reason: "unsupported" }));
        return;
      }
      upsertSubAgent(childId, { status: "killed" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] abort-subagent failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to stop sub-agent"}');
    }
    return;
  }

  // Promote a sub-agent to a session of its own. The relation row is KEPT
  // (with promoted:true) rather than deleted, because it still carries the
  // backend's own identities — which is how this session's transcript is
  // found on disk. What changes is that it stops being treated as a child:
  // it can be prompted, it no longer appears in its old parent's roster, and
  // archiving or deleting that parent no longer touches it.
  // HD6 — Keep and Detach. ONE mechanism underneath (the relation row is
  // kept, with promoted:true, because it still holds the backend ids that
  // locate this session's transcript on disk); two user actions above it,
  // because HD1 split what `promote` used to mean into two different things:
  //
  //   Keep    roster child -> tree session. "This sub-agent turned out to be
  //           worth keeping." Seeds on claude-code native tasks, because
  //           there is no conversation behind that id to resume.
  //   Detach  tree child -> root session. "This is its own thing now." Never
  //           seeds: it is already a real session with its own history.
  //
  // Their GUARDS differ, which is most of why they are separate routes.
  if (req.method === "POST" && (path === "/keep-session" || path === "/detach-session")) {
    requireControl(req);
    const detaching = path === "/detach-session";
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const childId = body.sessionId;
    const rel = childId ? sessionRelations[childId] : null;
    if (!rel || rel.rel !== "parent" || rel.promoted) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: detaching ? "not a detachable session" : "not a keepable sub-agent" }));
      return;
    }
    // Each action must be aimed at the kind it is for, or the guards below
    // are protecting the wrong thing.
    if (detaching && !isTreeChild(childId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "that is a sub-agent — use Keep", reason: "wrong-kind" }));
      return;
    }
    if (!detaching && !isRosterChild(childId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "that is already a session — use Detach", reason: "wrong-kind" }));
      return;
    }

    if (detaching) {
      // HD2 made this guard both MORE PERMISSIVE and more correct. The old
      // blanket "not while running" was right for a sub-agent but wrong for
      // a delegated session: under HD2 an async delegated child is not in
      // its parent's Stop cascade at all, so detaching it mid-run strands
      // nobody. The only case that still matters is a child its parent's
      // CURRENT turn is blocked on — detach that and the parent waits on
      // something it can no longer reach.
      const parentTurnId = sessions.get(rel.parent)?.turnId || null;
      if (rel.awaitedByParentTurn && rel.parentTurnId && parentTurnId
          && rel.parentTurnId === parentTurnId) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: "its parent is waiting on this session right now — stop that turn first",
          reason: "awaited",
        }));
        return;
      }
    } else if (isSubAgentRunning(childId)) {
      // Unchanged, and for the original reason: a running Task cut out of
      // its parent's cascade becomes unstoppable — the parent can no longer
      // reach it and the work carries on where nobody is watching.
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stop this sub-agent before keeping it", reason: "still-running" }));
      return;
    }

    // Auto-approve is deliberately NOT carried across. autoApproveForSession
    // walks parentOfSession, which returns null once promoted, so a
    // separated session stops inheriting it. That fails in the SAFE
    // direction — more prompting, not less — and is arguably what severing a
    // link should mean. Left silent on purpose: no confirm, no snapshot.
    sessionRelations[childId] = { ...rel, promoted: true, promotedAt: nowIso() };
    saveSessionRelations();
    subAgents.delete(childId);
    // A detached node takes its own subtree with it: the rows below still
    // point at a node that exists, so nothing needs rewriting.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionId: childId, backend: rel.backend || null }));
    return;
  }

  // Forget ONE sub-agent — the per-row action in the roster, deliberately
  // shaped like archiving a session rather than deleting one. The child's
  // transcript is left alone on the backend; this only stops PodPrompt
  // tracking it, so it leaves the roster. Real deletion happens only when
  // the PARENT session is deleted, which cascades (see /delete-session).
  if (req.method === "POST" && path === "/forget-sub-agent") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const childId = body.sessionId;
    const rel = childId ? sessionRelations[childId] : null;
    if (!rel || rel.rel !== "parent") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"not a known sub-agent"}');
      return;
    }
    // Refusing while it runs keeps the roster the only place live work is
    // visible — forgetting a running sub-agent would hide something that is
    // still consuming tokens and still able to raise a permission card.
    if (isSubAgentRunning(childId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stop this sub-agent before forgetting it", reason: "still-running" }));
      return;
    }
    const parentId = rel.parent;
    forgetSessionRelations([childId]);
    if (parentId) broadcastStatus(parentId, { type: "sub_agents_changed" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // Forget a session's recorded sub-agents. The relation index outlives the
  // process by design (a sub-agent's transcript is still on disk), but that
  // also means a session accumulates every sub-agent it has ever spawned,
  // and there was no way to clear that short of editing the sidecar by hand
  // and restarting — the in-memory copy would otherwise just rewrite it.
  // Only removes rows for sub-agents that are NOT running, so this cannot be
  // used to lose track of live work.
  if (req.method === "POST" && path === "/forget-sub-agents") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const parentId = body.sessionId;
    if (!parentId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    const all = descendantsOfSession(parentId);
    const running = all.filter((id) => isSubAgentRunning(id));
    const removable = all.filter((id) => !isSubAgentRunning(id));
    forgetSessionRelations(removable);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, forgotten: removable.length, keptRunning: running.length }));
    return;
  }

  if (req.method === "GET" && path === "/pending-approvals") {
    const out = [];
    for (const [id, p] of pendingApprovals) {
      out.push({
        id, sessionId: p.sessionId, kind: p.kind, toolName: p.toolName,
        askedAt: p.askedAt || null,
        parentSessionId: parentOfSession(p.sessionId),
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ pending: out, viewers: viewerLiveness.viewers }));
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
      // The relation row rides along so a backend can tell a sub-agent's
      // transcript apart from an ordinary session's — they live in different
      // places on disk and a child's synthesized id appears in neither.
      // The display setting governs this route only. read_session goes
      // through historyFor(), which is deep unconditionally.
      history = await backend.getSessionHistory(
        sessionId, state?.cwd, sessionRelations[sessionId] || null,
        { deep: deepHistoryEnabled });
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
    // Re-attach provenance the transcript still evidences but the converted
    // history has dropped. Only ever ADDS an origin — an entry that already
    // has one (a backend that learns to carry it) is left alone.
    //
    // A DELEGATED child's opening prompt is the one case the text cannot
    // speak for: peer mail carries "[message from @x]" and a resume carries
    // fixed wording, but a delegation prompt is just the work, written by
    // whatever model asked for it. So it is recovered from the relation row
    // instead — that row is the record of who created this session, which is
    // exactly the question. Without it the bubble claimed the USER had typed
    // a prompt no human ever wrote.
    const delRel = sessionRelations[sessionId];
    const delegationOrigin = (delRel && delRel.childKind === "delegated")
      ? `delegate:@${peers.get(delRel.createdBy || delRel.parent)?.handle || ""}`.replace(/@$/, "")
      : null;
    let seenUser = false;
    if (Array.isArray(history)) {
      for (const h of history) {
        if (!h) continue;
        const isUser = h.role === "user";
        if (!h.origin) {
          const inferred = inferOriginFromText(h.role, h.text);
          // Only the FIRST user entry: that is the delegation. Anything
          // later is peer mail (which carries its own marker) or something
          // the user really did type, now that HD1 makes these promptable.
          if (inferred) h.origin = inferred;
          else if (isUser && !seenUser && delegationOrigin) h.origin = delegationOrigin;
        }
        if (isUser) seenUser = true;
      }
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
      // gatherAllSessions also refreshes sessionIdToBackend as a side effect
      // (see its own comment) — every real /sessions poll opportunistically
      // keeps that cache current, on top of the one-time startup warm-up.
      const { allSessions, unreachableCount, unreachableSessions } = await gatherAllSessions(includeUnreachable);

      // Annotate every session (reachable or not) with what's known about
      // the host path it was last touched from — one bulk read of
      // SESSION_HOSTS_FILE rather than a re-read per session. lastKnownHostPath
      // powers viewer.html's "relaunch from X" hint on unreachable sessions
      // (unchanged); hostMismatch is the new signal, only ever set true when
      // BOTH the current and recorded host paths are actually known and
      // disagree — see SESSION_HOSTS_FILE's own comment for why this is a
      // soft, informational flag on an otherwise-normal session rather than
      // folded into `unreachable`.
      // Keep peer records (and therefore handles) current off a poll the
      // browser already makes. Without this, a session that messages before
      // anyone calls list_sessions has no title yet, so its handle stays the
      // provisional fallback and the RECIPIENT sees something meaningless —
      // the first cross-backend message arrived labelled with a raw id.
      for (const s_ of allSessions) {
        if (s_.archived || s_.unreachable) continue;
        peers.ensure(s_.sessionId, {
          title: s_.customTitle || s_.summary || s_.firstPrompt || null,
          backend: s_.backend,
        });
      }

      // HD1: native sub-agents are roster-only and must not appear as rows of
      // their own. Applied AFTER peers.ensure above, deliberately: a native
      // sub-agent can still be a message target, and dropping it from the
      // peer refresh here would strand its handle at the provisional
      // fallback. This filter is about the session LIST, nothing else.
      //
      // Promoted/kept children are unaffected — isRosterChild returns false
      // for them, which is the whole point of keeping the relation row.
      const listed = allSessions.filter((s) => !isRosterChild(s.sessionId));
      const hiddenRosterChildren = allSessions.length - listed.length;

      // Shape for the nested rows HD5 renders. Carried from Phase 17 so the
      // data is verifiable a phase before anything draws it: depth is counted
      // along the same parent edges the cascade walkers use, so a row's
      // indent and its delete blast radius can never disagree.
      for (const s_ of listed) {
        const parentId = parentOfSession(s_.sessionId);
        s_.parentSessionId = parentId;
        s_.treeDepth = parentId ? depthOfSession(s_.sessionId) : 0;
        // Lets the parent's feed attach this child's live status to the
        // delegate_session bubble that created it. Replaces the roster as
        // the bubble's status source: under HD1 a delegated child is not in
        // the roster at all, and before that it carried no status anyway —
        // subAgentsForParent read rel.native?.toolUseId, which toolDelegate
        // never set, so the value was always null.
        s_.delegateToolUseId = parentId
          ? (sessionRelations[s_.sessionId]?.native?.toolUseId || null)
          : null;
      }

      const sessionHosts = loadSessionHosts();
      const currentHostPath = process.env.HOST_WORKSPACE_PATH || null;
      const annotateHost = (s) => {
        const rec = sessionHosts[s.sessionId];
        s.lastKnownHostPath = rec?.hostPath || null;
        s.hostMismatch = !!(currentHostPath && rec?.hostPath && rec.hostPath !== currentHostPath);
        return s;
      };
      listed.forEach(annotateHost);
      if (unreachableSessions) unreachableSessions.forEach(annotateHost);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        // Promise.all resolves in request order, so a naive .flat() would
        // chunk all of one backend/project's sessions before another's,
        // regardless of actual recency — merge by lastModified instead so
        // "flat, sorted by recency" is true globally, not just per source.
        sessions: listed.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)),
        unreachableCount,
        unreachableSessions,
        // Diagnostic only, and the number that tells you HD1 is working:
        // how many rows the roster/tree split kept out of this list.
        hiddenRosterChildren,
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
    // (see viewer.html's openNewChatPicker) and pre-select one — every
    // registered backend is always a valid explicit choice for a new
    // session (see /prompt's body.backend), regardless of which one
    // defaultBackendId() currently answers.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ available: Object.keys(backends), default: defaultBackendId() }));
    return;
  }

  if (req.method === "GET" && path === "/projects") {
    // Driven by an explicit ?backend= from the new-chat picker's own
    // currently-selected radio button (see viewer.html's openNewChatPicker/
    // loadAndRenderProjects), not a single global default — each backend's
    // project discovery differs (Claude Code scans its own multi-project
    // session history; OpenCode's is a similar scan against its own /session
    // API — see backends/opencode.mjs's listProjects), so the picker must
    // re-fetch this whenever its selected backend changes, or it'd show one
    // backend's project list while the other is selected. Only falls back to
    // defaultBackendId() when no explicit backend is given at all (e.g. a
    // stale/older client).
    const backend = getBackend(url.searchParams.get("backend") || defaultBackendId());
    // Awaited: OpenCode's listProjects() is now genuinely async (a real
    // GET /session fetch, not a stub) — Claude Code's stays sync and just
    // resolves immediately either way.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await backend.listProjects()));
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
    if (!body.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    const enabled = !!body.enabled;
    const state = sessions.get(body.sessionId);
    if (state) {
      state.autoApprove = enabled;
    } else {
      // Pre-prompt (or post-restart) "new chat": park the choice for when
      // state is created, exactly like /set-model does. This must NOT create
      // state itself — that would pin cwd/backend from a mere checkbox click.
      const pre = preSeeds.get(body.sessionId) || {};
      preSeeds.set(body.sessionId, { ...pre, autoApprove: enabled });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, autoApprove: enabled }));
    return;
  }

  // MD9: pin auto-delivery for one session, or clear back to the derived
  // default. Unlike /auto-approve this needs no preSeeds dance — the
  // preference is durable and keyed by session id on its own, so it can be
  // set before any state exists without pinning cwd or backend.
  if (req.method === "POST" && path === "/auto-deliver") {
    requireControl(req);
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    if (!body.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    // null/undefined clears the pin; anything else is an explicit choice.
    const want = body.enabled === null || body.enabled === undefined ? null : !!body.enabled;
    const effective = setAutoDeliver(body.sessionId, want);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      autoDeliver: effective,
      explicit: sessionPrefs[body.sessionId]?.autoDeliver ?? null,
    }));
    return;
  }

  // ── The autonomy gate ─────────────────────────────────────────────────
  // §10. Replaces /chains, /pause, /extend-chain and /budget-preset. Four
  // routes became three, and the three take one number between them.
  //
  // §11: PD10 is deferred against a condition (the first non-local realm),
  // not postponed indefinitely — but these are still the routes it would
  // matter most for, since an agent that can POST its own lift has switched
  // off its own governor. They are classified NOW via requireControl() so
  // enabling it later is a change in one function rather than an audit.
  if (req.method === "GET" && path === "/autonomy") {
    requireControl(req);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(autonomySnapshot()));
    return;
  }

  // MD1: a tab telling the driver which session it is LOOKING at. Sent on
  // session switch, on visibilitychange, and as a heartbeat while visible.
  //
  // This REPLACES the old POST /presence. That route reset the autonomy
  // counter on any keydown/mousedown/focus — the weakest available signal
  // doing nearly all the work, so a stray trackpad brush silently re-armed
  // twenty autonomous turns. Presence is now inferred from the requests
  // that represent the user actually directing the system (MD7), which also
  // retires the polling trap AD1 had to warn about: nothing about presence
  // is reported by the browser any more.
  if (req.method === "POST" && path === "/viewing") {
    requireControl(req);
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const sessionId = body.sessionId;
    const wasWatched = sessionId ? isWatched(sessionId) : false;
    noteViewing(sessionId, !!body.visible);
    // Stopped watching => the hold lapses and whatever it was holding goes
    // now. MD3: release is the same condition evaluated continuously, not a
    // separate timer.
    let released = 0;
    if (wasWatched && !body.visible && sessionId) {
      released = releaseWatchedFor(sessionId).length;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, watching: isWatched(sessionId), released }));
    return;
  }

  // Lift the cap, or put it back. One route, because they are one decision.
  // `until` is EPOCH MS resolved by the browser (AD5) — this process is
  // almost certainly on UTC and must never interpret a wall-clock time.
  if (req.method === "POST" && path === "/autonomy-cap") {
    requireControl(req);
    // MD7: a cap action is the user directing the system. The counter reset
    // lives here; the release of parked mail is done explicitly below so its
    // count can be reported back, rather than twice via the helper.
    autonomy.noteHumanAction();
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    let result;
    if (body.allow) {
      // "Allow N more". The counter reset already happened above (MD7: this
      // is the user directing the system); there is nothing else to do, and
      // saying so explicitly beats leaning on capNow()'s side effect, which
      // would ALSO clear an uncapped override the user had deliberately set.
      result = { ok: true };
    } else if (body.lift) {
      result = autonomy.liftCap({ until: body.until === null || body.until === undefined ? null : Number(body.until) });
    } else if (body.pauseAfter !== undefined) {
      result = autonomy.setPauseAfter(Number(body.pauseAfter));
    } else {
      result = autonomy.capNow();
    }
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    // Lifting the cap, allowing more, or capping-now are all human actions
    // that unblock work, so each has to MOVE the mail it was holding —
    // otherwise the button visibly changes the state and nothing happens.
    const released = releaseAutonomyParked();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, released: released.length, ...autonomySnapshot() }));
    return;
  }

  // The destructive half, kept as a SEPARATE deliberate action rather than
  // folded into capping: capping is reversible, while aborting in-flight
  // turns throws away work that may be nearly finished. Done here rather
  // than in the browser because the driver knows exactly which sessions are
  // running — the browser would have to guess and would miss any session
  // running a turn it did not start.
  if (req.method === "POST" && path === "/stop-all") {
    requireControl(req);
    noteUserDirectedAction();   // MD7
    let stopped = 0;
    for (const [sessionId, state] of sessions) {
      if (!state.turnInFlight) continue;
      state.abortRequested = true;
      try { state.backend.abort(sessionId, state); stopped++; } catch (e) {
        console.error(`[driver] stop-all abort failed for ${sessionId}:`, e.message);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stopped, ...autonomySnapshot() }));
    return;
  }

  // ── Peers & inbox ─────────────────────────────────────────────────────
  // Two callers, deliberately one implementation. Without `from` this is the
  // raw registry, which is what the UI wants. With `from` it is exactly what
  // the list_sessions tool returns — because the OpenCode plugin calls this
  // route for ITS list_sessions, and if the two transports disagreed about
  // paging the two backends would quietly behave differently.
  //
  // The default cap lives in toolListPeers and nowhere else. A shim that
  // re-stated it would be a second copy to drift.
  if (req.method === "GET" && path === "/peers") {
    const from = podSessionIdFor(url.searchParams.get("from"));
    if (!from) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ realm: LOCAL_REALM, peers: peers.list(), total: peers.list().length }));
      return;
    }
    const limitParam = url.searchParams.get("limit");
    try {
      const result = await toolListPeers(from, {
        search: url.searchParams.get("search") || null,
        limit: limitParam ? Number(limitParam) : null,
        all: url.searchParams.get("all") === "1",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ realm: LOCAL_REALM, ...result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && path === "/inbox") {
    const sessionId = url.searchParams.get("session");
    const entries = (sessionId
      ? inbox.open().filter((e) => e.to?.id === sessionId || e.from?.id === sessionId)
      : inbox.open()
    ).map((e) => ({
      ...e,
      fromHandle: e.fromHandle || peers.get(e.from?.id)?.handle || null,
      toHandle: peers.get(e.to?.id)?.handle || null,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      entries,
      // Only PARKED entries count as stuck. Transient queueing behind a busy
      // target resolves in seconds, and a badge that counted it would
      // flicker all day until the user stopped seeing it.
      stuckCount: inbox.stuck().length,
      ...autonomy.status(),
    }));
    return;
  }

  if (req.method === "POST" && path === "/inbox-action") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const { entryId, action } = body || {};
    let result;
    if (action === "discard") result = inbox.discard(entryId);
    else if (action === "deliver-now") {
      // Deliberate override: releases the entry without topping the chain
      // up, so the user can let one message through without re-arming the
      // work that produced it.
      const entry = inbox.byId(entryId);
      if (!entry) result = { ok: false, reason: "no-such-entry" };
      else {
        // MD8: a delivery the user explicitly clicked is NOT autonomous
        // work. It bypasses the gate, is not charged, and — unlike every
        // earlier version of this code — does not reset the counter, so it
        // cannot release other sessions' parked mail as a side effect. That
        // only became possible once MD7 removed the blanket mousedown
        // listener, which used to fire before any handler here could run.
        result = inbox.release(entryId);
        if (result.ok) maybeDrainInbox(entry.to?.id, { userDirected: true });
      }
    } else if (body.action === "deliver") {
      // MD5: deliver the CHECKED subset as one coalesced turn. Unchecked
      // entries are simply not released, so they stay held and the bar
      // keeps showing them. One delivery action is one turn whatever it
      // carries, which is what makes picking a subset cheap rather than
      // costing a turn per message.
      const ids = Array.isArray(body.entryIds) ? body.entryIds : [];
      const target = body.sessionId || inbox.byId(ids[0])?.to?.id || null;
      let released = 0;
      for (const id of ids) {
        const e = inbox.byId(id);
        if (!e || (target && e.to?.id !== target)) continue;
        if (inbox.release(id).ok) released++;
      }
      if (!released) result = { ok: false, reason: "nothing-to-deliver" };
      else {
        maybeDrainInbox(target, { userDirected: true });
        result = { ok: true, delivered: released };
      }
    } else result = { ok: false, reason: "unknown-action" };
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stuckCount: inbox.stuck().length }));
    return;
  }

  // The HTTP face of deliver(). Claude Code's tools call deliver() directly
  // in-process; the OpenCode plugin runs inside `opencode serve` and so has
  // to come through here, carrying the session id ITS runtime supplied.
  //
  // PD10: `from` is presently taken on trust, like every other driver route.
  // Phase 16 replaces that with authenticate(request) -> principal, at which
  // point the plugin's shared secret identifies it as a local-realm caller
  // and a bare curl stops working.
  if (req.method === "POST" && path === "/deliver") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const fromId = podSessionIdFor(body.from);
    if (!fromId || !body.to) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"from and to are required"}');
      return;
    }
    // Goes through toolMessage, NOT deliver(), so this shim and the
    // in-process one are the same code path. Calling deliver() directly
    // skipped the fan-out cap and the sender's peer record — which is why
    // a cross-backend message first arrived labelled with a raw session id
    // instead of a handle.
    const receipt = toolMessage(fromId, {
      to: body.to,
      text: body.text || "",
      kind: body.kind === "result" ? "result" : "peer",
      resume: !!body.resume,
    });
    res.writeHead(receipt.ok ? 200 : 409, { "Content-Type": "application/json" });
    // `describe` is the model-facing wording, owned here so the two backends
    // explain the same outcome the same way.
    res.end(JSON.stringify({ ...receipt, describe: describeReceipt(receipt, body.to) }));
    return;
  }

  if (req.method === "POST" && path === "/delegate") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const fromId = podSessionIdFor(body.from);
    if (!fromId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"from is required"}');
      return;
    }
    try {
      const receipt = await toolDelegate(fromId, {
        backend: body.backend,
        prompt: body.prompt || "",
        title: body.title || null,
        model: body.model || null,
        awaitResult: body.awaitResult === true,
      });
      res.writeHead(receipt.ok ? 200 : 409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...receipt, describe: describeReceipt(receipt, body.backend) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // What the Continue strip reads. Returns the prompt too, so the browser
  // never has to know the wording — one source for both backends.
  if (req.method === "GET" && path === "/resume-state") {
    const sessionId = url.searchParams.get("sessionId");
    const resumable = sessionId ? resumableFor(sessionId) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      available: !!resumable,
      // Never offered for a sub-agent transcript: it is a record of
      // delegated work, not a conversation, and its input bar is hidden for
      // the same reason. Its parent is told the outcome and can re-prompt it.
      ...(resumable && !isRosterChild(sessionId) ? {
        reason: resumable.reason,
        error: resumable.error || null,
        lastTool: resumable.lastTool || null,
        at: resumable.at,
        prompt: resumePromptFor(resumable),
      } : { available: false }),
    }));
    return;
  }

  if (req.method === "POST" && path === "/continue") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const sessionId = body.sessionId;
    const resumable = sessionId ? resumableFor(sessionId) : null;
    if (!resumable || isRosterChild(sessionId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nothing to resume", reason: "not-resumable" }));
      return;
    }
    // source "resume" rather than "human": the text was generated, not typed,
    // and the transcript should not claim otherwise. It still mints a fresh
    // budget, because clicking Continue IS the user acting.
    const label = ({
      restart: "Continued after a restart",
      aborted: "Continued after being stopped",
      error: "Continued after an error",
    })[resumable.reason] || "Continued";
    const started = startTurn(sessionId, resumePromptFor(resumable), {
      source: "resume",
      origin: `resume:${resumable.reason}`,
    });
    if (!started.ok) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "could not resume", reason: started.reason }));
      return;
    }
    // Clicking Continue is the user acting, same as typing.
    releaseAutonomyParked();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && path === "/read-session") {
    const fromId = podSessionIdFor(url.searchParams.get("from"));
    if (!fromId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"from is required"}');
      return;
    }
    const num = (k) => (url.searchParams.get(k) ? Number(url.searchParams.get(k)) : null);
    try {
      const result = await toolReadSession(fromId, {
        session: url.searchParams.get("session"),
        search: url.searchParams.get("search"),
        from: num("start"),
        last: num("last"),
        role: url.searchParams.get("role"),
        limit: num("limit"),
      });
      res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ...result, rendered: renderReadSession(result) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && path === "/deep-history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ enabled: deepHistoryEnabled }));
    return;
  }

  if (req.method === "POST" && path === "/deep-history") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const enabled = setDeepHistory(!!body.enabled);
    console.log(`[driver] deep history display ${enabled ? "enabled" : "disabled"}`);
    // server.py seeds each session's log ONCE behind a latch, so the new
    // depth would otherwise never be fetched. Dropping the seed makes the
    // next connect re-read at the new depth.
    try {
      await fetch(VIEWER_MESSAGE_URL.replace("/message", "/reseed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch (e) {
      console.error("[driver] could not ask the viewer to reseed:", e.message);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled }));
    return;
  }

  // The OpenCode plugin fetches this rather than carrying its own copy.
  if (req.method === "GET" && path === "/system-prompt") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ systemPrompt: messagingSystemPrompt({ prefix: "" }) }));
    return;
  }

  if (req.method === "POST" && path === "/peer-settings") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    if (!body.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    peers.ensure(body.sessionId, { title: body.title, backend: body.backend });
    let result = { ok: true };
    if (typeof body.handle === "string") result = peers.setHandle(body.sessionId, body.handle);
    if (result.ok && typeof body.messageable === "boolean") {
      result = peers.setMessageable(body.sessionId, body.messageable);
    }
    if (!result.ok) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, peer: peers.get(body.sessionId) }));
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
      const cascaded = await cascadeToDescendants(targetId,
        (backend, childId, childState) => backend.archiveSession(childId, childState?.cwd), "archive");
      const state = sessions.get(targetId);
      const backend = backendFor(targetId, body.backend);
      await backend.archiveSession(targetId, state?.cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cascaded }));
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
      // Restoring a parent restores its sub-agents with it, so the tree the
      // user archived comes back whole rather than with holes in it.
      const cascaded = await cascadeToDescendants(body.sessionId,
        (backend2, childId, childState) => backend2.unarchiveSession(childId, childState?.cwd), "unarchive");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cascaded }));
    } catch (e) {
      console.error("[driver] unarchive-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to unarchive session"}');
    }
    return;
  }

  // What HD4's dialog reads. The browser must never derive a delete's blast
  // radius itself — the driver owns the relation index, and a dialog that
  // disagreed with what the server actually deletes would be worse than no
  // dialog at all.
  if (req.method === "GET" && path === "/delete-preview") {
    const sessionId = url.searchParams.get("sessionId");
    const kids = sessionId ? descendantsOfSession(sessionId) : [];
    const rosterKids = kids.filter(isRosterChild);
    const treeKids = kids.filter(isTreeChild);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      // Non-negotiable: HD1 leaves these no other way to be reached, so NOT
      // deleting them strands transcripts on disk that nothing can ever list
      // or open again.
      rosterCount: rosterKids.length,
      // Offered individually, pre-checked by "no user turns".
      delegated: treeKids.map((id) => {
        const rel = sessionRelations[id] || {};
        return {
          sessionId: id,
          title: peers.get(id)?.title || rel.description || null,
          backend: rel.backend || sessionIdToBackend.get(id) || null,
          hadUserTurn: !!rel.hadUserTurn,
          depth: depthOfSession(id),
        };
      }),
    }));
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
      // HD4. `keep` names delegated descendants the user unchecked; they
      // survive as ROOT sessions. Everything else under this session goes.
      //
      // Keeping a child keeps its whole subtree with it: the recursion
      // follows the parent's fate, so a kept child's own children are not
      // orphaned into deletion behind its back.
      const keep = new Set(Array.isArray(body.keep) ? body.keep : []);
      const kept = new Set();
      for (const id of keep) {
        if (!isTreeChild(id)) continue;   // roster children are not optional
        kept.add(id);
        for (const sub of descendantsOfSession(id)) kept.add(sub);
      }
      const doomed = descendantsOfSession(body.sessionId).filter((id) => !kept.has(id));

      let cascaded = 0;
      const gone = [];
      for (const childId of doomed.slice().reverse()) {
        try {
          const rel = sessionRelations[childId] || {};
          const b = getBackend(rel.backend || sessionIdToBackend.get(childId) || defaultBackendId());
          await b.deleteSession(childId, sessions.get(childId)?.cwd);
          cascaded++;
          gone.push(childId);
        } catch (e) {
          // Best effort: one unreachable child must not block the delete the
          // user actually asked for.
          console.error(`[driver] delete cascade failed for child ${childId}:`, e.message);
        }
      }
      // Forget what ACTUALLY went, before attempting the parent. If the
      // parent's own delete then throws, the index still matches reality
      // instead of naming children whose transcripts are already gone —
      // found by testing a delete whose parent transcript was missing, which
      // left the tree half-deleted and permanently uncleanable.
      if (gone.length) {
        for (const id of gone) sessions.delete(id);
        forgetSessionRelations(gone);
      }
      const state = sessions.get(body.sessionId);
      const backend = backendFor(body.sessionId, body.backend);
      await backend.deleteSession(body.sessionId, state?.cwd);
      sessions.delete(body.sessionId);
      // A kept child becomes a root: its relation row is dropped so nothing
      // still thinks it is a child of a session that no longer exists.
      for (const id of kept) {
        if (sessionRelations[id]?.parent === body.sessionId) delete sessionRelations[id];
      }
      if (kept.size) saveSessionRelations();
      // Drop the relation rows of everything deleted too — otherwise the
      // index keeps naming children of a session that no longer exists, and
      // depth/root walks start from a phantom.
      forgetSessionRelations([body.sessionId]);
      // Mail addressed to a session that no longer exists can never be
      // delivered, so it would sit stuck forever inflating the parked count.
      const orphanMail = inbox.open().filter((e) => !sessions.has(e.to?.id)
        && (doomed.includes(e.to?.id) || e.to?.id === body.sessionId));
      for (const e of orphanMail) inbox.discard(e.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cascaded, kept: [...kept], droppedMail: orphanMail.length }));
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
      const backend = getBackend(body.backend || defaultBackendId());
      explicitCwd = backend.resolveValidCwd(body.cwd);
      if (!explicitCwd) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"cwd must be an existing directory under the workspace root"}');
        return;
      }
    }
    // A sub-agent's transcript is a record of delegated work, not a
    // conversation: the parent gave it a prompt and consumed its report, so
    // a human message injected here would steer an agent whose output the
    // parent already took, with no record of it on the parent's side. Refused
    // with a reason the UI can act on — "promote this to its own session" is
    // the supported way to carry on from a sub-agent's findings.
    if (isRosterChild(sessionId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "this is a sub-agent transcript and cannot be prompted",
        reason: "child-session",
        parentSessionId: parentOfSession(sessionId),
      }));
      return;
    }
    const started = startTurn(sessionId, body.text || "", {
      source: "human",
      explicitCwd,
      backendId: body.backend,
    });
    if (!started.ok) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: "a turn is already in progress in this session",
        reason: started.reason,
      }));
      return;
    }
    // Typing IS presence, so this turn has already reset the counter — and
    // therefore has to move the mail that reset unblocks. See
    // releaseAutonomyParked.
    releaseAutonomyParked();
    // Fire-and-forget: the actual reply streams via server.py's SSE feed,
    // not this HTTP response. Different sessions' calls run fully
    // concurrently — only a second prompt to the SAME session is rejected
    // above.
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === "POST" && path === "/permission-response") {
    // MD7: answering a card is the user directing the system.
    noteUserDirectedAction();
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
    persistPendingApprovals();
    if (isRosterChild(pending.sessionId)) {
      upsertSubAgent(pending.sessionId, { awaiting: null, awaitingId: null });
    }
    // Clear the parked-on-a-human state as soon as this session has nothing
    // else outstanding. Checked rather than assumed because a turn can have
    // more than one ask open at a time.
    if (!pendingKindForSession(pending.sessionId)) {
      broadcastStatus(pending.sessionId, { type: "awaiting_input", kind: null });
    }

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
      : (body.allow ? (body.always ? "Always allowed" : "Allowed") : "Denied");
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
      // `always` asks the backend to widen its own rules so this ask stops
      // recurring, rather than PodPrompt remembering a decision the backend
      // doesn't know about. Both support it natively: claude-code takes the
      // PermissionUpdate[] it suggested back as updatedPermissions, opencode
      // takes a reply scope of "always". The suggestions ride along so the
      // backend doesn't have to re-derive them.
      pending.resolve({
        allow: !!body.allow,
        message: body.message,
        always: !!body.always && !!body.allow,
        suggestions: pending.suggestions || null,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  // HD2's scoped kill. Originally "Stop chain", walking chainId — but §10
  // deleted chains, so it walks the PARENT EDGE instead, which is arguably
  // the better scope: the parent edge is a thing the user can SEE in the
  // session tree and aim at. A chain was never visible as a thing to aim at.
  //
  // Deliberately separate from /abort rather than a flag on it. Plain Stop
  // means "stop what this turn is doing"; this means "stop this whole line of
  // work, including sessions that are running on their own account". Those
  // are different enough that fat-fingering one for the other should not be
  // possible.
  if (req.method === "POST" && path === "/stop-subtree") {
    requireControl(req);
    noteUserDirectedAction();   // MD7
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const rootId = body.sessionId;
    if (!rootId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    let stopped = 0;
    // The root itself first, then everything below it, so nothing it is
    // actively waiting on gets a chance to start new work after we pass it.
    for (const id of [rootId, ...descendantsOfSession(rootId)]) {
      const st = sessions.get(id);
      if (!st?.turnInFlight) continue;
      try {
        st.abortRequested = true;
        const rel = sessionRelations[id] || {};
        const backend = st.backend
          || getBackend(rel.backend || sessionIdToBackend.get(id) || defaultBackendId());
        backend.abort(id, st);
        if (isRosterChild(id)) upsertSubAgent(id, { status: "killed" });
        stopped++;
      } catch (e) {
        console.error(`[driver] stop-subtree failed for ${id}:`, e.message);
      }
    }
    // Mail addressed into this subtree would otherwise wake it straight back
    // up, which would make the button look like it had not worked.
    const doomed = new Set([rootId, ...descendantsOfSession(rootId)]);
    // discard() takes ONE id, not a list — passing an array matched nothing
    // and returned no-such-entry, silently leaving the mail in place.
    const dropped = inbox.open().filter((e) => doomed.has(e.to?.id));
    for (const e of dropped) inbox.discard(e.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stopped, droppedMail: dropped.length }));
    return;
  }

  if (req.method === "POST" && path === "/abort") {
    noteUserDirectedAction();   // MD7
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const state = sessions.get(body.sessionId);
    if (state) {
      // Recorded before delegating so the turn_end broadcast in runTurn's
      // finally can report reason:"aborted" rather than mislabelling a
      // deliberate Stop as a clean finish. claude-code can work this out for
      // itself (it owns the AbortController), but opencode cannot — its
      // abort() is a fire-and-forget POST with no feedback into the turn
      // body — so capturing the user's intent here is what makes the two
      // backends behave identically. Cleared by that same finally.
      // Guarded on turnInFlight so a Stop clicked when nothing is running
      // can't leave the flag set and mislabel the NEXT turn as aborted —
      // runTurn's finally only clears it for turns that actually ran.
      if (state.turnInFlight) state.abortRequested = true;
      state.backend.abort(body.sessionId, state);
    }
    // HD2: the cascade follows THE WAIT, not the parent edge.
    //
    // The parent edge is DURABLE — who started whom, outliving any turn.
    // Stop is TURN-SCOPED. Walking one along the other produced a real
    // failure: delegate a long job on Monday (async, so the parent's turn
    // ends immediately), prompt that parent about something unrelated on
    // Tuesday, hit Stop, and the cascade found Monday's delegate still
    // running and killed it. Nothing about Tuesday's turn had anything to do
    // with it, and the better HD1 makes delegated children feel like real
    // sessions, the more wrong that is.
    //
    // So: this turn's roster children (a native sub-agent IS this turn —
    // on claude-code it dies with the process anyway, and an opencode one is
    // an independent session that would otherwise keep burning tokens on a
    // report nobody will read), plus any delegated child THIS turn is
    // blocked on via await=true. Async delegated children are left alone;
    // you stop those from their own session, or with /stop-subtree.
    for (const childId of abortCascadeTargets(body.sessionId)) {
      // Only ones actually running. Cascading unconditionally re-labelled
      // finished sub-agents as "killed" — so stopping a turn turned every
      // completed row in the roster red, rewriting history for work that had
      // already succeeded — and fired pointless aborts at sessions that had
      // long since ended. A child with no live status (one from a previous
      // process, say) is by definition not running here.
      if (!isSubAgentRunning(childId)) continue;
      try {
        const childState = sessions.get(childId);
        const rel = sessionRelations[childId] || {};
        const backend = getBackend(rel.backend || sessionIdToBackend.get(childId) || defaultBackendId());
        if (childState?.turnInFlight) childState.abortRequested = true;
        backend.abort(childId, childState);
        // Roster entries only. A delegated child has no roster row under
        // HD1, and writing one here would conjure a sub-agent into a panel
        // that is supposed to contain nothing but native sub-agents.
        if (isRosterChild(childId)) upsertSubAgent(childId, { status: "killed" });
      } catch (e) {
        console.error(`[driver] abort cascade failed for child ${childId}:`, e.message);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(404);
  res.end();
});

// 0.0.0.0 by default because under Docker's default bridge network a service
// bound to 127.0.0.1 inside the container is not reachable through a -p publish
// at all; the publish itself (-p 127.0.0.1:PORT:PORT) is what scopes it. Under
// --host-network there is no namespace and no publish, so 0.0.0.0 would put
// THIS control plane — pause, delete, auto-approve, and everything §10 adds —
// on every host interface. podprompt.sh sets PODPROMPT_BIND_ADDR=127.0.0.1 in
// that mode. Defaulted rather than required so running the driver by hand, or
// from an older launcher, behaves as it always did.
const BIND_ADDR = process.env.PODPROMPT_BIND_ADDR || "0.0.0.0";

server.listen(args.port, BIND_ADDR, () => {
  console.log(`[driver] listening on ${BIND_ADDR}:${args.port}, forwarding to viewer at ${VIEWER_MESSAGE_URL}`);
  console.log(`[driver] new-chat default backend: ${defaultBackendId()}`);
  console.log("[driver] multi-session — no pinned session id; each request names its own target");
});
