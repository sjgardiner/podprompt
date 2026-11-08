// Chains, budgets & pause.
//
// A "chain" is one piece of work the user started. It exists because every
// automatic thing that follows from a typed prompt — a delegated sub-agent,
// a peer message, a reply to that reply — has to be bounded by SOMETHING,
// and the only honest trust root is the human:
//
//   Only a prompt the user types creates a chain. Everything automatic
//   spends from the one it belongs to.
//
// The budget lives on the chain record rather than travelling with each
// delivery. That matters for three reasons:
//   * "extend" becomes one field update, instead of chasing deliveries that
//     are already in flight;
//   * a model never holds the number, so "callers cannot raise their own
//     budget" is structural rather than a rule we have to enforce;
//   * pause and extend both need to name a chain in the UI anyway.
//
// This lives in its own module rather than inside driver.mjs specifically so
// it can be unit-tested without starting a server, spawning `opencode serve`
// or touching the real state directory. It is the code where a quiet logic
// error costs real money, so it is the code that most needs tests that do
// not depend on a running system.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

// Two independent limits, whichever runs out first. Steps stop a tight loop
// quickly; the deadline bounds the long-running case in units a human
// actually thinks in — which is what makes a generous step count safe to
// pick.
export const BUDGET_PRESETS = {
  short:  { label: "Short",  steps: 8,   ms: 15 * 60 * 1000 },
  normal: { label: "Normal", steps: 30,  ms: 2 * 60 * 60 * 1000 },
  long:   { label: "Long",   steps: 500, ms: 12 * 60 * 60 * 1000 },
};
export const DEFAULT_PRESET = "normal";

// Breadth, not depth. A budget of 8 with a fan-out of 50 is 50^8, so the
// step counter alone does not bound the expensive failure.
export const FANOUT_CAP_PER_TURN = 8;

// Counted along CREATION lineage, not the parent edge (see PD9). Promotion
// deletes the parent edge, so a parent-based depth count resets to zero on
// every promotion and this guard would never fire.
export const MAX_CREATION_DEPTH = 6;

const CHAIN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CHAINS = 500;

export function budgetFromPreset(preset, custom) {
  if (preset === "custom") {
    const steps = Number.isFinite(custom?.steps) && custom.steps > 0 ? Math.floor(custom.steps) : null;
    const ms = Number.isFinite(custom?.ms) && custom.ms > 0 ? Math.floor(custom.ms) : null;
    // Refused deliberately. Unlimited-everything is precisely the state this
    // mechanism exists to prevent, so it must not be reachable through the
    // API any more than through the form.
    if (steps === null && ms === null) return null;
    return { steps, ms };
  }
  const p = BUDGET_PRESETS[preset] || BUDGET_PRESETS[DEFAULT_PRESET];
  return { steps: p.steps, ms: p.ms };
}

