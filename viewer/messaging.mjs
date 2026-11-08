// Peer registry and inbox — the durable half of the delivery core.
//
// Split out of driver.mjs for the same reason chains.mjs was: this is state
// that must survive a restart and must behave correctly when it does, and
// that is far easier to prove with tests that do not need a running server.
//
// Two stores, deliberately separate:
//
//   peers  — who can be addressed, and by what name. Handles are a LOOKUP
//            KEY; provenance always stores {realm, id}. That split is what
//            makes renaming free and what keeps a future non-local realm
//            from being a breaking change to every stored record.
//
//   inbox  — what is waiting. Most of the time this is empty: an idle target
//            receives immediately and the message becomes an ordinary turn.
//            The inbox only becomes visible when something is STUCK.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

// Only "local" exists today. The point of naming it at all is that
// "unknown handle in a known realm" and "unknown realm" are different
// failures, and telling them apart later is free only if we do it now.
export const LOCAL_REALM = "local";
const KNOWN_REALMS = new Set([LOCAL_REALM]);

export function slugifyHandle(title, fallback = "session") {
  const base = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return base || fallback;
}

// "@researcher" | "researcher" | "@host/researcher" | a raw session id.
export function parseAddress(addr) {
  const raw = String(addr || "").trim();
  if (!raw) return { ok: false, reason: "bad-address" };
  const bare = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!bare) return { ok: false, reason: "bad-address" };
  const slash = bare.indexOf("/");
  if (slash === -1) return { ok: true, realm: LOCAL_REALM, name: bare, qualified: false };
  const realm = bare.slice(0, slash);
  const name = bare.slice(slash + 1);
  if (!realm || !name) return { ok: false, reason: "bad-address" };
  return { ok: true, realm, name, qualified: true };
}

export function createPeers({ file, onError = () => {}, now = () => Date.now() }) {
  let store = load();

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("shape");
      return { peers: raw.peers && typeof raw.peers === "object" ? raw.peers : {} };
    } catch {
      return { peers: {} };
    }
  }

  function save() {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(store));
      renameSync(`${file}.tmp`, file);
    } catch (e) { onError(e); }
  }

  function handleTaken(handle, exceptId) {
    return Object.entries(store.peers)
      .some(([id, p]) => id !== exceptId && p.handle === handle);
  }

  function uniqueHandle(base, exceptId) {
    if (!handleTaken(base, exceptId)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!handleTaken(candidate, exceptId)) return candidate;
    }
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // Assigned once, at first registration, and stable thereafter — a handle
  // that drifted as a session's title changed would break every reference a
  // model is holding mid-task.
  function ensure(sessionId, { title, backend, realm = LOCAL_REALM } = {}) {
    if (!sessionId) return null;
    const prev = store.peers[sessionId];
    if (prev) {
      let changed = false;
      if (backend && prev.backend !== backend) { prev.backend = backend; changed = true; }
      if (title && prev.title !== title) { prev.title = title; changed = true; }
      // A session usually has no title until its first turn has produced
      // one, and a peer record minted before that gets the fallback slug —
      // "@session-4", which tells a recipient nothing about who wrote to
      // them. Such a handle is PROVISIONAL and is upgraded once, the first
      // time a real title appears. A handle derived from a real title, or
      // one the user chose, is never touched: those are the ones a model
      // may already be holding.
      if (prev.provisional && title) {
        prev.handle = uniqueHandle(slugifyHandle(title), sessionId);
        prev.provisional = false;
        changed = true;
      }
      if (changed) save();
      return prev;
    }
    const rec = {
      id: sessionId,
      realm,
      handle: uniqueHandle(slugifyHandle(title), sessionId),
      title: title || null,
      backend: backend || null,
      messageable: true,
      provisional: !title,
      createdAt: now(),
    };
    store.peers[sessionId] = rec;
    save();
    return rec;
  }

  function get(sessionId) {
    return store.peers[sessionId] || null;
  }

  function byHandle(realm, name) {
    for (const p of Object.values(store.peers)) {
      if (p.realm === realm && p.handle === name) return p;
    }
    return null;
  }

  // Resolution happens at DELIVERY time, not send time — the same rule as
  // authorization, and for the same reason: the world may have changed
  // between a model deciding to send and the send actually happening.
  function resolve(addr) {
    const parsed = parseAddress(addr);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    if (!KNOWN_REALMS.has(parsed.realm)) return { ok: false, reason: "unknown-realm", realm: parsed.realm };
    // A raw session id is accepted so internal callers (delegation handing
    // back a child id) never have to round-trip through a handle.
    if (!parsed.qualified && store.peers[parsed.name]) {
      return { ok: true, ref: { realm: store.peers[parsed.name].realm, id: parsed.name } };
    }
    const hit = byHandle(parsed.realm, parsed.name);
    if (!hit) return { ok: false, reason: "unknown-handle", realm: parsed.realm, name: parsed.name };
    return { ok: true, ref: { realm: hit.realm, id: hit.id } };
  }

  function setHandle(sessionId, handle) {
    const rec = store.peers[sessionId];
    if (!rec) return { ok: false, reason: "unknown-session" };
    const slug = slugifyHandle(handle);
    if (!slug) return { ok: false, reason: "bad-handle" };
    if (handleTaken(slug, sessionId)) return { ok: false, reason: "handle-taken" };
    rec.handle = slug;
    // A handle the user chose is never provisional, even if the session
    // still has no title.
    rec.provisional = false;
    save();
    return { ok: true, peer: rec };
  }

  // A cheap fence without the per-pair grant model we rejected: it needs no
  // new graph state and answers the only question that model would have.
  function setMessageable(sessionId, messageable) {
    const rec = store.peers[sessionId];
    if (!rec) return { ok: false, reason: "unknown-session" };
    rec.messageable = !!messageable;
    save();
    return { ok: true, peer: rec };
  }

  function list() {
    return Object.values(store.peers).sort((a, b) => a.handle.localeCompare(b.handle));
  }

  function forget(ids) {
    let changed = false;
    for (const id of ids || []) {
      if (store.peers[id]) { delete store.peers[id]; changed = true; }
    }
    if (changed) save();
  }

  return { ensure, get, resolve, setHandle, setMessageable, list, forget, _store: () => store };
}

