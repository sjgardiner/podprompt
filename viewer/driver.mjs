#!/usr/bin/env node
// Bidirectional, multi-session driver for the Claude Code viewer.
//
// Accepts prompts from the browser, drives them through the Claude Agent SDK
// (query() — spawn-per-turn, threaded via `resume`, NOT a persistent stdin-fed
// process), and is the SOLE broadcaster of everything the browser shows —
// user prompts, assistant text, tool calls, and permission/question requests
// — all POSTed to server.py's /message endpoint using the SDK's own message
// uuids as ids (both assistant-message uuids and, for the user's own prompt,
// a uuid we supply ourselves via the one-item-async-generator prompt form;
// both confirmed empirically to land unchanged as the transcript entry's own
// `uuid`, though nothing else ever reads that file — this server no longer
// tails it at all).
//
// Multi-session concurrency: every piece of turn-related state (bootstrap
// status, in-flight flag, abort controller) is keyed by session id in the
// `sessions` Map below, instead of being a single set of module-level
// variables. This is what lets turns in different sessions run fully
// concurrently — verified empirically (two concurrent query() calls, one
// per session, `resume`-ing pre-existing sessions with different remembered
// words) that the SDK layer itself doesn't contend or cross-contaminate
// between sessions; each query() call is its own subprocess regardless.
// Every /message and /status broadcast now carries a sessionId so server.py
// can route it only to browser tabs currently viewing that session — no
// more one global "current" session shared by every connected tab.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import {
  existsSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync,
} from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import {
  query, listSessions, getSessionMessages, tagSession, renameSession, deleteSession,
} from "@anthropic-ai/claude-agent-sdk";

function parseArgs(argv) {
  const args = { port: 7844, viewerPort: 7843, cwd: "/workspace" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--viewer-port") args.viewerPort = Number(argv[++i]);
    else if (a === "--cwd") args.cwd = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const VIEWER_MESSAGE_URL = `http://127.0.0.1:${args.viewerPort}/message`;
const VIEWER_STATUS_URL = `http://127.0.0.1:${args.viewerPort}/status`;

// Same config directory Claude Code's own session storage uses (and the
// same one run-claude-docker.sh bind-mounts from ~/.claude-docker/ on the
// host) — stable across container relaunches regardless of what /workspace
// currently points at, which is exactly why the cross-project bookkeeping
// below lives here rather than anywhere under /workspace itself.
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || nodePath.join(os.homedir(), ".claude");
const PROJECTS_DIR = nodePath.join(CLAUDE_CONFIG_DIR, "projects");
const SESSION_HOSTS_FILE = nodePath.join(CLAUDE_CONFIG_DIR, "viewer-session-hosts.json");

// ── Multi-project discovery ─────────────────────────────────────────────
// A launch of --viewer is pinned to one root cwd (args.cwd, normally just
// /workspace), but the root can itself contain multiple real sub-projects —
// e.g. a working area with several repos checked out side by side — and
// Claude Code's own session storage already handles that fine on its own:
// sessions live under ~/.claude/projects/<cwd>/, keyed purely by whatever
// cwd was active when they were created, independent of anything this
// driver does. "Which projects exist" is really just "which cwds has
// Claude Code ever recorded, that currently resolve to somewhere under our
// root" — and each session transcript's first line already carries its own
// `cwd` field directly (confirmed by hand against real transcripts), which
// is far more robust to read than trying to reverse Claude Code's
// cwd-to-folder-name slugification would be (not reliably invertible — a
// real path containing a literal hyphen is ambiguous once slugified).
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isUnderRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root + nodePath.sep);
}

