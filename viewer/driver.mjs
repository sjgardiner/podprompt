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
  createChains, BUDGET_PRESETS, DEFAULT_PRESET,
  FANOUT_CAP_PER_TURN, MAX_CREATION_DEPTH,
} from "./chains.mjs";
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
    if (isChildSession(sessionId)) {
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
    if (isChildSession(sessionId)) {
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
  },
};
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
    childKind: info.childKind || prev.childKind || null, // "native-task" | "delegated-session"
    subagentType: info.subagentType ?? prev.subagentType ?? null,
    description: info.description ?? prev.description ?? null,
    native: { ...(prev.native || {}), ...(info.native || {}) },
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

function isChildSession(sessionId) {
  return !!parentOfSession(sessionId);
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

function subAgentsForParent(parentId) {
  return childrenOfSession(parentId).map((childId) => {
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

// ── Chains, budgets & pause ──────────────────────────────────────────────
// The store itself lives in chains.mjs so it can be unit-tested without
// starting a server or spawning `opencode serve`. This is the code where a
// quiet logic error costs real money, so it is the code that most needs
// tests that do not depend on a running system.
const chains = createChains({
  file: nodePath.join(PODPROMPT_STATE_DIR, "viewer-chains.json"),
  onError: (e) => console.error("[driver] failed to write chains file:", e.message),
});

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

function markTurnStarted(sessionId) {
  turnState[sessionId] = { inFlight: true, startedAt: nowIso(), lastTool: null };
  saveTurnState();
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

function maybeDrainInbox(sessionId) {
  // Global pause halts automatic delivery while leaving typed prompts
  // working, so this check belongs here and not in startTurn.
  if (chains.isGloballyPaused()) return false;
  if (!sessionIsIdle(sessionId)) return false;
  const group = inbox.nextDrainGroup(sessionId);
  if (!group.length) return false;
  // One sender gets named; several become "peer" without a handle, since no
  // single name would be honest about a coalesced delivery.
  const senders = new Set(group.map((e) => describeSender(e)));
  const originLabel = senders.size === 1
    ? `${group[0].kind === "result" ? "result" : "peer"}:${[...senders][0]}`
    : "peer";
  const started = startTurn(sessionId, composeDelivery(group), {
    source: "peer",
    origin: originLabel,
    chainId: group[0].chainId,
  });
  console.log(`[driver] drain -> ${sessionId}: ${group.length} msg(s), startTurn=${JSON.stringify(started)}`);
  if (!started.ok) {
    // Left queued on purpose. A refusal here is a transient condition (the
    // chain was paused between enqueue and drain, the session became busy),
    // and the next idle moment retries.
    return false;
  }
  inbox.markDelivered(group.map((e) => e.id));
  return true;
}

function drainAllInboxes() {
  for (const sessionId of inbox.sessionsWithPending()) maybeDrainInbox(sessionId);
}

// Conditions a user can lift. Anything else is a hard failure, not a thing
// to park: there would be nothing to press.
const PARKABLE_REASONS = new Set(["steps", "deadline", "global", "chain"]);

// A parked message has NOT been charged, so releasing it has to re-attempt
// the spend. Doing it here rather than at each call site is what stops a
// release path from quietly starting a turn for free — which is what the
// first cut of /extend-chain did.
function releaseParked(entry) {
  const spent = chains.spend(entry.chainId);
  if (!spent.ok) {
    // Still blocked, possibly for a different reason than before (extended
    // past the step limit but the deadline has since passed). Re-label it so
    // the UI explains the CURRENT obstacle rather than the original one.
    if (PARKABLE_REASONS.has(spent.reason)) inbox.park(entry.id, spent.reason);
    return { ok: false, reason: spent.reason };
  }
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
function deliver(toAddr, text, { from, kind = "peer", chainId }) {
  const resolved = peers.resolve(toAddr);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, to: toAddr };
  const to = resolved.ref;

  const auth = authorizeDelivery(from, to);
  if (!auth.allowed) return { ok: false, reason: auth.reason, to };

  const spent = chains.spend(chainId);
  if (!spent.ok) {
    // Parking is only meaningful for a condition the user can later LIFT:
    // out of steps, past the deadline, or paused. A message naming a chain
    // that does not exist has nothing to extend or resume, so parking it
    // would leave permanently stuck garbage inflating the badge the user is
    // supposed to trust. Those are rejected outright.
    if (!PARKABLE_REASONS.has(spent.reason)) {
      return { ok: false, reason: spent.reason, chainId };
    }
    // PARKED, not failed: the message becomes an inbox entry marked
    // undelivered, which extending or resuming releases and ignoring costs
    // nothing. The sender is still told immediately so it can wrap up
    // rather than wait. No step is spent — the spend is re-attempted at
    // release, so a parked message cannot be charged twice or charged for
    // work that never happened.
    const entry = inbox.enqueue({
      to, from, fromHandle: peers.get(from.id)?.handle || null, text, kind, chainId,
    });
    inbox.park(entry.id, spent.reason);
    broadcastStatus(to.id, { type: "inbox_changed" });
    return { ok: false, reason: spent.reason, parked: true, entryId: entry.id, chainId };
  }

  const entry = inbox.enqueue({
    to, from, fromHandle: peers.get(from.id)?.handle || null, text, kind, chainId,
  });
  const deliveredNow = maybeDrainInbox(to.id);
  broadcastStatus(to.id, { type: "inbox_changed" });
  return {
    ok: true,
    entryId: entry.id,
    delivered: deliveredNow,
    queued: !deliveredNow,
    remaining: spent.remaining,
    to,
  };
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
      subAgent: isChildSession(s.sessionId),
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
  // Everything automatic belongs to the chain the caller is running under.
  // No chain means no budget to spend, which means this is not a turn that
  // should be able to cause more work.
  const chainId = state?.chainId;
  if (!chainId) return { ok: false, reason: "no-chain" };
  // Breadth, checked before the step is spent: a step budget bounds depth
  // but not fan-out, and fan-out is where the expensive failure lives.
  const fan = noteFanout(state);
  if (!fan.ok) return { ok: false, reason: fan.reason, cap: fan.cap };
  // A session's FIRST outbound message necessarily happens before it has a
  // title, so its handle would otherwise be the provisional fallback and the
  // recipient would see "@session". The chain is named after the prompt the
  // user typed to start this work, which is both available here and exactly
  // the kind of name a session title would have ended up with anyway.
  peers.ensure(fromSessionId, {
    backend: sessionIdToBackend.get(fromSessionId) || null,
    title: peers.get(fromSessionId)?.title || chains.get(chainId)?.rootPrompt || null,
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
    chainId,
  });
}

function parentBackendId(sessionId) {
  return sessionIdToBackend.get(sessionId) || null;
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
async function toolDelegate(fromSessionId, { backend, prompt, title, awaitResult = false, model = null }) {
  const state = sessions.get(fromSessionId);
  const chainId = state?.chainId;
  if (!chainId) return { ok: false, reason: "no-chain" };
  if (!backends[backend]) return { ok: false, reason: "unknown-backend", backend };
  if (!String(prompt || "").trim()) return { ok: false, reason: "empty-prompt" };

  // Breadth before depth: a step budget bounds how long a chain runs, not
  // how wide it goes, and width is where the expensive failure lives.
  const fan = noteFanout(state);
  if (!fan.ok) return { ok: false, reason: fan.reason, cap: fan.cap };
  // Counted along creation lineage, so promotion cannot reset it (PD9).
  if (creationDepthExceeded(fromSessionId)) {
    return { ok: false, reason: "depth-cap", max: MAX_CREATION_DEPTH };
  }
  const spent = chains.spend(chainId);
  if (!spent.ok) return { ok: false, reason: spent.reason, chainId };

  // PodPrompt mints the id (C1). The opencode backend expects its client
  // ids to be distinguishable from its own ses_... ids.
  const childId = backend === "opencode" ? `oc-${randomUUID()}` : randomUUID();
  const childTitle = String(title || prompt).slice(0, 80);

  // The parent has to be addressable for its own child's report to reach
  // it in the async case.
  peers.ensure(fromSessionId, {
    backend: parentBackendId(fromSessionId),
    title: peers.get(fromSessionId)?.title || chains.get(chainId)?.rootPrompt || null,
  });
  registerChildSession(childId, {
    parent: fromSessionId,
    backend,
    // Distinct from "native-task": a delegated child is a REAL session on
    // its backend, which is why promotion needs no seeding for it.
    childKind: "delegated",
    description: childTitle,
    createdBy: fromSessionId,
  });
  peers.ensure(childId, { title: childTitle, backend });

  // C7: a model id means nothing to another backend, so it is only carried
  // across when the backends match. Otherwise the child takes its own
  // backend's default.
  const parentBackend = sessionIdToBackend.get(fromSessionId) || null;
  const inherited = (!model && parentBackend === backend) ? state?.model : null;
  const chosenModel = model || inherited || null;
  if (chosenModel) preSeeds.set(childId, { ...(preSeeds.get(childId) || {}), model: chosenModel });

  // Auto-approve is NOT set here: it resolves through the parent edge at
  // decision time (autoApproveForSession), so a child is exactly as
  // privileged as its parent and follows it if the user changes their mind
  // mid-task.
  // Registered BEFORE the turn starts, for both paths. Attaching afterwards
  // races a child that finishes quickly: the waiter would be added after
  // the resolve had already fired, and a blocking delegate would hang
  // forever on a turn that was already over.
  const waiter = awaitTurnEnd(childId);
  const started = startTurn(childId, prompt, {
    source: "delegate",
    origin: `delegate:@${peers.get(fromSessionId)?.handle || fromSessionId}`,
    chainId,
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
    watchDelegateForReport(waiter, childId, fromSessionId, chainId);
    return { ok: true, handle, childId, awaited: false, remaining: spent.remaining };
  }

  const outcome = await waiter;
  const text = await finalAssistantText(childId);
  return {
    ok: true, handle, childId, awaited: true,
    outcome: outcome?.reason || "completed",
    text, remaining: spent.remaining,
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
function watchDelegateForReport(waiter, childId, parentId, chainId) {
  waiter.then(async (outcome) => {
    const text = await finalAssistantText(childId);
    const handle = peers.get(childId)?.handle || childId;
    const body = text
      ? `Delegated work finished (${outcome?.reason || "completed"}):\n\n${text}`
      : `Delegated work ended with no output (${outcome?.reason || "completed"}).`;
    const receipt = deliver(parentId, body, {
      from: localPrincipal(childId),
      kind: "result",
      chainId,
    });
    if (!receipt.ok) {
      console.error(`[driver] delegated report from @${handle} not delivered: ${receipt.reason}`);
    }
  }).catch((e) => console.error(`[driver] delegate watcher failed for ${childId}:`, e.message));
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
  // Per-session budget defaults are keyed by session id too, so they would
  // otherwise outlive the sessions they describe.
  chains.forgetSessions(ids);
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
  source = "human", explicitCwd, backendId,
  chainId = null, preset = null, custom = null, origin = null, chainLabel = null,
} = {}) {
  const state = getSessionState(sessionId, explicitCwd, backendId);
  if (state.turnInFlight) {
    return { ok: false, reason: "busy" };
  }
  // Chain assignment lives here precisely BECAUSE this is the single entry
  // point. Putting it in the /prompt handler would mean every later caller
  // — a delegation, a peer delivery — needed its own copy, and the copies
  // would drift apart exactly the way the in-flight check would have.
  let chain;
  // "resume" mints its own chain alongside "human": clicking Continue IS the
  // user acting, and the trust root is the human, not the keystrokes.
  if (source === "human" || source === "resume") {
    const fallback = chains.getSessionPreset(sessionId);
    chain = chains.mint({
      // Chains are named after the prompt that created them, which is what
      // makes Extend and Pause legible. A resume's prompt is boilerplate, so
      // it supplies its own label — otherwise the panel fills with rows all
      // called "Your previous turn was interrupted...".
      rootPrompt: chainLabel || promptText,
      originSession: sessionId,
      preset: preset || fallback.preset,
      custom: preset ? custom : fallback.custom,
    });
    if (!chain) return { ok: false, reason: "invalid-budget" };
  } else {
    // Everything automatic must name the chain it belongs to. Minting one
    // here instead would make "create a session and prompt it" a way to buy
    // an unlimited fresh budget for the price of one tool call.
    chain = chains.get(chainId);
    if (!chain) return { ok: false, reason: "no-such-chain" };
    const status = chains.status(chain);
    if (status.state !== "active") {
      return { ok: false, reason: status.reason, chainState: status.state, chainId: chain.id };
    }
  }
  state.chainId = chain.id;
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
  return { ok: true, chainId: chain.id };
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
    resolveTurnWaiters(sessionId, outcome);
  }
}

// sessionId -> [resolve]. Deliberately a list: nothing stops two callers
// awaiting the same session.
const turnWaiters = new Map();

function awaitTurnEnd(sessionId) {
  return new Promise((resolve) => {
    const list = turnWaiters.get(sessionId) || [];
    list.push(resolve);
    turnWaiters.set(sessionId, list);
  });
}

function resolveTurnWaiters(sessionId, outcome) {
  const list = turnWaiters.get(sessionId);
  if (!list?.length) return;
  turnWaiters.delete(sessionId);
  for (const resolve of list) {
    try { resolve(outcome); } catch { /* a waiter's own failure is not ours */ }
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
      isChild: sessionId ? isChildSession(sessionId) : false,
      parentSessionId: sessionId ? parentOfSession(sessionId) : null,
      autoApprove: effectiveAutoApprove(sessionId, state),
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
    res.end(JSON.stringify({ subAgents: sessionId ? subAgentsForParent(sessionId) : [] }));
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
  if (req.method === "POST" && path === "/promote-session") {
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
      res.end('{"error":"not a promotable sub-agent"}');
      return;
    }
    // Not while it is still working. Promotion severs the parent link, so a
    // running sub-agent promoted mid-flight drops out of the parent's abort
    // cascade and its roster — the parent could no longer stop it, and the
    // work would carry on somewhere nobody is watching. The same reasoning
    // as refusing to Forget a running sub-agent.
    if (isSubAgentRunning(childId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "stop this sub-agent before promoting it", reason: "still-running" }));
      return;
    }
    sessionRelations[childId] = { ...rel, promoted: true, promotedAt: nowIso() };
    saveSessionRelations();
    subAgents.delete(childId);
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
      history = await backend.getSessionHistory(sessionId, state?.cwd, sessionRelations[sessionId] || null);
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

      const sessionHosts = loadSessionHosts();
      const currentHostPath = process.env.HOST_WORKSPACE_PATH || null;
      const annotateHost = (s) => {
        const rec = sessionHosts[s.sessionId];
        s.lastKnownHostPath = rec?.hostPath || null;
        s.hostMismatch = !!(currentHostPath && rec?.hostPath && rec.hostPath !== currentHostPath);
        return s;
      };
      allSessions.forEach(annotateHost);
      if (unreachableSessions) unreachableSessions.forEach(annotateHost);

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

  // ── Chains, budgets & pause ───────────────────────────────────────────
  // NOTE (PD10): these routes are presently reachable unauthenticated by any
  // agent with Bash, exactly like every other driver route. That is a
  // pre-existing exposure, but these are the routes it matters most for,
  // since they are the controls meant to restrain agents. Hardening (a
  // browser-held token, `authenticate(request) -> principal`) is Phase 16.
  if (req.method === "GET" && path === "/chains") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      chains: chains.list(),
      globalPaused: chains.isGloballyPaused(),
      globalPausedAt: chains.globalPausedAt(),
      presets: Object.fromEntries(
        Object.entries(BUDGET_PRESETS).map(([k, v]) => [k, { label: v.label, steps: v.steps, ms: v.ms }])),
      defaultPreset: DEFAULT_PRESET,
      fanoutCap: FANOUT_CAP_PER_TURN,
      maxCreationDepth: MAX_CREATION_DEPTH,
      sessionPreset: url.searchParams.get("session")
        ? chains.getSessionPreset(url.searchParams.get("session"))
        : null,
    }));
    return;
  }

  if (req.method === "POST" && path === "/pause") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const paused = !!body.paused;
    // Global pause is the breaker you reach for before you know which chain
    // is at fault; per-chain is the one that stops a runaway without
    // freezing unrelated overnight work. Both, from one route.
    const result = body.chainId ? chains.setPaused(body.chainId, paused) : chains.setGlobalPaused(paused);
    if (!result.ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    // The destructive half, and a SEPARATE deliberate action rather than
    // part of pausing: pause is reversible, while aborting in-flight turns
    // throws away work that may be nearly finished. Done here rather than in
    // the browser because the driver knows exactly which sessions are
    // running — the browser would have to guess from chain origins and would
    // miss any session running a turn it did not start.
    let stopped = 0;
    if (paused && body.stopRunning) {
      for (const [sessionId, state] of sessions) {
        if (!state.turnInFlight) continue;
        state.abortRequested = true;
        try { state.backend.abort(sessionId, state); stopped++; } catch (e) {
          console.error(`[driver] stop-running abort failed for ${sessionId}:`, e.message);
        }
      }
    }
    if (!paused) {
      // Resuming must move the mail the pause was HOLDING, not just the mail
      // that happened to be queued: messages that arrived while paused were
      // parked, and draining alone would leave them sitting there with the
      // pause visibly lifted.
      releaseParkedFor((e) => (body.chainId
        ? e.chainId === body.chainId && e.parkedReason === "chain"
        : e.parkedReason === "global"));
      drainAllInboxes();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      globalPaused: chains.isGloballyPaused(),
      chain: body.chainId ? chains.summary(chains.get(body.chainId)) : null,
      stopped,
    }));
    return;
  }

  if (req.method === "POST" && path === "/extend-chain") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const result = chains.extend(body.chainId, {
      steps: Number(body.steps) || 0,
      ms: Number(body.ms) || 0,
    });
    if (!result.ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    // Extending is what RELEASES the messages that were parked for running
    // out — the parked entry is the work waiting to resume, so topping up
    // the chain without releasing them would be a button that appears to do
    // nothing.
    const released = releaseParkedFor((e) =>
      e.chainId === body.chainId && (e.parkedReason === "steps" || e.parkedReason === "deadline"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, chain: chains.summary(result.chain), released: released.length }));
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
      chain: chains.summary(chains.get(e.chainId)),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      entries,
      // Only PARKED entries count as stuck. Transient queueing behind a busy
      // target resolves in seconds, and a badge that counted it would
      // flicker all day until the user stopped seeing it.
      stuckCount: inbox.stuck().length,
      globalPaused: chains.isGloballyPaused(),
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
        // A deliberate user override: it lets ONE message through without
        // re-arming the work that produced it. It still charges a step when
        // the chain can pay, so the budget keeps describing what actually
        // ran; when the chain cannot pay, the user's explicit instruction
        // wins and the release happens anyway.
        const spent = chains.spend(entry.chainId);
        result = inbox.release(entryId);
        if (result.ok) maybeDrainInbox(entry.to?.id);
        if (result.ok) result.charged = spent.ok;
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
      ...(resumable && !isChildSession(sessionId) ? {
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
    if (!resumable || isChildSession(sessionId)) {
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
      chainLabel: label,
    });
    if (!started.ok) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "could not resume", reason: started.reason }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, chainId: started.chainId }));
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

  if (req.method === "POST" && path === "/budget-preset") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const result = chains.setSessionPreset(body.sessionId, body.preset, body.custom || null);
    if (!result.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.reason }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, preset: result.preset, custom: result.custom }));
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
      const doomed = descendantsOfSession(body.sessionId);
      const cascaded = await cascadeToDescendants(body.sessionId,
        (backend2, childId, childState) => backend2.deleteSession(childId, childState?.cwd), "delete");
      const state = sessions.get(body.sessionId);
      const backend = backendFor(body.sessionId, body.backend);
      await backend.deleteSession(body.sessionId, state?.cwd);
      for (const childId of doomed) sessions.delete(childId);
      sessions.delete(body.sessionId);
      // Drop the relation rows too — otherwise the index keeps naming
      // children of a session that no longer exists, and depth/root walks
      // start from a phantom.
      forgetSessionRelations([...doomed, body.sessionId]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cascaded }));
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
    if (isChildSession(sessionId)) {
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
    // Fire-and-forget: the actual reply streams via server.py's SSE feed,
    // not this HTTP response. Different sessions' calls run fully
    // concurrently — only a second prompt to the SAME session is rejected
    // above.
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
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
    persistPendingApprovals();
    if (isChildSession(pending.sessionId)) {
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
    // Cascade to descendants, each through its own backend. On claude-code a
    // sub-agent dies with the parent's process anyway, but an opencode child
    // is an independent session on a separate server that knows nothing
    // about the parent — stopping the parent alone would leave it running,
    // burning tokens on a report nobody will read. This is also the hard
    // precondition for ever declaring perTaskStopAffordance, which flips
    // claude-code's interrupt from killing background tasks to sparing them.
    for (const childId of descendantsOfSession(body.sessionId)) {
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
        upsertSubAgent(childId, { status: "killed" });
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

server.listen(args.port, "0.0.0.0", () => {
  console.log(`[driver] listening on port ${args.port}, forwarding to viewer at ${VIEWER_MESSAGE_URL}`);
  console.log(`[driver] new-chat default backend: ${defaultBackendId()}`);
  console.log("[driver] multi-session — no pinned session id; each request names its own target");
});
