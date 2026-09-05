#!/usr/bin/env node
// Bidirectional driver for the Claude Code viewer.
//
// Accepts prompts from the browser, drives them through the Claude Agent SDK
// (query() — spawn-per-turn, threaded via `resume`, NOT a persistent stdin-fed
// process), and is the SOLE broadcaster of everything the browser shows —
// user prompts, assistant text, tool calls, and permission/question requests
// — all POSTed to server.py's /message endpoint using the SDK's own message
// uuids as ids (both assistant-message uuids and, for the user's own prompt,
// a uuid we supply ourselves via the one-item-async-generator prompt form;
// both confirmed empirically this session to land unchanged as the
// transcript entry's own `uuid`, though nothing else ever reads that file —
// this server no longer tails it at all).
//
// There used to be a file-tailing fallback here so a --tui-fallback terminal
// would also be reflected in the browser; that was deliberately cut. Mixing
// two independent broadcast sources meant a bug in this driver's own logic
// could be silently papered over by the tailer picking up the same content
// moments later — exactly the ambiguity you don't want while testing the
// driver itself. If you switch to the TUI fallback, the browser goes stale
// until you switch back; that's an accepted tradeoff, not an oversight.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  query, listSessions, getSessionMessages, tagSession, renameSession, deleteSession,
} from "@anthropic-ai/claude-agent-sdk";

function parseArgs(argv) {
  const args = { port: 7844, viewerPort: 7843, cwd: "/workspace", sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--viewer-port") args.viewerPort = Number(argv[++i]);
    else if (a === "--cwd") args.cwd = argv[++i];
    else if (a === "--session-id") args.sessionId = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const VIEWER_MESSAGE_URL = `http://127.0.0.1:${args.viewerPort}/message`;
const VIEWER_STATUS_URL = `http://127.0.0.1:${args.viewerPort}/status`;
const VIEWER_RESET_URL = `http://127.0.0.1:${args.viewerPort}/reset`;

// ── Session bootstrap state ────────────────────────────────────────────────
// The pinned session id is shared with server.py (same --session-id
// start-viewer.sh generates). First call in this process's lifetime tries
// `sessionId` (create fresh); if that fails (e.g. a --tui-fallback terminal
// already created it first), falls back to `resume` instead. Untested: the
// exact error shape the SDK throws for "session already exists" — this
// fallback is defensive, not verified against a real double-launch race.
let sessionId = args.sessionId;
let sessionBootstrapped = false;

// ── Available commands, refreshed from every turn's system/init message ────
// (the SDK's supportedCommands() is a method on a live Query object, not a
// standalone function — there's no way to fetch this before the first turn
// without keeping an idle Query warm, which we don't do here. Simple
// tradeoff: the palette is empty until the first prompt has been sent once.)
let knownCommands = { slash_commands: [], terminal_slash_commands: [], skills: [] };

// ── Pending permission/question approvals, keyed by request id ────────────
const pendingApprovals = new Map(); // id -> { resolve }

// ── In-flight turn, for /abort and for rejecting overlapping submissions ──
let activeAbortController = null;
let turnInFlight = false;

function nowIso() {
  return new Date().toISOString();
}

async function broadcast(role, text, id, ts) {
  try {
    await fetch(VIEWER_MESSAGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, text, id, ts: ts || nowIso() }),
    });
  } catch (e) {
    console.error("[driver] failed to broadcast to viewer:", e.message);
  }
}

async function broadcastStatus(payload) {
  try {
    await fetch(VIEWER_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("[driver] failed to broadcast status:", e.message);
  }
}

function summarizeToolInput(toolInput) {
  if (typeof toolInput !== "object" || toolInput === null) {
    return String(toolInput);
  }
  const preferredKeys = ["command", "file_path", "pattern", "query", "url", "description"];
  let text = null;
  for (const key of preferredKeys) {
    if (key in toolInput) {
      text = String(toolInput[key]);
      break;
    }
  }
  if (text === null) text = JSON.stringify(toolInput);
  return text.length <= 200 ? text : text.slice(0, 200) + "…";
}

function truncate(text, max) {
  return text.length <= max ? text : text.slice(0, max) + "\n… (truncated)";
}

// Plain-JS line diff (LCS-based) so Edit/Write tool calls can render a real
// diff in the browser without adding an npm dependency — the deployed copy
// is just file-copied, not npm-installed, so a new dependency would mean
// remembering to also vendor node_modules on every deploy. O(n*m) DP table;
// fine for typical old_string/new_string sizes. Capped below for huge edits.
function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  if (n * m > 400000) {
    return `- (${n} lines, too large to diff)\n+ (${m} lines, too large to diff)`;
  }
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(`  ${a[i]}`);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push(`- ${a[i]}`);
      i++;
    } else {
      lines.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) { lines.push(`- ${a[i]}`); i++; }
  while (j < m) { lines.push(`+ ${b[j]}`); j++; }
  return lines.join("\n");
}