export function createChains({ file, now = () => Date.now(), onError = () => {} }) {
  let store = load();

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("shape");
      return {
        chains: raw.chains && typeof raw.chains === "object" ? raw.chains : {},
        // Pause MUST survive a restart. Otherwise a restart silently undoes
        // a deliberate intervention — the worst possible behaviour for a
        // control whose entire job is to stop things happening unattended.
        globalPaused: !!raw.globalPaused,
        globalPausedAt: raw.globalPausedAt || null,
        // Per-session default budget. Durable because it is a user-visible
        // setting, and one that silently reverted on restart would be its
        // own bug.
        sessionPresets: raw.sessionPresets && typeof raw.sessionPresets === "object"
          ? raw.sessionPresets : {},
      };
    } catch {
      return { chains: {}, globalPaused: false, globalPausedAt: null, sessionPresets: {} };
    }
  }

  function save() {
    try {
      // Temp file + atomic rename, as everywhere else in PodPrompt: a crash
      // mid-write must not leave torn JSON that throws on the next read.
      writeFileSync(`${file}.tmp`, JSON.stringify(store));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      onError(e);
    }
  }

  function get(chainId) {
    return (chainId && store.chains[chainId]) || null;
  }

  // Derived, never stored. A stored "exhausted" flag goes stale the moment a
  // deadline passes with nobody looking at the record, and a safety limit
  // that depends on being polled is not a safety limit.
  //
  // Order matters: a global pause outranks everything, because it is the
  // breaker you reach for before you know what is actually wrong.
  function status(chain) {
    if (!chain) return { state: "unknown", reason: "no-such-chain" };
    if (store.globalPaused) return { state: "paused", reason: "global" };
    if (chain.paused) return { state: "paused", reason: "chain" };
    if (chain.deadline !== null && now() > chain.deadline) {
      return { state: "exhausted", reason: "deadline" };
    }
    if (chain.steps.limit !== null && chain.steps.used >= chain.steps.limit) {
      return { state: "exhausted", reason: "steps" };
    }
    return { state: "active", reason: null };
  }

  function mint({ rootPrompt, originSession, preset = DEFAULT_PRESET, custom = null }) {
    const budget = budgetFromPreset(preset, custom);
    if (!budget) return null;
    prune();
    const t = now();
    const id = `chn_${t.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    store.chains[id] = {
      id,
      // What the user asked for. This is how a chain is named everywhere in
      // the UI — "chain" is a word the user should never have to see.
      rootPrompt: String(rootPrompt || "").slice(0, 160),
      startedAt: t,
      originSession: { realm: "local", id: originSession || null },
      preset,
      steps: { used: 0, limit: budget.steps },
      deadline: budget.ms === null ? null : t + budget.ms,
      costUsed: 0, // plumbed, unused — a cost-denominated budget is the v2
      paused: false,
    };
    save();
    return store.chains[id];
  }

  // The one place a step is spent. Returns a reason on refusal so the caller
  // can tell the sender WHY, in-transcript: a silently dropped message is
  // indistinguishable to a model from a peer that chose not to answer, and
  // it responds to that by retrying.
  function spend(chainId) {
    const chain = get(chainId);
    if (!chain) return { ok: false, reason: "no-such-chain" };
    const st = status(chain);
    if (st.state !== "active") return { ok: false, reason: st.reason, state: st.state };
    chain.steps.used += 1;
    save();
    return {
      ok: true,
      remaining: chain.steps.limit === null ? null : chain.steps.limit - chain.steps.used,
    };
  }

  function extend(chainId, { steps = 0, ms = 0 } = {}) {
    const chain = get(chainId);
    if (!chain) return { ok: false, reason: "no-such-chain" };
    if (steps > 0 && chain.steps.limit !== null) chain.steps.limit += Math.floor(steps);
    if (ms > 0 && chain.deadline !== null) {
      // Extend from now, not from a deadline that may be hours in the past —
      // otherwise "extend by 2h" on a chain that expired last night buys
      // nothing at all.
      chain.deadline = Math.max(chain.deadline, now()) + Math.floor(ms);
    }
    save();
    return { ok: true, chain };
  }

  function setPaused(chainId, paused) {
    const chain = get(chainId);
    if (!chain) return { ok: false, reason: "no-such-chain" };
    chain.paused = !!paused;
    save();
    return { ok: true, chain };
  }

  function setGlobalPaused(paused) {
    store.globalPaused = !!paused;
    store.globalPausedAt = paused ? new Date(now()).toISOString() : null;
    save();
    return { ok: true, globalPaused: store.globalPaused };
  }

  function isGloballyPaused() {
    return !!store.globalPaused;
  }

  function globalPausedAt() {
    return store.globalPausedAt;
  }

  // Chains accumulate forever otherwise: one per typed prompt, and most of
  // them finish in seconds.
  function prune() {
    const cutoff = now() - CHAIN_RETENTION_MS;
    let changed = false;
    for (const [id, chain] of Object.entries(store.chains)) {
      if (chain.paused) continue; // a paused chain is an open question; keep it
      if (chain.startedAt < cutoff && status(chain).state !== "active") {
        delete store.chains[id];
        changed = true;
      }
    }
    const ids = Object.keys(store.chains);
    if (ids.length > MAX_CHAINS) {
      ids.sort((a, b) => (store.chains[a].startedAt || 0) - (store.chains[b].startedAt || 0));
      for (const id of ids.slice(0, ids.length - MAX_CHAINS)) {
        if (store.chains[id]?.paused) continue;
        delete store.chains[id];
        changed = true;
      }
    }
    if (changed) save();
  }

  function summary(chain) {
    if (!chain) return null;
    const st = status(chain);
    return {
      id: chain.id,
      rootPrompt: chain.rootPrompt,
      startedAt: chain.startedAt,
      originSession: chain.originSession,
      preset: chain.preset,
      steps: { ...chain.steps },
      deadline: chain.deadline,
      paused: !!chain.paused,
      state: st.state,
      reason: st.reason,
    };
  }

  function list() {
    prune();
    return Object.values(store.chains)
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(summary);
  }

  function getSessionPreset(sessionId) {
    const saved = sessionId ? store.sessionPresets[sessionId] : null;
    if (!saved) return { preset: DEFAULT_PRESET, custom: null };
    return { preset: saved.preset || DEFAULT_PRESET, custom: saved.custom || null };
  }

  function setSessionPreset(sessionId, preset, custom) {
    if (!sessionId) return { ok: false, reason: "no-session" };
    if (preset !== "custom" && !BUDGET_PRESETS[preset]) return { ok: false, reason: "unknown-preset" };
    if (!budgetFromPreset(preset, custom)) return { ok: false, reason: "invalid-budget" };
    store.sessionPresets[sessionId] = { preset, custom: preset === "custom" ? custom : null };
    save();
    return { ok: true, ...getSessionPreset(sessionId) };
  }

  function forgetSessions(ids) {
    let changed = false;
    for (const id of ids || []) {
      if (store.sessionPresets[id]) { delete store.sessionPresets[id]; changed = true; }
    }
    if (changed) save();
  }

  return {
    mint, get, status, spend, extend, summary, list, prune,
    setPaused, setGlobalPaused, isGloballyPaused, globalPausedAt,
    getSessionPreset, setSessionPreset, forgetSessions,
    // test seam only
    _store: () => store,
  };
}