// ── Inbox ────────────────────────────────────────────────────────────────

export const INBOX_STATES = ["queued", "delivered", "parked", "discarded"];

export function createInbox({ file, onError = () => {}, now = () => Date.now() }) {
  let store = load();

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") throw new Error("shape");
      return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  function save() {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(store));
      renameSync(`${file}.tmp`, file);
    } catch (e) { onError(e); }
  }

  function enqueue({ to, from, fromHandle = null, text, kind = "peer", chainId = null }) {
    const entry = {
      id: `msg_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      to,                 // {realm, id}
      from,               // {realm, id}  — stamped by the core, never by a model
      // The display name AS OF RECEIPT, so a later rename or disappearance
      // cannot orphan the record.
      fromHandle,
      text: String(text ?? ""),
      // Peer messages and returning delegation results render identically
      // today, but they are STORED distinctly: rendering alike is a one-line
      // choice, storing nothing is permanent.
      kind,
      chainId,
      createdAt: now(),
      state: "queued",
      parkedReason: null,
    };
    store.entries.push(entry);
    save();
    return entry;
  }

  function byId(id) {
    return store.entries.find((e) => e.id === id) || null;
  }

  function pendingFor(sessionId) {
    return store.entries.filter((e) => e.state === "queued" && e.to?.id === sessionId);
  }

  // A turn belongs to exactly one chain, so a drain must not mix them —
  // otherwise one chain's budget silently pays for another's work. Oldest
  // chain first; the rest drain on the next idle moment.
  function nextDrainGroup(sessionId) {
    const pending = pendingFor(sessionId);
    if (!pending.length) return [];
    const chainId = pending[0].chainId;
    return pending.filter((e) => e.chainId === chainId);
  }

  function markDelivered(ids) {
    let changed = false;
    for (const e of store.entries) {
      if (ids.includes(e.id) && e.state === "queued") { e.state = "delivered"; changed = true; }
    }
    if (changed) save();
  }

  function park(id, reason) {
    const e = byId(id);
    if (!e) return { ok: false, reason: "no-such-entry" };
    e.state = "parked";
    e.parkedReason = reason || null;
    save();
    return { ok: true, entry: e };
  }

  function release(id) {
    const e = byId(id);
    if (!e) return { ok: false, reason: "no-such-entry" };
    if (e.state !== "parked") return { ok: false, reason: "not-parked" };
    e.state = "queued";
    e.parkedReason = null;
    save();
    return { ok: true, entry: e };
  }

  function discard(id) {
    const e = byId(id);
    if (!e) return { ok: false, reason: "no-such-entry" };
    e.state = "discarded";
    save();
    return { ok: true, entry: e };
  }

  // The badge counts ONLY these. Transient queueing behind a busy target
  // resolves in seconds; a badge that counted it would flicker all day,
  // train the user to ignore it, and then fail on the night it matters.
  function stuck() {
    return store.entries.filter((e) => e.state === "parked");
  }

  function open() {
    return store.entries.filter((e) => e.state === "queued" || e.state === "parked");
  }

  function sessionsWithPending() {
    return [...new Set(store.entries.filter((e) => e.state === "queued").map((e) => e.to?.id))]
      .filter(Boolean);
  }

  // Delivered/discarded entries are history; the transcript is the real
  // record, so this store only needs to hold what is still actionable.
  function prune(maxKeep = 2000) {
    const before = store.entries.length;
    const openOnes = store.entries.filter((e) => e.state === "queued" || e.state === "parked");
    const closed = store.entries.filter((e) => e.state === "delivered" || e.state === "discarded");
    const keepClosed = closed.slice(-Math.max(0, maxKeep - openOnes.length));
    store.entries = [...openOnes, ...keepClosed].sort((a, b) => a.createdAt - b.createdAt);
    if (store.entries.length !== before) save();
  }

  function forgetSessions(ids) {
    const set = new Set(ids || []);
    const before = store.entries.length;
    store.entries = store.entries.filter((e) => !set.has(e.to?.id) && !set.has(e.from?.id));
    if (store.entries.length !== before) save();
  }

  return {
    enqueue, byId, pendingFor, nextDrainGroup, markDelivered,
    park, release, discard, stuck, open, sessionsWithPending, prune, forgetSessions,
    all: () => store.entries.slice(),
    _store: () => store,
  };
}
