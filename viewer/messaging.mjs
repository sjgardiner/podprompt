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

  // An ALIAS counts as taken, permanently.
  //
  // THE FAILURE THIS PREVENTS, which is the whole reason aliases exist: if a
  // freed handle could be reused, a stale reference would resolve
  // SUCCESSFULLY to a different session. Not an error the model can recover
  // from — a message silently delivered to the wrong agent. A handle that
  // merely stops resolving fails loudly and the system prompt already tells
  // a model to list again; a handle that resolves to the wrong peer teaches
  // it nothing and misroutes the work.
  //
  // So a name, once used by a session, belongs to that session for as long
  // as it exists. Aliases accumulate; a peer record is a few hundred bytes
  // and renames are rare, which is a trade worth making against silent
  // misdelivery.
  function handleTaken(handle, exceptId) {
    return Object.entries(store.peers)
      .some(([id, p]) => id !== exceptId
        && (p.handle === handle || p.aliases?.includes(handle)));
  }

  // Records written before handleSource existed have no field. They are
  // treated as "derived", which is true of every one of them: the only way
  // to get a chosen handle is setHandle(), whose sole caller is the
  // /peer-settings route, and that now stamps the field. Defaulting the
  // other way would freeze every existing handle at its first topic — the
  // exact problem this change exists to fix.
  function handleSourceOf(rec) {
    return rec.handleSource || "derived";
  }

  // Retire a handle into the alias list: still resolvable, never reusable.
  function retireHandle(rec, handle) {
    if (!handle) return;
    if (!Array.isArray(rec.aliases)) rec.aliases = [];
    if (!rec.aliases.includes(handle)) rec.aliases.push(handle);
  }

  function uniqueHandle(base, exceptId) {
    if (!handleTaken(base, exceptId)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!handleTaken(candidate, exceptId)) return candidate;
    }
    return `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // A DERIVED handle follows the title; a CHOSEN one never moves.
  //
  // This used to be "assigned once and stable thereafter", on the grounds
  // that a drifting handle breaks references a model is holding mid-task.
  // That reasoning was right and is now served by aliases instead: the old
  // handle keeps resolving, so nothing breaks, and it can never be reused by
  // another session, so nothing is misdelivered.
  //
  // What the old rule cost: a long-lived session's handle described whatever
  // it was doing when first addressed, forever. Observed live — a session
  // that had spent a day on the sub-agent redesign was still answering to
  // @ai-turn-complete-notification-fe, so three sub-agents addressed it by a
  // name that actively misdescribed it.
  // titleIsCustom distinguishes a title the USER set from a backend's
  // auto-summary, and only the former moves a handle.
  //
  // MEASURED, not assumed: claude-code's `summary` drifts. Sampled live, it
  // held things like "Ok, please author a new commit to store th…" — a
  // LATER user message, not the first. Re-deriving on that would rename a
  // session every few turns, minting @ok-please-author-a-new-commit and
  // spraying aliases, with the handle churning mid-task. Aliases would keep
  // it all resolving, so nothing would break; it would just be useless.
  //
  // A rename is an intentional act and the right trigger. An auto-summary
  // changing its mind is not.
  function ensure(sessionId, { title, backend, titleIsCustom = false, realm = LOCAL_REALM } = {}) {
    if (!sessionId) return null;
    const prev = store.peers[sessionId];
    if (prev) {
      let changed = false;
      if (backend && prev.backend !== backend) { prev.backend = backend; changed = true; }
      const titleChanged = !!(title && prev.title !== title);
      if (titleChanged) { prev.title = title; changed = true; }
      // Re-derive only when the title actually moved, the handle was ours to
      // choose, and the record is past its provisional phase (which the
      // branch below handles on its own terms).
      if (titleChanged && titleIsCustom && !prev.provisional && handleSourceOf(prev) === "derived") {
        const wanted = slugifyHandle(title);
        // Collisions REFUSE rather than suffix. Auto-suffixing on every
        // rename would mint @research-2 and leave it there forever even
        // after @research freed up — churn with no payoff. Keeping the
        // current handle is always a safe answer; it still resolves.
        if (wanted && wanted !== prev.handle && !handleTaken(wanted, sessionId)) {
          retireHandle(prev, prev.handle);
          prev.handle = wanted;
        }
      }
      // A session usually has no title until its first turn has produced
      // one, and a peer record minted before that gets the fallback slug —
      // "@session-4", which tells a recipient nothing about who wrote to
      // them. Such a handle is PROVISIONAL and is upgraded once, the first
      // time a real title appears. A handle derived from a real title, or
      // one the user chose, is never touched: those are the ones a model
      // may already be holding.
      if (prev.provisional && title) {
        retireHandle(prev, prev.handle);
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
      // "derived" = we guessed it from the title, so it may follow a rename.
      // "user" = you chose it, so it never moves.
      handleSource: "derived",
      // Handles this session used to answer to. Never reused by anyone else.
      aliases: [],
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
    // Then aliases — handles this session USED to answer to.
    //
    // A model holds handles in its context for the length of a task, and a
    // rename mid-task would otherwise strand every reference it is carrying.
    // Checked second so a current handle always wins: if some session has
    // legitimately been GIVEN this name, it is the one that answers.
    for (const p of Object.values(store.peers)) {
      if (p.realm === realm && p.aliases?.includes(name)) return p;
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
    // The outgoing name stays resolvable, exactly as for a derived rename:
    // whoever is holding it mid-task should not be stranded.
    if (slug !== rec.handle) retireHandle(rec, rec.handle);
    rec.handle = slug;
    // A handle the user chose is never provisional, even if the session
    // still has no title — and never moves again, whatever the title does.
    rec.provisional = false;
    rec.handleSource = "user";
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

  function enqueue({ to, from, fromHandle = null, text, kind = "peer" }) {
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

  function release(id, { by = "auto" } = {}) {
    const e = byId(id);
    if (!e) return { ok: false, reason: "no-such-entry" };
    if (e.state !== "parked") return { ok: false, reason: "not-parked" };
    e.state = "queued";
    // parkedReason is NOT cleared any more.
    //
    // It used to be, and that erased the only record that a message had ever
    // been held. A message held for two minutes and manually delivered then
    // looked byte-identical to one that sailed straight through, so
    // "why was that held?" was unanswerable from state — only from a log
    // that scrolls away. Caught the hard way: I read parkedReason:null off a
    // live record and concluded six messages were never parked, while the
    // driver log showed them parked and released a second apart.
    //
    // Nothing reads parkedReason without also checking state (stuck() filters
    // on state === "parked"), so keeping it is inert apart from being true.
    e.releasedBy = by;
    save();
    return { ok: true, entry: e };
  }

  // Per-MESSAGE approval, durable because it lives on the stored entry.
  //
  // WHY PER MESSAGE. The drain used to deliver everything queued for a
  // session, so a user who approved two messages also silently approved any
  // that arrived before the turn ended. That defeats the whole point of
  // holding mail for a watched session: you would be authorising mail you
  // had never seen.
  //
  // Durable because the approval has to OUTLIVE the turn that was running
  // when you clicked. Approving during a busy turn previously did nothing at
  // all — the click was discarded with the rest of the call.
  function approve(ids) {
    const want = new Set(Array.isArray(ids) ? ids : [ids]);
    const out = [];
    for (const e of store.entries) {
      if (!want.has(e.id)) continue;
      if (e.state !== "queued" && e.state !== "parked") continue;
      e.approved = true;
      if (e.state === "parked") { e.state = "queued"; e.releasedBy = "user"; }
      out.push(e);
    }
    if (out.length) save();
    return out;
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
    enqueue, byId, pendingFor, markDelivered,
    park, release, approve, discard, stuck, open, sessionsWithPending, prune, forgetSessions,
    all: () => store.entries.slice(),
    _store: () => store,
  };
}
