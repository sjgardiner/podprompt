// OpenCode backend.
//
// Drives OpenCode over its HTTP API, against a server driver.mjs spawns and
// supervises. `opencode serve`, the TUI and the CLI are all the one binary.
//
// WHY THERE IS AN ID MAP HERE
// ---------------------------
// `POST /api/session` ACCEPTS a caller-supplied id, which looked like an
// invitation to drop the clientToReal/realToClient bookkeeping and derive one
// id from the other with a pure, reversible function. That was built, it
// round-tripped, and it was WRONG.
//
// A session created with a CLIENT-SUPPLIED id cannot use the free models. It
// fails every time with `provider.free-limit`, while a session the server
// minted itself succeeds -- same server, same model, same project, seconds
// apart, reproduced repeatedly:
//
//     server-minted  ses_e34e511b2ffexq1C7R2GQICzx2  -> succeeded
//     client-supplied ses_557cc71f92ac7d7a           -> provider.free-limit
//
// Isolated by pointing `opencode run --server` at this very server, where it
// worked: the server was never the problem. The gateway appears to attribute
// free usage via something carried in a server-minted id (they are
// time-ordered, and the server forwards the id to the provider in an
// `x-opencode-session` header); an arbitrary id it did not issue gets no
// entitlement.
//
// HONEST CAVEAT ON THAT EVIDENCE. The free quota is ALSO genuinely
// intermittent and account-wide -- the native CLI, which has nothing to do
// with any of this, fails the same way when it is spent. So the A/B pairs
// above are suggestive rather than conclusive: two back-to-back comparisons
// both favoured server-minted ids, and across roughly forty minutes of trying
// a client-supplied id NEVER once succeeded while server-minted ids and the
// CLI succeeded several times -- but a bursty quota could in principle produce
// that pattern by chance. Settling it properly needs an interleaved run of
// several alternating pairs while quota is available.
//
// The change is kept regardless, because it is what the API documents: the
// server owns its ids. Relying on an undocumented willingness to accept
// arbitrary ones was the riskier design even if it turns out not to have been
// the cause.
//
// A SUB-AGENT HERE IS A REAL SESSION
// ----------------------------------
// The task tool spawns one by creating a session parented to the caller's,
// with its own id, its own transcript and its own event stream. Claude Code's
// sub-agents have none of that -- they exist only as messages inside the
// parent's stream -- and the difference shapes everything in `onChildEvent`:
// the roster's live status is relayed, the child's CONTENT is not, because
// the server is already keeping it.
//
// What it is NOT is a session the user addresses. That is a question about
// its ROLE, answered by the relation row the driver keeps (childKind
// "native-task"), and it is why `listSessions` filters `parentID` out while
// the id map still remembers it. See HD1 in driver.mjs, and the note in
// listSessions on why conflating those two was a real bug.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function createOpenCodeBackend({
  cwdRoot, broadcast, broadcastStatus, broadcastUserPrompt,
  messaging, baseUrl, password, stateFile,
  requestApproval, autoApproveForSession, resolveApprovalExternally,
  // The roster. A sub-agent here is a REAL session the server parents to the
  // one that spawned it, so these two hooks are all the driver needs: the
  // relation row says what role it plays, and the live map says what it is
  // doing right now.
  registerChild, updateSubAgent,
  // The durable half of the clientId <-> realId pairing, kept on the relation
  // row by the driver. The map file below is the primary record; this is what
  // recovers a pairing the map has lost -- see seedRealIds.
  noteRealSessionId,
  // How long a finished turn waits for an outstanding approval reply to land
  // before releasing the session anyway. Settable only so the test can prove
  // the bound exists without sleeping for the real one.
  approvalDrainMs = 30000,
  // How long a turn may go without ANY event before it is treated as wedged.
  // Settable only so the test can prove the human-wait exemption without
  // sitting through the real ten minutes.
  silenceLimitMs = 10 * 60 * 1000,
} = {}) {
  const BASE = baseUrl || "http://127.0.0.1:7856";
  // OpenCode always uses HTTP Basic auth with the username "opencode"; only the
  // password is settable, and `OPENCODE_SERVER_USERNAME` does not exist in the
  // binary at all. If the password is not supplied the server generates a
  // fresh one per start and prints it, which nothing here could discover --
  // so the launcher injects one it already knows instead.
  const AUTH = "Basic " + Buffer.from(`opencode:${password || ""}`).toString("base64");

  // ── ids ──────────────────────────────────────────────────────────────────
  // clientId <-> realId, persisted. See the header for why this cannot be a
  // pure function.
  const clientToReal = new Map();
  const realToClient = new Map();

  function loadMap() {
    if (!stateFile) return;
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const [c, r] of Object.entries(raw?.sessions || {})) {
        if (typeof c === "string" && typeof r === "string") {
          clientToReal.set(c, r);
          realToClient.set(r, c);
        }
      }
    } catch { /* missing or corrupt: start empty rather than fail over it */ }
  }

  function saveMap() {
    if (!stateFile) return;
    try {
      const tmp = `${stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(clientToReal) }, null, 2));
      renameSync(tmp, stateFile);
    } catch (e) {
      console.error("[opencode] failed to write the session id map:", e.message);
    }
  }

  function remember(clientId, realId) {
    if (clientToReal.get(clientId) === realId) return;
    clientToReal.set(clientId, realId);
    realToClient.set(realId, clientId);
    saveMap();
    // Mirrored onto the relation row for any session that has one. The
    // driver has always had a place to keep this and a function to read it
    // back at startup -- it was simply never handed the pairing, so both
    // halves sat dead and the map file was the only copy. One corrupted or
    // hand-edited map and every delegated child came back detached from its
    // parent, which is the exact failure the relation index exists to stop.
    noteRealSessionId?.(clientId, realId);
  }

  const toReal = (clientId) => clientToReal.get(clientId) || null;
  const toClient = (realId) => realToClient.get(realId) || null;

  loadMap();

  async function api(path, { method = "GET", body, timeoutMs = 30000, raw = false, envelope = false } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        signal: ctl.signal,
        headers: {
          Authorization: AUTH,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (raw) return res;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`OpenCode ${method} ${path} -> ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      const payload = await res.json().catch(() => null);
      // Every response wraps its result in `data` -- and a LIST response puts
      // its paging cursor in a SIBLING of it. Unwrapping is what a caller
      // almost always wants, but it silently discards that cursor, which is
      // how a capped list came to look like the complete one. `envelope`
      // keeps the whole payload for the callers that have to page.
      if (envelope) return payload;
      return payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // IDENTIFYING A BLOCK OF STREAMED TEXT. There is no textID or reasoningID
  // on these events -- a block is identified by its MESSAGE plus its ORDINAL
  // within that message. Keying on a field that does not exist put every
  // block under `undefined`: two text blocks in one turn merged into one, and
  // the durable bubble fell back to a random id, so it appeared alongside the
  // streamed text instead of replacing it.
  //
  // The same id is used for the live stream and the durable bubble, which is
  // what makes the second supersede the first in the viewer.
  //
  // The KIND is part of the key because ordinals restart per block type: the
  // reasoning and the text of one message are both ordinal 0, so without it
  // the answer lands on the id of the thinking that preceded it and replaces
  // it in the transcript.
  const blockId = (kind, d) => `${kind}:${d.assistantMessageID || "msg"}:${d.ordinal ?? 0}`;

  // A model's context window, cached. Needed to turn OpenCode's raw token
  // counts into the percentage the viewer's context bar wants, and it never
  // changes for a given model -- so it is fetched once rather than on every
  // usage event, of which there are several per turn.
  const contextLimits = new Map();   // "provider/id" -> context window, 0 = unknown
  let limitsLoaded = false;

  async function contextLimitFor(modelId) {
    if (!modelId) return 0;
    if (contextLimits.has(modelId)) return contextLimits.get(modelId);
    if (!limitsLoaded) {
      try {
        for (const m of (await api("/api/model", { timeoutMs: 8000 })) || []) {
          contextLimits.set(`${m.providerID}/${m.id}`, m.limit?.context || 0);
        }
        limitsLoaded = true;
      } catch {
        // An unknown limit means no context bar, which is strictly better
        // than a bar drawn against a guessed denominator.
        return 0;
      }
    }
    return contextLimits.get(modelId) || 0;
  }

  // Slash commands, cached. GET /api/command is DIRECTORY-SCOPED: called
  // without one it answers for the server's default directory and returned
  // zero rows here, which looks identical to "this backend has no commands".
  // With the workspace supplied it returns the real set (init, review, goal).
  //
  // Kept in the contract's shape rather than the API's: the viewer reads
  // slash_commands and terminal_slash_commands, and `skills` is a Claude Code
  // concept with no OpenCode equivalent, so it stays an empty array rather
  // than being omitted.
  let knownCommands = { slash_commands: [], terminal_slash_commands: [], skills: [] };
  let commandFetch = null;

  // RETRIED UNTIL IT LANDS ONCE. The backend is constructed in the same tick
  // that `opencode serve` is spawned, and the server needs several seconds
  // before it accepts connections -- so the first fetch always loses that
  // race and fails. A one-shot filler therefore left the palette empty for
  // the entire life of the process. listModels never showed this because it
  // refetches on every request; this is a cache, and a cache with no second
  // chance is just a permanent failure.
  function refreshCommands() {
    if (commandFetch) return commandFetch;
    commandFetch = (async () => {
      try {
        const rows = await api(`/api/command?directory=${encodeURIComponent(cwdRoot || "/")}`,
          { timeoutMs: 8000 });
        const names = (rows || []).map((c) => c.name).filter(Boolean);
        if (names.length) knownCommands = { slash_commands: names, terminal_slash_commands: [], skills: [] };
      } catch { /* a later call tries again; an empty palette is not an error */ }
      commandFetch = null;
    })();
    return commandFetch;
  }
  refreshCommands();

  // GET /api/session IS PAGED, and says so only if you look. It returns one
  // page -- 50 rows by default -- plus a SIBLING of `data`:
  //
  //     { "data": [...], "cursor": { "previous": "<opaque>", "next": "<opaque>" } }
  //
  // There is no total and no error when rows are left behind, so a single
  // call looks exactly like a complete list and silently loses everything
  // past the first page. That is not hypothetical: it is why sessions
  // carried over from the 1.x line stayed invisible even with correct id-map
  // entries -- they were simply older than the 50 most recent.
  //
  // The cursor is opaque and SERVER-MINTED: `offset` is accepted and does
  // nothing (three pages requested at different offsets came back byte-
  // identical), and any cursor value we invent is rejected with
  // InvalidCursorError. So the only honest way to read the whole list is to
  // follow `cursor.next` until it stops -- which is also why a bigger
  // `limit` is the wrong fix: it raises the cliff without removing it.
  // Archived state is reported as a TIMESTAMP at time.archived, not as a
  // boolean at `archived`. Both are accepted so this keeps working if a
  // later version adds the flag the obvious way.
  const isArchived = (s) => !!(s?.archived || s?.time?.archived);

  // SESSIONS ARE NOT THE ONLY PAGED LIST. A session's messages are too, and
  // that one is worse: a 374-message transcript returned its most recent 50
  // and looked complete, so the viewer showed a session that appeared to
  // begin in the middle. Both go through this.
  const MAX_PAGES = 200;

  async function pageAll(path, what, timeoutMs = 15000) {
    const out = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
      const env = await api(url, { timeoutMs, envelope: true });
      const rows = Array.isArray(env?.data) ? env.data : [];
      let fresh = 0;
      for (const r of rows) {
        // Keyed by id where there is one; a row without one cannot be
        // de-duplicated, so it is kept rather than dropped.
        const key = r?.id;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(r);
        fresh++;
      }
      const next = env?.cursor?.next;
      // Stop on the server saying "no more", on an empty page, and ALSO on a
      // page that was entirely duplicates. That last one is the guard that
      // matters: a cursor that stops advancing would otherwise spin here
      // until the page cap, re-fetching the same rows every time.
      if (!next || !rows.length || fresh === 0) return out;
      cursor = next;
    }
    console.error(`[opencode] stopped paging ${what} after ${MAX_PAGES} pages;`
      + ` ${out.length} rows read and the server still offered more`);
    return out;
  }

  const listAllSessions = () => pageAll("/api/session", "the session list");

  // THE SERVER MINTS THE ID. Never `POST /api/session` with one of ours --
  // see the header: a client-supplied id loses free-model access entirely.
  async function ensureSession(sessionId, { title = null, cwd = null } = {}) {
    const known = toReal(sessionId);
    if (known) {
      try {
        await api(`/api/session/${known}`, { timeoutMs: 8000 });
        return known;
      } catch (e) {
        // Anything but "it is gone" is a live problem worth surfacing rather
        // than papering over by silently minting a second session.
        if (e.status !== 404) throw e;
        clientToReal.delete(sessionId);
        realToClient.delete(known);
      }
    }
    const created = await api("/api/session", {
      method: "POST",
      body: {
        ...(title ? { title } : {}),
        location: { directory: cwd || cwdRoot || process.cwd() },
      },
    });
    const realId = created?.id;
    if (!realId) throw new Error("OpenCode created a session with no id");
    remember(sessionId, realId);
    return realId;
  }

  // For the read-only calls: resolve without creating. A session PodPrompt has
  // never driven has no real id yet, and inventing one would both fail and
  // pollute the map.
  function requireRealId(sessionId) {
    const id = toReal(sessionId);
    if (!id) {
      const e = new Error(`OpenCode has no session for ${sessionId}`);
      e.status = 404;
      throw e;
    }
    return id;
  }

  // ── the event stream ─────────────────────────────────────────────────────
  // One long-lived SSE connection per TURN rather than one shared for the
  // process. A turn is the only thing that needs it, the server is local, and
  // a per-turn connection cannot leak events from one turn into another's
  // bubbles -- which is a failure the previous backend spent real effort on.
  // `children` is a LIVE set, owned by the turn and mutated by this
  // generator: a sub-agent's session id is not knowable until the server
  // announces it, so admission cannot be decided once up front.
  async function* sessionEvents(realId, signal, children = new Set()) {
    const res = await fetch(`${BASE}/api/event`, {
      headers: { Authorization: AUTH, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`OpenCode event stream -> ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a frame may carry several
      // `data:` lines which concatenate.
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        // Session id lives on `data.sessionID` for session events; anything
        // else is server-wide chatter we do not care about mid-turn.
        //
        // Form events are the exception and nest everything a level deeper,
        // under `data.form` -- so their session id has to be looked for
        // there too. Without this a form raised in ANOTHER session reads as
        // having no session id at all and is let through to this turn's
        // watch, which would put one session's question on another's screen.
        const sid = ev?.data?.sessionID ?? ev?.data?.form?.sessionID;
        if (sid && sid !== realId && !children.has(sid)) {
          // A SUB-AGENT IS A SESSION OF ITS OWN, and that is the whole
          // difficulty: everything it does arrives under ITS id, which this
          // filter would discard as "another session's business" -- so the
          // roster would stay empty no matter how much work ran inside the
          // turn. It announces itself exactly once, with a session.created
          // naming this session as its parent, and from that point its
          // events belong to this turn as surely as the parent's own do.
          //
          // The parent's `session.tool.progress` carries the same pairing in
          // `metadata.sessionID` and is handled below as a BACKSTOP -- that
          // one arrives under the PARENT's id, so it survives even if the
          // creation event were ever missed.
          if (ev.type === "session.created" && ev.data?.parentID === realId) children.add(sid);
          else continue;
        }
        yield ev;
      }
    }
  }

  // ── turns ────────────────────────────────────────────────────────────────
  async function runTurn(sessionId, promptText, state) {
    state.turnInFlight = true;
    // Per-turn, and resetting it here is load-bearing: `state` is the
    // driver's durable per-session bag, so a flag left set by the previous
    // turn would make every later fold refuse and silently demote mid-turn
    // delivery to "queued" for the rest of the session's life.
    state.steerClosed = false;
    broadcastStatus(sessionId, { type: "turn_start", backend: "opencode" });
    const realId = await ensureSession(sessionId, { cwd: state?.cwd, title: state?.title });
    if (state?.model) {
      const [providerID, ...rest] = String(state.model).split("/");
      const id = rest.join("/");
      if (providerID && id) {
        await api(`/api/session/${realId}/model`, { method: "POST", body: { model: { providerID, id } } })
          .catch((e) => console.error(`[opencode] set-model failed for ${sessionId}:`, e.message));
      }
    }

    const userMsgId = randomUUID();
    broadcastUserPrompt(sessionId, promptText, userMsgId, state.turnOrigin);

    const ctl = new AbortController();
    state.abortController = ctl;
    let outcome = { reason: "completed" };
    // Text and reasoning arrive as deltas keyed by an id; they are accumulated
    // and broadcast on their `ended` event rather than per delta, matching how
    // the viewer already renders these parts.
    const text = new Map();
    const reasoning = new Map();

    // ── what the SERVER still has for this session ─────────────────────────
    // The OpenCode analogue of Claude Code's "the turn is not over just
    // because a result arrived". Here the turn ends by aborting the event
    // stream, and the hazard is the mirror image: a message folded in as the
    // turn finishes is admitted to the server's DURABLE inbox, delivered at
    // the next step boundary, and run as a fresh execution -- after we have
    // stopped watching. Nothing is lost (the server keeps the transcript),
    // but it runs unobserved: no turn_start, no streaming, the session reads
    // idle in the UI, and a permission card raised inside it is shown to
    // nobody while the tool call blocks.
    //
    // Measured against a live 2.2.7 server: a `delivery:"steer"` POST to an
    // already-idle session is NOT refused -- it is accepted and executed.
    //
    // The server states the pending work itself, symmetrically, on the
    // stream we already read: session.inbox.enqueued { inboxID } and
    // session.inbox.delivered { inboxID }. Confirmed present for every entry
    // path -- the opening prompt, a folded steer, and a sub-agent's spawn
    // prompt -- so what is still in flight is simply the difference.
    const inboxOutstanding = new Set();
    let sawTerminal = false;

    // Ends the turn only when the server has nothing left queued for it.
    function endIfServerIsDone() {
      if (!sawTerminal || inboxOutstanding.size > 0) return false;
      // Set in the SAME TICK as the abort, which is the point: until now
      // injectIntoTurn gated on state.turnInFlight, and that flag is cleared
      // only at the very end of the finally below -- after an approval drain
      // bounded at 30 seconds. That left a window up to half a minute wide
      // in which a fold was accepted and POSTed to a session the server had
      // already finished with.
      state.steerClosed = true;
      ctl.abort();
      return true;
    }

    // ── sub-agents ─────────────────────────────────────────────────────────
    // The real ids of every sub-agent this turn spawns. Also the admission
    // list for the event stream above; see the comment there.
    const children = new Set();

    // A turn is ended by a terminal EVENT. If the server never sends one --
    // it died, the stream wedged, a new event type we do not know about
    // replaced the ones we do -- nothing else would ever end this turn, and
    // the session would be busy forever with no way back. So the watch is
    // also bounded by silence: not by total duration, which would kill
    // legitimate long work, but by how long since anything at all arrived.
    // Cards raised during this turn. A permission BLOCKS the tool call, so
    // the turn cannot reach idle until each one is answered -- but an abort
    // or a stall can still end the watch with one outstanding, and the reply
    // has to be allowed to land either way.
    const pendingApprovals = [];
    // A turn PARKED ON A HUMAN is not a stalled turn. A permission blocks the
    // tool call and the server then emits nothing at all, so the silence
    // watchdog below cannot tell "waiting for you" from "wedged" -- and
    // walking away from a card for ten minutes would have killed the work
    // that was waiting for the answer. Counted rather than inferred from the
    // promise array, which keeps its entries after they settle.
    let awaitingHuman = 0;

    // Everything a sub-agent does, in one place. Deliberately NOT the main
    // switch: a child's events look identical to the parent's, so sharing the
    // switch would put a sub-agent's reasoning into the parent's transcript
    // and its token count into the parent's context gauge.
    //
    // WHAT IS DELIBERATELY ABSENT: any broadcast of the child's own text. On
    // Claude Code a sub-agent has no durable transcript, so live broadcast is
    // the ONLY record and the backend must relay every block. Here the server
    // keeps the child's transcript, and the two records cannot be reconciled
    // -- a live block is identified by message+ordinal while the stored one
    // carries a part id, so relaying would put every block on screen twice,
    // once per id. The server is the record; the roster carries the live
    // status; and `flushChildTranscript` below tops the view up when the work
    // is done.
    function onChildEvent(childId, type, d) {
      switch (type) {
        case "session.created":
          registerChild?.(childId, {
            parent: sessionId,
            backend: "opencode",
            // The role, not the implementation. This IS a session -- it is
            // just not one the user addresses, so it belongs in the roster
            // and nowhere else. See HD1 in driver.mjs.
            childKind: "native-task",
            subagentType: d.agent || null,
            // The server titles a sub-agent session with the calling tool's
            // `description`, which is exactly the roster's label.
            description: d.title || null,
            native: { realSessionId: childId },
          });
          // The id map is "ids this backend can resolve", and a child needs
          // an entry or its transcript cannot be fetched at all. The server
          // minted this id, so the mapping is the identity.
          remember(childId, childId);
          updateSubAgent?.(childId, { status: "running", startedAt: Date.now() });
          break;
        case "session.tool.input.started":
          noteToolName(d);
          updateSubAgent?.(childId, { status: "running", lastTool: d.name || null });
          break;
        case "session.tool.called": {
          // Never write a NULL over the name input.started already recorded:
          // upsertSubAgent merges, so a null here would blank the roster's
          // "last tool" line the moment the call it names actually runs.
          const named = toolNames.get(d.id);
          updateSubAgent?.(childId, { status: "running", ...(named ? { lastTool: named } : {}) });
          break;
        }
        case "session.text.ended": {
          const body = (d.text || "").trim();
          if (body) updateSubAgent?.(childId, { summary: body.split("\n")[0].slice(0, 200) });
          break;
        }
        case "session.step.ended":
        case "session.usage.updated":
          if (d.tokens) updateSubAgent?.(childId, { usage: d.tokens });
          break;
        case "session.execution.failed":
          updateSubAgent?.(childId, {
            status: "failed",
            error: d.error?.message || d.error?.type || "execution failed",
          });
          flushChildTranscript(childId);
          break;
        case "session.execution.interrupted":
          updateSubAgent?.(childId, { status: "killed" });
          flushChildTranscript(childId);
          break;
        case "session.execution.succeeded":
          updateSubAgent?.(childId, { status: "completed" });
          flushChildTranscript(childId);
          break;
        // A card raised INSIDE a sub-agent is routed to the PARENT, which is
        // the session the user is looking at -- a child has no input bar to
        // answer one in. The reply still goes to the child's own server
        // session, which is where the blocked tool call lives.
        case "permission.asked": {
          if (state.autoApprove || autoApproveForSession?.(sessionId)) {
            pendingApprovals.push(replyPermission(childId, d.id, { allow: true }));
            break;
          }
          awaitingHuman++;
          updateSubAgent?.(childId, { awaiting: d.action || "permission" });
          pendingApprovals.push(
            requestApproval?.(sessionId, "permission", d.action || "unknown",
              { resources: d.resources || [] },
              { canAlwaysAllow: true, externalId: d.id })
              .then((decision) => (decision?.cancelled ? undefined : replyPermission(childId, d.id, decision)))
              .finally(() => { awaitingHuman--; updateSubAgent?.(childId, { awaiting: null }); }),
          );
          break;
        }
        case "form.created": {
          const form = d.form || d;
          if (form.metadata?.kind !== "question") break;
          awaitingHuman++;
          updateSubAgent?.(childId, { awaiting: "question" });
          pendingApprovals.push(
            requestApproval?.(sessionId, "question", "AskUserQuestion",
              { questions: questionsFromForm(form) }, { externalId: form.id })
              .then((answer) => (answer?.cancelled ? undefined : replyForm(childId, form, answer)))
              .finally(() => { awaitingHuman--; updateSubAgent?.(childId, { awaiting: null }); }),
          );
          break;
        }
        default: break;
      }
    }
    let lastEventAt = Date.now();
    const SILENCE_LIMIT_MS = silenceLimitMs;
    const idleWatch = setInterval(() => {
      if (awaitingHuman > 0) return;
      if (Date.now() - lastEventAt > SILENCE_LIMIT_MS && !ctl.signal.aborted) {
        outcome = { reason: "stalled", error: `no events for ${Math.round(SILENCE_LIMIT_MS / 60000)}m` };
        ctl.abort();
      }
    }, Math.min(30000, Math.max(50, silenceLimitMs / 4)));
    idleWatch.unref?.();

    try {
      const stream = sessionEvents(realId, ctl.signal, children);
      // The prompt is posted AFTER the stream is open, or the first events of
      // the turn race the subscription and are lost.
      const started = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        // The agent rides along with the prompt as well as being set on the
        // session. setMode is best-effort by contract -- the driver records
        // the choice even when the backend call fails -- so carrying it here
        // is what makes the recorded choice actually take effect on the turn.
        return api(`/api/session/${realId}/prompt`, {
          method: "POST",
          body: { text: promptText, ...(state?.mode ? { agent: state.mode } : {}) },
        });
      })();
      started.catch((e) => { outcome = { reason: "error", error: e.message }; ctl.abort(); });

      for await (const ev of stream) {
        // A sub-agent's events count as activity: they are this turn's own
        // work, and a long one would otherwise look like silence and trip
        // the watchdog below.
        lastEventAt = Date.now();
        const d = ev.data || {};
        const sid = d.sessionID ?? d.form?.sessionID;
        if (sid && sid !== realId) { onChildEvent(sid, ev.type, d); continue; }
        switch (ev.type) {
          // STREAMING. The deltas were being accumulated and thrown away,
          // with one broadcast at the END of each block -- so a long answer
          // sat invisible until it was finished and then appeared all at
          // once. The viewer has rendered live text all along; nothing was
          // feeding it. stream_delta carries the text SO FAR, not the
          // increment, which is what the viewer's handler expects.
          case "session.text.started":
            text.set(blockId("text", d), "");
            broadcastStatus(sessionId, {
              type: "stream_start", id: blockId("text", d), role: "assistant", model: state.model || null,
            });
            break;
          case "session.text.delta": {
            const key = blockId("text", d);
            const sofar = (text.get(key) || "") + (d.delta || "");
            text.set(key, sofar);
            broadcastStatus(sessionId, { type: "stream_delta", id: key, role: "assistant", text: sofar });
            break;
          }
          case "session.text.ended": {
            const key = blockId("text", d);
            const body = d.text ?? text.get(key) ?? "";
            // Still broadcast at the end: the live stream is a preview the
            // viewer discards on reload, and this is the durable bubble.
            // Sharing the id is what lets it REPLACE the streamed one rather
            // than appear twice.
            if (body.trim()) broadcast(sessionId, "assistant", body, key, null, state.model || null);
            text.delete(key);
            break;
          }
          case "session.reasoning.started":
            reasoning.set(blockId("reasoning", d), "");
            broadcastStatus(sessionId, {
              type: "stream_start", id: blockId("reasoning", d), role: "thinking", model: state.model || null,
            });
            break;
          case "session.reasoning.delta": {
            const key = blockId("reasoning", d);
            const sofar = (reasoning.get(key) || "") + (d.delta || "");
            reasoning.set(key, sofar);
            broadcastStatus(sessionId, { type: "stream_delta", id: key, role: "thinking", text: sofar });
            break;
          }
          case "session.reasoning.ended": {
            const key = blockId("reasoning", d);
            const body = d.text ?? reasoning.get(key) ?? "";
            if (body.trim()) broadcast(sessionId, "thinking", body, key, null, state.model || null);
            reasoning.delete(key);
            break;
          }
          // COST AND CONTEXT. The viewer has an indicator for each, and the
          // spend one exists specifically for this backend -- its tooltip
          // reads "OpenCode has no subscription/quota concept". Neither was
          // ever fed, so both stayed hidden for every OpenCode session.
          case "session.usage.updated":
          case "session.step.ended": {
            if (typeof d.cost === "number") {
              broadcastStatus(sessionId, { type: "spend", totalCostUsd: d.cost });
            }
            const t = d.tokens;
            if (t) {
              // PROMPT-SIDE tokens only. What occupies the context window is
              // what gets sent, including the part served from cache; output
              // and reasoning are generation, and only occupy the window on
              // the NEXT request, where they arrive counted in `input`.
              const used = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
              const max = await contextLimitFor(state.model);
              if (max > 0) {
                broadcastStatus(sessionId, {
                  type: "context_usage",
                  percentage: Math.min(100, (used / max) * 100),
                  totalTokens: used,
                  maxTokens: max,
                  model: state.model || null,
                });
              }
            }
            break;
          }
          // The name arrives here and nowhere else; see summarizeTool.
          case "session.tool.input.started":
            noteToolName(d);
            break;
          // `d.callID` DOES NOT EXIST -- the field is `d.id`, and it is the
          // same id the stored part carries. Minting a random one instead
          // meant a live tool bubble and its replayed self could never be
          // recognised as the same bubble.
          case "session.tool.called":
            broadcast(sessionId, "tool", summarizeTool(d), d.id || randomUUID(), null, state.model || null);
            break;
          case "session.tool.failed":
            broadcast(sessionId, "tool",
              `*(${summarizeTool(d).replace(/\*\*/g, "")} failed: ${d.error?.message || "unknown"})*`,
              d.id || randomUUID(), null, state.model || null);
            break;
          // THE TASK BUBBLE AND THE ROSTER ROW ARE THE SAME THING, and this
          // is the only event that says so: a task tool's progress carries
          // the spawned session's id in `metadata.sessionID` while arriving
          // under the PARENT's id, alongside the tool call's own `id` --
          // which is also the id of the bubble already on screen. Recording
          // the pair is what lets the browser hang live sub-agent status off
          // that bubble instead of rendering an inert "task" line.
          //
          // Also the backstop for admission: a sub-agent whose session.created
          // was missed (a stream reconnect, an event dropped) is still picked
          // up here, under an id this turn was never filtering out.
          case "session.tool.progress":
          case "session.tool.success": {
            const kid = d.metadata?.sessionID;
            if (!kid || kid === realId) break;
            if (!children.has(kid)) {
              children.add(kid);
              onChildEvent(kid, "session.created", { title: d.input?.description || null });
            }
            registerChild?.(kid, { parent: sessionId, native: { toolUseId: d.id || null } });
            if (d.metadata?.status === "completed") onChildEvent(kid, "session.execution.succeeded", {});
            break;
          }
          case "permission.asked": {
            // Auto-approve is checked here rather than by the card, and it
            // walks up the parent chain: a delegated session's own tool calls
            // must inherit the flag, or unattended delegation parks on its
            // first gated action and sits there until someone ticks a box.
            if (state.autoApprove || autoApproveForSession?.(sessionId)) {
              pendingApprovals.push(replyPermission(realId, d.id, { allow: true }));
              break;
            }
            // d.action is the ruleset key being asked about ("read",
            // "podprompt-message", ...) — the closest OpenCode equivalent of
            // Claude's toolName for the generic "Approve <toolName>?" card.
            // Always offerable: the reply takes a scope, so widening is
            // available for every ask without proposing specific rules.
            awaitingHuman++;
            pendingApprovals.push(
              requestApproval?.(sessionId, "permission", d.action || "unknown",
                { resources: d.resources || [] },
                { canAlwaysAllow: true, externalId: d.id })
                .then((decision) => (decision?.cancelled ? undefined : replyPermission(realId, d.id, decision)))
                .finally(() => { awaitingHuman--; }),
            );
            break;
          }
          // Answered or withdrawn somewhere else -- the user replying in the
          // OpenCode TUI, or the server giving up on it. Retract our card
          // rather than leaving one the model is no longer waiting on;
          // replying to a dead request is what produces a 404. Harmless for
          // our OWN replies, which emit this too: by then the card is gone
          // and the lookup finds nothing.
          case "permission.replied":
          case "permission.rejected":
          case "form.replied":
          case "form.cancelled": {
            const extId = d.id || d.form?.id || d.formID;
            if (extId) {
              resolveApprovalExternally?.(extId,
                "This request was already answered or withdrawn in OpenCode.");
            }
            break;
          }
          case "form.created": {
            // THE PAYLOAD IS NESTED. permission.asked puts its request
            // directly under `data`; a form event wraps it in `data.form`.
            // Reading it the same way as a permission finds undefined
            // everywhere, so the card silently never appears and the turn
            // blocks on a question nobody was shown.
            const form = d.form || d;
            // Only a question form is a question; OpenCode uses forms for other
            // things too, and answering one of those as if it were a
            // multiple-choice prompt would put nonsense into it.
            if (form.metadata?.kind !== "question") break;
            awaitingHuman++;
            pendingApprovals.push(
              requestApproval?.(sessionId, "question", "AskUserQuestion",
                { questions: questionsFromForm(form) }, { externalId: form.id })
                .then((answer) => (answer?.cancelled ? undefined : replyForm(realId, form, answer)))
                .finally(() => { awaitingHuman--; }),
            );
            break;
          }
          // EVERY terminal event must end the watch, not just the happy one.
          // Measured against the real server: a turn that fails emits
          // session.execution.failed and then NOTHING -- no session.idle
          // follows it. Setting the outcome without ending the watch left the
          // loop waiting on an event that never comes, so a single failed
          // turn hung the session permanently.
          case "session.execution.failed":
            outcome = { reason: "error", error: d.error?.message || d.error?.type || "execution failed" };
            ctl.abort();
            break;
          case "session.execution.interrupted":
            outcome = { reason: "aborted" };
            ctl.abort();
            break;
          // The server's own account of work it has accepted and not yet
          // run. A counter would do, but a set of ids cannot double-count a
          // repeated event or drift negative on one we never saw enqueued.
          case "session.inbox.enqueued":
            if (d.inboxID) inboxOutstanding.add(d.inboxID);
            break;
          case "session.inbox.delivered":
            if (d.inboxID) inboxOutstanding.delete(d.inboxID);
            // Delivery can be the moment the turn becomes endable -- the
            // item arrived after a terminal event and its execution has now
            // finished -- and no further idle need follow to say so.
            if (inboxOutstanding.size === 0 && sawTerminal) {
              // Not ended here: the execution this delivery starts is still
              // to come. sawTerminal is reset so the NEXT terminal event is
              // the one that ends the turn.
              sawTerminal = false;
            }
            break;
          case "session.idle":
          case "session.execution.succeeded":
            // succeeded can arrive before idle; either ends our watch.
            sawTerminal = true;
            if (!endIfServerIsDone()) {
              console.log(`[opencode] ${sessionId}: turn finished with ${inboxOutstanding.size}`
                + " message(s) the server has queued and not yet run; staying on the stream");
            }
            break;
          default: break;
        }
      }
    } catch (e) {
      // An abort we asked for is the normal exit from the loop above.
      if (e.name !== "AbortError" && !ctl.signal.aborted) {
        outcome = { reason: "error", error: e.message };
      }
    } finally {
      clearInterval(idleWatch);
      // Settle, never reject: these are reply round-trips that already log
      // their own failures, and one of them throwing must not turn a
      // finished turn into a failed one.
      //
      // BOUNDED, because reaching here with a card still open is already
      // anomalous: a permission blocks the tool call, so a turn that answered
      // its cards cannot be at this point with one outstanding. What can is a
      // turn that was aborted or stalled underneath an open card -- and that
      // card may never be answered by anyone. Waiting on it forever would
      // leave turnInFlight set and the session busy with no way back, which
      // is the same failure the silence watchdog above exists to prevent.
      if (pendingApprovals.length) {
        const settled = await Promise.race([
          Promise.allSettled(pendingApprovals).then(() => true),
          new Promise((r) => setTimeout(() => r(false), approvalDrainMs)),
        ]);
        if (!settled) {
          console.error(`[opencode] ${sessionId}: turn ended with an unanswered approval;`
            + " releasing the session rather than waiting on it");
        }
      }
      state.abortController = null;
      state.turnInFlight = false;
    }
    state.turnOutcome = outcome;
    return outcome;
  }

  // ── permissions and questions ───────────────────────────────────────────
  // OpenCode blocks the tool call and emits an event; if nobody answers, the
  // dies with an unexplained tool failure rather than hanging visibly. So a
  // dropped event here is worse than an error -- it looks like the model
  // failed at something, with no card and no reason.
  //
  // Both routes are SESSION-scoped (/api/session/{id}/permission/{req}/reply),
  // and the event carries location.directory with it, so neither a directory
  // cache nor a
  // directory-scoped reply is needed -- a reply that resolved against the
  // server's default directory would silently find nothing, and that whole
  // class of bug cannot occur with a session-scoped route.
  async function replyPermission(realId, requestID, decision) {
    // The reply vocabulary is the server's: "once" | "always" | "reject" --
    // so the viewer's existing decision shape maps over unchanged.
    const reply = decision?.allow ? (decision.always ? "always" : "once") : "reject";
    try {
      await api(`/api/session/${realId}/permission/${requestID}/reply`,
        { method: "POST", body: { decision: reply }, timeoutMs: 5000 });
    } catch (e) {
      console.error("[opencode] failed to reply to permission:", e.message);
    }
  }

  // A "question" here is a FORM: typed fields, each with its own options and a
  // `custom` flag for free text. The viewer's question card reads Claude's
  // QuestionInfo[] shape, so the fields are presented in that shape and the
  // answer is mapped back by field key.
  function questionsFromForm(form) {
    return (form.fields || []).map((f) => ({
      question: f.description || f.title || "",
      header: f.title || f.key,
      multiSelect: f.type === "array",
      options: (f.options || []).map((o) => ({
        label: o.label ?? o.value, description: o.description || "",
      })),
    }));
  }

  async function replyForm(realId, form, answer) {
    const fields = form.fields || [];
    // `structured` is a per-question {header, answer} array in the same order
    // as the fields (see driver.mjs's /permission-response). The server wants one
    // value per field key, so a multiSelect array is joined rather than sent
    // as an array -- the field's declared type is a string.
    const out = {};
    fields.forEach((f, i) => {
      let v = Array.isArray(answer?.structured) ? answer.structured[i]?.answer : undefined;
      if (v === undefined) v = String(answer?.text ?? "");
      out[f.key] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    });
    try {
      await api(`/api/session/${realId}/form/${form.id}/reply`,
        { method: "POST", body: { answer: out }, timeoutMs: 5000 });
    } catch (e) {
      console.error("[opencode] failed to reply to question:", e.message);
    }
  }

  // THE TOOL'S NAME IS NOT ON THE EVENT THAT ANNOUNCES THE CALL. Measured
  // against 2.2.7, one call's lifecycle is:
  //
  //   session.tool.input.started  { id, name }          <- the ONLY name
  //   session.tool.input.ended    { id, text }
  //   session.tool.called         { id, input }
  //   session.tool.progress       { id, metadata }
  //   session.tool.success        { id, content, metadata }
  //
  // So reading `d.tool`/`d.name` off the `called` event finds nothing, and
  // EVERY tool bubble in a live OpenCode turn read "**tool**". The shell ones
  // salvaged a command string out of `input` and so looked plausible, which
  // is how this survived. The name is carried forward from the first event
  // instead, keyed by the call id the whole sequence shares.
  //
  // Bounded, because a turn can make unboundedly many calls and nothing here
  // would otherwise ever forget one. Oldest out first; a bubble that outlives
  // its entry falls back to "tool", which is where it started.
  const toolNames = new Map();
  const MAX_REMEMBERED_TOOL_NAMES = 500;
  function noteToolName(d) {
    if (!d?.id || !d.name) return;
    toolNames.set(d.id, d.name);
    while (toolNames.size > MAX_REMEMBERED_TOOL_NAMES) {
      toolNames.delete(toolNames.keys().next().value);
    }
  }

  function summarizeTool(d) {
    const name = d.tool || d.name || toolNames.get(d.id) || "tool";
    // A STORED part nests its arguments under `state.input`; a LIVE event
    // puts them directly on `input`. Reading only the live shape made every
    // replayed tool bubble lose its argument.
    const raw = d.input ?? d.state?.input;
    const input = raw && typeof raw === "object" ? raw : {};
    const first = input.command || input.filePath || input.path || input.pattern
      || input.description || "";
    return first ? `**${name}** \`${String(first).slice(0, 120)}\`` : `**${name}**`;
  }

  // A FINISHED SUB-AGENT'S TRANSCRIPT, pushed into its own feed.
  //
  // The problem this solves is the one created by NOT relaying a child's
  // blocks live (see onChildEvent): server.py seeds a session's log from
  // getSessionHistory exactly once, latched, the first time a tab asks to
  // view it. Open a sub-agent while it is still working and that snapshot is
  // all you ever get -- and open it the instant it is created and the latch
  // closes over an EMPTY log, so the finished transcript would never appear
  // at all without a server.py restart.
  //
  // Replaying it at completion costs one request and cannot double anything:
  // these are the same entries, carrying the same part ids the seed used, and
  // the viewer upserts by id. A tab with the partial view fills in; a tab
  // that never opened it gets a log that the later seed then dedups away.
  const flushedChildren = new Set();
  async function flushChildTranscript(childRealId) {
    // ONCE PER CHILD. Two independent events say "this sub-agent finished" --
    // its own session.execution.succeeded and the parent's tool.success --
    // and both are wanted, because either can be the one that survives a
    // stream hiccup. Replaying twice would put the whole transcript in the
    // log twice over.
    if (flushedChildren.has(childRealId)) return;
    flushedChildren.add(childRealId);
    try {
      const entries = await transcriptOf(childRealId, `sub-agent ${childRealId}`);
      for (const e of entries) {
        broadcast(childRealId, e.role, e.text, e.id, e.ts || null, e.model || null);
      }
    } catch (e) {
      // Never fatal: the roster row and the parent's turn are both fine
      // without it, and the next view of the child still seeds normally.
      console.error(`[opencode] could not replay sub-agent transcript ${childRealId}:`, e.message);
    }
  }

  // The stored transcript of a session, converted to the viewer's shape.
  // Separate from the backend method because the ROSTER needs it too: a
  // sub-agent's transcript is fetched here when its work ends, and the
  // method below is only the contract's front door onto the same thing.
  async function transcriptOf(realId, label = realId) {
    let rows;
    try {
      // PAGED, like the session list. A single call returns the most recent
      // 50 messages and nothing says the rest exist, so a long session
      // rendered as though it began in the middle -- measured at 50 of 374.
      rows = await pageAll(`/api/session/${realId}/message`,
        `the transcript of ${label}`, 20000);
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
    // The server returns NEWEST FIRST, and `cursor.next` walks further
    // BACK in time -- so the pages concatenate newest-to-oldest and one
    // reverse at the end puts the whole transcript in the order the viewer
    // renders. Reversing per page would interleave them wrongly.
    const ordered = [...(rows || [])].reverse();
    const out = [];
    for (const m of ordered) {
      const info = m.info || m;
      // A row is NOT shaped the way the 1.x backend expected, and the
      // difference is silent:
      // every field we used to read simply comes back undefined, so the
      // transcript renders empty rather than wrong. Measured against 2.2.7:
      //   assistant -> { type, content: [{type:"text"|"reasoning"|"tool"}],
      //                  model: {providerID, id}, time }
      //   user      -> { type, text, time }   // no parts array at all
      // `parts`/`payload` are kept as fallbacks so this keeps working if a
      // later version changes its mind.
      const parts = Array.isArray(m.parts) ? m.parts
        : Array.isArray(m.content) ? m.content
        : [];
      const type = m.type || info.role;
      const body = (p) => p.text || "";
      // A model is labelled {providerID, id}; the viewer wants "provider/id".
      const modelLabel = info.modelID
        || (info.model && typeof info.model === "object"
          ? [info.model.providerID, info.model.id].filter(Boolean).join("/") || null
          : info.model || null);
      if (type === "user") {
        const t = parts.filter((p) => p.type === "text").map(body).join("\n")
          || (typeof m.text === "string" ? m.text : "")
          || (typeof m.payload?.text === "string" ? m.payload.text : "");
        if (t.trim()) out.push({ role: "user", text: t, id: info.id || randomUUID(), ts: info.time?.created || null, model: null });
        continue;
      }
      if (type !== "assistant") continue;
      // A STORED PART HAS NO ID. Measured against 2.2.7: an assistant
      // message's `content` entries carry type, text and time and nothing
      // else -- so `p.id` is always undefined and the old `p.id ||
      // randomUUID()` minted a FRESH id for the same block on every fetch.
      // That makes a transcript impossible to de-duplicate: server.py dedups
      // on the (id, role, text) triple, so two fetches of one unchanged
      // message are two different messages to it, and the content appears
      // twice. (Found by replaying a sub-agent's transcript into its own
      // feed, which showed every block three times.)
      //
      // A part IS identified, just positionally: by its message and its index
      // among the parts of its own KIND -- which is exactly what the live
      // stream calls `ordinal`, and exactly what blockId() builds a live
      // bubble id from. So deriving the same id here is not merely stable
      // across fetches, it is the SAME id the live stream already used, and
      // a reloaded transcript now lands on the bubbles already on screen
      // instead of beside them.
      //
      // The counter advances for EVERY part of a kind, including ones too
      // empty to render. The server numbers what it streamed, not what we
      // chose to show, so skipping one here would shift every ordinal after
      // it and quietly break the pairing this exists to create.
      const ordinal = { text: 0, reasoning: 0 };
      for (const p of parts) {
        const ts = info.time?.created || null;
        const n = p.type in ordinal ? ordinal[p.type]++ : 0;
        const idFor = (kind) => blockId(kind, { assistantMessageID: info.id, ordinal: n });
        if (p.type === "text" && p.text?.trim()) {
          out.push({ role: "assistant", text: p.text, id: idFor("text"), ts, model: modelLabel });
        } else if (p.type === "reasoning" && p.text?.trim()) {
          out.push({ role: "thinking", text: p.text, id: idFor("reasoning"), ts, model: modelLabel });
        } else if (p.type === "tool") {
          // A tool part carries the provider's own call id, which the live
          // path also uses -- so this one was already stable, and is kept.
          out.push({ role: "tool", text: summarizeTool(p), id: p.callID || p.id || randomUUID(), ts, model: modelLabel });
        } else {
          continue;
        }
      }
    }
    return out;
  }

  return {
    id: "opencode",

    async runTurn(sessionId, promptText, state) {
      return runTurn(sessionId, promptText, state);
    },

    abort(sessionId, state) {
      state?.abortController?.abort();
      api(`/api/session/${requireRealId(sessionId)}/interrupt`, { method: "POST", body: {}, timeoutMs: 5000 })
        .catch((e) => console.error(`[opencode] interrupt failed for ${sessionId}:`, e.message));
    },

    // THE REASON THIS BACKEND EXISTS.
    //
    // Hands a message to a turn that is already running. OpenCode admits it to the
    // session's durable inbox and the agent loop picks it up at its next step
    // boundary -- the same semantics Claude Code's input queue gives, which is
    // not a coincidence: an agent loop is inference -> tools -> inference, so
    // a step boundary is the only point a message can enter without throwing
    // away the work in flight.
    //
    // ASYNC, and the driver awaits it. The answer is only knowable once the
    // POST returns, and a receipt that claimed "folded" before the server had
    // accepted anything would be a message lost with the sender believing it
    // delivered -- exactly what the delivery core exists to prevent. So this
    // reports what actually happened rather than what is likely.
    async injectIntoTurn(sessionId, state, text) {
      // turnInFlight is NOT the right question. The driver clears it only at
      // the very end of runTurn's finally, after an approval drain bounded at
      // 30 seconds -- so it stays true long after the server has finished the
      // turn, and a steer accepted in that window runs as an execution nobody
      // is watching. steerClosed is set in the same tick the turn stops
      // reading the event stream, which is the honest boundary.
      //
      // Refusing is safe by contract: the driver re-queues whatever this
      // declines, so the message is not lost -- it starts a fresh turn, which
      // is exactly what it should do once the old one is over.
      if (!state?.turnInFlight || state.steerClosed) return false;
      if (typeof text !== "string" || !text) return false;
      try {
        await api(`/api/session/${requireRealId(sessionId)}/prompt`, {
          method: "POST",
          body: { text, delivery: "steer" },
          timeoutMs: 10000,
        });
        return true;
      } catch (e) {
        console.error(`[opencode] steer refused for ${sessionId}:`, e.message);
        return false;
      }
    },

    // THE SHAPE IS THE CONTRACT. viewer.html reads cmds.slash_commands and
    // cmds.terminal_slash_commands; an array satisfies neither, so the
    // command palette showed nothing for an OpenCode session -- quietly,
    // because the viewer defaults each missing key to [].
    //
    // Synchronous by contract (the driver calls it without awaiting from the
    // warm-up path), so this serves a cache -- and tops it up in the
    // background whenever it is still empty, which is what recovers from the
    // cold-start race above without a timer or a retry ladder.
    getKnownCommands() {
      if (!knownCommands.slash_commands.length) refreshCommands();
      return knownCommands;
    },

    cwdForSession(sessionId, fallbackCwd) { return fallbackCwd || cwdRoot; },

    resolveValidCwd(candidate) {
      if (!candidate) return null;
      const root = cwdRoot || process.cwd();
      const abs = candidate.startsWith("/") ? candidate : `${root}/${candidate}`;
      // Separator-anchored, NOT a bare startsWith: "/workspace-other" starts
      // with "/workspace" and is a sibling, not a child. That comparison is
      // the only thing standing between us and running a session in a
      // foreign tree, and the plain prefix test silently accepts it.
      const base = root.endsWith("/") ? root.slice(0, -1) : root;
      return abs === base || abs.startsWith(`${base}/`) ? abs : null;
    },

    // THE SHAPE IS THE CONTRACT, the third time in this file. The picker reads
    // `data.projects`, each row's `cwd` and `label`, and `data.root` to decide
    // which entry means "no cwd at all". Handed a bare array of {id, path} it
    // finds `projects` undefined and renders NOTHING -- not even the root, so
    // there is no way to start a session in the workspace itself.
    //
    // A project's directory is `canonical`. There is no `directory` or
    // `worktree` field, so reading those produced an empty path for every row
    // on top of the wrong container.
    async listProjects() {
      const base = cwdRoot || process.cwd();
      const label = (cwd) => (cwd === base ? "(root)" : (cwd.startsWith(`${base}/`) ? cwd.slice(base.length + 1) : cwd));
      // The root is offered UNCONDITIONALLY. The server only knows about a
      // directory once something has run there, so on a fresh install the
      // workspace itself is absent from this list -- which would leave the
      // picker unable to offer the one directory that always exists.
      const projects = [{ cwd: base, label: "(root)" }];
      const seen = new Set([base]);
      try {
        for (const p of (await api("/api/project", { timeoutMs: 8000 })) || []) {
          const cwd = p.canonical || "";
          // Under the root only: resolveValidCwd refuses anything else, so
          // offering it would produce a menu entry that cannot be chosen.
          // That also keeps other clients' projects (and "/") out.
          if (!cwd || seen.has(cwd) || !cwd.startsWith(`${base}/`)) continue;
          seen.add(cwd);
          projects.push({ cwd, label: label(cwd) });
        }
      } catch { /* an unreachable server still offers the root */ }
      return { projects, root: base };
    },

    // RETURNS AN ENVELOPE, not a bare array. gatherAllSessions() does
    // `perBackend.flatMap((r) => r.sessions)`, so a backend that returns the
    // array directly yields [undefined] and every /sessions poll then dies on
    // `s.sessionId`. Measured: registering this backend broke the session
    // list outright until the shape was fixed, and the error named a property
    // rather than a backend, so it looked like a driver bug.
    //
    // Every row must also carry `backend`: the same function uses it to
    // populate sessionIdToBackend, which is how a session is routed back to
    // the runtime that owns it. Without it a session becomes unroutable
    // the moment the in-memory state is lost.
    // The driver hands every backend its own live session index and the
    // pending-approval lookup. Omitting
    // `inFlight` here did not break the listing -- it just made every
    // session look permanently idle, to the browser and to anything asking
    // "is this session busy?", which is the question the whole mid-turn
    // delivery path turns on.
    async listSessions(opts, sessionsIndex, pendingKindForSession) {
      const rows = await listAllSessions();
      const out = [];
      for (const s of rows || []) {
        // A SUB-AGENT CHILD IS NOT A TOP-LEVEL SESSION. It is a real session
        // with a real transcript -- that is what distinguishes this backend
        // from Claude Code, whose sub-agents have none -- but it is a worker
        // owned by its parent's turn, addressed only through it. Listing one
        // puts it in the picker AND the peer list, where it reads as an
        // independent chat you could open and message. That happened: eleven
        // of them, until the criterion was corrected.
        //
        // SKIPPED, NOT UNMAPPED. The id map is NOT "sessions the user may
        // open" -- it is "ids this backend can resolve" -- and the two were
        // conflated, which is why the filter had to live in the map and the
        // map was therefore wrong. It lives here now, where it can ask the
        // honest question.
        //
        // A child this process is actually driving IS mapped: onChildEvent
        // remembers it the moment the server announces it, and records the
        // id on its relation row too, so seedOpenCodeRealIds() hands it back
        // after a restart. Mapping every OTHER child seen in a listing would
        // buy nothing -- a sub-agent with no relation row appears in no
        // roster, so nothing will ever ask for its transcript -- while
        // growing the map by every sub-agent the TUI has ever spawned.
        if (s.parentID) continue;
        // Anything else without an entry belongs to another client.
        const clientId = toClient(s.id);
        if (!clientId) continue;
        const cwd = s.location?.directory || cwdRoot;
        out.push({
          sessionId: clientId,
          backend: "opencode",
          summary: s.title || null,
          customTitle: s.title || null,
          firstPrompt: s.title || null,
          lastModified: s.time?.updated || s.time?.created || null,
          createdAt: s.time?.created || null,
          cwd,
          projectLabel: cwd === cwdRoot ? "(root)" : cwd,
          unreachable: false,
          inFlight: !!sessionsIndex?.get?.(clientId)?.turnInFlight,
          pendingKind: pendingKindForSession?.(clientId) ?? null,
          // The flag lives at `time.archived` (a timestamp), not `archived`.
          // Reading the wrong one made this permanently false -- harmless
          // only for as long as the un-paged list happened to contain almost
          // no archived sessions. Paging surfaces all of them, and without
          // this they would arrive looking like ordinary live sessions.
          archived: isArchived(s),
          tag: isArchived(s) ? "archived" : null,
        });
      }
      return { sessions: out, unreachableCount: 0, unreachableSessions: [] };
    },

    async getSessionHistory(sessionId) {
      // A session this backend cannot resolve has no transcript to show, and
      // that is NORMAL rather than an error: server.py asks every backend
      // about ids it has not placed yet, and a brand-new session legitimately
      // has no real id. requireRealId raises a 404-shaped error for exactly
      // this case, and it has to be caught HERE -- it is outside transcriptOf,
      // which takes a real id it can trust.
      let realId;
      try {
        realId = requireRealId(sessionId);
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
      return transcriptOf(realId, sessionId);
    },

    async archiveSession(sessionId) {
      await api(`/api/session/${requireRealId(sessionId)}`, { method: "PATCH", body: { archived: true } });
      return { ok: true };
    },
    async unarchiveSession(sessionId) {
      await api(`/api/session/${requireRealId(sessionId)}`, { method: "PATCH", body: { archived: false } });
      return { ok: true };
    },
    async deleteSession(sessionId) {
      const realId = requireRealId(sessionId);
      await api(`/api/session/${realId}`, { method: "DELETE" });
      // Forget the mapping too. The server has no such session any more, so a
      // surviving entry is a pointer to a 404 -- it would make the map grow
      // without bound, and anything that reused the client id would resolve
      // to a dead session instead of creating a live one. Only AFTER the
      // delete succeeds: dropping it first would strand a session that is
      // still there if the request failed.
      clientToReal.delete(sessionId);
      realToClient.delete(realId);
      saveMap();
      return { ok: true };
    },
    async renameSession(sessionId, title) {
      await api(`/api/session/${requireRealId(sessionId)}`, { method: "PATCH", body: { title } });
      return { ok: true };
    },

    // THE SHAPE IS THE CONTRACT, exactly as it is for listSessions. The
    // viewer reads `data.available` and `data.current`; handed a bare array
    // it finds neither, renders no options, and the model picker simply does
    // not appear -- with no error anywhere, because an array is a perfectly
    // good JSON response. A session then runs on whatever the server defaults
    // to, which is the one thing the picker exists to prevent.
    async listModels() {
      let rows;
      try {
        rows = await api("/api/model", { timeoutMs: 15000 });
      } catch (e) {
        console.error("[opencode] listModels failed:", e.message);
        return { available: [], current: null };
      }
      const available = (rows || [])
        .filter((m) => m.enabled !== false)
        // providerID, not id: a model's own id is bare ("beam-1.0-bf16") and
        // only the pair identifies it. Every custom provider configured in
        // opencode.jsonc appears here alongside the built-in ones.
        .map((m) => ({ id: `${m.providerID}/${m.id}`, label: `${m.name || m.id} (${m.providerID})` }));

      // What the server will ACTUALLY use when nobody has chosen. A session
      // object does not carry its model, so without this the picker would
      // select whichever entry happened to sort first and quietly misreport
      // the model the next turn runs on. The driver overrides this with an
      // explicit pick when it has one.
      let current = null;
      try {
        const def = await api("/api/model/default", { timeoutMs: 8000 });
        if (def?.providerID && def?.id) current = `${def.providerID}/${def.id}`;
      } catch { /* a missing default is not worth failing the list over */ }

      return { available, current };
    },

    // Agents are OpenCode's modes. Only the PRIMARY, non-hidden ones are a
    // user's choice: `build` and `plan`. The subagent ones (general, explore)
    // are spawned by the model, and the hidden ones (compaction, title,
    // summary) are internal bookkeeping -- offering either as a mode would
    // let someone put a session into a state it was never meant to run in.
    async listModes(sessionId) {
      try {
        const rows = await api("/api/agent", { timeoutMs: 8000 });
        const available = (rows || [])
          .filter((a) => a.mode === "primary" && !a.hidden)
          .map((a) => ({ id: a.id, label: a.name || a.id }));
        if (!available.length) return null;
        // `build` is the server's default. The driver prefers an explicit
        // in-run choice over this, so it only shows through before one.
        return { current: "build", available };
      } catch (e) {
        console.error("[opencode] listModes failed:", e.message);
        return null;
      }
    },

    async setMode(sessionId, mode) {
      const realId = await ensureSession(sessionId);
      await api(`/api/session/${realId}/agent`, { method: "POST", body: { agent: mode } });
      return { ok: true };
    },

    async setModel(sessionId, modelId) {
      const [providerID, ...rest] = String(modelId || "").split("/");
      const id = rest.join("/");
      if (!providerID || !id) return { ok: false, reason: "bad-model-id" };
      const realId = await ensureSession(sessionId);
      await api(`/api/session/${realId}/model`, { method: "POST", body: { model: { providerID, id } } });
      return { ok: true };
    },

    // THE PLUGIN ONLY KNOWS THE SERVER'S ID. A tool handler is handed
    // ctx.sessionID by OpenCode's runtime -- that is the whole security
    // argument for the plugin, since the model cannot forge it -- but it is
    // the id the SERVER minted, and the driver files everything under the
    // client id instead. So every tool call arrives claiming to be from a
    // session the driver has never heard of.
    //
    // podSessionIdFor() in driver.mjs translates through exactly this
    // method. Without it the translation silently falls through to the raw
    // id, the sender resolves to nothing, and mail or delegation sent FROM
    // an OpenCode session fails with "no-session" -- which reads as a
    // routing problem on the recipient's side rather than a failure to
    // recognise the sender. list_sessions still worked throughout, because
    // listing peers does not need to know who is asking, so the gap looked
    // narrower than it was.
    // Called once at startup with every pairing the relation index still
    // knows. Additive and idempotent: an entry the map already holds is left
    // alone, so this can only ever restore, never overwrite.
    seedRealIds(pairs) {
      let n = 0;
      for (const [clientId, realId] of pairs || []) {
        if (!clientId || !realId) continue;
        if (clientToReal.get(clientId) === realId) continue;
        remember(clientId, realId);
        n++;
      }
      return n;
    },

    clientIdForReal(realId) {
      return toClient(realId);
    },

    // Test seam. The client-id <-> server-id map is the one piece of state
    // this backend cannot recompute (see the header), so losing it loses the
    // session -- worth asserting directly rather than only through behaviour.
    _ids: { toReal, toClient },
  };
}
