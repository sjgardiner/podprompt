// Unit tests for the chain/budget/pause store.
//
// Run: node viewer/chains.test.mjs
//
// Deliberately written to try to BREAK the design rather than to confirm it.
// The bugs this project has actually shipped were all found by tests built
// to contradict an assumption, and missed by tests built to demonstrate one.
// So: clock manipulation, both-blank budgets, pause outranking, restart
// survival, and the budget-laundering path specifically.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createChains, DEFAULT_PRESET, BUDGET_PRESETS } from "./chains.mjs";

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, got, want) {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const dir = mkdtempSync(nodePath.join(tmpdir(), "chains-test-"));
let clock = 1_000_000_000_000;
const now = () => clock;
const file = (n) => nodePath.join(dir, `${n}.json`);

// ── minting ──────────────────────────────────────────────────────────────
{
  const c = createChains({ file: file("mint"), now });
  const chain = c.mint({ rootPrompt: "refactor the parser", originSession: "s1" });
  check("mint returns a chain", !!chain);
  eq("preset defaults", chain.preset, DEFAULT_PRESET);
  eq("steps start at zero", chain.steps.used, 0);
  eq("step limit from preset", chain.steps.limit, BUDGET_PRESETS[DEFAULT_PRESET].steps);
  eq("deadline is absolute", chain.deadline, clock + BUDGET_PRESETS[DEFAULT_PRESET].ms);
  eq("status is active", c.status(chain).state, "active");
  eq("origin realm recorded", chain.originSession.realm, "local");

  const long = "x".repeat(400);
  const trimmed = c.mint({ rootPrompt: long, originSession: "s1" });
  check("root prompt is truncated", trimmed.rootPrompt.length <= 160, `len ${trimmed.rootPrompt.length}`);
}

// ── custom budgets: one field may be unconstrained, never both ───────────
{
  const c = createChains({ file: file("custom"), now });
  check("both-blank custom is refused",
    c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: null, ms: null } }) === null);
  check("both-blank via zeros is refused",
    c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: 0, ms: 0 } }) === null);
  check("both-blank via junk is refused",
    c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: "lots", ms: NaN } }) === null);

  const stepsOnly = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: 3, ms: null } });
  check("steps-only custom is allowed", !!stepsOnly);
  eq("steps-only has no deadline", stepsOnly.deadline, null);

  const timeOnly = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: null, ms: 60_000 } });
  check("time-only custom is allowed", !!timeOnly);
  eq("time-only has no step limit", timeOnly.steps.limit, null);

  eq("setSessionPreset refuses both-blank",
    c.setSessionPreset("s", "custom", { steps: null, ms: null }).reason, "invalid-budget");
  eq("setSessionPreset refuses unknown preset",
    c.setSessionPreset("s", "enormous").reason, "unknown-preset");
}

// ── spending to exhaustion ───────────────────────────────────────────────
{
  const c = createChains({ file: file("spend"), now });
  const chain = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: 2, ms: null } });
  eq("first spend ok", c.spend(chain.id).ok, true);
  eq("remaining after one", c.spend(chain.id).remaining, 0);
  const third = c.spend(chain.id);
  eq("third spend refused", third.ok, false);
  eq("refusal names steps", third.reason, "steps");
  eq("status exhausted", c.status(chain).state, "exhausted");
  eq("spending an unknown chain is refused", c.spend("chn_nope").reason, "no-such-chain");

  // A time-only chain must never exhaust on steps, however many it spends.
  const t = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: null, ms: 60_000 } });
  for (let i = 0; i < 50; i++) c.spend(t.id);
  eq("unlimited steps never exhausts on steps", c.status(t).state, "active");
  eq("unlimited steps reports null remaining", c.spend(t.id).remaining, null);
}

// ── the deadline is enforced without anyone polling ──────────────────────
{
  const c = createChains({ file: file("deadline"), now });
  const chain = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: null, ms: 1000 } });
  eq("active before deadline", c.status(chain).state, "active");
  clock += 1001;
  // The point: nothing touched this record in between. Exhaustion is derived.
  eq("exhausted after deadline with no intervening call", c.status(chain).state, "exhausted");
  eq("spend refused on deadline", c.spend(chain.id).reason, "deadline");
  clock -= 1001;
}

