// The autonomy gate — §10 (AD1–AD5). Replaces chains.mjs.
//
// ONE integer bounds every automatic turn in the system:
//
//     autonomousTurnsSinceYou
//
//   increments  when an AUTOMATIC turn starts — a delegation, a peer
//               delivery, an inbox release. Native sub-agents do not count:
//               they run inside their parent's turn, not as turns (HD1).
//   resets      on any human input event.
//   at N (=20)  automatic turns stop starting; pending work parks.
//
// That single rule covers all three states the system is ever in:
//
//   working at the keyboard  → the counter keeps resetting, so autonomy runs
//                              freely. An attended user needs only a kill
//                              switch, and that is what this degenerates to.
//   walked away              → the counter climbs and everything parks. The
//                              dead-man's switch.
//   present but not looking  → the counter climbs and everything parks. This
//                              is the case a pure idle-timer design misses,
//                              and the reason the unit here is TURNS rather
//                              than minutes.
//
// WHY THIS REPLACED PER-CHAIN BUDGETS. Not simplification for its own sake —
// the old unit was weaker at the job. The only caps were per-turn fan-out,
// creation depth, and per-chain steps; there was no global cap at all, so ten
// concurrent chains at the "Normal" preset was 300 unsupervised turns and
// nothing bounded the number of chains. Per-chain budgets DO NOT COMPOSE. A
// single global counter does, by construction. (The empirical nudge: the live
// store held 17 chains and not one had ever spent a step — every chain was a
// bare user prompt, because startTurn minted one for every human turn.)
//
// Lives in its own module for the same reason chains.mjs did: so it can be
// unit-tested without starting a server, spawning `opencode serve` or touching
// the real state directory. This is the code where a quiet logic error either
// costs real money or wrongly freezes the user's work.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

// Breadth, not depth. The counter alone does not bound the expensive failure:
// a cap of 20 with a fan-out of 50 is still 1000 sessions on turn one.
export const FANOUT_CAP_PER_TURN = 8;

// Counted along CREATION lineage, not the parent edge. Detaching (HD6) clears
// the parent edge, so a parent-based count would reset to zero on every
// detach and this guard would never fire.
export const MAX_CREATION_DEPTH = 6;

// Low enough to catch a loop early, high enough that a healthy three-way
// delegation finishes without ever being noticed.
export const DEFAULT_PAUSE_AFTER = 20;

// Human actions arrive as a debounced stream of input events, and resetting a
// counter that is already zero is not worth an fsync each time. Writes are
// skipped unless something actually changed or this much time has passed.
const HUMAN_WRITE_COALESCE_MS = 30 * 1000;

