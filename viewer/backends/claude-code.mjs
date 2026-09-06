// Claude Code backend for the viewer driver.
//
// Everything here is specific to the Claude Agent SDK: spawn-per-turn
// query(), the create-vs-resume bootstrap dance, includePartialMessages
// stream-block bookkeeping, the LCS diff renderer, and Claude's own
// ~/.claude/projects/*.jsonl-based session/project discovery.
//
// Exposes the shared Backend contract (see backends/README in driver.mjs's
// header comment for the full interface list): runTurn, listSessions,
// getSessionHistory, archiveSession, unarchiveSession, deleteSession,
// renameSession, abort, listProjects, rescanProjects, resolveValidCwd,
// cwdForSession, getKnownCommands. Every method that needs to reach the
// browser goes through the `broadcast`/`broadcastStatus`/`requestApproval`
// hooks passed in at construction — this module never talks to server.py or
// the shared pendingApprovals map directly, so it stays swappable with any
// other backend that honors the same hooks.

import { randomUUID } from "node:crypto";
import {
  existsSync, readdirSync, readFileSync, writeFileSync, realpathSync, statSync,
} from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import {
  query, listSessions, getSessionMessages, tagSession, renameSession, deleteSession,
} from "@anthropic-ai/claude-agent-sdk";

export function createClaudeCodeBackend({ cwdRoot, broadcast, broadcastStatus, requestApproval }) {
  // Same config directory Claude Code's own session storage uses (and the
  // same one run-claude-docker.sh bind-mounts from ~/.claude-docker/ on the
  // host) — stable across container relaunches regardless of what /workspace
  // currently points at, which is exactly why the cross-project bookkeeping
  // below lives here rather than anywhere under /workspace itself.
  const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || nodePath.join(os.homedir(), ".claude");
  const PROJECTS_DIR = nodePath.join(CLAUDE_CONFIG_DIR, "projects");
  const SESSION_HOSTS_FILE = nodePath.join(CLAUDE_CONFIG_DIR, "viewer-session-hosts.json");

  // ── Multi-project discovery ─────────────────────────────────────────────
  // A launch of --viewer is pinned to one root cwd (cwdRoot, normally just
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

  let knownProjects = discoverProjects(cwdRoot);

  function rescanProjectsInternal() {
    knownProjects = discoverProjects(cwdRoot);
    return knownProjects;
  }

  function projectLabelFor(cwd) {
    if (cwd === cwdRoot) return "(root)";
    return nodePath.relative(cwdRoot, cwd) || "(root)";
  }

  // Validates a browser-supplied cwd for a brand-new session: must resolve to
  // a real, existing directory that is the root or a strict subdirectory of
  // it — the same boundary the SDK itself enforces for its own
  // --add-dir/additionalDirectories option (a related but distinct concept:
  // that widens one session's tool-access scope, this decides which
  // project's session storage a session belongs to). Returns the original
  // candidate string (not the realpath — the session keeps using exactly
  // what the browser asked for) or null if invalid.
  function resolveValidCwd(candidate) {
    if (!candidate || typeof candidate !== "string") return null;
    if (!existsSync(candidate)) return null;
    const real = safeRealpath(candidate);
    const rootReal = safeRealpath(cwdRoot);
    if (!real || !rootReal || !isUnderRoot(real, rootReal)) return null;
    if (!knownProjects.reachable.has(candidate)) {
      // Registered immediately rather than waiting for the next scan —
      // anything this backend creates itself is already known the moment it
      // happens; discovery/rescan only exists for finding pre-existing
      // sessions this process didn't create.
      knownProjects.reachable.set(candidate, null);
    }
    return candidate;
  }

  // Best-known cwd for a session id we may never have run a turn for
  // ourselves this process — the caller's own in-memory state (if any) wins;
  // this is only consulted as a fallback via `fallbackCwd`.
  function cwdForSession(sessionId, fallbackCwd) {
    return fallbackCwd || knownProjects.sessionIdToCwd.get(sessionId) || cwdRoot;
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
  function stampSessionHost(sessionId, cwd) {
    const hostPath = process.env.HOST_WORKSPACE_PATH;
    if (!hostPath) return; // older launch script, or non-docker dev usage — nothing to record
    let data = {};
    try {
      data = JSON.parse(readFileSync(SESSION_HOSTS_FILE, "utf8"));
    } catch {
      // missing or corrupt — start fresh rather than fail the turn over this
    }
    data[sessionId] = { hostPath, cwd, lastSeen: new Date().toISOString() };
    try {
      writeFileSync(SESSION_HOSTS_FILE, JSON.stringify(data));
    } catch (e) {
      console.error("[claude-code] failed to write session-hosts file:", e.message);
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

  // ── Available commands, refreshed from every turn's system/init message ──
  // Shared across all sessions deliberately — this reflects what commands/
  // skills/agents this codebase and CLAUDE.md make available, which doesn't
  // vary per session, so there's no reason to track it per session id. (The
  // SDK's supportedCommands() is a method on a live Query object, not a
  // standalone function — there's no way to fetch this before a first turn
  // runs anywhere without keeping an idle Query warm, which we don't do here.)
  let knownCommands = { slash_commands: [], terminal_slash_commands: [], skills: [] };

  // ── Available models, refreshed opportunistically from the tail of every
  // turn (see the `result` handling in consume() below) ───────────────────
  // Same shape of problem as knownCommands above: Query.supportedModels() is
  // a live control-request method, not a standalone function, so there's no
  // way to populate this before any turn has ever run. Shared across sessions
  // for the same reason knownCommands is — the model lineup doesn't vary per
  // session, only which one a given session has selected (state.model).
  let knownModels = [];
  // Set once usage_EXPERIMENTAL_...() has rejected a first time — see the
  // "result" message handling below — so an unsupported-on-this-CLI-build
  // control command logs one clear line instead of spamming the console
  // (and the attached pty a human may never actually see) on every turn of
  // every session for the rest of this process's life.
  let loggedUsageApiUnavailable = false;

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

  // ── canUseTool: permission approval + AskUserQuestion, both via the shared
  // requestApproval hook (which owns the pendingApprovals map and the
  // broadcast to server.py) ───────────────────────────────────────────────
  // A factory rather than one shared function, since it needs to know which
  // session's turn it's guarding — canUseTool's own callback signature carries
  // no session identifier, so this closes over one instead. Also takes the
  // session's shared `state` bag so it can read `state.autoApprove` fresh on
  // every single tool call (not just once at turn start) — toggling the
  // browser's auto-approve checkbox off mid-turn takes effect starting with
  // the very next tool call, not just the next turn.
  function makeCanUseTool(sessionId, state) {
    return async function canUseTool(toolName, toolInput, options) {
      if (toolName === "AskUserQuestion") {
        // Deliberately NOT short-circuited by auto-approve — that flag only
        // concerns tool-permission gating, not answering substantive
        // questions Claude is asking the user; those always still reach the
        // browser regardless.
        const answer = await requestApproval(sessionId, "question", toolName, toolInput);
        // Verified: canUseTool fires for AskUserQuestion, but `allow` alone
        // leaves it unanswered ("The user did not answer the questions").
        // Denying with a crafted message is the mechanism that actually
        // works — Claude treats the message as the real answer.
        return { behavior: "deny", message: `The user answered: ${answer}` };
      }

      if (state.autoApprove) {
        return { behavior: "allow", updatedInput: toolInput };
      }

      const decision = await requestApproval(sessionId, "permission", toolName, toolInput);
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

  // ── Drive one turn ───────────────────────────────────────────────────────
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
  // and the error only surfaces when iterating the async generator. This
  // wraps the whole first-attempt turn (query + full iteration) and retries
  // once with `resume` if it fails, which is where the real failure lands.
  //
  // `state` is the shared per-session bag driver.mjs owns (cwd, turnInFlight,
  // abortController, bootstrapped) — this backend reads/writes those same
  // fields directly rather than keeping its own shadow copy, since driver.mjs
  // already needs `turnInFlight`/`abortController` for its own /abort and
  // /prompt-busy-check routes regardless of which backend is active.
  async function runTurn(sessionId, promptText, state) {
    stampSessionHost(sessionId, state.cwd);
    state.turnInFlight = true;
    broadcastStatus(sessionId, { type: "turn_start" });

    const streamTracker = makeStreamTracker(sessionId);
    const canUseTool = makeCanUseTool(sessionId, state);

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
      // state.model is only ever set by the browser's model-switcher
      // (POST /set-model, see driver.mjs) — omit the option entirely rather
      // than pass undefined/null so an unset session keeps using the CLI's
      // own default model, exactly like before this feature existed.
      ...(state.model ? { model: state.model } : {}),
    };

    async function consume(opts) {
      const q = query({ prompt: onePrompt(), options: opts });
      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          // sessionId is always chosen by the browser up front (create-mode
          // explicitly passes it), never left for the SDK to generate — so
          // there's nothing to learn from msg.session_id here beyond
          // confirming bootstrap succeeded. Deliberately NOT reassigning the
          // outer sessionId from it: canUseTool/streamTracker above already
          // closed over the original value, and doing so would risk them and
          // any broadcast() call after this point disagreeing on which
          // session a single turn belongs to if the two ever differed.
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

        // SDKStatusMessage: status is 'compacting' while auto-compaction is
        // actively running, 'requesting' while waiting on the API, or null
        // otherwise. compact_result/compact_error only arrive once a
        // compaction that was in progress finishes — surfaced here so the
        // browser can flash a success/failure note rather than just the
        // spinner disappearing silently.
        if (msg.type === "system" && msg.subtype === "status") {
          if (msg.status === "compacting") {
            broadcastStatus(sessionId, { type: "compacting", active: true });
          } else if (msg.compact_result) {
            broadcastStatus(sessionId, { type: "compacting", active: false, result: msg.compact_result, error: msg.compact_error });
          }
          continue;
        }

        // SDKCompactBoundaryMessage: fires once a compaction has actually
        // completed and landed in the transcript, carrying real
        // before/after token counts — a more concrete completion signal
        // than the status message above (which this may arrive alongside,
        // slightly after, or — on some CLI versions — instead of).
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          const meta = msg.compact_metadata || {};
          broadcastStatus(sessionId, {
            type: "compacting", active: false, result: "success",
            preTokens: meta.pre_tokens, postTokens: meta.post_tokens, trigger: meta.trigger,
          });
          continue;
        }

        if (msg.type === "result") {
          // Both of these are control-request methods on the live Query
          // object `q`, called here (still inside the for-await loop, right
          // as the turn's final message arrives) on the theory that this is
          // the freshest safe point to ask. Verified by hand against this
          // exact CLI build, though, that timing isn't actually what decides
          // whether usage_EXPERIMENTAL_...() succeeds here: calling it right
          // at turn start (system/init) rejects with the exact same "Query
          // closed before response received" as calling it here at the very
          // end — this CLI binary (2.1.261, paired with SDK wrapper
          // 0.3.261) simply doesn't implement that control command yet (nor
          // getContextUsage(), same rejection). supportedModels() is a
          // different, older control command this same CLI build DOES
          // implement, which is why the model switcher works fine while the
          // plan-usage bar stays silently hidden — not a bug in either path,
          // just an environment/CLI-version gap. usage_EXPERIMENTAL_...()'s
          // one-time (not per-turn) log line below exists so that's fast to
          // rediscover later, without needing another from-scratch
          // diagnostic session — this should simply start working, with no
          // code change, whenever this container's CLI is upgraded past
          // whatever version first added server-side support for it.
          q.supportedModels().then((models) => {
            knownModels = models || [];
          }).catch((e) => {
            console.error(`[claude-code] supportedModels() failed for session ${sessionId}:`, e.message);
          });
          if (!loggedUsageApiUnavailable) {
            q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().then((usage) => {
              broadcastStatus(sessionId, {
                type: "plan_usage",
                subscription_type: usage?.rate_limits_available ? usage.subscription_type : null,
                rate_limits: usage?.rate_limits_available ? usage.rate_limits : null,
              });
            }).catch((e) => {
              loggedUsageApiUnavailable = true;
              console.error(
                "[claude-code] usage_EXPERIMENTAL_...() unavailable on this CLI build — the " +
                "plan-usage bar will stay hidden for every session until the CLI is upgraded " +
                `(logging this once, not per-turn). Rejection was: ${e.message}`
              );
            });
          }
          continue;
        }

        if (msg.type === "assistant" && msg.message?.content) {
          if (msg.context_usage) {
            broadcastStatus(sessionId, {
              type: "context_usage",
              percentage: msg.context_usage.percentage,
              totalTokens: msg.context_usage.total_tokens,
              maxTokens: msg.context_usage.raw_max_tokens,
              model: msg.context_usage.model,
            });
          }
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
        // "Session ID ... is already in use" is the CLI's own signal that
        // this id belongs to a pre-existing session — the routine case of
        // resuming a session in the viewer after this driver process
        // restarted (and so has no in-memory `bootstrapped` state for it
        // yet), not a real failure, so it's not worth an error-level log;
        // the resume retry below is expected to succeed. Anything else here
        // is a genuine, unexpected failure on the very first attempt, still
        // worth surfacing loudly even though the same retry gets a chance.
        if (!/already in use/i.test(e.message || "")) {
          console.error(`[claude-code] first turn for session ${sessionId} failed assuming create-mode, retrying with resume:`, e.message);
        }
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
        console.log(`[claude-code] turn aborted for session ${sessionId}`);
        broadcast(sessionId, "tool", "*(stopped)*", randomUUID());
      } else {
        console.error(`[claude-code] error during turn for session ${sessionId}:`, e.message);
        broadcast(sessionId, "tool", `*(error: ${e.message})*`, randomUUID());
      }
    } finally {
      if (state.abortController === abortController) state.abortController = null;
      state.turnInFlight = false;
      broadcastStatus(sessionId, { type: "turn_end" });
    }
  }

  return {
    id: "claude-code",

    async runTurn(sessionId, promptText, state) {
      return runTurn(sessionId, promptText, state);
    },

    abort(sessionId, state) {
      state?.abortController?.abort();
    },

    getKnownCommands() {
      return knownCommands;
    },

    cwdForSession(sessionId, fallbackCwd) {
      return cwdForSession(sessionId, fallbackCwd);
    },

    resolveValidCwd(candidate) {
      return resolveValidCwd(candidate);
    },

    listProjects() {
      return { projects: [...knownProjects.reachable.keys()].map((cwd) => ({ cwd, label: projectLabelFor(cwd) })), root: cwdRoot };
    },

    rescanProjects() {
      rescanProjectsInternal();
      return {
        projects: [...knownProjects.reachable.keys()].map((cwd) => ({ cwd, label: projectLabelFor(cwd) })),
        root: cwdRoot,
        unreachableCount: knownProjects.unreachable.size,
      };
    },

    // `sessionsIndex` is the shared driver.mjs `sessions` Map (sessionId ->
    // {turnInFlight, ...}) — needed here only to report inFlight/pendingKind
    // per listed session, kept as a plain param rather than a constructor
    // closure so this backend never has to guess which Map instance is live.
    async listSessions({ includeUnreachable }, sessionsIndex, pendingKindForSession) {
      const reachableCwds = [...knownProjects.reachable.keys()];
      const perProject = await Promise.all(reachableCwds.map(async (cwd) => {
        try {
          const list = await listSessions({ dir: cwd, limit: 50 });
          return list.map((s) => ({
            ...s,
            backend: "claude-code",
            cwd,
            projectLabel: projectLabelFor(cwd),
            unreachable: false,
            inFlight: !!sessionsIndex.get(s.sessionId)?.turnInFlight,
            pendingKind: pendingKindForSession(s.sessionId),
          }));
        } catch (e) {
          console.error(`[claude-code] listSessions failed for ${cwd}:`, e.message);
          return [];
        }
      }));

      let unreachableSessions;
      if (includeUnreachable) {
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
              backend: "claude-code",
              cwd,
              projectLabel: projectLabelFor(cwd),
              unreachable: true,
              lastKnownHostPath: lastKnownHostPath(sessionId),
              ...lightweightSessionSummary(nodePath.join(folderPath, file)),
            });
          }
        }
      }

      return {
        sessions: perProject.flat().sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0)),
        unreachableCount: knownProjects.unreachable.size,
        unreachableSessions,
      };
    },

    async getSessionHistory(sessionId, fallbackCwd) {
      try {
        const raw = await getSessionMessages(sessionId, { dir: cwdForSession(sessionId, fallbackCwd) });
        return convertSessionMessages(raw);
      } catch {
        return [];
      }
    },

    async archiveSession(sessionId, fallbackCwd) {
      await tagSession(sessionId, "archived", { dir: cwdForSession(sessionId, fallbackCwd) });
    },

    async unarchiveSession(sessionId, fallbackCwd) {
      await tagSession(sessionId, null, { dir: cwdForSession(sessionId, fallbackCwd) });
    },

    async deleteSession(sessionId, fallbackCwd) {
      await deleteSession(sessionId, { dir: cwdForSession(sessionId, fallbackCwd) });
    },

    async renameSession(sessionId, title, fallbackCwd) {
      await renameSession(sessionId, title, { dir: cwdForSession(sessionId, fallbackCwd) });
    },

    // ── Model switching ──────────────────────────────────────────────────
    // Unlike OpenCode's setMode (a live API call that takes effect
    // immediately), there's no live Query to push a model change to
    // in-between turns in this spawn-per-turn architecture — driver.mjs's
    // own state.model (set below) is the sole source of truth, read fresh
    // by runTurn's baseOpts on the *next* turn this session runs. setModel
    // itself is therefore a no-op; it exists only so /set-model's backend
    // contract check (`typeof backend.setModel === "function"`) passes.
    listModels() {
      // ModelInfo.resolvedModel is NOT the reliable "is this a genuine
      // first-party model" signal it looks like — verified by hand that
      // Claude Code echoes `value` straight back as `resolvedModel` for
      // every custom modelPicker.options entry too (e.g. "azure/gpt-5.2" ->
      // resolvedModel "azure/gpt-5.2"), not just the real built-in aliases.
      // So instead of trying to infer "custom" from the ModelInfo shape,
      // this reads the exact same settings.json modelPicker.options list
      // that ADDS those entries in the first place (populated by the
      // separate LiteLLM-sync tooling the user runs, independent of
      // run-claude-docker.sh itself) and excludes precisely those `value`s
      // — nothing else in supportedModels()'s response was ever added by
      // that tooling, so this is an exact filter, not a heuristic. Those
      // custom entries are only reachable at all when this process is
      // actually talking to that gateway — ANTHROPIC_BASE_URL is set if and
      // only if run-claude-docker.sh launched with --litellm (confirmed
      // against that script: --direct and --direct-api never set it) — so
      // showing them in the switcher under --direct/--direct-api would just
      // offer a pile of models that don't exist there and will error if
      // picked.
      const usingGateway = !!process.env.ANTHROPIC_BASE_URL;
      let customValues = new Set();
      if (!usingGateway) {
        try {
          const settings = JSON.parse(readFileSync(nodePath.join(CLAUDE_CONFIG_DIR, "settings.json"), "utf8"));
          for (const opt of settings?.modelPicker?.options || []) {
            if (opt?.model) customValues.add(opt.model);
          }
        } catch (e) {
          console.error("[claude-code] failed to read settings.json for model-picker filtering:", e.message);
        }
      }
      return {
        available: knownModels
          .filter((m) => usingGateway || !customValues.has(m.value))
          .map((m) => ({
            id: m.value,
            label: m.displayName,
            description: m.description,
          })),
      };
    },

    async setModel() {},
  };
}