// ── extend ───────────────────────────────────────────────────────────────
{
  const c = createChains({ file: file("extend"), now });
  const chain = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: 1, ms: null } });
  c.spend(chain.id);
  eq("exhausted", c.status(chain).state, "exhausted");
  c.extend(chain.id, { steps: 2 });
  eq("extend revives it", c.status(chain).state, "active");
  eq("extend raised the limit", c.get(chain.id).steps.limit, 3);

  // Extending a long-expired chain must buy time from NOW, not from a
  // deadline hours in the past — otherwise "+2h" on last night's chain
  // does nothing at all.
  const t = c.mint({ rootPrompt: "p", originSession: "s", preset: "custom", custom: { steps: null, ms: 1000 } });
  clock += 10 * 60 * 60 * 1000;
  eq("expired overnight", c.status(t).state, "exhausted");
  c.extend(t.id, { ms: 60_000 });
  eq("extend from now, not from the stale deadline", c.status(t).state, "active");
  clock -= 10 * 60 * 60 * 1000;

  eq("extending an unknown chain is refused", c.extend("chn_nope", { steps: 5 }).reason, "no-such-chain");
}

// ── pause, and its precedence ────────────────────────────────────────────
{
  const c = createChains({ file: file("pause"), now });
  const a = c.mint({ rootPrompt: "a", originSession: "s1" });
  const b = c.mint({ rootPrompt: "b", originSession: "s2" });

  c.setPaused(a.id, true);
  eq("per-chain pause blocks that chain", c.spend(a.id).reason, "chain");
  eq("per-chain pause leaves others alone", c.spend(b.id).ok, true);

  c.setGlobalPaused(true);
  eq("global pause blocks everything", c.spend(b.id).reason, "global");
  // Global outranks per-chain: the breaker you reach for before you know
  // which chain is at fault must not report a confusing per-chain reason.
  eq("global outranks per-chain", c.status(c.get(a.id)).reason, "global");

  c.setGlobalPaused(false);
  eq("resuming globally restores others", c.spend(b.id).ok, true);
  eq("resuming globally does NOT clear a per-chain pause", c.spend(a.id).reason, "chain");
  c.setPaused(a.id, false);
  eq("per-chain resume works", c.spend(a.id).ok, true);
}

// ── restart survival ─────────────────────────────────────────────────────
{
  const f = file("restart");
  const c1 = createChains({ file: f, now });
  const chain = c1.mint({ rootPrompt: "overnight run", originSession: "s1", preset: "long" });
  c1.spend(chain.id);
  c1.spend(chain.id);
  c1.setGlobalPaused(true);
  c1.setSessionPreset("s1", "long");

  // A restart must not silently undo a deliberate intervention.
  const c2 = createChains({ file: f, now });
  eq("pause survives restart", c2.isGloballyPaused(), true);
  eq("spend count survives restart", c2.get(chain.id).steps.used, 2);
  eq("session preset survives restart", c2.getSessionPreset("s1").preset, "long");
  eq("deadline survives restart", c2.get(chain.id).deadline, chain.deadline);
}

// ── corrupt / missing state must not throw ───────────────────────────────
{
  const f = file("corrupt");
  writeFileSync(f, "{not json at all");
  const c = createChains({ file: f, now });
  eq("corrupt file starts fresh", c.list().length, 0);
  eq("corrupt file is not paused", c.isGloballyPaused(), false);
  check("still usable after corruption", !!c.mint({ rootPrompt: "p", originSession: "s" }));

  writeFileSync(f, JSON.stringify({ chains: "nope", globalPaused: "yes" }));
  const c2 = createChains({ file: f, now });
  eq("wrong-typed chains is coerced", c2.list().length, 0);
  eq("truthy string paused is coerced to bool", c2.isGloballyPaused(), true);
}

// ── writes are atomic-ish: no torn JSON left behind ──────────────────────
{
  const f = file("atomic");
  const c = createChains({ file: f, now });
  const chain = c.mint({ rootPrompt: "p", originSession: "s" });
  c.spend(chain.id);
  const raw = readFileSync(f, "utf8");
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch {}
  check("on-disk state is valid JSON", parsed !== null);
  eq("on-disk state reflects the spend", parsed.chains[chain.id].steps.used, 1);
}

// ── pruning keeps paused chains ──────────────────────────────────────────
{
  const c = createChains({ file: file("prune"), now });
  const old = c.mint({ rootPrompt: "old", originSession: "s" });
  const held = c.mint({ rootPrompt: "held", originSession: "s" });
  c.setPaused(held.id, true);
  clock += 8 * 24 * 60 * 60 * 1000;
  c.prune();
  check("stale finished chain is pruned", c.get(old.id) === null);
  check("paused chain survives pruning", c.get(held.id) !== null);
  clock -= 8 * 24 * 60 * 60 * 1000;
}

// ── forgetting sessions drops their presets ──────────────────────────────
{
  const c = createChains({ file: file("forget"), now });
  c.setSessionPreset("gone", "short");
  eq("preset set", c.getSessionPreset("gone").preset, "short");
  c.forgetSessions(["gone"]);
  eq("preset dropped with the session", c.getSessionPreset("gone").preset, DEFAULT_PRESET);
}

rmSync(dir, { recursive: true, force: true });

console.log(`\nchains.mjs: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