// Richer tool summary for Edit/MultiEdit/Write, showing an actual diff
// instead of the one-line truncated preview summarizeToolInput() gives every
// other tool. Falls through to summarizeToolInput() for anything else.
function formatToolSummary(toolName, toolInput) {
  if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput?.new_string === "string") {
    const diff = diffLines(toolInput.old_string, toolInput.new_string);
    return `\`Edit\` ${toolInput.file_path || ""}\n\`\`\`diff\n${truncate(diff, 4000)}\n\`\`\``;
  }
  if (toolName === "MultiEdit" && Array.isArray(toolInput?.edits)) {
    const parts = toolInput.edits.map((e, idx) =>
      `--- edit ${idx + 1} ---\n${diffLines(e.old_string || "", e.new_string || "")}`);
    return `\`MultiEdit\` ${toolInput.file_path || ""}\n\`\`\`diff\n${truncate(parts.join("\n"), 4000)}\n\`\`\``;
  }
  if (toolName === "Write" && typeof toolInput?.content === "string") {
    return `\`Write\` ${toolInput.file_path || ""}\n\`\`\`\n${truncate(toolInput.content, 4000)}\n\`\`\``;
  }
  return `\`${toolName}\` ${summarizeToolInput(toolInput)}`;
}

// ── Session picker support ───────────────────────────────────────────────
// Converting getSessionMessages() results into our {role, text, id, ts}
// shape mirrors the parsing logic the retired transcript tailer used to do
// against raw JSONL lines (preserved in git history) — same shapes, just fed
// from this cleaner SDK function instead. One known gap: SessionMessage
// carries no per-entry timestamp, so historically-loaded messages get
// ts: null (formatTs() in viewer.html already renders that as blank, not an
// error). Another: unlike the live path, this doesn't distinguish a
// task-notification "user" entry as its own "agent" role — a minor fidelity
// loss versus the live broadcast path, not a functional gap.
function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n\n");
  }
  return "";
}

function toolUsesFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "tool_use");
}

function isRealUserPrompt(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) {
    const hasText = content.some((b) => b && b.type === "text");
    const hasToolResult = content.some((b) => b && b.type === "tool_result");
    return hasText && !hasToolResult;
  }
  return false;
}

function convertSessionMessages(rawMessages) {
  const out = [];
  for (const entry of rawMessages) {
    if (entry.parent_agent_id) continue; // subagent-internal, skip (mirrors the old isSidechain filter)
    const content = entry.message?.content;

    if (entry.type === "assistant") {
      const text = extractTextFromContent(content);
      if (text.trim()) out.push({ role: "assistant", text, id: entry.uuid, ts: null });
      for (const tu of toolUsesFromContent(content)) {
        out.push({ role: "tool", text: formatToolSummary(tu.name, tu.input), id: tu.id, ts: null });
      }
    } else if (entry.type === "user" && isRealUserPrompt(content)) {
      const text = extractTextFromContent(content);
      if (text.trim()) out.push({ role: "user", text, id: entry.uuid, ts: null });
    }
  }
  return out;
}

