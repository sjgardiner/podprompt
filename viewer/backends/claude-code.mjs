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
// renameSession, abort, listProjects, resolveValidCwd,
// cwdForSession, getKnownCommands. Every method that needs to reach the
// browser goes through the `broadcast`/`broadcastStatus`/`requestApproval`
// hooks passed in at construction — this module never talks to server.py or
// the shared pendingApprovals map directly, so it stays swappable with any
// other backend that honors the same hooks.

import { randomUUID } from "node:crypto";
import {
  appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync,
} from "node:fs";
import nodePath from "node:path";
import os from "node:os";
import {
  query, listSessions, getSessionMessages, getSubagentMessages,
  tagSession, renameSession, deleteSession,
} from "@anthropic-ai/claude-agent-sdk";

export function createClaudeCodeBackend({ cwdRoot, broadcast, broadcastStatus, requestApproval, registerChild, autoApproveForSession, updateSubAgent }) {
  // Best-effort transcript-uuid -> live bubble-id pairing, kept for this
  // process's lifetime only. Filled by runTurn's consume() loop (which
  // drains the stream tracker's announced ids per completed assistant
  // message, keyed by msg.uuid — the transcript entry's own uuid, per the
  // confirmed property below) and read by convertSessionMessages() when it
  // rebuilds history ids, so a history event re-seeded from the transcript
  // reuses the SAME bubble id a live turn already minted and server.py's
  // exact-triple dedup can suppress the duplicate instead of rendering it
  // twice. Strictly non-authoritative by design: the pairing is
  // probabilistic (the live stream announces bubble ids before the uuid that
  // completes them exists — the desync documented on makeStreamTracker), so
  // any wrong or missing entry degrades to the fallback ids (entry.uuid /
  // uuid-thinking-k) that already exist today. It can only improve dedup,
  // never cause content to be merged or dropped, and it's in-memory by
  // construction because the transcript/live-log overlap it exists to fix
  // can only occur within one server process life.
  const uuidToBubbleId = new Map(); // uuid -> { text: id|null, thinking: [id,...] }

  // Same config directory Claude Code's own session storage uses (and the
  // same real ~/.claude podprompt.sh bind-mounts — shared with any native,
  // non-Docker `claude` install on this host, not a container-only copy) —
  // stable across container relaunches regardless of what /workspace
  // currently points at, which is exactly why the cross-project bookkeeping
  // below lives here rather than anywhere under /workspace itself.
  const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || nodePath.join(os.homedir(), ".claude");
  const PROJECTS_DIR = nodePath.join(CLAUDE_CONFIG_DIR, "projects");

  // Tools whose whole purpose is to delegate to a sub-agent. Their bubbles
  // get the 'agent' role rather than 'tool'.
  const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

  // readdirSync that yields [] instead of throwing for a path that does not
  // exist — the sub-agent lookups below probe several speculative paths.
  function safeReaddir(dir) {
    try { return readdirSync(dir); } catch { return []; }
  }

  // ── Sub-agent permission attribution ───────────────────────────────────
  // The PermissionRequest hook runs ALONGSIDE canUseTool and never decides.
  // That is not caution, it is what this CLI actually supports — verified
  // live, and the negative result is worth recording because the type
  // definitions imply otherwise:
  //
  //   canUseTool + hook -> both fire, ~2ms apart, exactly one card. The hook
  //                        carries agent_id/agent_type; canUseTool does not.
  //   hook alone        -> NEITHER fires. Withholding canUseTool does not
  //                        promote the hook to decider; it removes the client
  //                        from the permission path entirely and the CLI
  //                        falls back to its own internal rules. Observed
  //                        directly: auto-approve off, no card shown, and
  //                        commands ran anyway.
  //
  // So the hook is an attribution side-channel, never an authority.
  // PODPROMPT_PERM_HOOK=off disables it; cards then fall back to the parent
  // session unattributed, exactly as before this existed.
  const PERM_HOOK_ON = (process.env.PODPROMPT_PERM_HOOK || "on").toLowerCase() !== "off";
  const PERM_PROBE_LOG = process.env.PODPROMPT_PERM_PROBE_LOG || "/tmp/podprompt-perm-probe.log";

  // The driver's own stdout goes to the container's console, which is awkward
  // to read after the fact — the probe writes to a file instead so a
  // verification run can be inspected directly.
  function permProbe(event, detail) {
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
    try { appendFileSync(PERM_PROBE_LOG, line); } catch { /* probe must never break a turn */ }
    console.log(`[perm-probe] ${event}`, JSON.stringify(detail));
  }
  if (PERM_HOOK_ON && process.env.PODPROMPT_PERM_PROBE_LOG) {
    permProbe("mode", { attribution: true, pid: process.pid });
  }

  // Sub-agent id maps, at factory scope rather than per-turn: canUseTool
  // closes over this scope, so declaring them inside runTurn would make them
  // invisible there — a ReferenceError that no syntax check catches. The keys
  // are globally unique ids, so sharing them across turns cannot collide.
  const childIdForToolUse = new Map(); // tool_use_id -> podprompt child session id
  const childIdForTask = new Map();    // task_id      -> podprompt child session id
  const childIdForAgent = new Map();   // agent_id     -> podprompt child session id

  // A sub-agent's identity, learned from the hook and consumed by the
  // canUseTool call it accompanies. Keyed on tool name + exact serialized
  // input, which is sound rather than a guess: the two fire ~2ms apart in a
  // fixed order for the SAME call, so at most one ask with a given key is in
  // flight. Entries are short-lived and swept, so a hook whose canUseTool
  // never arrives cannot accumulate.
  const agentHints = new Map(); // key -> { agentId, agentType, at, waiters: [] }
  const AGENT_HINT_TTL_MS = 5000;

  function hintKey(toolName, toolInput) {
    let serialized;
    try { serialized = JSON.stringify(toolInput); } catch { serialized = String(toolInput); }
    return `${toolName} ${serialized}`;
  }

  function recordAgentHint(toolName, toolInput, agentId, agentType) {
    const key = hintKey(toolName, toolInput);
    const now = Date.now();
    for (const [k, v] of agentHints) if (now - v.at > AGENT_HINT_TTL_MS) agentHints.delete(k);
    const prev = agentHints.get(key);
    const entry = { agentId, agentType, at: now, waiters: prev?.waiters || [] };
    agentHints.set(key, entry);
    for (const resolve of entry.waiters.splice(0)) resolve(entry);
  }

  // canUseTool fires FIRST (~2ms ahead of the hook), so it waits briefly for
  // the hint rather than reading it. Only when a sub-agent could plausibly be
  // asking — with no live children this returns immediately and the common
  // case pays nothing.
  function awaitAgentHint(toolName, toolInput, liveChildren) {
    if (!PERM_HOOK_ON || liveChildren === 0) return Promise.resolve(null);
    const key = hintKey(toolName, toolInput);
    const existing = agentHints.get(key);
    if (existing && Date.now() - existing.at <= AGENT_HINT_TTL_MS) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const entry = agentHints.get(key)
        || { agentId: null, agentType: null, at: Date.now(), waiters: [] };
      entry.waiters.push(resolve);
      agentHints.set(key, entry);
      // Bounded: a main-thread ask never gets a hint, and must not be held
      // up waiting for one that is not coming.
      setTimeout(() => {
        const i = entry.waiters.indexOf(resolve);
        if (i >= 0) entry.waiters.splice(i, 1);
        resolve(null);
      }, 250);
    });
  }

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

  // Per-turn host-path bookkeeping (which host directory was backing
  // /workspace the last time a turn ran for a session) now lives in
  // driver.mjs — stampSessionHost() there is called generically from the
  // shared runTurn() wrapper for every backend, not per-backend, and the
  // hostMismatch check it feeds is used by /sessions regardless of which
  // backend a session belongs to. See driver.mjs's own comment above
  // SESSION_HOSTS_FILE for the full explanation (including why this used to
  // live here, Claude-Code-only, and why that no longer made sense once
  // OpenCode needed the same "here's where to relaunch from" hint).

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

  // ── Available models, refreshed opportunistically from the start of every
  // turn (see the `system`/`init` handling in consume() below) ────────────
  // Same shape of problem as knownCommands above: Query.supportedModels() is
  // a live control-request method, not a standalone function, so there's no
  // way to populate this before any turn has ever run. Shared across sessions
  // for the same reason knownCommands is — the model lineup doesn't vary per
  // session, only which one a given session has selected (state.model).
  let knownModels = [];
  // Single-flight warm-up promise for knownModels. Unlike the old setup (the
  // only writer was supportedModels().then(...) inside a real turn's system/
  // init handling), this fills the cache up front via a throwaway Query that
  // never yields a real user prompt — reading initializationResult().models
  // directly. No real turn ever runs, so it works at driver.mjs startup (the
  // startup loop's unawaited backend.listModels() call above triggers this)
  // before any session has sent a prompt. Verified empirically: resolves in
  // ~270ms, then interrupt() tears the subprocess down cleanly with no orphan
  // process and no phantom transcript (settling only via the control channel
  // means Claude Code never persists a transcript for a turn that never ran).
  let modelsWarmPromise = null;
  function ensureModelsWarmed() {
    if (knownModels.length > 0) return Promise.resolve();
    if (modelsWarmPromise) return modelsWarmPromise;
    modelsWarmPromise = (async () => {
      const neverPrompt = (async function* () {
        await new Promise(() => {});
      })();
      const q = query({
        prompt: neverPrompt,
        options: { cwd: cwdRoot, permissionMode: "default" },
      });
      try {
        const init = await q.initializationResult();
        knownModels = init?.models || [];
      } finally {
        try {
          await q.interrupt();
        } catch (e) {
          console.error("[claude-code] model warm-up interrupt failed:", e.message);
        }
      }
    })().catch((e) => {
      // Don't permanently poison the cache on one bad attempt: reset the
      // single-flight promise so the next call retries from scratch instead
      // of leaving knownModels [] forever.
      modelsWarmPromise = null;
      console.error("[claude-code] model list warm-up failed:", e.message);
    });
    return modelsWarmPromise;
  }
  // ── Account-wide plan usage (subscription 5-hour/7-day rate-limit windows)
  // For future sessions investigating the plan-usage bar (this exact
  // question has come up more than once — the control-request API for it is
  // genuinely hard to find in docs, so don't rediscover this from scratch):
  // the never-yielding-prompt trick above is NOT specific to models.
  // Empirically verified (throwaway script, 2026-09-06 — see the
  // project-docker-viewer memory file for the full investigation) that the
  // SDK's usage control-request resolves the same way on a never-run Query
  // built exactly like the one above — no `resume` option needed at all,
  // since the payload (`subscription_type`/`rate_limits`) is account-scoped,
  // not session-scoped. Round trip was ~1.6s (heavier than the ~270ms models
  // case, presumably a real network hop to Anthropic's usage endpoint rather
  // than CLI-local state, but still cheap enough to poll on a timer),
  // `interrupt()` afterward was clean, no orphan process, no phantom
  // transcript — same cleanliness as the models warm-up.
  //
  // One fetch answers for every session sharing this account, so — like
  // knownModels above — this cache lives at backend-module scope, not
  // per-session. But *when* to poll and *who* to tell is driver.mjs's job,
  // not this file's: only driver.mjs knows every session id currently live
  // (this backend instance is shared across all of them and has no
  // visibility into the `sessions` Map). So this file only exposes
  // refreshAccountUsage()/getCachedAccountUsage() (see the returned object
  // at the bottom of this file); driver.mjs calls refreshAccountUsage() on a
  // timer and opportunistically after every turn, then fans the result out
  // via broadcastStatus() to every session id it knows about.
  //
  // Wrapped in a plainly-named function rather than calling the SDK method
  // inline: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` is
  // the SDK's own (still officially unstable) name for it, but we've now
  // verified it thoroughly enough to build on — leaving that name scattered
  // across call sites would make every future reader assume this feature is
  // shakier than it's actually proven to be. If a future SDK release renames
  // or stabilizes the method, this is the one place to update.
  async function fetchSubscriptionUsage(q) {
    return q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
  }

  let planUsageCache = null; // last successful {subscription_type, rate_limits}, or null (never fetched yet, or this account has no plan/quota — e.g. API-key/Bedrock/Vertex)
  let planUsagePromise = null; // single-flight in-flight fetch, same pattern as modelsWarmPromise
  let loggedPlanUsageUnavailable = false;

  function getCachedAccountUsage() {
    return planUsageCache;
  }

  // Single-flight: a timer tick and a just-finished turn landing at the same
  // moment collapse into one real fetch instead of two. Always resolves to
  // the best-known payload — a transient failure returns the last good
  // cache (if any) rather than null, so one bad poll never blanks out an
  // already-working bar; only a genuinely never-fetched-yet cache is null.
  function refreshPlanUsage() {
    if (planUsagePromise) return planUsagePromise;
    planUsagePromise = (async () => {
      const neverPrompt = (async function* () {
        await new Promise(() => {});
      })();
      const q = query({
        prompt: neverPrompt,
        options: { cwd: cwdRoot, permissionMode: "default" },
      });
      try {
        const usage = await fetchSubscriptionUsage(q);
        if (usage?.rate_limits_available) {
          planUsageCache = { subscription_type: usage.subscription_type, rate_limits: usage.rate_limits };
        }
      } finally {
        try {
          await q.interrupt();
        } catch (e) {
          console.error("[claude-code] plan-usage poll interrupt failed:", e.message);
        }
      }
      return planUsageCache;
    })().catch((e) => {
      // Not a one-shot breaker: keep retrying on every future call (timer
      // tick or post-turn trigger) regardless of this failure, same
      // philosophy as the old per-turn code this replaces. Just rate-limit
      // the console spam.
      if (!loggedPlanUsageUnavailable) {
        loggedPlanUsageUnavailable = true;
        console.error(
          `[claude-code] plan-usage poll failed (will keep retrying, logging this class of failure once): ${e.message}`
        );
      }
      return planUsageCache;
    }).finally(() => {
      planUsagePromise = null; // let the next tick/trigger retry, success or failure
    });
    return planUsagePromise;
  }

  // ── Per-session "which model did this session actually use" ─────────────
  // listModels(sessionId) derives the picker's pre-selected value from the
  // session's own transcript (the last assistant entry's resolved
  // `message.model`), reverse-mapped to a picker alias via knownModels'
  // `resolvedModel` field, rather than falling back to a global default.
  // Claude Code genuinely restores a session's last-used model on resume, but
  // that restoration is only observable live through the system/init message
  // — which doesn't arrive until a real turn runs in resume mode — so the
  // on-disk transcript is the only cheap, turn-free source. Values are cached
  // per session and dropped whenever that session completes a turn, since
  // only a real turn can change the answer. (getSessionMessages() on even a
  // multi-MB transcript resolves in ~70ms here — the 9MB session in this
  // environment included — so a fresh look on a cache miss is not meaningfully
  // expensive; the cache just avoids re-reading it on every /models poll.)
  const derivedModelCache = new Map(); // sessionId -> resolved model id (string) | null

  // Last assistant entry backward until one carries a usable string
  // `message.model`. Subagent/internal entries can interleave, and some
  // entries carry a non-string placeholder, so scan rather than assume the
  // final entry.
  function lastAssistantModel(rawMessages) {
    for (let i = (rawMessages || []).length - 1; i >= 0; i--) {
      const entry = rawMessages[i];
      if (entry?.type !== "assistant") continue;
      const m = entry.message?.model;
      if (typeof m === "string" && m.length > 0) return m;
    }
    return null;
  }

  // Reverse-map a resolved model id (e.g. "claude-haiku-4-5-20251001") back to
  // the picker alias (`haiku`). Ambiguity is real, not hypothetical: `default`
  // and `sonnet` both resolve to the same underlying model, so on a tie we
  // deliberately prefer `default`. If no alias resolves (e.g. a removed/renamed
  // model, or a model only reachable through a gateway this process isn't
  // talking to), fall back to the raw resolved id — listModels() then reports
  // it as not present in `available`, which is exactly what the frontend needs
  // to render its "model unavailable" state.
  function aliasForResolvedModel(resolved) {
    if (typeof resolved !== "string" || !resolved) return null;
    const matches = knownModels.filter((m) => m.resolvedModel === resolved);
    if (!matches.length) return resolved;
    const preferred = matches.find((m) => m.value === "default");
    if (preferred) return preferred.value;
    return matches[0].value;
  }

  async function derivedCurrentForSession(sessionId) {
    if (derivedModelCache.has(sessionId)) return derivedModelCache.get(sessionId);
    let resolved = null;
    try {
      const raw = await getSessionMessages(sessionId, { dir: cwdForSession(sessionId) });
      resolved = lastAssistantModel(raw);
    } catch (e) {
      // Session not reachable / no transcript — no derivation possible; same
      // treatment as "no session-specific model known": leave current unset so
      // the caller falls back to its default behavior.
      console.error(`[claude-code] failed to derive model for session ${sessionId}:`, e.message);
    }
    derivedModelCache.set(sessionId, resolved);
    return resolved;
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
    // Full text, never truncated — the viewer caps bubble *display* (scrollable
    // 400px body) and lets the user hide/collapse tool bubbles entirely, so
    // there's no reason to clip the content out of reach.
    return text;
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
  // instead of the plain one-liner summarizeToolInput() gives every other
  // tool. Falls through to summarizeToolInput() for anything else. Diff
  // content is full (never truncated) — the viewer caps the bubble's height
  // and lets the user hide/collapse it, so clipping costs the user nothing.
  function formatToolSummary(toolName, toolInput) {
    if (toolName === "Edit" && typeof toolInput?.old_string === "string" && typeof toolInput?.new_string === "string") {
      const diff = diffLines(toolInput.old_string, toolInput.new_string);
      return `\`Edit\` ${toolInput.file_path || ""}\n\`\`\`diff\n${diff}\n\`\`\``;
    }
    if (toolName === "MultiEdit" && Array.isArray(toolInput?.edits)) {
      const parts = toolInput.edits.map((e, idx) =>
        `--- edit ${idx + 1} ---\n${diffLines(e.old_string || "", e.new_string || "")}`);
      return `\`MultiEdit\` ${toolInput.file_path || ""}\n\`\`\`diff\n${parts.join("\n")}\n\`\`\``;
    }
    if (toolName === "Write" && typeof toolInput?.content === "string") {
      return `\`Write\` ${toolInput.file_path || ""}\n\`\`\`\n${toolInput.content}\n\`\`\``;
    }
    return `\`${toolName}\` ${summarizeToolInput(toolInput)}`;
  }

  // ── Session history conversion ───────────────────────────────────────────
  // Converting getSessionMessages() results into our {role, text, id, ts}
  // shape — deliberately the same shape the live broadcast path produces, so
  // history replays and live bubbles render identically. One known gap: SessionMessage
  // carries no per-entry timestamp, so historically-loaded messages get
  // ts: null (formatTs() in viewer.html already renders that as blank, not an
  // error). Another: unlike the live path, this doesn't distinguish a
  // task-notification "user" entry as its own "agent" role — a minor fidelity
  // loss versus the live broadcast path, not a functional gap. Unlike the
  // live stream, the full diff text of Edit/MultiEdit/Write tool bubbles
  // here is rebuilt independently from the SDK's stored tool_use input, so
  // history shows the same content the broadcast did.
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

  // `includeSubagent` is set only when converting a sub-agent's OWN
  // transcript, where every entry is by definition sub-agent-internal. In a
  // parent's transcript those entries are still skipped: they belong to the
  // child session's feed, not the parent's.
  function convertSessionMessages(rawMessages, { includeSubagent = false } = {}) {
    const out = [];
    for (const entry of rawMessages) {
      // Same fragility-margin as the opencode backend's converter: one
      // odd-shaped JSONL entry (a partial line from a crash, an interstitial
      // bookkeeping message, a subagent message missing `message.something`)
      // must not blank that session's whole rendered history. Convert
      // per-entry; skip what's unusable, keep the rest.
      try {
        // Sub-agent-internal entries belong to that sub-agent's own child
        // session, not here — skipped in a parent's transcript, kept when we
        // are converting the sub-agent's own file. isSidechain is the older
        // CLI builds' spelling of the same thing.
        if (!includeSubagent && (entry.parent_agent_id || entry.isSidechain)) continue;
        const content = entry.message?.content;

        if (entry.type === "assistant") {
          // Get model for this assistant message from transcript entry
          const msgModel = entry.message?.model;
          const model = msgModel ? aliasForResolvedModel(msgModel) : null;
          // Thinking blocks first (each its own bubble, matching the live
          // stream's per-block broadcast). Without this the browser's
          // in-memory log would re-seed tool/assistant text but silently
          // drop every reasoning block on a fresh server.py connect — the
          // source of thinking bubbles vanishing across a container restart.
          // The live bubble ids recorded under this transcript uuid (see
          // uuidToBubbleId) are used when available — positional by index
          // among the *visible* thinking blocks here, which is exactly the
          // order the tracker announced them in — with the derived
          // `uuid-thinking-k` fallback for anything the pairer missed.
          let thinkIdx = 0;
          const knownIds = (entry.uuid && uuidToBubbleId.get(entry.uuid)) || null;
          for (const b of (Array.isArray(content) ? content : [])) {
            if (b?.type === "thinking" && b?.thinking) {
              const paired = knownIds?.thinking?.[thinkIdx] || null;
              out.push({ role: "thinking", text: b.thinking, id: paired || `${entry.uuid}-thinking-${thinkIdx}`, ts: null, model: model || null });
              thinkIdx++;
            }
          }
          const text = extractTextFromContent(content);
          if (text.trim()) out.push({ role: "assistant", text, id: knownIds?.text || entry.uuid, ts: null, model: model || null });
          for (const tu of toolUsesFromContent(content)) {
            out.push({ role: "tool", text: formatToolSummary(tu.name, tu.input), id: tu.id, ts: null, model: model || null });
          }
        } else if (entry.type === "user" && isRealUserPrompt(content)) {
          const text = extractTextFromContent(content);
          if (text.trim()) out.push({ role: "user", text, id: entry.uuid, ts: null, model: null });
        }
      } catch (e) {
        console.error("[claude-code] skipped a history entry during conversion:", e.message);
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
      // Which sub-agent (if any) this ask belongs to. canUseTool itself is
      // told nothing about that, so the answer comes from the hook firing
      // alongside it — see the attribution block near the top of this file.
      const hint = await awaitAgentHint(toolName, toolInput, childIdForTask.size);
      const askingChildId = hint?.agentId ? (childIdForAgent.get(hint.agentId) || null) : null;
      // The card belongs in the asking sub-agent's own session: that is where
      // its transcript lives, so the approval sits next to the work that
      // prompted it instead of in a parent feed that never mentions it.
      const target = askingChildId || sessionId;

      if (toolName === "AskUserQuestion") {
        // Deliberately NOT short-circuited by auto-approve — that flag only
        // concerns tool-permission gating, not answering substantive
        // questions Claude is asking the user; those always still reach the
        // browser regardless.
        //
        // requestApproval resolves with { text, structured } for a question
        // (see driver.mjs's /permission-response — text/structured shape
        // added alongside per-question "Other" free-text support so
        // backends/opencode.mjs's replyQuestion can consume per-question
        // answers directly instead of re-parsing a joined string). This
        // backend only ever wants the plain-text form — Claude reads the
        // answer as a crafted deny message, not structured data.
        const answer = await requestApproval(target, "question", toolName, toolInput);
        // Verified: canUseTool fires for AskUserQuestion, but `allow` alone
        // leaves it unanswered ("The user did not answer the questions").
        // Denying with a crafted message is the mechanism that actually
        // works — Claude treats the message as the real answer.
        return { behavior: "deny", message: `The user answered: ${answer.text}` };
      }

      // Inherited down the tree, so a sub-agent of an auto-approved parent is
      // covered without the user ticking anything per child. On this backend
      // a sub-agent's calls already arrive on the parent's state, so this is
      // belt and braces for the cross-backend case.
      if (state.autoApprove || autoApproveForSession?.(sessionId)) {
        return { behavior: "allow", updatedInput: toolInput };
      }

      // options.suggestions is the SDK's own offer of rules that would stop
      // this ask recurring this session ("Typically if presenting the user an
      // option 'always allow' or similar, then this full set of suggestions
      // should be returned as the updatedPermissions in the
      // PermissionResult"). Passed to the browser so the card can offer that
      // third choice; returned as updatedPermissions when the user takes it.
      const suggestions = Array.isArray(options?.suggestions) ? options.suggestions : null;
      const decision = await requestApproval(target, "permission", toolName, toolInput, {
        suggestions,
        // Only offerable when the SDK actually proposed rules for this call;
        // without them there is nothing to widen and "Always allow" would be
        // a button that quietly behaved like a plain Allow.
        canAlwaysAllow: !!(suggestions && suggestions.length),
        // Named only when a sub-agent asked but could not be pinned to its
        // own session — then the card at least says who is asking rather
        // than reading as though the main thread asked.
        agentType: (!askingChildId && hint?.agentType) ? hint.agentType : null,
      });
      if (decision && decision.allow) {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          ...(decision.always && suggestions && suggestions.length
            ? { updatedPermissions: suggestions }
            : {}),
        };
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
    // Announced bubble ids per type, in streaming order. Filled when a block
    // first announces its bubble (first non-whitespace delta); drained once
    // per completed assistant message by consume() via takeAnnouncedIds() to
    // build the best-effort uuid->bubble-id map for history re-seeding (see
    // uuidToBubbleId / getSessionHistory). This is a strict one-way drain —
    // it does NOT resurrect the old id-cross-referencing for LIVE broadcasts,
    // which remain driven entirely by content_block_stop under each block's
    // own id (the documented FIFO-desync bug this tracker was rewritten to
    // avoid). Only the *smallest* answer we need is shared: "which ids got
    // announced this turn, in stream order", keyed by type — which aligns a
    // posteriori with convertSessionMessages' own non-empty-block ordering.
    const announcedByType = { text: [], thinking: [] };
    let sawStreamEvents = false;
    // Per-TYPE, because the fallback below needs to be per-type. A single
    // whole-turn flag meant that if the CLI streamed text blocks but not
    // thinking blocks, thinking was suppressed both ways: never streamed, and
    // never re-broadcast from the complete message either, because the flag
    // was already true. Thinking then existed on disk but never appeared
    // live — which is exactly how it behaved.
    const announcedStreamByType = { text: false, thinking: false };
    // The model for the message currently streaming. Captured here because
    // this is the ONLY place it is known in time: modelByUuid is filled from
    // the complete assistant message, which arrives AFTER its blocks have
    // streamed, and a streamed text block never gets a final broadcast (that
    // is suppressed to avoid duplicating the bubble). So without this the
    // model label was simply absent on every live turn and only appeared
    // when history was re-read from disk — which is exactly how it looked.
    let streamingModel = null;

    function handleStreamEvent(event) {
      if (!event) return;

      // message_start carries the model for everything that follows it.
      if (event.type === "message_start") {
        const m = event.message?.model;
        if (m) streamingModel = aliasForResolvedModel(m);
        return;
      }

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
        // Skip whitespace-only deltas to prevent empty MODEL bubbles
        if (!chunk.trim()) return;
        entry.text += chunk;
        const role = entry.type === "thinking" ? "thinking" : "assistant";
        if (!entry.started) {
          entry.started = true;
          // Record the bubble's id now that it actually exists (a block that
          // never produces visible text never announces and never gets here).
          announcedByType[entry.type].push(entry.id);
          // Recorded when a bubble is genuinely created, not at
          // content_block_start: a block that never produces visible content
          // announces nothing, and must not suppress its own fallback.
          announcedStreamByType[entry.type] = true;
          // Carrying the model here matches what the opencode backend
          // already does, and is what the viewer's stream_start handler
          // reads to label the bubble.
          broadcastStatus(sessionId, { type: "stream_start", id: entry.id, role, model: streamingModel });
        }
        broadcastStatus(sessionId, { type: "stream_delta", id: entry.id, role, text: entry.text });
        return;
      }

        if (event.type === "content_block_stop") {
          const entry = liveBlocks.get(event.index);
          if (!entry) return;
          liveBlocks.delete(event.index);
          if (!entry.text.trim()) return; // never produced visible content — no bubble exists, nothing to finalize
          broadcast(sessionId, entry.type === "thinking" ? "thinking" : "assistant", entry.text, entry.id, null, null);
        }
    }

    return {
      handleStreamEvent,
      get sawStreamEvents() { return sawStreamEvents; },
      // "Did a bubble of this type actually get streamed this turn?" — the
      // question each fallback below needs to ask about ITS OWN type.
      streamedType(type) { return !!announcedStreamByType[type]; },
      // Take (and empty) the announced ids of one type, in announced order —
      // called once per completed assistant message so each uuid's pairing is
      // built from exactly that message's own blocks. Best-effort: any
      // mismatch with the transcript's block set just leaves the converter's
      // fallback ids in place.
      takeAnnouncedIds(type) {
        const taken = announcedByType[type];
        announcedByType[type] = [];
        return taken;
      },
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
  // duplicate, now that nothing else will ever independently
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
    // Host-path stamping now happens generically in driver.mjs's own
    // runTurn() wrapper, once for every backend — see its comment.
    state.turnInFlight = true;
    // `backend` here lets server.py's /status handler seed this session's
    // history from disk (if it hasn't already) before this turn's own
    // broadcasts start landing — see the comment on server.py's turn_start
    // handling for why that has to happen here, not only on a browser's
    // GET /events, and why the backend hint is required.
    broadcastStatus(sessionId, { type: "turn_start", backend: "claude-code" });

    const streamTracker = makeStreamTracker(sessionId);
    const canUseTool = makeCanUseTool(sessionId, state);

    const userMsgUuid = randomUUID();
    broadcast(sessionId, "user", promptText, userMsgUuid, null, null);

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
      // ALWAYS passed. Verified live that withholding it does not promote the
      // hook below to decider — it removes the client from the permission
      // path entirely and the CLI falls back to its own rules, running
      // commands with no card shown and auto-approve off. canUseTool is, and
      // stays, the only authority on whether a tool runs.
      canUseTool,
      // Live typing + thinking-block visibility in the browser. Deliberately
      // not also setting `thinking:` here — adaptive thinking is already the
      // SDK's default for models that support it, and forcing it on would be
      // a real cost/latency change (extended thinking tokens), not just a
      // display change. This only asks for whatever the model already
      // produces to be streamed instead of dropped.
      // The hook is registered purely to learn WHICH sub-agent is asking:
      // it fires alongside canUseTool carrying agent_id, which canUseTool's
      // own options do not provide, and it never returns a decision.
      ...(PERM_HOOK_ON
        ? { hooks: { PermissionRequest: [{ hooks: [permissionAttributionHook] }] } }
        : {}),
      includePartialMessages: true,
      // Declares that the viewer renders a per-sub-agent stop control, which
      // it now does (the roster's stop button -> POST /abort-subagent).
      //
      // This INVERTS what Stop means for background tasks: declared, an
      // interrupt spares them and they are stopped one at a time through our
      // own affordance; undeclared, the CLI fails closed and an interrupt
      // kills them. So it is only safe alongside the parent->child abort
      // cascade in driver.mjs, which is what now stops a sub-agent when the
      // parent is stopped. Declaring this WITHOUT that cascade would leave
      // orphaned sub-agents running, which is exactly what the fail-closed
      // default exists to prevent.
      perTaskStopAffordance: true,
      // Without this the SDK forwards only a sub-agent's tool_use/tool_result
      // blocks — "enough for a heartbeat counter" in its own words — so a
      // sub-agent's reasoning and its final report never arrive at all, and
      // its child session would contain tool bubbles and nothing else. Costs
      // no extra model tokens: the text is already generated, this only asks
      // for it to be forwarded rather than dropped.
      forwardSubagentText: true,
      // Makes task_progress carry a model-written one-line status, which is
      // what the roster shows as a sub-agent's current activity. The only
      // option here with a real (small) cost, since the model writes them.
      agentProgressSummaries: true,
      // state.model is only ever set by the browser's model-switcher
      // (POST /set-model, see driver.mjs) — omit the option entirely rather
      // than pass undefined/null so an unset session keeps using the CLI's
      // own default model, exactly like before this feature existed.
      ...(state.model ? { model: state.model } : {}),
    };

    // ── Sub-agents ─────────────────────────────────────────────────────────
    // Claude Code runs a sub-agent as a Task INSIDE this session rather than
    // as a session of its own, so unlike opencode there is nothing to adopt —
    // the child session is synthesized here. It is keyed on the spawning
    // tool_use_id rather than the task_id because that is the one identifier
    // present both in these live events and in the on-disk
    // subagents/agent-<id>.meta.json, which is what lets a live view and a
    // replayed view agree on which sub-agent they are looking at.

    // The sub-agent id families do not meet. task_started speaks task_id and
    // tool_use_id; the hooks speak agent_id; nothing live carries a pair of
    // one from each. So the link is learned opportunistically from the few
    // messages that DO carry both (SDKToolProgressMessage, and a denied
    // permission), and until it is learned a sub-agent's ask is labelled by
    // its agent TYPE rather than pinned to its child session. That is a
    // smaller claim than guessing, which on a permission card is the worst
    // thing to get wrong.
    function linkAgentToToolUse(agentId, toolUseId) {
      if (!agentId || !toolUseId) return;
      const childId = childIdForToolUse.get(toolUseId);
      if (childId && !childIdForAgent.has(agentId)) {
        childIdForAgent.set(agentId, childId);
        registerChild?.(childId, { parent: sessionId, native: { agentId } });
      }
    }

    function ensureChildSession(info) {
      const toolUseId = info.tool_use_id;
      if (!toolUseId) return null; // nothing stable to key on; skip rather than invent one
      let childId = childIdForToolUse.get(toolUseId);
      if (!childId) {
        childId = randomUUID();
        childIdForToolUse.set(toolUseId, childId);
        registerChild?.(childId, {
          parent: sessionId,
          backend: "claude-code",
          childKind: "native-task",
          subagentType: info.subagent_type || null,
          description: info.description || null,
          // Verified against a live CLI run: task_started's task_id IS the
          // agent id the transcript file is named after — a sub-agent with
          // task_id a29580a68b7c7c8ec writes
          // subagents/agent-a29580a68b7c7c8ec.jsonl. So the two id families
          // that looked disjoint (task_id/tool_use_id vs agent_id) are in
          // fact joined, and the agent id is known live rather than having
          // to be recovered from disk.
          native: { toolUseId, taskId: info.task_id || null, agentId: info.task_id || null },
        });
      }
      if (info.task_id) {
        childIdForTask.set(info.task_id, childId);
        childIdForAgent.set(info.task_id, childId);
      }
      return childId;
    }

    // NOT REGISTERED YET — see baseOpts. Written and ready, but switching the
    // permission path over is a safety-relevant change that cannot be
    // verified from here: if this CLI build ignores PermissionRequest hooks,
    // registering it and dropping canUseTool would silently remove tool
    // gating altogether, and registering it ALONGSIDE canUseTool may prompt
    // twice for one call. Both failure modes need a real CLI to rule out.
    //
    // Attribution only. Fires alongside canUseTool (~2ms after it) for the
    // same call, carrying the agent_id that canUseTool's own options do not.
    // It deliberately returns {} — "no opinion" — because this hook is not
    // and cannot be an authority: verified live that making it one by
    // withholding canUseTool simply removes the client from the permission
    // path. canUseTool picks the recorded hint up via awaitAgentHint.
    async function permissionAttributionHook(input) {
      const toolName = input?.tool_name || "tool";
      const toolInput = input?.tool_input || {};
      const agentId = input?.agent_id || null;
      const agentType = input?.agent_type || null;
      if (agentId) recordAgentHint(toolName, toolInput, agentId, agentType);
      if (process.env.PODPROMPT_PERM_PROBE_LOG) {
        permProbe("hook-fired", {
          toolName, agentId, agentType,
          resolvedChild: agentId ? (childIdForAgent.get(agentId) || null) : null,
          liveChildren: childIdForTask.size,
        });
      }
      return {};
    }

    function routeSubagentMessage(childId, msg) {
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            broadcast(childId, "assistant", block.text, block.id || randomUUID(), null, null);
          } else if (block.type === "thinking" && block.thinking) {
            broadcast(childId, "thinking", block.thinking, randomUUID(), null, null);
          } else if (block.type === "tool_use") {
            updateSubAgent?.(childId, { lastTool: block.name || null });
            broadcast(childId, "tool", formatToolSummary(block.name, block.input), block.id, null, null);
          }
        }
      }
    }

    // The SDK's task_* messages are the sub-agent lifecycle. All of them used
    // to fall through the loop's unhandled default and vanish.
    function handleTaskMessage(msg) {
      if (msg.subtype === "task_started") {
        // Ambient/housekeeping tasks are explicitly not activity ("Consumers
        // should hide this from the inline transcript") — they are not
        // sub-agents and must not appear as one.
        if (msg.skip_transcript || msg.ambient) return;
        // task_started covers EVERY kind of registered task, not just
        // sub-agents — a backgrounded Bash command is a local_bash task and
        // arrives here too. Observed live: ordinary Bash calls were being
        // registered as sub-agents and shown in the roster, identifiable
        // only by having no subagent_type. Only a Task-tool sub-agent
        // (local_agent) is one of ours.
        if (msg.task_type && msg.task_type !== "local_agent") return;
        if (!msg.task_type && !msg.subagent_type) return;
        const childId = ensureChildSession(msg);
        if (!childId) return;
        updateSubAgent?.(childId, {
          status: "running",
          startedAt: Date.now(),
          isBackgrounded: !!msg.is_backgrounded,
          description: msg.description || null,
          subagentType: msg.subagent_type || null,
        });
        return;
      }
      if (msg.subtype === "task_progress") {
        const childId = msg.task_id ? childIdForTask.get(msg.task_id)
          : (msg.tool_use_id ? childIdForToolUse.get(msg.tool_use_id) : null);
        if (!childId) return;
        updateSubAgent?.(childId, {
          status: "running",
          lastTool: msg.last_tool_name || null,
          summary: msg.summary || null,
          usage: msg.usage || null,
        });
        return;
      }
      if (msg.subtype === "task_updated") {
        const childId = msg.task_id ? childIdForTask.get(msg.task_id) : null;
        if (!childId || !msg.patch) return;
        updateSubAgent?.(childId, {
          ...(msg.patch.status ? { status: msg.patch.status } : {}),
          ...(msg.patch.error ? { error: msg.patch.error } : {}),
          ...(typeof msg.patch.is_backgrounded === "boolean"
            ? { isBackgrounded: msg.patch.is_backgrounded } : {}),
        });
      }
    }

    async function consume(opts) {
      const q = query({ prompt: onePrompt(), options: opts });
      const modelByUuid = new Map(); // uuid -> model display name
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
          // supportedModels() is a control-request method on this live Query
          // `q` — it round-trips to the CLI subprocess over its control
          // channel. Verified by hand (against this exact CLI build) that
          // this channel stops being serviced right around when the CLI
          // emits its final `result` message for the turn: calling it there
          // (previously done, at the `result` branch below) reliably
          // rejects with "Query closed before response received" — 100%
          // reproducible, not a flaky race — while calling it here,
          // immediately after `system/init`, resolves in ~1s every time. So
          // this isn't a CLI-version gap (the control command is already
          // implemented in this container's CLI binary — confirmed by
          // string-searching the actual binary at CLAUDE_CODE_EXECPATH —
          // and this call proves it live), it's purely about calling before
          // the turn's control channel winds down. Net effect: this
          // refreshes once per turn, from *before* that turn's tokens are
          // counted (a turn's lag behind, same trade-off knownCommands
          // above already made) — acceptable for a model list that only
          // needs to move over time, not be perfectly real-time.
          //
          // usage_EXPERIMENTAL_...() (the plan-usage bar) used to be called
          // here too, on exactly this same reasoning — moved out entirely as
          // of 2026-09-06 to a driver-level global poll instead (see
          // refreshPlanUsage()/fetchSubscriptionUsage() above and driver.mjs)
          // once it was verified that call doesn't need a real turn (or even
          // this session's `resume`) at all, since the payload is
          // account-scoped. Don't re-add a per-turn usage_EXPERIMENTAL_...()
          // call here — see this file's plan-usage section above for why.
          q.supportedModels().then((models) => {
            knownModels = models || [];
          }).catch((e) => {
            console.error(`[claude-code] supportedModels() failed for session ${sessionId}:`, e.message);
          });
          continue;
        }

        if (msg.type === "stream_event") {
          streamTracker.handleStreamEvent(msg.event);
          continue;
        }

        // Anything carrying BOTH ids teaches us the pairing the hook needs.
        if (msg.agent_id && msg.tool_use_id) linkAgentToToolUse(msg.agent_id, msg.tool_use_id);

        if (msg.type === "system"
            && (msg.subtype === "task_started" || msg.subtype === "task_progress" || msg.subtype === "task_updated")) {
          handleTaskMessage(msg);
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
          // supportedModels() used to be called here too (and, briefly,
          // usage_EXPERIMENTAL_...() alongside it) — moved to the
          // system/init handler above. See the comment there: calling
          // either one at this point (the turn's last message) reliably
          // fails with "Query closed before response received" because this
          // CLI build stops servicing `q`'s control channel once the turn
          // is winding down, not because the CLI lacks the command.
          // usage_EXPERIMENTAL_...() has since moved again, off this
          // per-turn `q` entirely — see refreshPlanUsage() above.
          continue;
        }

        // A sub-agent's frames arrive on this same stream, distinguished only
        // by parent_tool_use_id. Routed to the child session that tool call
        // created, so they stop masquerading as the parent's own work — and
        // so context_usage from a sub-agent stops overwriting the parent's
        // context bar, and a sub-agent running a cheaper model stops stamping
        // that model onto bubbles in the parent's feed.
        if (msg.parent_tool_use_id && childIdForToolUse.has(msg.parent_tool_use_id)) {
          routeSubagentMessage(childIdForToolUse.get(msg.parent_tool_use_id), msg);
          continue;
        }

        if (msg.type === "assistant" && msg.message?.content) {
          // Capture model for this message (msg.model takes precedence, fallback to context_usage)
          const model = msg.model || (msg.context_usage?.model || null);
          if (model) modelByUuid.set(msg.uuid, aliasForResolvedModel(model));
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
            if (block.type === "text" && block.text && !streamTracker.streamedType("text")) {
              broadcast(sessionId, "assistant", block.text, msg.uuid, null, modelByUuid.get(msg.uuid));
            } else if (block.type === "thinking" && block.thinking && !streamTracker.streamedType("thinking")) {
              broadcast(sessionId, "thinking", block.thinking, randomUUID(), null, null);
            } else if (block.type === "tool_use") {
              const msgModel = modelByUuid.get(msg.uuid) || null;
              // Spawning a sub-agent is not the same kind of event as running
              // a tool, and rendering it as one made the most structurally
              // significant thing a turn can do look like a `Grep`. It gets
              // the dedicated 'agent' role, carrying the task's description
              // as its title; the viewer fills in live status underneath from
              // the roster, keyed by this same tool_use id.
              if (SUBAGENT_TOOL_NAMES.has(block.name)) {
                const title = (block.input && (block.input.description || block.input.prompt)) || block.name;
                broadcast(sessionId, "agent", String(title).split("\n")[0].slice(0, 200), block.id, null, msgModel);
              } else {
                broadcast(sessionId, "tool", formatToolSummary(block.name, block.input), block.id, null, msgModel);
              }
            }
          }
          // Best-effort pairing for history re-seeding: drain this completed
          // message's announced bubble ids (if streaming happened at all) into
          // the per-uuid map convertSessionMessages reads when it rebuilds
          // history ids — so a history event re-seeded from the transcript
          // reuses the SAME bubble id a live turn already minted, letting
          // server.py's exact-triple dedup actually suppress the duplicate.
          // Safe to guess at by construction: a wrong pairing just leaves the
          // fallback (entry.uuid / uuid-thinking-k) ids in place, identical
          // to today's behavior — it can never mis-merge or drop content.
          if (msg.uuid && streamTracker.sawStreamEvents) {
            const thinkingIds = streamTracker.takeAnnouncedIds("thinking");
            const textIds = streamTracker.takeAnnouncedIds("text");
            uuidToBubbleId.set(msg.uuid, { thinking: thinkingIds, text: textIds[0] || null });
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
        broadcast(sessionId, "tool", "*(stopped)*", randomUUID(), null, null);
        state.turnOutcome = { reason: "aborted" };
      } else {
        console.error(`[claude-code] error during turn for session ${sessionId}:`, e.message);
        broadcast(sessionId, "tool", `*(error: ${e.message})*`, randomUUID(), null, null);
        state.turnOutcome = { reason: "error", error: e.message };
      }
    } finally {
      if (state.abortController === abortController) state.abortController = null;
      state.turnInFlight = false;
      // A completed turn may have run on a different model (state.model) than
      // the session's previous one — drop the cached derivation so the next
      // listModels() re-reads the transcript's new last assistant entry.
      derivedModelCache.delete(sessionId);
      // turn_end is deliberately NOT broadcast here — driver.mjs's runTurn
      // wrapper emits it once this returns, reading the state.turnOutcome set
      // above so a Stop and a crash reach the browser as distinguishable
      // reasons. See the backend-contract comment at the top of driver.mjs.
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

    // `sessionsIndex` is the shared driver.mjs `sessions` Map (sessionId ->
    // {turnInFlight, ...}) — needed here only to report inFlight/pendingKind
    // per listed session, kept as a plain param rather than a constructor
    // closure so this backend never has to guess which Map instance is live.
    async listSessions({ includeUnreachable }, sessionsIndex, pendingKindForSession) {
      const reachableCwds = [...knownProjects.reachable.keys()];
      const perProject = await Promise.all(reachableCwds.map(async (cwd) => {
        try {
          const list = await listSessions({ dir: cwd, limit: 50 });
          return list.map((s) => {
            // Get file path for createdAt from transcript
            const transcriptPath = s.transcript_path || null;
            let createdAt = null;
            if (transcriptPath) {
              try {
                const stat = statSync(transcriptPath);
                // Try birthtime first (most accurate), fallback to ctime
                createdAt = stat.birthtimeMs || stat.ctimeMs || null;
              } catch {
                // ignore
              }
            }
            return {
              ...s,
              backend: "claude-code",
              cwd,
              projectLabel: projectLabelFor(cwd),
              createdAt: createdAt || null,
              unreachable: false,
              inFlight: !!sessionsIndex.get(s.sessionId)?.turnInFlight,
              pendingKind: pendingKindForSession(s.sessionId),
            };
          });
        } catch (e) {
          console.error(`[claude-code] listSessions failed for ${cwd}:`, e.message);
          return [];
        }
      }));

      let unreachableSessions;
      if (includeUnreachable) {
        unreachableSessions = [];
        for (const [cwd, folder] of knownProjects.unreachable) {
          const folderPath = nodePath.join(PROJECTS_DIR, folder);
          let files = [];
          try {
            files = readdirSync(folderPath).filter((f) => f.endsWith(".jsonl"));
          } catch {
            continue;
          }
          for (const file of files) {
            const sessionId = file.slice(0, -".jsonl".length);
            const filePath = nodePath.join(folderPath, file);
            // Get file birthtime for createdAt
            let createdAt = null;
            try {
              const stat = statSync(filePath);
              createdAt = stat.birthtimeMs || stat.ctimeMs || null;
            } catch {
              // ignore
            }
            unreachableSessions.push({
              sessionId,
              backend: "claude-code",
              cwd,
              projectLabel: projectLabelFor(cwd),
              createdAt: createdAt,
              unreachable: true,
              // lastKnownHostPath/hostMismatch are attached centrally by
              // driver.mjs's /sessions handler now (see its own comment) —
              // not backend-specific, so no longer computed here.
              ...lightweightSessionSummary(filePath),
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

    // The live task_* events give a tool_use_id but never the agent id the
    // transcript file is named after. The sidecar beside each sub-agent
    // transcript carries both, so this is the join: scan the parent's
    // subagents/ directory for the meta whose toolUseId matches.
    resolveSubagentAgentId(parentSessionId, toolUseId) {
      if (!parentSessionId || !toolUseId) return null;
      for (const folder of safeReaddir(PROJECTS_DIR)) {
        const dir = nodePath.join(PROJECTS_DIR, folder, parentSessionId, "subagents");
        for (const f of safeReaddir(dir)) {
          if (!f.endsWith(".meta.json")) continue;
          try {
            const meta = JSON.parse(readFileSync(nodePath.join(dir, f), "utf8"));
            if (meta?.toolUseId === toolUseId) {
              return f.slice("agent-".length, -".meta.json".length);
            }
          } catch { /* a torn or unexpected sidecar is not worth failing over */ }
        }
      }
      return null;
    },

    async getSessionHistory(sessionId, fallbackCwd, relation) {
      // A sub-agent's transcript is a file of its own
      // (subagents/agent-<agentId>.jsonl), not entries inside the parent's —
      // so replaying one means asking the SDK for that agent's messages
      // against the PARENT's session id, not this child's synthesized id,
      // which no transcript on disk has ever heard of.
      if (relation?.childKind === "native-task") {
        const parentId = relation.parent;
        const agentId = relation.native?.agentId
          || this.resolveSubagentAgentId(parentId, relation.native?.toolUseId);
        if (!agentId || !parentId) return [];
        try {
          const raw = await getSubagentMessages(parentId, agentId, {
            dir: cwdForSession(parentId, fallbackCwd),
          });
          return convertSessionMessages(raw, { includeSubagent: true });
        } catch {
          return [];
        }
      }
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
    async listModels(sessionId) {
      // Warm the model list first (single-flight; the throwaway-query warm-up
      // in ensureModelsWarmed() fills knownModels at startup, before any real
      // turn has run — see the comment block by its declaration above). The
      // startup loop and every /models request share the same single-flight
      // promise, so concurrent early calls don't spawn competing queries.
      await ensureModelsWarmed();
      const available = knownModels.map((m) => ({
        id: m.value,
        label: m.displayName,
        description: m.description,
      }));
      // Derive this session's own last-used model (see the comment block by
      // derivedModelCache) and reverse-map it to a picker alias. This is the
      // session-specific `current` that replaces the old global-default
      // fallback; driver.mjs's own state.model override still wins on top of
      // this (see its /models route), so an explicit in-run picker choice
      // always takes precedence. currentConfirmed tells the frontend whether
      // the derived value is actually selectable right now — false means "this
      // session's model isn't in the currently-known lineup", the signal for
      // its "model unavailable" state.
      const derivedResolved = sessionId ? await derivedCurrentForSession(sessionId) : null;
      const derivedAlias = aliasForResolvedModel(derivedResolved);
      const current = derivedAlias || null;
      const currentConfirmed = !!current && available.some((m) => m.id === current);
      return { available, current, currentConfirmed };
    },

    async setModel() {},

    // ── Account-wide plan usage (see the section by refreshPlanUsage() above
    // for the full story) ────────────────────────────────────────────────
    // Not part of the documented backend contract at the top of driver.mjs
    // (both are optional, feature-detected with `typeof backend.x ===
    // "function"`, same as listModels()/getKnownCommands()) — OpenCode has
    // no equivalent (its "spend" concept is a per-session running cost
    // accumulator, not an account-wide quota, so there's nothing to
    // centralize there the same way).
    async refreshAccountUsage() {
      return refreshPlanUsage();
    },

    getCachedAccountUsage() {
      return getCachedAccountUsage();
    },
  };
}
