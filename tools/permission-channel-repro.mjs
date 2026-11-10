#!/usr/bin/env node
// Makes the permission-channel failure happen on demand, and proves the fix
// stops it. Run by hand; it costs a handful of model calls and about a minute.
//
//     node tools/permission-channel-repro.mjs
//
// Exits 0 if the fix holds, 1 if it does not. Takes no arguments.
//
//
// WHAT THIS IS FOR
// ----------------
// The unit tests next to the driver (viewer/turn-binding.test.mjs) cover the
// decision in isolation: given a result message, is it ours? They would still
// pass if somebody broke the wiring around it — the gate, the message loop, or
// the order of the two. This script exercises the real Claude Agent SDK and
// the real CLI, end to end, and is the only thing that would notice.
//
// It is NOT part of `node --test`: it spends real tokens and takes ~60s.
//
//
// THE BUG IT REPRODUCES
// ---------------------
// PodPrompt hands the SDK a prompt generator. When that generator finishes,
// the SDK waits for the FIRST `result` message and then closes stdin to the
// CLI child ("Calling transport.endInput() to close stdin to CLI process", in
// its own debug output). The canUseTool permission callback travels over that
// same stdin.
//
// So any result arriving before the turn is genuinely finished silently ends
// the turn's ability to obtain a permission decision, while the turn carries
// on looking healthy: tools the CLI permits internally (ls, grep, reads) keep
// working, text keeps streaming, and the turn still reports success.
//
// Claude Code emits an early result when it clears a background task orphaned
// by a previous turn — about a millisecond after init, before the prompt is
// looked at. That is what scenario 2 below arranges deliberately.
//
// THE FIX, which scenario 3 checks: park the generator and release it only on
// a result carrying the uuid we stamped on our own prompt. The early result
// carries no user-message uuid at all, because no user message caused it.
//
// Observed 2026-11-10. See viewer/turn-binding.mjs.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

const WORK = nodePath.join(os.tmpdir(), "podprompt-permission-repro");
const PROBE = nodePath.join(WORK, "probe.txt");

// The SDK lives with the deployed viewer, not with this script. Try the normal
// resolution first so this still works from a checkout that has node_modules.
async function loadSdk() {
  const candidates = [
    "@anthropic-ai/claude-agent-sdk",
    nodePath.join(os.homedir(), ".local/share/podprompt/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* try the next one */ }
  }
  console.error("Could not find @anthropic-ai/claude-agent-sdk. Looked in:");
  for (const c of candidates) console.error("   " + c);
  process.exit(2);
}
const { query } = await loadSdk();

// Running this from inside a Claude Code session leaves CLAUDECODE and friends
// in the environment, which confuses the child we are about to spawn. Clear
// them for our own process, so the child inherits a clean slate.
for (const k of [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID",
]) delete process.env[k];

const T0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - T0).padStart(6)}ms]`, ...a);

// The same test the driver uses. Duplicated rather than imported so this
// script keeps working if the module moves, and so a change to the real one
// does not silently change what this verifies.
function resultIsOurs(msg, uuid) {
  if (!msg || msg.type !== "result" || !uuid) return false;
  const list = msg.user_message_uuids;
  if (Array.isArray(list)) return list.includes(uuid);
  return msg.user_message_uuid === uuid;
}

function makeGate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open: () => open() };
}

// `hold` false reproduces the OLD behaviour (generator returns immediately);
// true reproduces the CURRENT one (generator parks until our result).
async function runTurn({ tag, text, resume, hold }) {
  const uuid = randomUUID();
  const gate = makeGate();
  let sessionId = resume || null;
  let results = 0, permissionFailures = 0, canUseToolCalls = 0;

  const prompt = (async function* () {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid };
    if (hold) await gate.promise;
  })();

  const q = query({
    prompt,
    options: {
      cwd: WORK,
      permissionMode: "default",
      maxTurns: 12,
      ...(resume ? { resume } : {}),
      canUseTool: async (name, input) => {
        canUseToolCalls++;
        log(`${tag}   canUseTool reached (${name})`);
        return { behavior: "allow", updatedInput: input };
      },
    },
  });

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id || sessionId;
      if (msg.type === "user") {
        for (const b of msg.message?.content || []) {
          if (b?.type !== "tool_result" || b.is_error !== true) continue;
          const t = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          if (t.trimStart().startsWith("Tool permission request failed")) {
            permissionFailures++;
            log(`${tag}   PERMISSION FAILURE`);
          }
        }
      }
      if (msg.type === "result") {
        results++;
        const ours = resultIsOurs(msg, uuid);
        log(`${tag}   result #${results}: ${ours ? "ours" : "NOT ours (queued work of its own)"}`);
        if (ours) gate.open();
      }
    }
  } finally {
    gate.open();
    try { q.close(); } catch { /* already closed */ }
  }
  return { sessionId, results, permissionFailures, canUseToolCalls };
}