// ── Shared session-switch machinery ─────────────────────────────────────────
// Used by the explicit /switch-session and /new-session endpoints, and by
// /archive-session when archiving the currently-active session — which needs
// to move somewhere sensible automatically (most-recently-used other active
// session, or a fresh chat if none remain) rather than leave the driver
// pointed at a session that just dropped out of the active list.
async function postReset(messages) {
  await fetch(VIEWER_RESET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

async function switchToSession(targetId) {
  const raw = await getSessionMessages(targetId, { dir: args.cwd });
  const converted = convertSessionMessages(raw);
  sessionId = targetId;
  sessionBootstrapped = true;
  await postReset(converted);
}

async function startNewSession() {
  sessionId = null;
  sessionBootstrapped = false;
  knownCommands = { slash_commands: [], terminal_slash_commands: [], skills: [] };
  await postReset([]);
}

// ── canUseTool: permission approval + AskUserQuestion, both via the browser ─
async function canUseTool(toolName, toolInput, options) {
  const id = randomUUID();

  if (toolName === "AskUserQuestion") {
    const answer = await new Promise((resolve) => {
      pendingApprovals.set(id, { resolve, kind: "question", toolName, toolInput });
      broadcast(
        "permission",
        JSON.stringify({ kind: "question", toolName, toolInput }),
        id
      );
    });
    // Verified this session: canUseTool fires for AskUserQuestion, but
    // `allow` alone leaves it unanswered ("The user did not answer the
    // questions"). Denying with a crafted message is the mechanism that
    // actually works — Claude treats the message as the real answer.
    return { behavior: "deny", message: `The user answered: ${answer}` };
  }

  const decision = await new Promise((resolve) => {
    pendingApprovals.set(id, { resolve, kind: "permission", toolName, toolInput });
    broadcast(
      "permission",
      JSON.stringify({ kind: "permission", toolName, toolInput }),
      id
    );
  });

  if (decision && decision.allow) {
    return { behavior: "allow", updatedInput: toolInput };
  }
  return { behavior: "deny", message: (decision && decision.message) || "Denied by user" };
}

// ── Drive one turn ───────────────────────────────────────────────────────────
// The prompt is wrapped in a one-item async generator (still fully
// spawn-per-turn — this doesn't reintroduce a persistent process) rather than
// passed as a bare string, specifically so we can supply our own uuid for the
// user's message. Verified this session: that uuid lands unchanged as the
// transcript entry's own `uuid` for this turn (same property already
// confirmed for assistant messages) — so broadcasting it immediately, before
// query() even starts, gives correct chronological ordering with no risk of
// a mismatched-id duplicate, now that nothing else (no tailer) will ever
// independently re-emit this same content.
// ── Live partial-message streaming (includePartialMessages) ────────────────
// The SDK emits raw Anthropic stream events (message_start/content_block_*/
// message_delta/message_stop) alongside the normal message stream when
// includePartialMessages is on. An earlier version of this tracker tried to
// pair each streamed block with the *separately arriving* complete
// per-block assistant message (SDKAssistantMessage doc: "the CLI emits one
// assistant message per completed content block") via a type-keyed FIFO —
// that broke in two ways found by hand: (1) a thinking block that streams
// no visible text at all (redacted/summarized-away reasoning — the API
// otherwise streams only pings for it) still got a bubble eagerly created
// at content_block_start, which then never received a finalize broadcast
// and sat empty forever; (2) whenever step (1) happened, the FIFO desynced
// for every later block of the *same type* in that turn — one skipped
// dequeue shifts everything after it onto the wrong id, leaving orphaned
// live bubbles stuck mid-stream with the blinking cursor never cleared.
//
// Fix: don't cross-reference the complete assistant message at all. Treat
// the stream events as the sole source of truth — content_block_start opens
// bookkeeping only (no bubble yet), the first non-empty delta announces the
// bubble (stream_start) so a block that never produces real text never gets
// one, and content_block_stop broadcasts the finalize itself under the same
// id the live deltas used, so there's no separate id to match up and no
// FIFO to desync. sawStreamEvents is a whole-turn fallback flag: if this
// turn produced no stream events at all (e.g. a future SDK path that
// doesn't honor includePartialMessages), the complete-message loop below
// still broadcasts text/thinking directly so content is never silently
// dropped.
function makeStreamTracker() {
  const liveBlocks = new Map(); // stream index -> { id, type, text, started }
  let sawStreamEvents = false;

  function handleStreamEvent(event) {
    if (!event) return;

    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text" || block?.type === "thinking") {
        sawStreamEvents = true;
        liveBlocks.set(event.index, { id: randomUUID(), type: block.type, text: "", started: false });
      }
      return;
    }

    if (event.type === "content_block_delta") {
      const entry = liveBlocks.get(event.index);
      if (!entry) return;
      const delta = event.delta;
      const chunk = delta?.type === "text_delta" ? delta.text
                  : delta?.type === "thinking_delta" ? delta.thinking
                  : null;
      if (!chunk) return; // ignore empty text and non-text deltas (signature_delta, pings, ...)
      entry.text += chunk;
      const role = entry.type === "thinking" ? "thinking" : "assistant";
      if (!entry.started) {
        entry.started = true;
        broadcastStatus({ type: "stream_start", id: entry.id, role });
      }
      broadcastStatus({ type: "stream_delta", id: entry.id, role, text: entry.text });
      return;
    }

    if (event.type === "content_block_stop") {
      const entry = liveBlocks.get(event.index);
      if (!entry) return;
      liveBlocks.delete(event.index);
      if (!entry.text) return; // never produced visible content — no bubble exists, nothing to finalize
      broadcast(entry.type === "thinking" ? "thinking" : "assistant", entry.text, entry.id);
    }
  }

  return {
    handleStreamEvent,
    get sawStreamEvents() { return sawStreamEvents; },
  };
}

