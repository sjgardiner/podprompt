// OpenCode backend for the viewer driver.
//
// Talks to a long-lived `opencode serve` instance over plain HTTP + one
// shared SSE stream (GET /event), rather than spawning a subprocess per
// turn the way the Claude Code backend does. Empirically characterized
// against a real running server this session:
//
//   - Messages decompose into typed Parts (text/tool/step-start/step-finish/
//     reasoning/...) with stable `prt_*` ids that update in place via
//     `message.part.updated` (full replace) and `message.part.delta` (an
//     incremental `{field, delta}` patch — only ever seen for `field:"text"`
//     against a text part in testing here).
//   - A tool part's `state.status` moves pending -> running -> completed|error,
//     `state.metadata.output` growing live while running (e.g. streamed
//     bash stdout) — this is what /session/{id}/message's SSE traffic looks
//     like for a Bash-equivalent tool call, captured firsthand this session.
//   - Multi-turn context needs no client-side resending: POSTing to an
//     existing sessionID carries full prior context server-side (verified:
//     a second turn correctly recalled a secret word from turn one with
//     nothing re-supplied).
//   - Permission prompts arrive as their own SSE event (not a Part) and are
//     answered via a separate POST — genuinely async/push, not a callback
//     the request blocks on the way Claude's canUseTool is. Plan-mode
//     edit denial doesn't even reach this path: the model just states it
//     can't edit and never attempts the tool at all (no permission event
//     fires), confirmed live this session switching a session to `plan` and
//     asking for an in-workspace write.
//   - Agent/mode ("build" vs "plan" vs "explore"/"general") is a first-class
//     per-session concept with its own permission ruleset, switchable at any
//     time via POST /api/session/{id}/agent — no Claude Code equivalent.
//
// One long-lived SSE connection is shared across ALL sessions (the server
// multiplexes every session's events onto /event) rather than one
// connection per session/turn — opened once at backend construction and
// dispatched by `sessionID` to whichever session's turn is currently
// in-flight and awaiting completion.

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import nodePath from "node:path";

