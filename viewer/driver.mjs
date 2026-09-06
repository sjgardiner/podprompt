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
//
// Status payload types broadcast via broadcastStatus (beyond the older
// turn_start/turn_end/thinking_tokens/tool_progress/stream_start/
// stream_delta set): context_usage {percentage,totalTokens,maxTokens},
// compacting {active,result?,error?}, plan_usage {subscription_type,
// rate_limits} (Claude Code only — null/null when not on a real
// subscription-backed session, e.g. LiteLLM/API-key/Bedrock/Vertex), and
// spend {totalCostUsd} (OpenCode's analogue of plan_usage — no plan/quota
// concept exists there, just a running cost accumulator).
//
// Multi-session concurrency: every piece of turn-related state (bootstrap
// status, in-flight flag, abort controller, cwd, backend) is keyed by
// session id in the `sessions` Map below, instead of being a single set of
// module-level variables — this is what lets turns in different sessions
// run fully concurrently regardless of backend.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
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

async function broadcast(sessionId, role, text, id, ts) {
  try {
    await fetch(VIEWER_MESSAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, role, text, id, ts: ts || nowIso() }),
    });
  } catch (e) {
    console.error("[driver] failed to broadcast to viewer:", e.message);
  }
}

async function broadcastStatus(sessionId, payload) {
  try {
    await fetch(VIEWER_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, ...payload }),
    });
  } catch (e) {
    console.error("[driver] failed to broadcast status:", e.message);
  }
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
// Returns a Promise that resolves with whatever /permission-response passed
// (a plain {allow, message} decision for a permission ask, or a raw string
// answer for a question) — the backend decides how to interpret that.
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
  // start-viewer.sh always launches a headless `opencode serve` on this
  // same port regardless of which backend is the default (see its own
  // comments) — baseUrl just needs to agree with whatever port that was
  // actually started on.
  "opencode": createOpenCodeBackend({ ...backendHooks, baseUrl: `http://127.0.0.1:${args.opencodePort}` }),
};

function getBackend(id) {
  const b = backends[id];
  if (b) return b;
  console.error(`[driver] unknown backend "${id}", falling back to claude-code`);
  return backends["claude-code"];
}

// Eagerly warm each backend's model/command cache right now, rather than
// waiting for the first browser-triggered call. For claude-code this
// accomplishes nothing (knownModels/knownCommands can only ever be filled in
// as a side effect of a real turn completing somewhere — an architectural
// limitation, not a caching one — so calling these now just returns the same
// empty defaults a moment sooner) but it's a harmless no-op: both methods
// are synchronous, side-effect-free reads of existing module state. For
// opencode it's a real improvement: GET /config/providers and GET /command
// need no session/turn to exist, only a reachable `opencode serve`, so
// firing them now means a session that never sends a single message can
// still see a populated model/command picker. Safe to fire before
// `opencode serve` has finished its ~1s cold start because both fetch
// functions now retry-on-failure (they clear their own "started" guard in
// the catch block) rather than permanently caching a transient connection
// failure — see fetchProviderListInBackground/fetchKnownCommandsInBackground
// in backends/opencode.mjs.
for (const backend of Object.values(backends)) {
  if (typeof backend.getKnownCommands === "function") backend.getKnownCommands();
  if (typeof backend.listModels === "function") backend.listModels();
}

// Tracks which backend ids are currently failing /sessions, so the poll
// loop below (the sessions panel refetches every few seconds) logs a
// transition — "started failing" / "recovered" — exactly once each, instead
// of the same "fetch failed" line once per poll forever. Both backends are
// expected to be reachable in a normal deployment (start-viewer.sh starts
// `opencode serve` itself now), so a *sustained* failure here usually means
// something genuinely worth looking at — a manual/non-standard launch that
// skipped starting `opencode serve`, or it crashing after startup — not a
// permanently-expected condition to just ignore; a brief failure right at
// container startup (before `opencode serve` finishes its ~1s cold start)
// is the one benign case and is exactly what the log-once-on-transition
// behavior below is for.
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
    const history = await backend.getSessionHistory(sessionId, state?.cwd);
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
    const modes = await backend.listModes(sessionId);
    if (modes && state) modes.current = state.mode || modes.current || null;
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
    const models = await backend.listModels(sessionId);
    if (models && state) models.current = state.model || models.current || null;
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
      pending.resolve(body.answer);
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