export function createAutonomy({ file = null, now = Date.now, onError = null } = {}) {
  const store = load();

  function load() {
    const fresh = {
      count: 0,
      pauseAfter: DEFAULT_PAUSE_AFTER,
      // null = normal. Otherwise { until: epochMs|null, setAt }. `until: null`
      // is an indefinite lift — "until I turn it back on".
      override: null,
      lastHumanAt: null,
      // Diagnostics, not policy. What lets the morning strip say "4,312
      // autonomous turns ran across 7 sessions" — information the per-chain
      // design had no way to surface.
      automaticTurnsTotal: 0,
    };
    if (!file) return fresh;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") return fresh;
      return {
        count: Number.isFinite(raw.count) && raw.count >= 0 ? Math.floor(raw.count) : 0,
        pauseAfter: validPauseAfter(raw.pauseAfter) ? Math.floor(raw.pauseAfter) : DEFAULT_PAUSE_AFTER,
        override: validOverride(raw.override) ? raw.override : null,
        lastHumanAt: Number.isFinite(raw.lastHumanAt) ? raw.lastHumanAt : null,
        automaticTurnsTotal: Number.isFinite(raw.automaticTurnsTotal) ? raw.automaticTurnsTotal : 0,
      };
    } catch {
      // Missing or corrupt. Start from the SAFE state — capped, counter zero
      // — rather than inheriting an unreadable override that might have been
      // an indefinite lift.
      return fresh;
    }
  }

  function validPauseAfter(n) {
    return Number.isFinite(n) && n >= 1;
  }

  function validOverride(o) {
    if (o === null || o === undefined) return false;
    if (typeof o !== "object") return false;
    return o.until === null || (Number.isFinite(o.until) && o.until > 0);
  }

  function save() {
    if (!file) return;
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(store));
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  // Clears a lapsed override. Deliberately does NOT touch the counter: that
  // is what makes "until 8 AM" work. The counter has been climbing all night
  // while the override suppressed the gate, so the moment the lift expires it
  // is already far past pauseAfter and everything parks immediately — with no
  // separate deadline-reached code path to get wrong.
  function expireOverride() {
    if (!store.override) return false;
    const until = store.override.until;
    if (until !== null && now() >= until) {
      store.override = null;
      save();
      return true;
    }
    return false;
  }

  function overrideLive() {
    expireOverride();
    return !!store.override;
  }

  // The single gate. Mirrors chains.spend()'s shape on purpose: one call
  // site, check and charge together, so "was it allowed" and "did it count"
  // can never drift apart.
  //
  // Note the counter advances even while uncapped. That is not an oversight;
  // it is the mechanism described above.
  function chargeAutomaticTurn() {
    const uncapped = overrideLive();
    if (!uncapped && store.count >= store.pauseAfter) {
      return {
        ok: false,
        reason: "autonomy-paused",
        count: store.count,
        pauseAfter: store.pauseAfter,
      };
    }
    store.count += 1;
    store.automaticTurnsTotal += 1;
    save();
    return {
      ok: true,
      uncapped,
      count: store.count,
      remaining: uncapped ? null : Math.max(0, store.pauseAfter - store.count),
    };
  }

  // Any human input event. Also what [Allow N more] does — AD3: allowing more
  // IS interacting, so there is no second code path for it.
  function noteHumanAction() {
    const last = store.lastHumanAt;
    const changed = store.count !== 0;
    store.count = 0;
    store.lastHumanAt = now();
    if (changed || last === null || store.lastHumanAt - last > HUMAN_WRITE_COALESCE_MS) save();
    return { ok: true };
  }

  // `until` is epoch ms, resolved BY THE BROWSER (AD5) — the container is
  // almost certainly on UTC, so this module must never interpret a wall-clock
  // time. null means indefinite.
  function liftCap({ until = null } = {}) {
    if (until !== null && !(Number.isFinite(until) && until > now())) {
      return { ok: false, reason: "until-must-be-future" };
    }
    store.override = { until: until === null ? null : Math.floor(until), setAt: now() };
    save();
    return { ok: true, override: { ...store.override } };
  }

  // The strip's [Cap it now]. A deliberate click is a human action, so the
  // counter resets — otherwise capping after an overnight run would park
  // everything the instant you asked for the cap back, which reads as the
  // button doing the opposite of what it says.
  function capNow() {
    store.override = null;
    store.count = 0;
    store.lastHumanAt = now();
    save();
    return { ok: true };
  }

  function setPauseAfter(n) {
    if (!validPauseAfter(n)) return { ok: false, reason: "invalid-pause-after" };
    store.pauseAfter = Math.floor(n);
    save();
    return { ok: true, pauseAfter: store.pauseAfter };
  }

  // Everything the strip needs, in one read. `state` is DERIVED, never
  // stored — the same discipline chains.mjs used for exhaustion, and for the
  // same reason: a stored status is a second source of truth that can age.
  function status() {
    const uncapped = overrideLive();
    const paused = !uncapped && store.count >= store.pauseAfter;
    return {
      state: uncapped ? "uncapped" : (paused ? "paused" : "open"),
      paused,
      uncapped,
      uncappedUntil: store.override ? store.override.until : null,
      count: store.count,
      pauseAfter: store.pauseAfter,
      remaining: uncapped ? null : Math.max(0, store.pauseAfter - store.count),
      lastHumanAt: store.lastHumanAt,
      automaticTurnsTotal: store.automaticTurnsTotal,
    };
  }

  return {
    chargeAutomaticTurn, noteHumanAction, liftCap, capNow, setPauseAfter, status,
    // Test seam only.
    _store: store,
  };
}