const ORPHAN = "Use the Bash tool with run_in_background set to true to run exactly: sleep 900"
  + "\nThen immediately reply with the single word DONE. Do not wait for it.";
const NEEDS_PERMISSION = `Use the Write tool to create ${PROBE} containing the single word OK.`;

function freshWorkspace() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
}

const failures = [];
function check(label, condition, detail) {
  console.log(`${condition ? "  PASS" : "  FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!condition) failures.push(label);
}

// ── 1. Control: a healthy session, old-style generator. ────────────────────
console.log("\n=== 1. control (healthy session) ===");
freshWorkspace();
{
  const a = await runTurn({ tag: "C1", text: "Reply with the single word READY. Use no tools.", hold: false });
  const b = await runTurn({ tag: "C2", text: NEEDS_PERMISSION, resume: a.sessionId, hold: false });
  check("one result", b.results === 1, `got ${b.results}`);
  check("permission callback reached", b.canUseToolCalls === 1);
  check("no permission failures", b.permissionFailures === 0);
}

// ── 2. The bug, on demand: orphan a background task, old-style generator. ──
console.log("\n=== 2. the bug (orphaned background task, generator returns early) ===");
freshWorkspace();
let bugReproduced = false;
{
  const a = await runTurn({ tag: "B1", text: ORPHAN, hold: false });
  const b = await runTurn({ tag: "B2", text: NEEDS_PERMISSION, resume: a.sessionId, hold: false });
  bugReproduced = b.permissionFailures > 0 && b.canUseToolCalls === 0;
  check("two results (one of them not ours)", b.results >= 2, `got ${b.results}`);
  check("bug reproduced: permission callback never reached", bugReproduced,
    `canUseTool=${b.canUseToolCalls} failures=${b.permissionFailures}`);
  check("the file was NOT written", !existsSync(PROBE));
}

// ── 3. The fix: same setup, generator parks until our own result. ──────────
console.log("\n=== 3. the fix (same setup, generator holds the input open) ===");
freshWorkspace();
{
  const a = await runTurn({ tag: "F1", text: ORPHAN, hold: true });
  const b = await runTurn({ tag: "F2", text: NEEDS_PERMISSION, resume: a.sessionId, hold: true });
  check("still two results — the early one still happens", b.results >= 2, `got ${b.results}`);
  check("permission callback reached anyway", b.canUseToolCalls === 1);
  check("no permission failures", b.permissionFailures === 0, `got ${b.permissionFailures}`);
  check("the file WAS written", existsSync(PROBE));
}

rmSync(WORK, { recursive: true, force: true });

console.log("");
if (!bugReproduced) {
  // Worth saying out loud: if scenario 2 stops failing, this script has
  // stopped testing anything, and scenario 3 passing means nothing.
  console.log("NOTE: scenario 2 did not reproduce the bug. Either Claude Code no longer");
  console.log("      emits an early result for an orphaned task, or this script has gone");
  console.log("      stale. Scenario 3 proves nothing on its own until scenario 2 fails.");
}
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("All checks passed: the bug reproduces, and holding the input open prevents it.");
process.exit(0);