async function runTurn(promptText) {
  turnInFlight = true;
  broadcastStatus({ type: "turn_start" });

  const streamTracker = makeStreamTracker();

  const userMsgUuid = randomUUID();
  broadcast("user", promptText, userMsgUuid);

  async function* onePrompt() {
    yield {
      type: "user",
      message: { role: "user", content: promptText },
      parent_tool_use_id: null,
      uuid: userMsgUuid,
    };
  }

  const abortController = new AbortController();
  activeAbortController = abortController;

  const baseOpts = {
    cwd: args.cwd,
    permissionMode: "default",
    maxTurns: 50,
    abortController,
    canUseTool,
    // Live typing + thinking-block visibility in the browser. Deliberately
    // not also setting `thinking:` here — adaptive thinking is already the
    // SDK's default for models that support it, and forcing it on would be
    // a real cost/latency change (extended thinking tokens), not just a
    // display change. This only asks for whatever the model already
    // produces to be streamed instead of dropped.
    includePartialMessages: true,
  };

  // Both the primary query() attempt and the resume-fallback retry are now
  // inside this same try/finally as the turn loop itself — previously the
  // fallback attempt sat outside it, so if BOTH calls threw synchronously,
  // the exception escaped runTurn() entirely, skipping the finally block
  // below. That left turnInFlight stuck true forever, silently rejecting
  // every subsequent prompt with 409 — a real bug, not just a theoretical
  // one, and the likely explanation for messages appearing to go nowhere.
  try {
    let q;
    try {
      const opts = sessionBootstrapped
        ? { ...baseOpts, resume: sessionId }
        : { ...baseOpts, sessionId };
      q = query({ prompt: onePrompt(), options: opts });
    } catch (e) {
      console.error("[driver] query() threw synchronously, retrying with resume:", e.message);
      q = query({ prompt: onePrompt(), options: { ...baseOpts, resume: sessionId } });
    }

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        sessionBootstrapped = true;
        knownCommands = {
          slash_commands: msg.slash_commands || [],
          terminal_slash_commands: msg.terminal_slash_commands || [],
          skills: msg.skills || [],
        };
        continue;
      }

      if (msg.type === "stream_event") {
        streamTracker.handleStreamEvent(msg.event);
        continue;
      }

      if (msg.type === "system" && msg.subtype === "thinking_tokens") {
        broadcastStatus({ type: "thinking_tokens", estimated_tokens: msg.estimated_tokens });
        continue;
      }

      if (msg.type === "tool_progress") {
        broadcastStatus({ type: "tool_progress", toolName: msg.tool_name, elapsedSeconds: msg.elapsed_time_seconds });
        continue;
      }

      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          // text/thinking are already broadcast live by streamTracker (see
          // its content_block_stop handling) whenever this turn produced any
          // stream events at all — re-broadcasting them here too would just
          // duplicate the bubble under a different id. Only fall back to
          // broadcasting them directly if streaming genuinely never
          // happened for this turn, so content is never silently dropped.
          if (block.type === "text" && block.text && !streamTracker.sawStreamEvents) {
            broadcast("assistant", block.text, msg.uuid);
          } else if (block.type === "thinking" && block.thinking && !streamTracker.sawStreamEvents) {
            broadcast("thinking", block.thinking, randomUUID());
          } else if (block.type === "tool_use") {
            broadcast("tool", formatToolSummary(block.name, block.input), block.id);
          }
        }
      }
      // Deliberately not re-broadcasting: system/init (no visible bubble in
      // the tailer either), user/tool_result (tailer folds these into the
      // preceding tool's one-liner, not a separate bubble), result (no
      // visible bubble today — cost/usage display is a future nicety, not
      // wired to anything yet).
    }
  } catch (e) {
    // Verified this session: the SDK does NOT throw the standard DOM
    // AbortError name/shape for a user-initiated abort — it threw a plain
    // error with message "Claude Code process aborted by user" instead, so
    // checking e.name here silently misclassified a deliberate Stop click as
    // a real error. Checking the abortController we control ourselves is
    // more robust than guessing at the SDK's exception shape.
    if (abortController.signal.aborted) {
      console.log("[driver] turn aborted");
      broadcast("tool", "*(stopped)*", randomUUID());
    } else {
      console.error("[driver] error during turn:", e.message);
      broadcast("tool", `*(error: ${e.message})*`, randomUUID());
    }
  } finally {
    if (activeAbortController === abortController) activeAbortController = null;
    turnInFlight = false;
    broadcastStatus({ type: "turn_end" });
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

  if (req.method === "GET" && req.url === "/commands") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(knownCommands));
    return;
  }

  // Resync point for the browser: turn_start/turn_end are ephemeral SSE
  // broadcasts, not replayed on reconnect (unlike message_log), so a client
  // that misses one (a reconnect landing mid-turn, a dropped event) could
  // otherwise get permanently stuck showing Stop with no way to recover
  // short of a page reload. Called on every SSE reconnect.
  if (req.method === "GET" && req.url === "/turn-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ inFlight: turnInFlight }));
    return;
  }

  if (req.method === "GET" && req.url === "/sessions") {
    try {
      const sessions = await listSessions({ dir: args.cwd, limit: 50 });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, currentSessionId: sessionId }));
    } catch (e) {
      console.error("[driver] listSessions failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to list sessions"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/switch-session") {
    if (turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is already in progress"}');
      return;
    }
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
    try {
      await switchToSession(targetId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] switch-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to switch session"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/new-session") {
    if (turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is already in progress"}');
      return;
    }
    await startNewSession();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === "POST" && req.url === "/archive-session") {
    if (turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is already in progress"}');
      return;
    }
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
    try {
      await tagSession(targetId, "archived", { dir: args.cwd });
      // Archiving doesn't disable a session — resume still works on it — so
      // archiving the currently-active one wouldn't otherwise force any
      // change. Move on automatically rather than leave the driver quietly
      // pointed at a session that just dropped out of the active list.
      if (targetId === sessionId) {
        const sessions = await listSessions({ dir: args.cwd, limit: 50 });
        const nextActive = sessions.find((s) => s.sessionId !== targetId && s.tag !== "archived");
        if (nextActive) {
          await switchToSession(nextActive.sessionId);
        } else {
          await startNewSession();
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] archive-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to archive session"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/unarchive-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    try {
      await tagSession(body.sessionId, null, { dir: args.cwd });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] unarchive-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to unarchive session"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/delete-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    if (body.sessionId === sessionId) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"cannot delete the active session — switch away first"}');
      return;
    }
    try {
      await deleteSession(body.sessionId, { dir: args.cwd });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] delete-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to delete session"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/rename-session") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    try {
      await renameSession(body.sessionId, body.title, { dir: args.cwd });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } catch (e) {
      console.error("[driver] rename-session failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to rename session"}');
    }
    return;
  }

  if (req.method === "POST" && req.url === "/prompt") {
    if (turnInFlight) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end('{"error":"a turn is already in progress"}');
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400);
      res.end('{"error":"invalid json"}');
      return;
    }
    const text = body.text || "";
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    // Fire-and-forget: the actual reply streams via server.py's SSE feed,
    // not this HTTP response.
    runTurn(text).catch((e) => console.error("[driver] runTurn failed:", e.message));
    return;
  }

  if (req.method === "POST" && req.url === "/permission-response") {
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
    // "resolvedText" state used to live only in that tab's in-memory JS
    // object (viewer.html set it locally in the click handler and never
    // told the server), so a reload — which recreates every bubble fresh
    // from server.py's message_log — had no way to know it was already
    // answered and re-rendered live Allow/Deny buttons for it. Broadcasting
    // an updated 'permission' message under the same id, with the decision
    // baked in, means the next history/reset replay renders it resolved.
    const resolvedText = typeof body.answer === "string"
      ? `Answered: ${body.answer}`
      : (body.allow ? "Allowed" : "Denied");
    broadcast("permission", JSON.stringify({
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

  if (req.method === "POST" && req.url === "/abort") {
    if (activeAbortController) activeAbortController.abort();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(args.port, "0.0.0.0", () => {
  console.log(`[driver] listening on port ${args.port}, forwarding to viewer at ${VIEWER_MESSAGE_URL}`);
  console.log(`[driver] session id: ${sessionId || "(none pinned — will auto-generate on first prompt)"}`);
});