// Peeks at session files in a project folder until one line yields a
// `cwd` — every session in one folder should agree (the folder itself is
// keyed by cwd), so the first hit is enough. Verified by hand that the
// *first line* of a transcript isn't reliably the one carrying `cwd` —
// some files lead with a couple of queue-operation bookkeeping entries
// first — so this scans every line of a file, not just its first, before
// moving on to the next file.
function firstRecordedCwd(folderPath, files) {
  for (const file of files) {
    try {
      const fh = readFileSync(nodePath.join(folderPath, file), "utf8");
      for (const line of fh.split("\n")) {
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.cwd) return entry.cwd;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// One pass over ~/.claude/projects/*, producing: `reachable` (cwd ->
// project folder name) for every cwd that currently exists under the root,
// always including the root itself; `unreachable` (cwd -> folder name) for
// every recorded cwd that looks like ours (starts with the root) but
// doesn't currently resolve — most commonly because the host directory
// backing /workspace changed since those sessions were created. That case
// is deliberately not auto-detected/fixed (see the design discussion — too
// fuzzy to chase reliably), just surfaced. `sessionIdToCwd` is a direct
// index built from the same pass so looking up one session's project never
// needs to guess or re-scan.
function discoverProjects(rootCwd) {
  const rootReal = safeRealpath(rootCwd) || rootCwd;
  const reachable = new Map([[rootCwd, null]]);
  const unreachable = new Map();
  const sessionIdToCwd = new Map();

  let projectFolders = [];
  try {
    projectFolders = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // No projects directory yet (e.g. a brand-new install) — nothing to discover.
  }

  for (const folder of projectFolders) {
    const folderPath = nodePath.join(PROJECTS_DIR, folder);
    let files = [];
    try {
      files = readdirSync(folderPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const recordedCwd = firstRecordedCwd(folderPath, files);
    if (!recordedCwd || !isUnderRoot(recordedCwd, rootCwd)) continue; // not ours, or not under our root

    for (const file of files) {
      sessionIdToCwd.set(file.slice(0, -".jsonl".length), recordedCwd);
    }
    if (recordedCwd === rootCwd) continue; // already have the root itself

    const real = safeRealpath(recordedCwd);
    if (real && isUnderRoot(real, rootReal)) {
      reachable.set(recordedCwd, folder);
    } else {
      unreachable.set(recordedCwd, folder);
    }
  }

  return { reachable, unreachable, sessionIdToCwd };
}

let knownProjects = discoverProjects(args.cwd);

function rescanProjects() {
  knownProjects = discoverProjects(args.cwd);
  return knownProjects;
}

function projectLabelFor(cwd) {
  if (cwd === args.cwd) return "(root)";
  return nodePath.relative(args.cwd, cwd) || "(root)";
}

// Validates a browser-supplied cwd for a brand-new session: must resolve to
// a real, existing directory that is the root or a strict subdirectory of
// it — the same boundary the SDK itself enforces for its own
// --add-dir/additionalDirectories option (a related but distinct concept:
// that widens one session's tool-access scope, this decides which
// project's session storage a session belongs to). Returns the original
// candidate string (not the realpath — the session keeps using exactly
// what the browser asked for) or null if invalid.
function resolveValidCwd(candidate, root) {
  if (!candidate || typeof candidate !== "string") return null;
  if (!existsSync(candidate)) return null;
  const real = safeRealpath(candidate);
  const rootReal = safeRealpath(root);
  if (!real || !rootReal || !isUnderRoot(real, rootReal)) return null;
  return candidate;
}

// Best-known cwd for a session id we may never have run a turn for
// ourselves this process — the in-memory state wins if we have touched it,
// falling back to the discovery index, then the root.
function cwdForSession(sessionId) {
  return sessions.get(sessionId)?.cwd || knownProjects.sessionIdToCwd.get(sessionId) || args.cwd;
}

// ── Per-turn host-path bookkeeping ──────────────────────────────────────
// Records, per session, which host directory was backing /workspace the
// last time a turn actually started for it — the one piece of state that
// needs the *launch script* itself to cooperate (HOST_WORKSPACE_PATH is
// exported by run-claude-docker.sh; nothing inside the container otherwise
// has any way to know the host-side path at all — Docker bind mounts don't
// carry that information across the boundary on their own). Lives in the
// same config directory session storage does, so it survives container
// relaunches independent of whatever /workspace currently points at —
// which is exactly the point: it's meant to answer "where do I need to
// point the launch script to get back to this" for a session that's since
// become unreachable.
//
// Written unconditionally at the start of every turn — not gated on
// success (the host-path binding is a property of which container/mount
// was active for the attempt, not of whether the attempt panned out), and
// not skipped even when the value hasn't changed since last time (the file
// is tiny and this runs at most once per turn, so there's no real cost to
// keeping the logic simple — and "only write if different" would still
// need to check every time anyway). Fully synchronous (no `await` anywhere
// in this function) so concurrent turns for *different* sessions can never
// tear each other's read-modify-write of this one shared file: JS's
// single-threaded execution guarantees a synchronous function runs to
// completion before any other pending async work gets a turn, no matter
// how many other turns are concurrently in flight.
function stampSessionHost(sessionId, cwd) {
  const hostPath = process.env.HOST_WORKSPACE_PATH;
  if (!hostPath) return; // older launch script, or non-docker dev usage — nothing to record
  let data = {};
  try {
    data = JSON.parse(readFileSync(SESSION_HOSTS_FILE, "utf8"));
  } catch {
    // missing or corrupt — start fresh rather than fail the turn over this
  }
  data[sessionId] = { hostPath, cwd, lastSeen: nowIso() };
  try {
    writeFileSync(SESSION_HOSTS_FILE, JSON.stringify(data));
  } catch (e) {
    console.error("[driver] failed to write session-hosts file:", e.message);
  }
}

function lastKnownHostPath(sessionId) {
  try {
    const data = JSON.parse(readFileSync(SESSION_HOSTS_FILE, "utf8"));
    return data[sessionId]?.hostPath || null;
  } catch {
    return null;
  }
}

// Lightweight, SDK-independent session summary for the unreachable bucket
// (listSessions()/getSessionMessages() need a `dir` that actually resolves,
// which is exactly what these sessions don't have) — reads just enough of
// the raw transcript to produce a title and a timestamp.
function lightweightSessionSummary(filePath) {
  let firstPrompt = null;
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "user" && isRealUserPrompt(entry.message?.content)) {
        const text = extractTextFromContent(entry.message?.content);
        if (text && text.trim()) {
          firstPrompt = text.trim().slice(0, 200);
          break;
        }
      }
    }
  } catch {
    // ignore — leave firstPrompt null
  }
  let lastModified = null;
  try {
    lastModified = statSync(filePath).mtimeMs;
  } catch {
    // ignore — leave lastModified null
  }
  return { firstPrompt, lastModified };
}

// ── Per-session state ────────────────────────────────────────────────────
// Lazily created on first use (a fresh client-minted id for "new chat", or
// the first time this process is asked to run a turn in a pre-existing
// session it hasn't touched yet). Nothing pre-seeds this at startup anymore
// — unlike the single-session driver this replaces, there's no "the" pinned
// session; every prompt names its own target explicitly. cwd defaults via
// cwdForSession() — the discovery index if this is a pre-existing session
// in a known sub-project, else the root — but a brand-new session can
// override that with an explicit, already-validated cwd (see /prompt).
const sessions = new Map(); // sessionId -> SessionState

function getSessionState(sessionId, explicitCwd) {
  let s = sessions.get(sessionId);
  if (!s) {
    const cwd = explicitCwd || cwdForSession(sessionId);
    s = { bootstrapped: false, turnInFlight: false, abortController: null, cwd };
    sessions.set(sessionId, s);
  }
  return s;
}

// ── Available commands, refreshed from every turn's system/init message ────
// Shared across all sessions deliberately — this reflects what commands/
// skills/agents this codebase and CLAUDE.md make available, which doesn't
// vary per session, so there's no reason to track it per session id. (The
// SDK's supportedCommands() is a method on a live Query object, not a
// standalone function — there's no way to fetch this before a first turn
// runs anywhere without keeping an idle Query warm, which we don't do here.)
let knownCommands = { slash_commands: [], terminal_slash_commands: [], skills: [] };

// ── Pending permission/question approvals, keyed by request id ────────────
// Flat and global (not nested under per-session state) since request ids
// are already globally unique — but each entry now also carries its
// sessionId, both so the resolved-decision rebroadcast can be tagged
// correctly and so /sessions can report which sessions currently have a
// decision waiting on the user (the sessions-panel badge).
const pendingApprovals = new Map(); // id -> { resolve, sessionId, kind, toolName, toolInput }

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

// ── Session history conversion ───────────────────────────────────────────
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

// ── canUseTool: permission approval + AskUserQuestion, both via the browser ─
// A factory rather than one shared function, since it needs to know which
// session's turn it's guarding — canUseTool's own callback signature carries
// no session identifier, so this closes over one instead.
function makeCanUseTool(sessionId) {
  return async function canUseTool(toolName, toolInput, options) {
    const id = randomUUID();

    if (toolName === "AskUserQuestion") {
      const answer = await new Promise((resolve) => {
        pendingApprovals.set(id, { resolve, sessionId, kind: "question", toolName, toolInput });
        broadcast(
          sessionId,
          "permission",
          JSON.stringify({ kind: "question", toolName, toolInput }),
          id
        );
      });
      // Verified: canUseTool fires for AskUserQuestion, but `allow` alone
      // leaves it unanswered ("The user did not answer the questions").
      // Denying with a crafted message is the mechanism that actually
      // works — Claude treats the message as the real answer.
      return { behavior: "deny", message: `The user answered: ${answer}` };
    }

    const decision = await new Promise((resolve) => {
      pendingApprovals.set(id, { resolve, sessionId, kind: "permission", toolName, toolInput });
      broadcast(
        sessionId,
        "permission",
        JSON.stringify({ kind: "permission", toolName, toolInput }),
        id
      );
    });

    if (decision && decision.allow) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    return { behavior: "deny", message: (decision && decision.message) || "Denied by user" };
  };
}

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
function makeStreamTracker(sessionId) {
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
        broadcastStatus(sessionId, { type: "stream_start", id: entry.id, role });
      }
      broadcastStatus(sessionId, { type: "stream_delta", id: entry.id, role, text: entry.text });
      return;
    }

    if (event.type === "content_block_stop") {
      const entry = liveBlocks.get(event.index);
      if (!entry) return;
      liveBlocks.delete(event.index);
      if (!entry.text) return; // never produced visible content — no bubble exists, nothing to finalize
      broadcast(sessionId, entry.type === "thinking" ? "thinking" : "assistant", entry.text, entry.id);
    }
  }

  return {
    handleStreamEvent,
    get sawStreamEvents() { return sawStreamEvents; },
  };
}

