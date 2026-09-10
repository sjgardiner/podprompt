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

  // ── Per-session "which model did this session actually use" ─────────────
  // listModels(sessionId) derives the picker's pre-selected value from the
  // session's own message history (the last assistant entry's
  // info.providerID/info.modelID, composed into the same "providerID/modelID"
  // string the rest of this file uses), rather than always pre-selecting the
  // server-wide configured default. opencode retores a session's context
  // server-side, and /session/{id}/message (already fetched for
  // getSessionHistory) carries the truth for free. Cached per session and
  // dropped whenever that session completes a turn (only a real turn changes
  // the answer), so repeated /models polls don't re-fetch history each time.
  const derivedModelIdCache = new Map(); // input sessionId (client or real) -> "providerID/modelID" | null

  // Best-effort live->history id pairing, kept for this process's lifetime
  // only. A user message broadcast live by this process mints its own random
  // id (userMsgUuid in runTurn), while the same message read back from
  // history is keyed by opencode's real message id (info.id). Recorded when
  // the user echo arrives (onEvent's message.updated, where runTurn's
  // userMsgUuid is in scope) so convertSessionMessages can reuse the LIVE id
  // when re-seeding — letting server.py's exact-triple dedup suppress the
  // duplicate instead of rendering the prompt twice. Strictly best-effort:
  // a miss just falls back to info.id, identical to today's behavior.
  const userBubbleIdByRealId = new Map(); // real message id -> live broadcast uuid

  // Last assistant entry backward until one carries both providerID/modelID —
  // /session/{id}/message can lead with bookkeeping parts or other odd shapes,
  // so scan rather than assume the final entry.
  function lastAssistantModelId(rawMessages) {
    for (let i = (rawMessages || []).length - 1; i >= 0; i--) {
      const info = rawMessages[i]?.info;
      if (info?.role !== "assistant") continue;
      if (info.providerID && info.modelID) return `${info.providerID}/${info.modelID}`;
    }
    return null;
  }

  async function derivedModelIdForSession(sessionId) {
    if (derivedModelIdCache.has(sessionId)) return derivedModelIdCache.get(sessionId);
    let derived = null;
    if (clientToReal.has(sessionId) || sessionId.startsWith("ses_")) {
      const target = knownRealId(sessionId);
      try {
        const raw = await api(`/session/${target}/message`, { timeoutMs: 15000 });
        derived = lastAssistantModelId(raw || []);
      } catch (e) {
        // Session unreachable / no history — no derivation possible; fall back
        // to the server default so the picker still has a sane pre-selection.
        console.error(`[opencode] failed to derive model for session ${sessionId}:`, e.message);
      }
    }
    derivedModelIdCache.set(sessionId, derived);
    return derived;
  }

  // Returns a promise for a /config/providers fetch so listModels() can await
  // it. The listen loop is shared across callers (the cache of a successful
  // one wins; nobody double-fetches). Failure-safe two ways:
  //   1) a transient error (e.g. this fires before a cold `opencode serve`
  //      finishes opening its HTTP server — measured at ~4.1s to answer, and
  //      /config/providers itself gated ~2.6-4s later by the litellm plugin's
  //      live provider discovery; see the driver.mjs process-ownership block)
  //      is retried a couple of times here with a short delay, so a single
  //      /models call — the browser's very first one right after boot — still
  //      comes back with real data instead of an empty cache, and
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
  let sseReconnectDelay = 1000;

  // Called whenever the shared event connection (GET /global/event, see
  // ensureSse) can no longer deliver events — a thrown read error, a clean
  // end-of-stream, or a failed initial connect all land here. `opencode serve`
  // keeps that stream open indefinitely (it emits
  // `server.connected` immediately and a `server.heartbeat` every 10s), so an
  // EOF is never a healthy idle state: it means the stream is gone. A dead
  // stream MUST NOT leave `sseReady` as a resolved promise pointing at
  // nothing — that was the bug where a single dropped connection (serve
  // restart, the respawn gap after a crash, a connection opened during cold
  // start and then closed) silently killed every later turn's streaming,
  // thinking, finalization AND `session.idle` while turn_start/user
  // broadcasts kept working, leaving the browser stuck on "Thinking…" until
  // the 15s grace timeout fired and the turn ended with no response rendered.
  function scheduleSseReconnect(message) {
    if (message) console.error(`[opencode] ${message}`);
    // Real gap closed: a turn in flight when the shared stream dies gets an
    // immediate signal instead of decaying into runTurn's slower 15s grace
    // timeout with the browser sitting on a live typing cursor. Same shape of
    // orphan-cleanup as driver.mjs's expirePendingApprovals — reject each
    // registered waiter now (the reject was captured into the waiter entry by
    // runTurn), let that turn's own try/catch broadcast a clear error
    // promptly, then clear the map so runTurn's finally-block delete()s are
    // harmless no-ops.
    if (turnWaiters.size) {
      const err = new Error("OpenCode SSE connection lost mid-turn; will reconnect");
      for (const [, waiter] of turnWaiters) {
        if (typeof waiter.reject === "function") waiter.reject(err);
      }
      turnWaiters.clear();
    }
    sseReady = null;
    setTimeout(ensureSse, sseReconnectDelay);
    sseReconnectDelay = Math.min(sseReconnectDelay * 2, 10000);
  }

  function ensureSse() {
    if (sseReady) return sseReady;
    sseReady = (async () => {
      try {
        // /event (not /global/event) is scoped to a single directory/"project"
        // instance server-side — empirically confirmed live (and matching
        // upstream reports, e.g. anomalyco/opencode#46733): a session created
        // under the server's own default directory streamed real
        // message.part.*/message.updated events over /event just fine, but an
        // otherwise-identical session created one directory level down
        // (cwdRoot's own subdirectories, e.g. the project the browser's
        // "+ New chat" picker actually lets you choose) got NOTHING but
        // server.connected/server.heartbeat on that same connection — the
        // turn still ran and persisted correctly server-side (confirmed via
        // the plain REST API), it just never reached this process live. Since
        // this one shared connection already has to span every session
        // regardless of which project directory it lives in (driver.mjs
        // dispatches purely by sessionID — see dispatchEvent below — not by
        // directory), /global/event's lack of directory filtering is exactly
        // what's wanted here, not a loss of isolation: an event for a session
        // nobody's turnWaiters currently cover (a different project, or even a
        // session driven by a native `opencode` CLI entirely outside this
        // podprompt instance) is still just silently ignored below, same as
        // today.
        //
        // Accept mirrors what opencode's own SDK sends (application/json,
        // text/event-stream): undici's flat default `*/*` gets a 200 from
        // Effect's stream route, but advertising the event-stream content
        // type removes any negotiation ambiguity across serving layers.
        const res = await fetch(`${BASE}/global/event`, {
          headers: { Accept: "application/json, text/event-stream" },
        });
        if (!res.ok || !res.body) {
          scheduleSseReconnect(`OpenCode /global/event -> ${res.status}, reconnecting`);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        sseReconnectDelay = 1000; // a fresh live connection resets the backoff
        (async function pump() {
          try {
            while (true) {
              const { done, value } = await reader.read();
              // A clean EOF is still a dead connection (see
              // scheduleSseReconnect for why serve's stream never naturally
              // ends) — fall through to the reconnect below rather than
              // treating it as "stream healthy, just idle"; silently
              // poisoning sseReady was exactly the reported bug.
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
            scheduleSseReconnect("OpenCode SSE stream closed (clean EOF), reconnecting");
          } catch (e) {
            scheduleSseReconnect(`OpenCode SSE stream ended unexpectedly, reconnecting: ${e.message}`);
          }
        })();
      } catch (e) {
        // Initial-connect failure (server still cold, port not bound yet):
        // NEVER leave `sseReady` as a rejected promise — every subsequent
        // await ensureSse() would rethrow and kill the turn before any
        // broadcast, user echo included.
        scheduleSseReconnect(`OpenCode SSE connect failed, reconnecting: ${e.message}`);
      }
    })();
    return sseReady;
  }

  function dispatchEvent(evt) {
    // /global/event wraps the actual event under `payload` (with sibling
    // `directory`/`project` fields identifying which project it came from —
    // not needed here since dispatch is purely by sessionID), unlike the
    // single-instance /event endpoint's flat {id, type, properties} shape.
    // Confirmed empirically against a live server: without this unwrap,
    // evt.type/evt.properties are both undefined for every event this
    // connection ever sees, so every event is silently dropped — looks
    // identical to "no events arrived at all" from the dispatch side, but is
    // really just a shape mismatch.
    if (evt && evt.payload && typeof evt.payload === "object") evt = evt.payload;
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
  // captured and inspected by hand). Text is full, never truncated — the
  // viewer caps bubble display (scrollable 400px body) and lets the user
  // hide/collapse tool bubbles entirely.
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
    // `backend` here lets server.py's /status handler seed this session's
    // history from disk (if it hasn't already) before this turn's own
    // broadcasts start landing — see the comment on server.py's turn_start
    // handling for why that has to happen here, not only on a browser's
    // GET /events, and why the backend hint is required.
    broadcastStatus(sessionId, { type: "turn_start", backend: "opencode" });

    // Render-fallback bookkeeping (declared before the user broadcast, which
    // registers its bubble id below). contentDelivered flips true once an
    // actual assistant ANSWER was broadcast (streamed start, or a whole-text
    // reply) — intentionally NOT on thinking/tool bubbles, so that if the
    // answer text never surfaced the POST-response fallback below still runs.
    // emittedIds collects every content bubble id broadcast this turn (user,
    // thinking, assistant, tool) so the fallback can never duplicate
    // something the live path already rendered (message ids there vs part
    // ids here, so this is a belt-and-suspenders guard, not the primary
    // cross-check).
    let contentDelivered = false;
    const emittedIds = new Set();

    const userMsgUuid = randomUUID();
    broadcast(sessionId, "user", promptText, userMsgUuid, null, null);
    emittedIds.add(userMsgUuid);

    // partID -> accumulated text, so message.part.delta's incremental
    // {field, delta} patches can be re-broadcast as the running full text a
    // stream_delta status update needs (mirrors the Claude backend's
    // stream_start/stream_delta shape so the browser's existing live-typing
    // rendering works unmodified for either backend).
    const liveText = new Map(); // partID -> { text, started, type, sentMessage, messageID, model }
    // Track per-assistant-message model from message.updated events
    const messageModelByRealId = new Map(); // info.id -> "providerID/modelID" string

    // opencode re-broadcasts the just-appended USER message as ordinary
    // "type: text" parts over /event (probe-confirmed: message.part.updated
    // with the full prompt text under the user message's id). Those would
    // otherwise be indistinguishable from the assistant's first answer parts
    // and get fabricated into a spurious assistant bubble right after every
    // prompt — the empty-bubble-plus-blinking-cursor bug. message.updated
    // for the user message carries its role + id; parts carry messageID, so
    // matching on that set filters the echoes out exactly.
    const userMessageIDs = new Set(); // message ids originating from the user
    // Part ids of the echoed user text. Delta events carry no messageID, so
    // the delta path can't check userMessageIDs itself — it mirrors that
    // guard via these part ids, captured when part.updated detects the echo.
    const userPartIDs = new Set();
    // When a tool part first reports "running", record its start time so the
    // tool_progress status can carry elapsedSeconds (the browser renders that
    // in its "Running `tool`… (Ns)" indicator; opencode parts don't expose a
    // start timestamp directly). Cleared once the part completes or errors.
    const toolStartedAt = new Map(); // partID -> Date.now()
    // Tools currently mid-run (partID -> tool name), re-broadcast on a 1s
    // ticker while they run. Unlike Claude Code — whose SDK re-emits
    // tool_progress every couple of seconds with a fresh elapsed —
    // opencode sends one part.updated per lifecycle transition, so the
    // browser's "Running … (Ns)" indicator would otherwise freeze at its
    // first (≈0s) value for the whole duration of a long tool call. Driving
    // the re-broadcast client-side from the recorded start time gives the
    // opencode backend the same live tick.
    const runningTools = new Map(); // partID -> tool name
    let toolTicker = null;
    const startToolTicker = () => {
      if (toolTicker) return;
      toolTicker = setInterval(() => {
        for (const [partId, toolName] of runningTools) {
          broadcastStatus(sessionId, {
            type: "tool_progress",
            toolName,
            elapsedSeconds: (Date.now() - toolStartedAt.get(partId)) / 1000,
          });
        }
      }, 1000);
    };
    const stopToolTickerFor = (partId) => {
      runningTools.delete(partId);
      toolStartedAt.delete(partId);
      // Keep the shared ticker alive for any other still-running tool; it's
      // torn down wholesale at turn end (see `finally` below).
    };

    // part.type values that carry a model's chain-of-thought (older opencode
    // calls it "reasoning", newer "thinking"); anything else streaming on a
    // part.delta is the assistant's actual answer.
    const isThinkingPart = (type) => type === "reasoning" || type === "thinking";
    const roleForPartType = (type) => (isThinkingPart(type) ? "thinking" : "assistant");

    // Broadcast a part's accumulated text as its authoritative, final
    // message. The browser treats a broadcast under a part id it saw stream
    // (stream_start/stream_delta) as the finalize signal: it drops the
    // blinking cursor and swaps to the real markdown render. Idempotent via
    // sentMessage so the three completion paths (terminal part.state.status,
    // message.updated.time.completed, and the end-of-turn sweep in runTurn)
    // can all fire against the same part without duplicating the broadcast.
    function finalizeEntry(entry, partId) {
      if (!entry?.started) return;
      // Skip whitespace-only content to prevent empty MODEL bubbles
      if (!entry.text.trim() || entry.sentMessage) return;
      entry.sentMessage = true;
      const model = entry.model || (entry.messageID ? messageModelByRealId.get(entry.messageID) : null);
      broadcast(sessionId, roleForPartType(entry.type), entry.text, partId, null, model);
      emittedIds.add(partId);
      if (roleForPartType(entry.type) === "assistant") contentDelivered = true;
    }

    const pendingApprovalPromises = [];

    function onEvent(evt) {
      if (evt.type === "message.part.updated") {
        const part = evt.properties.part;
        if (!part || !part.id) return;
        if (userMessageIDs.has(part.messageID)) {
          // User-echo part — never render, and remember its part id so the
          // delta path below (which carries no messageID) can't fabricate a
          // phantom assistant bubble out of that part's streamed deltas.
          userPartIDs.add(part.id);
          return;
        }
        const entry = liveText.get(part.id) || { text: "", started: false, type: part.type };
        entry.type = part.type; // needed later by the part.delta path to pick the broadcast role
        entry.text = part.text || entry.text;
        entry.messageID = part.messageID;
        liveText.set(part.id, entry);

        if (part.type === "reasoning" || part.type === "thinking") {
          // Thinking full-text path. opencode's server almost always streams
          // thinking via part.delta (the reasoning part's part.updated shows
          // text:"" at creation) — but when it does carry text on this event
          // (or a reasoning frontend delivers the whole thing at once), this
          // is what surfaces it as a thinking bubble. Deltas keep streaming
          // into the same bubble afterwards (same part.id); the final
          // authoritative text is re-broadcast when the part completes (see
          // finalizeEntry right below) or the turn ends.
          if (entry.text.trim()) broadcast(sessionId, "thinking", entry.text, part.id, null, entry.model);
          if (part.state?.status === "completed" || part.state?.status === "error") finalizeEntry(entry, part.id);
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
            // Skip whitespace-only content to prevent empty MODEL bubbles
            if (entry.text.trim()) {
              entry.started = true;
              entry.sentMessage = true;
              broadcast(sessionId, "assistant", entry.text, part.id);
              emittedIds.add(part.id);
              contentDelivered = true;
            }
            return;
          }
          // Per-part completion: a part whose deltas have all streamed now
          // carries a terminal state. This is the opencode analogue of
          // Claude Code's content_block_stop → message broadcast — it lets
          // the browser drop an assistant bubble's blinking cursor and swap
          // in the authoritative markdown render the moment THIS part
          // finishes, not when the whole (possibly multi-message, tool-
          // interleaved) turn ends. Without it every finished bubble keeps
          // its cursor until turn_end.
          if (part.state?.status === "completed" || part.state?.status === "error") finalizeEntry(entry, part.id);
          return;
        }
        if (part.type === "tool") {
          const status = part.state?.status;
          // Only broadcast a one-liner on completion/error — pending/running
          // are surfaced as ephemeral status only, matching the Claude
          // backend's "one bubble per finished tool call" shape rather than
          // spamming a new bubble per lifecycle transition.
          if (status === "running") {
            if (!toolStartedAt.has(part.id)) toolStartedAt.set(part.id, Date.now());
            runningTools.set(part.id, part.tool);
            broadcastStatus(sessionId, { type: "tool_progress", toolName: part.tool, elapsedSeconds: (Date.now() - toolStartedAt.get(part.id)) / 1000 });
            startToolTicker();
          } else if (status === "completed" || status === "error") {
            stopToolTickerFor(part.id);
            const msgModel = part.messageID ? messageModelByRealId.get(part.messageID) : null;
            broadcast(sessionId, "tool", summarizeToolPart(part), part.id, null, msgModel || null);
            emittedIds.add(part.id);
          }
          return;
        }
        return;
      }

      if (evt.type === "message.part.delta") {
        const { partID, field, delta } = evt.properties;
        if (field !== "text" || !delta) return;
        if (userPartIDs.has(partID)) return; // user-echo part — never render
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
        // Don't open a bubble on pure whitespace: a text part's first delta
        // can be whitespace only ("\n", spaces), and emitting a stream_start
        // there created an empty MODEL bubble the moment the turn began —
        // visible until turn_end and never finalized (finalizeEntry and the
        // end-of-turn sweep both skip whitespace-only text). Accumulate the
        // whitespace silently (a real reply's leading whitespace still shows
        // once the first real token lands) and start broadcasting only once
        // the part actually holds non-whitespace content.
        if (!entry.text.trim()) return; // still whitespace-only — keep accumulating, emit nothing
        if (!entry.started) {
          entry.started = true;
          // Record model for this message (from messageModelByRealId if available)
          const model = entry.messageID ? messageModelByRealId.get(entry.messageID) : null;
          if (model) entry.model = model;
          broadcastStatus(sessionId, { type: "stream_start", id: partID, role: roleForPartType(entry.type), model: model || null });
          if (roleForPartType(entry.type) === "assistant") contentDelivered = true;
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
          // Best-effort pairing so a history re-seed of this same user
          // message reuses the live broadcast's id (see userBubbleIdByRealId).
          userBubbleIdByRealId.set(info.id, userMsgUuid);
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
        // Track model for this message (providerID/modelID composite)
        if (info.id && info.providerID && info.modelID) {
          messageModelByRealId.set(info.id, `${info.providerID}/${info.modelID}`);
        }
        // Per-message completion: the terminal message.updated for an
        // assistant message carries time.completed. In a tool-interleaved
        // turn each assistant message completes in turn, so this finalizes
        // exactly that message's parts the moment they're done — same
        // effect as the terminal part.state.status path above, reached by a
        // different signal for robustness. Idempotent via sentMessage.
        if (info.id && info.time?.completed) {
          for (const [partId, entry] of liveText) {
            if (entry.messageID === info.id) finalizeEntry(entry, partId);
          }
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
        // Held so ensureSse() can reject every in-flight turn the instant the
        // shared stream dies (see the catch in ensureSse) — otherwise a turn
        // whose connection vanished has no signal until runTurn's slower 15s
        // grace timeout below, and the browser sits on a live typing cursor
        // pretending nothing happened.
        reject,
      });
    });
    // The turnWaiter's reject can fire while `done` has no consumer yet — the
    // shared stream dying during the in-flight POST (see scheduleSseReconnect)
    // rejects before runTurn's Promise.race below attaches its handler, and a
    // handler-less rejection is an UNHANDLED rejection at the Node process
    // level, crashing the whole driver despite runTurn's try/catch. Swallow
    // the anticipatory rejection here; the race below still observes the
    // rejection (it reacts to the original `done`), so the fail-fast signal
    // survives unmodified.
    done.catch(() => {});

    try {
      // state.model (set via POST /set-model, see driver.mjs) is a plain
      // "providerID/modelID" composite string — parsed back into the object
      // shape /session/{id}/message actually expects. Omitted entirely if
      // unset or malformed, letting the server fall back to its own
      // default model, same as an unset state.mode already falls back to
      // "build" just below.
      const model = state.model ? parseModelId(state.model) : null;
      const postResult = await api(`/session/${realId}/message`, {
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
      // turn ended. Most parts are now finalized earlier (per-part on
      // terminal state, per-message on completion — see finalizeEntry), so
      // this sweep is a backstop for any part whose completion signal was
      // missed. Broadcast the authoritative full text under the correct
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
        if (entry.started && entry.text.trim() && !entry.sentMessage) {
          const model = entry.model || (entry.messageID ? messageModelByRealId.get(entry.messageID) : null);
          broadcast(sessionId, roleForPartType(entry.type), entry.text, partId, null, model);
          emittedIds.add(partId);
          if (roleForPartType(entry.type) === "assistant") contentDelivered = true;
        }
      }

      // ── Render fallback: trust the POST response when the shared ──
      // event stream stayed silent. If no stream event ever surfaced the
      // assistant answer (the
      // shared SSE stream can die just after the POST resolves, before the
      // reconnect logic in ensureSse gets a chance to run), the browser has
      // only the user bubble and the turn has already ended. The POST
      // response body itself carries the finished message+parts — convert it
      // through the same shape the seeded history uses and broadcast every
      // content entry not already emitted (skipping the user echo). Guarded
      // by contentDelivered so a healthy streamed turn is never re-broadcast
      // as duplicate bubbles. Note: e.ts is the message's time.created in ms,
      // which the browser's formatTs happily renders as a real timestamp.
      if (!contentDelivered && postResult) {
        const raw = Array.isArray(postResult)
          ? postResult
          : postResult.info || postResult.message
            ? postResult.message ? [postResult.message] : [postResult]
            : [];
        for (const e of convertSessionMessages(raw)) {
          if (e.role === "user" || emittedIds.has(e.id)) continue;
          emittedIds.add(e.id);
          broadcast(sessionId, e.role, e.text, e.id, e.ts, e.model);
        }
      }
    } catch (e) {
      console.error(`[opencode] error during turn for session ${sessionId}:`, e.message);
      broadcast(sessionId, "tool", `*(error: ${e.message})*`, randomUUID());
    } finally {
      turnWaiters.delete(realId);
      // A completed turn may have run on a different model (state.model) than
      // the session's last one — drop the cached derivation so the next
      // listModels() re-reads the new final assistant message.
      derivedModelIdCache.delete(sessionId);
      state.turnInFlight = false;
      clearInterval(toolTicker);
      toolTicker = null;
      runningTools.clear();
      toolStartedAt.clear();
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
        body: JSON.stringify({ reply: decision?.allow ? "once" : "reject" }),
        timeoutMs: 5000,
      });
    } catch (e) {
      console.error("[opencode] failed to reply to permission:", e.message);
    }
  }

  async function replyQuestion(requestID, questions, answer) {
    // `answer` is {text, structured} (see driver.mjs's /permission-response).
    // `structured` is a per-question {header, answer} array in the same
    // order as `questions` — `answer` is a string, or an array of strings
    // for a multiSelect question — which is already exactly the shape
    // OpenCode's /question/{id}/reply wants (`answers: [[label,...], ...]`,
    // one array of labels per question), so no parsing needed at all.
    //
    // Falls back to re-deriving it from the joined display string
    // (`text`/`${header}: ${label}; ${header2}: ${label2}`, split on "; "
    // with a header-prefix strip) only if `structured` wasn't sent — kept
    // cheap and harmless as a defensive fallback, but don't rely on it: that
    // old approach is fragile whenever a label or free-typed "Other" answer
    // contains "; " or a colon, which is exactly why `structured` exists now.
    let answers;
    if (Array.isArray(answer?.structured)) {
      answers = questions.map((q, i) => {
        const raw = answer.structured[i]?.answer;
        return Array.isArray(raw) ? raw : [raw ?? ""];
      });
    } else {
      const segments = String(answer?.text ?? "").split("; ");
      answers = questions.map((q, i) => {
        const seg = segments[i] || "";
        const prefix = `${q.header || q.question}: `;
        const label = seg.startsWith(prefix) ? seg.slice(prefix.length) : seg;
        return [label];
      });
    }
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
          // Prefer the live broadcast's id when this message was rendered
          // live this process life (see userBubbleIdByRealId) so server.py's
          // exact-triple dedup suppresses the duplicate; else the real id.
          if (text.trim()) out.push({ role: "user", text, id: userBubbleIdByRealId.get(info.id) || info.id, ts: info.time?.created || null, model: null });
        } else if (info.role === "assistant") {
          const msgModel = (info.providerID && info.modelID) ? `${info.providerID}/${info.modelID}` : null;
          // Reasoning/thinking parts first (each its own bubble, matching the
          // live stream's broadcasts keyed by part.id). This is what keeps
          // thinking bubbles across a server.py/container restart: the
          // browser's in-memory log is wiped on restart and re-seeded from
          // this conversion, so dropping them here was why reasoning only
          // ever appeared live and vanished after a bounce.
          let thinkIdx = 0;
          for (const p of parts) {
            if ((p?.type === "reasoning" || p?.type === "thinking") && p?.text) {
              out.push({ role: "thinking", text: p.text, id: p?.id || `${info.id}-thinking-${thinkIdx++}`, ts: info.time?.created || null, model: msgModel || null });
            }
          }
          const text = extractTextFromParts(parts, "text");
          if (text.trim()) {
            // Prefer the live broadcast's text-part id over info.id: the
            // common single-text-part case then re-seeds the SAME bubble id a
            // live turn minted (live broadcasts assistant bubbles by part.id,
            // see finalizeEntry), and server.py's exact-triple dedup
            // suppresses the duplicate. Multi-text-part messages keep today's
            // one-bubble-per-message rendering (first text part's id).
            const textPart = parts.find((p) => p?.type === "text" && p?.text) || null;
            out.push({ role: "assistant", text, id: textPart?.id || info.id, ts: info.time?.created || null, model: msgModel || null });
          }
          for (const p of parts) {
            if (p?.type === "tool" && (p?.state?.status === "completed" || p?.state?.status === "error")) {
              // Same timestamp source as its sibling assistant/thinking
              // bubbles — without it a tool bubble re-seeded from history
              // (post container restart) rendered with no timestamp while
              // every other role carried one.
              out.push({ role: "tool", text: summarizeToolPart(p), id: p?.id || info.id, ts: info.time?.created || null, model: msgModel || null });
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

  // Same string-based boundary check backends/claude-code.mjs's
  // discoverProjects() uses for its own subproject filter — duplicated
  // rather than shared for the same "not worth a cross-backend helper yet"
  // reason resolveValidCwd's own comment gives.
  function isUnderRoot(candidate, root) {
    return candidate === root || candidate.startsWith(root + nodePath.sep);
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

    // Mirrors Claude Code's own multi-project discovery once framed the same
    // way: "which directories under root have ever had a session," not a
    // filesystem/git scan. Claude Code derives that by scanning its own
    // ~/.claude/projects/*.jsonl for each session's recorded cwd; GET
    // /session already hands back the identical primitive for OpenCode —
    // every session's own `directory` field, the same one listSessions()
    // below already reads — so no new discovery mechanism was actually
    // needed here, just applying the same idea to OpenCode's own data. This
    // used to be left as a permanent root-only stub "until multi-project
    // discovery is generalized across backends" — it turned out OpenCode
    // already exposes the primitive for free, so there was nothing to
    // generalize, just to wire up.
    async listProjects() {
      const fallback = { projects: [{ cwd: cwdRoot, label: "(root)" }], root: cwdRoot };
      let raw;
      try {
        raw = await api("/session", { timeoutMs: 8000 });
      } catch (e) {
        // `opencode serve` unreachable or still on its several-second cold
        // start after a container restart — degrade to the root-only view
        // rather than fail the new-chat picker open entirely; it'll show
        // the real list next time the picker's asked once the server's up.
        console.error("[opencode] listProjects: /session fetch failed, falling back to root-only:", e.message);
        return fallback;
      }
      const dirs = new Set([cwdRoot]); // root always offered, same convention as Claude Code's seeded root
      for (const s of raw || []) {
        if (!s.directory || !isUnderRoot(s.directory, cwdRoot)) continue;
        try {
          // Drop directories that no longer exist on disk — mirrors Claude
          // Code's own reachable/unreachable split for subprojects, just
          // without a distinct "unreachable projects" bucket of its own
          // (out of scope here — nothing offers a dead path either way).
          realpathSync(s.directory);
          dirs.add(s.directory);
        } catch {
          // gone — silently excluded
        }
      }
      return {
        projects: [...dirs].map((cwd) => ({
          cwd,
          label: cwd === cwdRoot ? "(root)" : (nodePath.relative(cwdRoot, cwd) || "(root)"),
        })),
        root: cwdRoot,
      };
    },

    async listSessions({ includeUnreachable }, sessionsIndex, pendingKindForSession) {
      const raw = await api("/session", { timeoutMs: 8000 });
      const list = (raw || [])
        .filter((s) => !s.parentID) // subtask/child sessions aren't shown as their own top-level entry
        // OPENCODE_DATA_DIR is a single, global-per-user host directory (see
        // podprompt.sh), not scoped per project — GET /session can return
        // sessions recorded under a directory with nothing to do with this
        // launch's root at all (an unrelated repo mounted at this same
        // container path on some earlier run). Claude Code's own
        // discoverProjects() already filters exactly this way; this backend
        // never did, so a foreign session could leak straight into the list.
        .filter((s) => s.directory && isUnderRoot(s.directory, cwdRoot))
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
          // A cold `opencode serve` takes ~4.1s before its HTTP server even
          // answers (driver.mjs now spawns and supervises it itself — see the
          // process-ownership block there), so the browser's very first /modes
          // call races that window. Return an empty list rather than rethrow:
          // driver.mjs's /modes route has no try/catch of its own, and an
          // unhandled rejection there kills the whole driver process, taking
          // the viewer down with it. The empty list also leaves viewer.html's
          // modesResolved false so it re-fetches on the next connect/turn_end
          // status event.
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
    async listModels(sessionId) {
      // Await the in-flight fetch (with its bounded cold-start retries) so the
      // very first /models call — not just a later one — returns real data.
      // On a server that's genuinely down this resolves empty after the retries
      // exhaust and resets, so the next call tries again from scratch.
      await fetchProviderListInBackground();
      // `current` used to unconditionally pre-select the server's configured
      // default. Now it prefers this session's own last-used model (derived
      // from /session/{id}/message's final assistant entry — see the comment
      // block by derivedModelIdCache) and only falls back to the configured
      // default when nothing session-specific can be derived (new session, no
      // history yet, or an unreachable one). driver.mjs overrides this with
      // state.model once the user has made an explicit choice this run.
      const derived = sessionId ? await derivedModelIdForSession(sessionId) : null;
      const current = derived || configDefaultModelId || null;
      const currentConfirmed = !!current && modelListCache.some((m) => m.id === current);
      return { available: modelListCache, current, currentConfirmed };
    },

    async setModel() {},
  };
}