export function createOpenCodeBackend({ cwdRoot, broadcast, broadcastStatus, requestApproval, baseUrl }) {
  const BASE = baseUrl || "http://127.0.0.1:7845";
  let knownCommandsCache = null;
  let knownCommandsFetchStarted = false;
  let agentListCache = null;

  // ── Model list, lazily fetched the same way knownCommandsCache is ───────
  // GET /config/providers enumerates every configured provider (whichever
  // ones this opencode server's own auth/config actually has — could be one,
  // could be many) and every model each exposes, including `limit.context`
  // per model — the source both listModels() (the model-switcher UI) and
  // the per-message context-percentage calculation below read from. Modeled
  // as a flat "providerID/modelID" composite id string on the wire so
  // viewer.html's model-switcher payload shape stays identical across
  // backends (see backends/claude-code.mjs's listModels, whose ids are
  // plain model-name strings with no such split).
  let providerListPromise = null; // in-flight /config/providers fetch (listModels() awaits it)
  const modelContextLimits = new Map(); // "providerID/modelID" -> context window size
  let modelListCache = []; // [{id, label}]
  let configDefaultModelId = null; // composite "providerID/modelID" of the configured default, if resolvable

  // Returns a promise for a /config/providers fetch so listModels() can await
  // it. The listen loop is shared across callers (the cache of a successful
  // one wins; nobody double-fetches). Failure-safe two ways:
  //   1) a transient error (e.g. this fires before `opencode serve`'s ~1s
  //      cold start finishes accepting connections) is retried a couple of
  //      times here with a short delay, so a single /models call — the
  //      browser's very first one right after boot — still comes back with
  //      real data instead of an empty cache, and
  //   2) only when every attempt fails (the server genuinely isn't up) is the
  //      promise dropped, letting the next listModels() call try from scratch
  //      — never leaving the cache wrongly "poisoned" for the container's life.
  function fetchProviderListInBackground() {
    if (providerListPromise) return providerListPromise;
    providerListPromise = (async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          const data = await api("/config/providers", { timeoutMs: 10000 });
          const available = [];
          let providerIds = new Set();
          for (const p of data?.providers || []) {
            providerIds.add(p.id);
            for (const [modelKey, info] of Object.entries(p.models || {})) {
              const id = `${p.id}/${modelKey}`;
              if (info?.limit?.context) modelContextLimits.set(id, info.limit.context);
              available.push({ id, label: `${p.name || p.id} / ${info?.name || modelKey}` });
            }
          }
          modelListCache = available;
          // /config/providers also reports the server's configured default as
          // {providerID: modelID} (or {agentName: ...} in some setups). Pick the
          // entry whose key names a real provider so /models can pre-select it.
          configDefaultModelId = null;
          for (const [key, value] of Object.entries(data?.default || {})) {
            const composite = String(value).includes("/") ? String(value) : `${key}/${value}`;
            const [pId, mId] = composite.split("/");
            if (pId && mId && (providerIds.has(pId) || !providerIds.size)) {
              configDefaultModelId = composite;
              break;
            }
          }
          return;
        } catch (e) {
          console.error(`[opencode] failed to fetch /config/providers (attempt ${attempt}/3):`, e.message);
          if (attempt >= 3) break;
          await new Promise((r) => setTimeout(r, 750));
        }
      }
      // All attempts failed — drop the promise so the next listModels() call
      // (viewer.html re-fetches on connect and after each turn) retries.
      providerListPromise = null;
    })();
    return providerListPromise;
  }

  function parseModelId(id) {
    const s = String(id || "");
    const idx = s.indexOf("/");
    if (idx === -1) return null;
    return { providerID: s.slice(0, idx), modelID: s.slice(idx + 1) };
  }

  // ── Client id <-> real OpenCode id alias ────────────────────────────────
  // viewer.html mints its own crypto.randomUUID() for a brand-new chat
  // before any backend session exists, and that id is what every later
  // driver.mjs route call is keyed by. Claude Code's CLI happens to accept
  // a client-chosen UUID as a resumable session id, so this was never an
  // issue for that backend — but OpenCode's POST /session always mints its
  // own `ses_...` id server-side and ignores any `id` in the request body
  // (confirmed live: posting {id: "<uuid>"} still returns a fresh ses_...).
  // So every method below translates the incoming client id to the real
  // OpenCode id via this map, minting the real session (and the mapping)
  // lazily on first use. In-memory only — a driver restart loses the
  // mapping for any session whose real id was never independently
  // discoverable, which would orphan that chat's client-side id. Treated as
  // a known first-pass gap, same as the deferred multi-project-discovery
  // work, rather than solved with on-disk persistence here.
  const clientToReal = new Map(); // client-minted id -> real ses_... id
  const realToClient = new Map(); // real ses_... id -> client-minted id

  function knownRealId(sessionId) {
    return clientToReal.get(sessionId) || sessionId;
  }

  // Fetched lazily on first actual getKnownCommands() call, not at backend
  // construction — this factory runs for every registered backend
  // unconditionally at driver startup (see driver.mjs's `backends` map),
  // regardless of whether this backend is ever selected, so fetching here
  // would mean every driver launch requires `opencode serve` to be up just
  // to avoid an error log, even for a deployment that only ever uses
  // claude-code. GET /command is static per-server (not per-turn/session
  // the way Claude's slash_commands arrives), so a one-time fetch, kicked
  // off the first time something actually asks and cached after, is enough;
  // the synchronous getKnownCommands() below (driver.mjs's /commands route
  // never awaits it, matching the Claude backend's shape) just returns
  // empty defaults until that first fetch resolves.
  function fetchKnownCommandsInBackground() {
    if (knownCommandsFetchStarted) return;
    knownCommandsFetchStarted = true;
    (async () => {
      try {
        const list = await api("/command", { timeoutMs: 5000 });
        knownCommandsCache = {
          slash_commands: (list || []).map((c) => c.name),
          terminal_slash_commands: [],
          skills: (list || []).filter((c) => c.source === "skill").map((c) => c.name),
        };
      } catch (e) {
        console.error("[opencode] failed to fetch /command list:", e.message);
        // See fetchProviderListInBackground's identical reasoning: clear the
        // guard on failure so a transient error (server not up yet) doesn't
        // permanently suppress every later retry.
        knownCommandsFetchStarted = false;
      }
    })();
  }

  // ── Shared SSE dispatch ──────────────────────────────────────────────────
  // Keyed by sessionID, not by turn/request id — OpenCode's events all carry
  // sessionID directly, and only one turn is ever in flight per session at a
  // time (the driver.mjs /prompt route already rejects a second concurrent
  // prompt to the same session), so this is unambiguous.
  const turnWaiters = new Map(); // sessionID -> { onEvent(evt), resolve, reject }
  // Permission-ask events carry their own requestID, not reliably matched to
  // a specific in-flight turn's waiter (a permission can in principle arrive
  // for a session between turns, though not observed in practice) — tracked
  // separately so a permission event is never silently dropped just because
  // no turn waiter happens to be registered for that session at the moment.
  const permissionSessionOf = new Map(); // requestID -> sessionID

  let sseReady = null;
  function ensureSse() {
    if (sseReady) return sseReady;
    sseReady = (async () => {
      const res = await fetch(`${BASE}/event`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      (async function pump() {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const chunk = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              let evt;
              try {
                evt = JSON.parse(dataLine.slice("data: ".length));
              } catch {
                continue;
              }
              dispatchEvent(evt);
            }
          }
        } catch (e) {
          console.error("[opencode] SSE stream ended unexpectedly, reconnecting:", e.message);
          sseReady = null;
          setTimeout(ensureSse, 1000);
        }
      })();
    })();
    return sseReady;
  }

  function dispatchEvent(evt) {
    const props = evt.properties || {};
    const sessionID = props.sessionID
      || props.info?.sessionID
      || props.part?.sessionID;

    if (evt.type === "permission.asked") {
      // properties IS the PermissionRequest itself (id, sessionID, permission
      // [a string key like "edit"/"bash"], patterns, metadata, always, tool)
      // — not nested under a `permission` key, despite the event name.
      if (props.id && sessionID) permissionSessionOf.set(props.id, sessionID);
      const waiter = sessionID && turnWaiters.get(sessionID);
      if (waiter) waiter.onPermission(props);
      return;
    }

    if (evt.type === "question.asked") {
      // properties is {id, sessionID, questions: [QuestionInfo], tool} —
      // questions (plural) already matches the {question,header,options:
      // [{label,description}]} shape the viewer's AskUserQuestion card
      // renders for the Claude backend, so it's passed through as-is.
      if (props.id && sessionID) permissionSessionOf.set(props.id, sessionID);
      const waiter = sessionID && turnWaiters.get(sessionID);
      if (waiter) waiter.onQuestion(props);
      return;
    }

    const waiter = sessionID && turnWaiters.get(sessionID);
    if (waiter) waiter.onEvent(evt);
  }

  // Optional explicit timeout (opts.timeoutMs) — some requests MUST be able to
  // fail fast: a /config/providers fetch that hangs (a socket race during a
  // serve cold start can leave undici's connection stuck forever) would hold
  // providerListPromise pending indefinitely and every later /models call
  // would await a promise that never settles — the model picker silently
  // never appearing. Default is NO timeout: the POST to /session/{id}/message
  // waits for the full generation and must not be aborted mid-reply.
  async function api(path, opts) {
    const { timeoutMs, headers, ...rest } = opts || {};
    let signal;
    let timer;
    if (timeoutMs) {
      const ctl = new AbortController();
      timer = setTimeout(() => ctl.abort(new Error(`OpenCode API ${path} timed out after ${timeoutMs}ms`)), timeoutMs);
      signal = ctl.signal;
    }
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...rest,
        signal,
        headers: { "Content-Type": "application/json", ...(headers || {}) },
      });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => "");
        throw new Error(`OpenCode API ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      }
      if (res.status === 204) return null;
      const ct = res.headers.get("content-type") || "";
      return ct.includes("application/json") ? res.json() : res.text();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Part -> viewer broadcast translation ────────────────────────────────
  // Mirrors formatToolSummary()'s one-liner style from the Claude backend so
  // both backends render comparably in the same browser, without needing a
  // real diff renderer for OpenCode's edit/write tools yet (state.metadata
  // doesn't carry the equivalent of Claude's old_string/new_string in the
  // same shape — worth revisiting once a real edit-tool part has been
  // captured and inspected by hand).
  function summarizeToolPart(part) {
    const state = part.state || {};
    const input = state.input || {};
    const preferredKeys = ["command", "filePath", "file_path", "pattern", "query", "url", "description"];
    let text = null;
    for (const key of preferredKeys) {
      if (key in input) {
        text = String(input[key]);
        break;
      }
    }
    if (text === null) text = JSON.stringify(input);
    if (text.length > 200) text = text.slice(0, 200) + "…";
    return `\`${part.tool}\` ${text}`;
  }

  // ── Drive one turn ───────────────────────────────────────────────────────
  // Unlike the Claude backend, there is no bootstrap ambiguity here: the
  // server always knows whether a session is new or existing (this function
  // is only ever called after the session is guaranteed to exist — see
  // ensureSession below), and no subprocess lifecycle to manage — this is a
  // single POST plus SSE-driven event handling until session.idle.
  //
  // `sessionId` is the client-minted id (used for every broadcast, since
  // the browser/server.py SSE relay is keyed by that id); `realId` is the
  // actual OpenCode `ses_...` id (used for every OpenCode API call and for
  // registering the turnWaiter, since that's what incoming SSE events from
  // OpenCode itself carry).
  async function runTurn(sessionId, realId, promptText, state) {
    await ensureSse();
    state.turnInFlight = true;
    broadcastStatus(sessionId, { type: "turn_start" });

    const userMsgUuid = randomUUID();
    broadcast(sessionId, "user", promptText, userMsgUuid);

    // partID -> accumulated text, so message.part.delta's incremental
    // {field, delta} patches can be re-broadcast as the running full text a
    // stream_delta status update needs (mirrors the Claude backend's
    // stream_start/stream_delta shape so the browser's existing live-typing
    // rendering works unmodified for either backend).
    const liveText = new Map(); // partID -> { text, started, type, sentMessage }

    // opencode re-broadcasts the just-appended USER message as ordinary
    // "type: text" parts over /event (probe-confirmed: message.part.updated
    // with the full prompt text under the user message's id). Those would
    // otherwise be indistinguishable from the assistant's first answer parts
    // and get fabricated into a spurious assistant bubble right after every
    // prompt — the empty-bubble-plus-blinking-cursor bug. message.updated
    // for the user message carries its role + id; parts carry messageID, so
    // matching on that set filters the echoes out exactly.
    const userMessageIDs = new Set(); // message ids originating from the user

    // part.type values that carry a model's chain-of-thought (older opencode
    // calls it "reasoning", newer "thinking"); anything else streaming on a
    // part.delta is the assistant's actual answer.
    const isThinkingPart = (type) => type === "reasoning" || type === "thinking";
    const roleForPartType = (type) => (isThinkingPart(type) ? "thinking" : "assistant");

    const pendingApprovalPromises = [];

    function onEvent(evt) {
      if (evt.type === "message.part.updated") {
        const part = evt.properties.part;
        if (!part || !part.id) return;
        if (userMessageIDs.has(part.messageID)) return; // user-echo part — never render
        const entry = liveText.get(part.id) || { text: "", started: false, type: part.type };
        entry.type = part.type; // needed later by the part.delta path to pick the broadcast role
        entry.text = part.text || entry.text;
        liveText.set(part.id, entry);

        if (part.type === "reasoning" || part.type === "thinking") {
          // Thinking full-text path. opencode's server almost always streams
          // thinking via part.delta (the reasoning part's part.updated shows
          // text:"" at creation) — but when it does carry text on this event
          // (or a reasoning frontend delivers the whole thing at once), this
          // is what surfaces it as a thinking bubble. Deltas keep streaming
          // into the same bubble afterwards (same part.id); the final
          // authoritative text is re-broadcast when the turn ends.
          if (entry.text) broadcast(sessionId, "thinking", entry.text, part.id);
          return;
        }
        if (part.type === "text") {
          // NO stream_start here — that's emitted by the first part.delta
          // below instead. opencode fires message.part.updated for the
          // USER's own echoed text part too, and emitting a stream_start on
          // that used to raise an EMPTY assistant bubble with a blinking
          // cursor immediately after every prompt, before a single reply
          // token had arrived.
          if (entry.text && !entry.started) {
            // A reply delivered whole with no deltas (a short/unchunked
            // response): surface it directly as the final message. Deltas
            // never fire for it, so started + sentMessage here keep the
            // turn-end finalization from re-broadcasting the same text.
            entry.started = true;
            entry.sentMessage = true;
            broadcast(sessionId, "assistant", entry.text, part.id);
          }
          return;
        }
        if (part.type === "tool") {
          const status = part.state?.status;
          // Only broadcast a one-liner on completion/error — pending/running
          // are surfaced as ephemeral status only, matching the Claude
          // backend's "one bubble per finished tool call" shape rather than
          // spamming a new bubble per lifecycle transition.
          if (status === "running") {
            broadcastStatus(sessionId, { type: "tool_progress", toolName: part.tool, output: part.state?.metadata?.output });
          } else if (status === "completed" || status === "error") {
            broadcast(sessionId, "tool", summarizeToolPart(part), part.id);
          }
          return;
        }
        return;
      }

      if (evt.type === "message.part.delta") {
        const { partID, field, delta } = evt.properties;
        if (field !== "text" || !delta) return;
        // part.delta carries no part type (verified empirically): the type
        // is whatever the matching message.part.updated recorded, which
        // opencode always delivers before the first delta of a part.
        const entry = liveText.get(partID) || { text: "", started: false, type: undefined };
        entry.text += delta;
        liveText.set(partID, entry);
        // part.delta carries NO part type — the role is looked up from the
        // most recent part.updated for this part.id (empirically that event
        // arrives before the first delta of a part, carrying type "reasoning"
        // for the thinking stream and "text" for the answer). Reasoning text
        // must never be broadcast under the assistant role (that's what put
        // the model's whole chain-of-thought into a "Claude" bubble).
        if (!entry.started) {
          entry.started = true;
          broadcastStatus(sessionId, { type: "stream_start", id: partID, role: roleForPartType(entry.type) });
        }
        broadcastStatus(sessionId, { type: "stream_delta", id: partID, role: roleForPartType(entry.type), text: entry.text });
        return;
      }

      // Message-level (not part-level) update — carries the assistant
      // message's running tokens/cost/model once the provider has actually
      // responded. Used for both the context-usage bar (percentage against
      // the model's own limit.context, since OpenCode has no direct
      // percentage field the way Claude's SDKContextUsage does) and the
      // running spend counter this backend shows in place of Claude Code's
      // plan/rate-limit bar (OpenCode has no subscription/quota concept).
      if (evt.type === "message.updated") {
        const info = evt.properties?.info;
        if (!info) return;
        if (info.role === "user" && info.id) {
          // Remember user message ids so the echoed user text part above can
          // be told apart from the assistant's answer parts.
          userMessageIDs.add(info.id);
          return;
        }
        if (info.role !== "assistant") return;
        if (info.tokens) {
          const t = info.tokens;
          const totalTokens = (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
          const maxTokens = modelContextLimits.get(`${info.providerID}/${info.modelID}`);
          if (maxTokens) {
            broadcastStatus(sessionId, {
              type: "context_usage",
              percentage: Math.min(100, (totalTokens / maxTokens) * 100),
              totalTokens, maxTokens, model: info.modelID,
            });
          }
        }
        // Only once the message has actually finished (not on an earlier,
        // still-in-progress update) — re-reading the session's own
        // cumulative `cost` field rather than summing message deltas
        // ourselves sidesteps any risk of double-counting if this event
        // fires more than once per message.
        if (info.time?.completed) {
          api(`/session/${realId}`, { timeoutMs: 8000 }).then((s) => {
            if (typeof s?.cost === "number") broadcastStatus(sessionId, { type: "spend", totalCostUsd: s.cost });
          }).catch(() => {});
        }
        return;
      }

      // Compaction-equivalent events — no per-session "closeness" signal
      // exists to show ahead of time the way Claude Code's context_usage
      // percentage does (OpenCode fires these only once compaction is
      // already underway/done), but active/done is still worth surfacing
      // the same way. `session.next.*` is a newer/possibly-experimental
      // event family alongside the older, minimal `session.compacted` —
      // handled defensively since it's unclear which a given opencode
      // server version actually emits.
      if (evt.type === "session.next.compaction.started") {
        broadcastStatus(sessionId, { type: "compacting", active: true });
        return;
      }
      if (evt.type === "session.next.compaction.ended" || evt.type === "session.compacted") {
        broadcastStatus(sessionId, { type: "compacting", active: false, result: "success" });
        return;
      }
    }

    function onPermission(perm) {
      if (state.autoApprove) {
        pendingApprovalPromises.push(replyPermission(perm.id, { allow: true }));
        return;
      }
      // perm.permission is the ruleset key being asked about ("edit", "bash",
      // ...) — the closest OpenCode equivalent of Claude's toolName, shown
      // in the generic "Approve <toolName>?" card since these aren't
      // per-tool-call structured the way AskUserQuestion is.
      const p = requestApproval(sessionId, "permission", perm.permission || "unknown", perm.metadata || {})
        .then((decision) => replyPermission(perm.id, decision));
      pendingApprovalPromises.push(p);
    }

    function onQuestion(q) {
      // toolInput.questions is what the viewer's question card reads —
      // q.questions already matches Claude's QuestionInfo[] shape
      // ({question,header,options:[{label,description}]}) closely enough to
      // render unmodified.
      const p = requestApproval(sessionId, "question", "AskUserQuestion", { questions: q.questions })
        .then((answer) => replyQuestion(q.id, q.questions, answer));
      pendingApprovalPromises.push(p);
    }

    const done = new Promise((resolve, reject) => {
      turnWaiters.set(realId, {
        onEvent(evt) {
          onEvent(evt);
          if (evt.type === "session.idle") resolve();
        },
        onPermission,
        onQuestion,
      });
    });

    try {
      // state.model (set via POST /set-model, see driver.mjs) is a plain
      // "providerID/modelID" composite string — parsed back into the object
      // shape /session/{id}/message actually expects. Omitted entirely if
      // unset or malformed, letting the server fall back to its own
      // default model, same as an unset state.mode already falls back to
      // "build" just below.
      const model = state.model ? parseModelId(state.model) : null;
      await api(`/session/${realId}/message`, {
        method: "POST",
        body: JSON.stringify({
          agent: state.mode || "build",
          ...(model ? { model } : {}),
          parts: [{ type: "text", text: promptText }],
        }),
      });
      // The POST above already resolves once the full assistant reply is
      // generated server-side (confirmed empirically: the response body
      // itself carries the finished message+parts) — but session.idle over
      // SSE is still awaited so any in-flight permission/question exchange
      // that arrived mid-turn has actually settled before this function
      // returns, and so the live-streaming path above gets to run to
      // completion for a browser watching in real time. A short race is
      // possible if session.idle already fired before this awaits it (a
      // very fast turn) — guarded by resolving `done` eagerly if the POST
      // itself completes and no idle event ever arrives within a grace
      // period.
      await Promise.race([done, sleep(15000).then(() => {})]);
      await Promise.all(pendingApprovalPromises);

      // Finalize every still-streaming bubble: opencode broadcasts no
      // terminal "message" of its own, so without this the browser's live
      // typing cursor would keep blinking forever on each bubble after the
      // turn ended. Broadcast the authoritative full text under the correct
      // role (a "thinking" one for reasoning/thinking parts, "assistant"
      // otherwise) under the SAME part.id — the browser treats a broadcast
      // for an already-streaming part as the finalize signal (drops the
      // typing cursor, swaps to a real markdown render for assistants).
      // Thinking bubbles get their own final authoritative text even if
      // part.updated already carried it mid-stream (entries sent whole via
      // the "no deltas" path above are skipped via sentMessage). All done
      // before turn_end so the status-bar resync and the blockers see the
      // finished text arrive in order.
      for (const [partId, entry] of liveText) {
        if (entry.started && entry.text && !entry.sentMessage) {
          broadcast(sessionId, roleForPartType(entry.type), entry.text, partId);
        }
      }
    } catch (e) {
      console.error(`[opencode] error during turn for session ${sessionId}:`, e.message);
      broadcast(sessionId, "tool", `*(error: ${e.message})*`, randomUUID());
    } finally {
      turnWaiters.delete(realId);
      state.turnInFlight = false;
      broadcastStatus(sessionId, { type: "turn_end" });
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function replyPermission(requestID, decision) {
    try {
      await api(`/permission/${requestID}/reply`, {
        method: "POST",
        body: JSON.stringify({ answer: decision?.allow ? "once" : "reject" }),
        timeoutMs: 5000,
      });
    } catch (e) {
      console.error("[opencode] failed to reply to permission:", e.message);
    }
  }

  async function replyQuestion(requestID, questions, formattedAnswer) {
    // The viewer's question card only ever sends back one joined string —
    // `${header}: ${label}; ${header2}: ${label2}` — built in viewer.html
    // from the same `questions` array in the same order, so it's split back
    // apart here rather than changing the shared viewer<->driver contract
    // (which also serves the Claude backend's plain-text AskUserQuestion
    // answer) just for OpenCode's structured answers: [[label], ...] shape.
    const segments = String(formattedAnswer || "").split("; ");
    const answers = questions.map((q, i) => {
      const seg = segments[i] || "";
      const prefix = `${q.header || q.question}: `;
      const label = seg.startsWith(prefix) ? seg.slice(prefix.length) : seg;
      return [label];
    });
    try {
      await api(`/question/${requestID}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers }),
        timeoutMs: 5000,
      });
    } catch (e) {
      console.error("[opencode] failed to reply to question:", e.message);
    }
  }

  // ── Session/message shape conversion ────────────────────────────────────
  function extractTextFromParts(parts, type) {
    return parts
      .filter((p) => p.type === type && p.text)
      .map((p) => p.text)
      .join("\n\n");
  }

  function convertSessionMessages(rawMessages) {
    const out = [];
    for (const m of rawMessages) {
      // One malformed or odd-shaped message must NEVER blank that session's
      // whole transcript for the viewer. /session/{id}/message can contain
      // background bookkeeping entries (compaction/summary agents, permission
      // interstitials) whose `info` is missing or shaped differently than a
      // normal user/assistant message, and the history route used to bubble
      // any such exception straight up to a catch-all that returned [] —
      // so a single such message in an otherwise fine conversation wiped the
      // entire rendered history. Convert per-message now: skip the unusable
      // entry, keep everything else.
      try {
        const info = m?.info;
        const parts = Array.isArray(m?.parts) ? m.parts : [];
        if (!info || typeof info !== "object" || !info.id) continue;
        if (info.role === "user") {
          const text = extractTextFromParts(parts, "text");
          if (text.trim()) out.push({ role: "user", text, id: info.id, ts: info.time?.created || null });
        } else if (info.role === "assistant") {
          const text = extractTextFromParts(parts, "text");
          if (text.trim()) out.push({ role: "assistant", text, id: info.id, ts: info.time?.created || null });
          for (const p of parts) {
            if (p?.type === "tool" && (p?.state?.status === "completed" || p?.state?.status === "error")) {
              out.push({ role: "tool", text: summarizeToolPart(p), id: p?.id || info.id, ts: null });
            }
          }
        }
      } catch (e) {
        console.error("[opencode] skipped a history message during conversion:", e.message);
      }
    }
    return out;
  }

  // ── Session creation is eager here, unlike Claude Code's lazy
  // create-or-resume guess: OpenCode's POST /session always creates a fresh
  // `ses_...` id (confirmed live: it ignores a client-supplied `id` in the
  // body entirely) and takes `directory` as a query param, not a body field
  // — so a client-minted id needs an explicit create call, and the real id
  // it comes back with, before its first /prompt. Returns the real id to
  // use for the rest of this turn.
  async function ensureSession(sessionId, cwd) {
    if (clientToReal.has(sessionId)) return clientToReal.get(sessionId);
    // Already a real id (e.g. the browser is resuming a session it learned
    // about from /sessions, not a freshly client-minted one) — nothing to
    // create.
    if (sessionId.startsWith("ses_")) return sessionId;
    const dir = cwd || cwdRoot;
    const created = await api(`/session?directory=${encodeURIComponent(dir)}`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 10000,
    });
    clientToReal.set(sessionId, created.id);
    realToClient.set(created.id, sessionId);
    return created.id;
  }

  return {
    id: "opencode",

    async runTurn(sessionId, promptText, state) {
      const realId = await ensureSession(sessionId, state.cwd);
      return runTurn(sessionId, realId, promptText, state);
    },

    async abort(sessionId) {
      try {
        await api(`/session/${knownRealId(sessionId)}/abort`, { method: "POST", timeoutMs: 5000 });
      } catch (e) {
        console.error("[opencode] abort failed:", e.message);
      }
    },

    getKnownCommands() {
      // Kicks off the one-time fetch on first call (no-op on every call
      // after) and returns whatever's cached so far — empty defaults until
      // that fetch resolves, then the real list from then on. OpenCode's
      // command list is static per-server (not per-turn like Claude's
      // slash_commands), so there's no need to refresh it from every turn
      // the way the Claude backend does.
      fetchKnownCommandsInBackground();
      return knownCommandsCache || { slash_commands: [], terminal_slash_commands: [], skills: [] };
    },

    cwdForSession(sessionId, fallbackCwd) {
      return fallbackCwd || cwdRoot;
    },

    resolveValidCwd(candidate) {
      // Same boundary rule as the Claude backend (existing dir, root or
      // strict subdirectory) — duplicated rather than shared, since a
      // shared cwd-validation helper would be the first thing worth
      // factoring out if/when multi-project discovery is generalized across
      // backends (explicitly deferred).
      if (!candidate || typeof candidate !== "string") return null;
      if (!existsSync(candidate)) return null;
      try {
        const real = realpathSync(candidate);
        const rootReal = realpathSync(cwdRoot);
        if (real !== rootReal && !real.startsWith(rootReal + nodePath.sep)) return null;
      } catch {
        return null;
      }
      return candidate;
    },

    listProjects() {
      // OpenCode's own /project endpoint is a single entry per directory it
      // has ever been run against — not the same multi-sub-project
      // filesystem scan the Claude backend does. Left minimal (just the
      // root) until multi-project discovery is generalized across backends.
      return { projects: [{ cwd: cwdRoot, label: "(root)" }], root: cwdRoot };
    },

    rescanProjects() {
      return { projects: [{ cwd: cwdRoot, label: "(root)" }], root: cwdRoot, unreachableCount: 0 };
    },

    async listSessions({ includeUnreachable }, sessionsIndex, pendingKindForSession) {
      const raw = await api("/session", { timeoutMs: 8000 });
      const list = (raw || [])
        .filter((s) => !s.parentID) // subtask/child sessions aren't shown as their own top-level entry
        .map((s) => {
          // sessionsIndex/pendingKindForSession are keyed by the client id
          // the driver's own state Map uses, not OpenCode's real ses_...
          // id — translate back via realToClient where a mapping exists
          // (this process created the session), else the real id itself is
          // the only id the browser can have ever used for it (a session
          // pre-existing before this driver started, or from a driver
          // restart that lost the in-memory mapping).
          const clientId = realToClient.get(s.id) || s.id;
          return {
            sessionId: clientId,
            backend: "opencode",
            summary: s.title,
            customTitle: s.title,
            firstPrompt: s.title,
            lastModified: s.time?.updated || s.time?.created || null,
            createdAt: s.time?.created || null,
            cwd: s.directory,
            projectLabel: s.directory === cwdRoot ? "(root)" : s.directory,
            unreachable: false,
            inFlight: !!sessionsIndex.get(clientId)?.turnInFlight,
            pendingKind: pendingKindForSession(clientId),
            archived: !!s.time?.archived,
            // viewer.html's sessions panel filters the "Archived" tab on the
            // Claude-SDK-style `tag` field; OpenCode's archive flag lives in
            // time.archived, so translate it (alongside `archived`, which
            // nothing else reads but is kept for symmetry with claude-code).
            tag: s.time?.archived ? "archived" : null,
          };
        });
      return { sessions: list, unreachableCount: 0, unreachableSessions: includeUnreachable ? [] : undefined };
    },

    async getSessionHistory(sessionId) {
      if (!clientToReal.has(sessionId) && !sessionId.startsWith("ses_")) return [];
      const target = knownRealId(sessionId);
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const raw = await api(`/session/${target}/message`, { timeoutMs: 15000 });
          return convertSessionMessages(raw || []);
        } catch (e) {
          // Same cold-start budget as the provider fetch: a tab can connect
          // while the opencode serve is still binding its port, and a failed
          // history fetch must not look like a genuinely empty session.
          lastErr = e;
          if (attempt < 2) await new Promise((r) => setTimeout(r, 750));
        }
      }
      // No silent blanking: an empty transcript looks identical to a
      // brand-new session to the browser. Log it so a real backend failure
      // is distinguishable from legitimately having no history yet.
      console.error(`[opencode] failed to fetch history for session ${sessionId}:`, lastErr.message);
      throw lastErr;
    },

    async archiveSession(sessionId) {
      await api(`/session/${knownRealId(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ time: { archived: Date.now() } }),
        timeoutMs: 8000,
      });
    },

    async unarchiveSession(sessionId) {
      // Verified against 1.18.29: a PATCH with {time:{archived:0}} persists,
      // and the archived=0 round-trip is falsy for the viewer (!!0 === false),
      // so an unarchived session renders and stays unarchived.
      await api(`/session/${knownRealId(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ time: { archived: 0 } }),
        timeoutMs: 8000,
      });
    },

    async deleteSession(sessionId) {
      const realId = knownRealId(sessionId);
      await api(`/session/${realId}`, { method: "DELETE", timeoutMs: 5000 });
      clientToReal.delete(sessionId);
      realToClient.delete(realId);
    },

    async renameSession(sessionId, title) {
      await api(`/session/${knownRealId(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title }),
        timeoutMs: 5000,
      });
    },

    // ── OpenCode-only extension: agent/mode switching ─────────────────────
    // Confirmed live this session: build has no blanket edit-deny, plan has
    // edit:*->deny (only narrow plan-scratch-file exceptions) — switching a
    // session's agent genuinely changes what it will attempt, sometimes
    // (plan mode) without even a permission round-trip, since the model
    // itself knows its own ruleset and self-censors.
    async listModes() {
      // Current mode isn't reported by /agent — it's tracked per-session by
      // driver.mjs's own state.mode (set on setMode, read in runTurn above),
      // same as the Claude backend has no server-side "current mode" of its
      // own either.
      if (!agentListCache) {
        try {
          agentListCache = await api("/agent", { timeoutMs: 5000 });
        } catch (e) {
          console.error("[opencode] failed to fetch /agent (mode list):", e.message);
          // opencode `serve` can take ~1s to start accepting connections after
          // the container boots (start-viewer.sh launches it and the driver at
          // the same time), so the browser's very first /modes call races that
          // window. Return an empty list rather than rethrow: driver.mjs's
          // /modes route has no try/catch of its own, and an unhandled
          // rejection there kills the whole driver process, taking the viewer
          // down with it. The empty list also leaves viewer.html's modesResolved
          // false so it re-fetches on the next connect/turn_end status event.
          return { available: [] };
        }
      }
      return {
        // mode: "primary" also includes internal agents (compaction/
        // summary/title) used for background bookkeeping, not something a
        // user ever selects — those are the ones flagged `hidden: true`,
        // confirmed against the live /agent response.
        available: agentListCache
          .filter((a) => a.mode === "primary" && !a.hidden)
          .map((a) => ({ id: a.name, label: a.name })),
      };
    },

    async setMode(sessionId, mode) {
      // Best-effort by design: driver.mjs records state.mode (which runTurn
      // actually honors via the per-message `agent` field) regardless of how
      // this resolves, and driver.mjs callers pass a client-minted id with no
      // knownRealId mapping for brand-new sessions — so this throws (404) on
      // exactly the calls where swallowing it is correct. Must never throw
      // out to driver.mjs, or a pre-session set-mode would fail the request.
      try {
        await api(`/api/session/${knownRealId(sessionId)}/agent`, {
          method: "POST",
          body: JSON.stringify({ agent: mode }),
        });
      } catch (e) {
        if (process.env.OPENCODE_DEBUG) {
          console.error("[opencode] setMode best-effort call failed:", e.message);
        }
      }
    },

    // ── Model switching across every configured provider ──────────────────
    // Unlike setMode (a live API call, since agent/mode is a genuine
    // server-side session setting), there's no equivalent "set the
    // session's model" endpoint — the model is chosen fresh per message
    // (see the `model` field built in runTurn above), so setModel is a
    // no-op; driver.mjs's own state.model (set right after this resolves)
    // is what runTurn actually reads on the next message it sends.
    async listModels() {
      // Await the in-flight fetch (with its bounded cold-start retries) so the
      // very first /models call — not just a later one — returns real data.
      // On a server that's genuinely down this resolves empty after the retries
      // exhaust and resets, so the next call tries again from scratch.
      await fetchProviderListInBackground();
      // `current` pre-selects the server's configured default (from
      // /config/providers' `default` map) so the picker reflects what the
      // next message would actually use; driver.mjs overrides this with
      // state.model once the user has made an explicit choice this run.
      return { current: configDefaultModelId, available: modelListCache };
    },

    async setModel() {},
  };
}