// ── Drive one turn ───────────────────────────────────────────────────────────
// The prompt is wrapped in a one-item async generator (still fully
// spawn-per-turn — this doesn't reintroduce a persistent process) rather than
// passed as a bare string, specifically so we can supply our own uuid for the
// user's message. That uuid lands unchanged as the transcript entry's own
// `uuid` for this turn (same property already confirmed for assistant
// messages) — so broadcasting it immediately, before query() even starts,
// gives correct chronological ordering with no risk of a mismatched-id
// duplicate, now that nothing else (no tailer) will ever independently
// re-emit this same content.
//
// Bootstrap ambiguity: the first time this process is asked to run a turn
// in a given session id, it doesn't know whether that id is brand new
// (client-minted for "new chat" — needs `sessionId` create-mode) or an
// existing session on disk this process just hasn't touched yet (needs
// `resume`). Empirically verified: passing `sessionId` for an id that
// already has history does NOT throw synchronously from query() itself —
// the CLI subprocess exits (code 1, "Session ID ... is already in use")
// and the error only surfaces when iterating the async generator. The
// previous single-session version of this driver had a synchronous
// try/catch around the query() call for exactly this case, which — given
// the above — could never actually have caught it; this version instead
// wraps the whole first-attempt turn (query + full iteration) and retries
// once with `resume` if it fails, which is where the real failure lands.
async function runTurn(sessionId, promptText) {
  const state = getSessionState(sessionId);
  stampSessionHost(sessionId, state.cwd);
  state.turnInFlight = true;
  broadcastStatus(sessionId, { type: "turn_start" });

  const streamTracker = makeStreamTracker(sessionId);
  const canUseTool = makeCanUseTool(sessionId);

  const userMsgUuid = randomUUID();
  broadcast(sessionId, "user", promptText, userMsgUuid);

  function onePrompt() {
    // A fresh async generator per attempt: once iterated (even partially,
    // even to a thrown error), a JS generator is exhausted and can't be
    // replayed — the resume-retry below needs its own.
    return (async function* () {
      yield {
        type: "user",
        message: { role: "user", content: promptText },
        parent_tool_use_id: null,
        uuid: userMsgUuid,
      };
    })();
  }

  const abortController = new AbortController();
  state.abortController = abortController;

  const baseOpts = {
    cwd: state.cwd,
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

  async function consume(opts) {
    const q = query({ prompt: onePrompt(), options: opts });
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        // Unlike the single-session driver this replaces, sessionId is
        // always chosen by the browser up front (create-mode explicitly
        // passes it), never left for the SDK to generate — so there's
        // nothing to learn from msg.session_id here beyond confirming
        // bootstrap succeeded. Deliberately NOT reassigning the outer
        // sessionId from it: canUseTool/streamTracker above already closed
        // over the original value, and doing so would risk them and any
        // broadcast() call after this point disagreeing on which session a
        // single turn belongs to if the two ever differed.
        state.bootstrapped = true;
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
        broadcastStatus(sessionId, { type: "thinking_tokens", estimated_tokens: msg.estimated_tokens });
        continue;
      }

      if (msg.type === "tool_progress") {
        broadcastStatus(sessionId, { type: "tool_progress", toolName: msg.tool_name, elapsedSeconds: msg.elapsed_time_seconds });
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
            broadcast(sessionId, "assistant", block.text, msg.uuid);
          } else if (block.type === "thinking" && block.thinking && !streamTracker.sawStreamEvents) {
            broadcast(sessionId, "thinking", block.thinking, randomUUID());
          } else if (block.type === "tool_use") {
            broadcast(sessionId, "tool", formatToolSummary(block.name, block.input), block.id);
          }
        }
      }
      // Deliberately not re-broadcasting: system/init (no visible bubble),
      // user/tool_result (folded into the preceding tool's one-liner, not a
      // separate bubble), result (no visible bubble today — cost/usage
      // display is a future nicety, not wired to anything yet).
    }
  }

  try {
    try {
      const opts = state.bootstrapped
        ? { ...baseOpts, resume: sessionId }
        : { ...baseOpts, sessionId };
      await consume(opts);
    } catch (e) {
      if (abortController.signal.aborted) throw e; // a deliberate Stop, not a bootstrap-guess failure — don't retry
      if (state.bootstrapped) throw e; // already confirmed real via a prior turn — a retry wouldn't change anything
      console.error(`[driver] first turn for session ${sessionId} failed assuming create-mode, retrying with resume:`, e.message);
      await consume({ ...baseOpts, resume: sessionId });
    }
  } catch (e) {
    // Verified: the SDK does NOT throw the standard DOM AbortError
    // name/shape for a user-initiated abort — it throws a plain error with
    // message "Claude Code process aborted by user" instead, so checking
    // e.name here silently misclassified a deliberate Stop click as a real
    // error. Checking the abortController we control ourselves is more
    // robust than guessing at the SDK's exception shape.
    if (abortController.signal.aborted) {
      console.log(`[driver] turn aborted for session ${sessionId}`);
      broadcast(sessionId, "tool", "*(stopped)*", randomUUID());
    } else {
      console.error(`[driver] error during turn for session ${sessionId}:`, e.message);
      broadcast(sessionId, "tool", `*(error: ${e.message})*`, randomUUID());
    }
  } finally {
    if (state.abortController === abortController) state.abortController = null;
    state.turnInFlight = false;
    // Any permission/question this turn asked but never got an answer for
    // (the turn ended — aborted, or the underlying query() threw — before
    // /permission-response was ever called for it) would otherwise orphan
    // in pendingApprovals forever: nothing else ever deletes an entry
    // except that one handler, so the session's badge would stay lit
    // indefinitely with no way to tell a genuinely-live request apart from
    // an abandoned one. Found via TRUMPET, an old test session whose
    // "waiting on an answer" badge stayed lit long after nothing was
    // running for it — the actual root cause turned out to be this leak,
    // not any client-side rendering bug (which was verified correct
    // multiple times over). Broadcasting a resolved:true rebroadcast (same
    // shape /permission-response itself sends) rather than a silent
    // delete, so any permission/question card still shown live in a
    // browser (Allow/Deny buttons that would otherwise just 404 if
    // clicked) updates to reflect that it expired, instead of sitting
    // there looking actionable forever.
    for (const [id, pending] of pendingApprovals) {
      if (pending.sessionId !== sessionId) continue;
      pendingApprovals.delete(id);
      broadcast(sessionId, "permission", JSON.stringify({
        kind: pending.kind, toolName: pending.toolName, toolInput: pending.toolInput,
        resolved: true, resolvedText: "This request expired (the turn ended without an answer).",
      }), id);
    }
    broadcastStatus(sessionId, { type: "turn_end" });
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(knownCommands));
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
    const inFlight = sessionId ? !!sessions.get(sessionId)?.turnInFlight : false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ inFlight }));
    return;
  }

  // Full persisted history for a session, converted to the browser's
  // {role, text, id, ts} shape. Pulled by server.py the first time a tab
  // asks to view a session it has no live log for yet — not pushed by this
  // driver anymore (that was the old /reset-broadcast design, which only
  // made sense when there was a single shared "current" session for every
  // connected tab to be reset onto). An unknown/brand-new session id (e.g.
  // one just minted client-side for "new chat") legitimately has no
  // history yet; that's not an error, just an empty array.
  if (req.method === "GET" && path === "/session-history") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"error":"sessionId required"}');
      return;
    }
    try {
      const raw = await getSessionMessages(sessionId, { dir: cwdForSession(sessionId) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(convertSessionMessages(raw)));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("[]");
    }
    return;
  }

  // Reachable sessions are always fetched (one listSessions() call per known
  // project, merged) — that's the normal, cheap case. The unreachable bucket
  // (sessions whose recorded cwd no longer resolves — see discoverProjects)
  // is only actually assembled when asked for via ?includeUnreachable=1,
  // since producing it means reading raw transcript files directly rather
  // than the cheap SDK path; the count alone (knownProjects.unreachable.size)
  // costs nothing extra and is always included so the "show count" settings
  // choice never needs the expensive path at all.
  if (req.method === "GET" && path === "/sessions") {
    try {
      const reachableCwds = [...knownProjects.reachable.keys()];
      const perProject = await Promise.all(reachableCwds.map(async (cwd) => {
        try {
          const list = await listSessions({ dir: cwd, limit: 50 });
          return list.map((s) => ({
            ...s,
            cwd,
            projectLabel: projectLabelFor(cwd),
            unreachable: false,
            inFlight: !!sessions.get(s.sessionId)?.turnInFlight,
            pendingKind: pendingKindForSession(s.sessionId),
          }));
        } catch (e) {
          console.error(`[driver] listSessions failed for ${cwd}:`, e.message);
          return [];
        }
      }));

      let unreachableSessions;
      if (url.searchParams.get("includeUnreachable") === "1") {
        unreachableSessions = [];
        for (const [cwd, folder] of knownProjects.unreachable) {
          if (!folder) continue;
          const folderPath = nodePath.join(PROJECTS_DIR, folder);
          let files = [];
          try {
            files = readdirSync(folderPath).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue;
          }
          for (const file of files) {
            const sessionId = file.slice(0, -".jsonl".length);
            unreachableSessions.push({
              sessionId,
              cwd,
              projectLabel: projectLabelFor(cwd),
              unreachable: true,
              lastKnownHostPath: lastKnownHostPath(sessionId),
              ...lightweightSessionSummary(nodePath.join(folderPath, file)),
            });
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        // Promise.all resolves in request order, so a naive .flat() would
        // chunk all of project A's sessions before any of project B's,
        // regardless of actual recency — merge by lastModified instead so
        // "flat, sorted by recency" is true globally, not just per project.
        sessions: perProject.flat().sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)),
        unreachableCount: knownProjects.unreachable.size,
        unreachableSessions,
      }));
    } catch (e) {
      console.error("[driver] /sessions failed:", e.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"failed to list sessions"}');
    }
    return;
  }

  if (req.method === "GET" && path === "/projects") {
    const projects = [...knownProjects.reachable.keys()].map((cwd) => ({ cwd, label: projectLabelFor(cwd) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects, root: args.cwd }));
    return;
  }

  if (req.method === "POST" && path === "/rescan-projects") {
    rescanProjects();
    const projects = [...knownProjects.reachable.keys()].map((cwd) => ({ cwd, label: projectLabelFor(cwd) }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects, root: args.cwd, unreachableCount: knownProjects.unreachable.size }));
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
    // No more "move away from the currently-active session" special case —
    // there is no single active session anymore. Archiving doesn't disable
    // resume, so a tab that's still viewing/prompting an archived session
    // keeps working exactly as before; it just shows under "Archived" in
    // any sessions panel that refreshes its list.
    try {
      await tagSession(targetId, "archived", { dir: cwdForSession(targetId) });
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
      await tagSession(body.sessionId, null, { dir: cwdForSession(body.sessionId) });
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
      await deleteSession(body.sessionId, { dir: cwdForSession(body.sessionId) });
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
      await renameSession(body.sessionId, body.title, { dir: cwdForSession(body.sessionId) });
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
    // Only meaningful for a brand-new session (the "new chat" project
    // picker) — an already-known session just keeps whatever cwd it was
    // first created with, below. Validated up front rather than silently
    // substituted, so a bad path is a clear error instead of a session
    // quietly landing somewhere the user didn't ask for.
    let explicitCwd;
    if (body.cwd) {
      explicitCwd = resolveValidCwd(body.cwd, args.cwd);
      if (!explicitCwd) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"cwd must be an existing directory under the workspace root"}');
        return;
      }
      // Register it immediately rather than waiting for the next scan —
      // anything this driver creates itself is already known the moment it
      // happens; discovery/rescan only exists for finding pre-existing
      // sessions this process didn't create.
      if (!knownProjects.reachable.has(explicitCwd)) {
        knownProjects.reachable.set(explicitCwd, null);
      }
    }
    if (getSessionState(sessionId, explicitCwd).turnInFlight) {
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
    // "resolvedText" state used to live only in that tab's in-memory JS
    // object (viewer.html set it locally in the click handler and never
    // told the server), so a reload had no way to know it was already
    // answered and re-rendered live Allow/Deny buttons for it. Broadcasting
    // an updated 'permission' message under the same id, with the decision
    // baked in, means the next history replay renders it resolved.
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
    if (state?.abortController) state.abortController.abort();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(args.port, "0.0.0.0", () => {
  console.log(`[driver] listening on port ${args.port}, forwarding to viewer at ${VIEWER_MESSAGE_URL}`);
  console.log("[driver] multi-session — no pinned session id; each request names its own target");
});
