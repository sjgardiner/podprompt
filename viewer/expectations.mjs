// Who is waiting on whom, and since when — durable.
//
// WHY THIS EXISTS
// ---------------
// An async delegate() used to arm a one-shot in-memory promise and trust it
// to deliver the child's report. That promise had two failure modes, both
// measured, both silent:
//
//   1. It fired on the child's FIRST turn end, whatever ended it. A child
//      that hit a rate limit was reported to its parent as "ended with no
//      output (error)" while the auto-resume sweep was, correctly, about to
//      retry it. The retry then succeeded and the real answer had nowhere to
//      go, because resolveTurnWaiters() deletes the whole waiter list on its
//      first fire. The parent was not stalled -- it had been told the
//      opposite of the truth, and an ordinary 429 was enough to cause it.
//
//   2. It lived only in memory. A driver restart dropped every pending
//      watcher. The child was auto-resumed, finished, and nobody was told.
//
// A record on disk fixes the second by construction: a restart reloads it and
// can reconcile. And because the record outlives any single turn, the FIRST
// is fixable too -- the decision to report moves from "a turn ended" to "this
// child is finished", which is a different and checkable question.
//
// KEYED BY CHILD, not by parent: a parent may be waiting on several children
// at once, and each finishes on its own schedule. One row per delegation.
//
// DELIBERATELY NOT a general "I am waiting for X" API agents can call. Every
// row here is created by delegate() and destroyed by the driver, so the set
// is bounded by real delegations and cannot be inflated by a model that
// forgets to clean up after itself.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function createExpectations({ file = null, now = Date.now, onError = null } = {}) {
  const store = load();

  function load() {
    const fresh = { expectations: {} };
    if (!file) return fresh;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object" || typeof raw.expectations !== "object") return fresh;
      // Drop anything malformed rather than carrying it forward: a row with
      // no parent can never be delivered to anyone, and a row with no `since`
      // can never go stale, so both would be immortal garbage in a set whose
      // whole purpose is to be swept.
      const kept = {};
      for (const [childId, rec] of Object.entries(raw.expectations || {})) {
        if (!rec || typeof rec !== "object") continue;
        if (typeof rec.parentId !== "string" || !rec.parentId) continue;
        if (!Number.isFinite(rec.since)) continue;
        kept[childId] = {
          parentId: rec.parentId,
          since: rec.since,
          notified: rec.notified === true,
        };
      }
      return { expectations: kept };
    } catch {
      return fresh;
    }
  }

  // Same write discipline as the other state modules: temp file plus rename,
  // so a crash mid-write cannot leave a half-parsed file that load() would
  // then silently treat as "no expectations" -- which is exactly the failure
  // this module exists to prevent.
  function save() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2));
      renameSync(tmp, file);
    } catch (e) {
      onError?.(e);
    }
  }

  function record(childId, parentId) {
    if (!childId || !parentId) return { ok: false, reason: "bad-args" };
    // Re-recording is not an error: a delegate retried by a supervisor should
    // refresh the clock rather than inherit a stale one and go instantly
    // "stale" on the next sweep.
    store.expectations[childId] = { parentId, since: now(), notified: false };
    save();
    return { ok: true, expectation: { ...store.expectations[childId] } };
  }

  function get(childId) {
    const rec = store.expectations[childId];
    return rec ? { childId, ...rec } : null;
  }

  function clear(childId) {
    if (!store.expectations[childId]) return { ok: false, reason: "unknown" };
    delete store.expectations[childId];
    save();
    return { ok: true };
  }

  // Marked rather than cleared: the parent still has not had its answer, so
  // the row must survive to be delivered if the child ever does finish. What
  // changes is only that we will not nudge about it twice (one delegation
  // buys one send, one report, and at most one nudge).
  function markNotified(childId) {
    const rec = store.expectations[childId];
    if (!rec) return { ok: false, reason: "unknown" };
    rec.notified = true;
    save();
    return { ok: true };
  }

  function all() {
    return Object.entries(store.expectations)
      .map(([childId, rec]) => ({ childId, ...rec }));
  }

  // Everything a given parent is still waiting on. Used when a parent is
  // deleted, so its rows do not outlive it and get swept forever against a
  // session that cannot receive anything.
  function forgetFor(parentId) {
    const gone = [];
    for (const [childId, rec] of Object.entries(store.expectations)) {
      if (rec.parentId !== parentId) continue;
      delete store.expectations[childId];
      gone.push(childId);
    }
    if (gone.length) save();
    return gone;
  }

  return { record, get, clear, markNotified, all, forgetFor, _store: store };
}
