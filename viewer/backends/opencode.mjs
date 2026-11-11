// OpenCode backend.
//
// Drives OpenCode 2 (`@opencode/cli`, exposed in the image as `opencode2`)
// over its HTTP API, against a server driver.mjs spawns and supervises.
//
// WHY THE BINARY HAS A 2 IN IT AND NOTHING ELSE DOES
// --------------------------------------------------
// OpenCode 2 ships as a SEPARATE npm package from the 1.x line (`opencode-ai`)
// with an independent version number, and BOTH declare a bin named `opencode`.
// The image installs 2.x under its own prefix and exposes it as `opencode2` so
// npm never has to arbitrate that collision. That suffix is a packaging
// detail: there is one OpenCode here, and this is it.
//
// It is also worth knowing why the move happened, because the symptom was
// confusing. The 1.x line advertised `delivery: "steer"` -- admitting a
// message into a turn that is ALREADY RUNNING, folded in at the next step
// boundary with nothing aborted -- and silently dropped it. Its model resolver
// only understood the legacy `aisdk` provider descriptors while every active
// model is published against the native `@opencode/ai/providers/*` adapters,
// so no turn ever ran on that path. "We are already on the latest opencode"
// was true of 1.x and said nothing about 2.x.
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
// Isolated by pointing `opencode2 run --server` at this very server, where it
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
// WHAT IS STILL MISSING
// ---------------------
// Sub-agent rosters and slash commands are not wired yet. Those are additive
// and are called out here rather than stubbed silently. Permission prompts
// and questions ARE wired; see the permissions section below.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function createOpenCodeBackend({
  cwdRoot, broadcast, broadcastStatus, broadcastUserPrompt,
  messaging, baseUrl, password, stateFile,
  requestApproval, autoApproveForSession, resolveApprovalExternally,
  // How long a finished turn waits for an outstanding approval reply to land
  // before releasing the session anyway. Settable only so the test can prove
  // the bound exists without sleeping for the real one.
  approvalDrainMs = 30000,
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

  const MAX_SESSION_PAGES = 200;

  async function listAllSessions() {
    const out = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const env = await api(`/api/session${q}`, { timeoutMs: 15000, envelope: true });
      const rows = Array.isArray(env?.data) ? env.data : [];
      let fresh = 0;
      for (const r of rows) {
        if (!r?.id || seen.has(r.id)) continue;
        seen.add(r.id);
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
    console.error(`[opencode] stopped paging the session list after ${MAX_SESSION_PAGES} pages;`
      + ` ${out.length} sessions read and the server still offered more`);
    return out;
  }

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
  async function* sessionEvents(realId, signal) {
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
        if (sid && sid !== realId) continue;
        yield ev;
      }
    }
  }

  // ── turns ────────────────────────────────────────────────────────────────
  async function runTurn(sessionId, promptText, state) {
    state.turnInFlight = true;
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
    let lastEventAt = Date.now();
    const SILENCE_LIMIT_MS = 10 * 60 * 1000;
    const idleWatch = setInterval(() => {
      if (Date.now() - lastEventAt > SILENCE_LIMIT_MS && !ctl.signal.aborted) {
        outcome = { reason: "stalled", error: `no events for ${Math.round(SILENCE_LIMIT_MS / 60000)}m` };
        ctl.abort();
      }
    }, 30000);
    idleWatch.unref?.();

    try {
      const stream = sessionEvents(realId, ctl.signal);
      // The prompt is posted AFTER the stream is open, or the first events of
      // the turn race the subscription and are lost.
      const started = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return api(`/api/session/${realId}/prompt`, { method: "POST", body: { text: promptText } });
      })();
      started.catch((e) => { outcome = { reason: "error", error: e.message }; ctl.abort(); });

      for await (const ev of stream) {
        lastEventAt = Date.now();
        const d = ev.data || {};
        switch (ev.type) {
          case "session.text.started": text.set(d.textID, ""); break;
          case "session.text.delta": text.set(d.textID, (text.get(d.textID) || "") + (d.delta || "")); break;
          case "session.text.ended": {
            const body = d.text ?? text.get(d.textID) ?? "";
            if (body.trim()) broadcast(sessionId, "assistant", body, d.textID || randomUUID(), null, state.model || null);
            text.delete(d.textID);
            break;
          }
          case "session.reasoning.started": reasoning.set(d.reasoningID, ""); break;
          case "session.reasoning.delta":
            reasoning.set(d.reasoningID, (reasoning.get(d.reasoningID) || "") + (d.delta || "")); break;
          case "session.reasoning.ended": {
            const body = d.text ?? reasoning.get(d.reasoningID) ?? "";
            if (body.trim()) broadcast(sessionId, "thinking", body, d.reasoningID || randomUUID(), null, state.model || null);
            reasoning.delete(d.reasoningID);
            break;
          }
          case "session.tool.called":
            broadcast(sessionId, "tool", summarizeTool(d), d.callID || randomUUID(), null, state.model || null);
            break;
          case "session.tool.failed":
            broadcast(sessionId, "tool", `*(${d.tool || "tool"} failed: ${d.error?.message || "unknown"})*`,
              d.callID || randomUUID(), null, state.model || null);
            break;
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
            pendingApprovals.push(
              requestApproval?.(sessionId, "permission", d.action || "unknown",
                { resources: d.resources || [] },
                { canAlwaysAllow: true, externalId: d.id })
                .then((decision) => (decision?.cancelled ? undefined : replyPermission(realId, d.id, decision))),
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
            pendingApprovals.push(
              requestApproval?.(sessionId, "question", "AskUserQuestion",
                { questions: questionsFromForm(form) }, { externalId: form.id })
                .then((answer) => (answer?.cancelled ? undefined : replyForm(realId, form, answer))),
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
          case "session.idle":
          case "session.execution.succeeded":
            // succeeded can arrive before idle; either ends our watch.
            ctl.abort();
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
  // and the event carries location.directory with it. v1 had neither: a bare
  // reply resolved against the server's default directory and silently found
  // nothing, which is why that backend caches a directoryForSession map. That
  // whole class of bug cannot occur here, so nothing models it.
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

  function summarizeTool(d) {
    const name = d.tool || d.name || "tool";
    const input = d.input && typeof d.input === "object" ? d.input : {};
    const first = input.command || input.filePath || input.path || input.pattern || "";
    return first ? `**${name}** \`${String(first).slice(0, 120)}\`` : `**${name}**`;
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
      if (!state?.turnInFlight || typeof text !== "string" || !text) return false;
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

    getKnownCommands() { return []; },

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

    async listProjects() {
      try {
        const rows = await api("/api/project", { timeoutMs: 8000 });
        return (rows || []).map((p) => ({ id: p.id, path: p.directory || p.worktree || "", label: p.name || p.id }));
      } catch { return []; }
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
        // Only sessions PodPrompt drove: anything else is another client's
        // and has no entry in our map.
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
      let rows;
      try {
        rows = await api(`/api/session/${requireRealId(sessionId)}/message`, { timeoutMs: 20000 });
      } catch (e) {
        if (e.status === 404) return [];
        throw e;
      }
      // The server returns NEWEST FIRST; the viewer renders oldest first.
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
        // later version converges on the v1 shape.
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
        for (const p of parts) {
          const ts = info.time?.created || null;
          if (p.type === "text" && p.text?.trim()) {
            out.push({ role: "assistant", text: p.text, id: p.id || randomUUID(), ts, model: modelLabel });
          } else if (p.type === "reasoning" && p.text?.trim()) {
            out.push({ role: "thinking", text: p.text, id: p.id || randomUUID(), ts, model: modelLabel });
          } else if (p.type === "tool") {
            out.push({ role: "tool", text: summarizeTool(p), id: p.id || randomUUID(), ts, model: modelLabel });
          }
        }
      }
      return out;
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

    async listModels() {
      try {
        const rows = await api("/api/model", { timeoutMs: 15000 });
        return (rows || [])
          .filter((m) => m.enabled !== false)
          .map((m) => ({ id: `${m.providerID}/${m.id}`, label: `${m.name || m.id} (${m.providerID})` }));
      } catch (e) {
        console.error("[opencode] listModels failed:", e.message);
        return [];
      }
    },

    async setModel(sessionId, modelId) {
      const [providerID, ...rest] = String(modelId || "").split("/");
      const id = rest.join("/");
      if (!providerID || !id) return { ok: false, reason: "bad-model-id" };
      const realId = await ensureSession(sessionId);
      await api(`/api/session/${realId}/model`, { method: "POST", body: { model: { providerID, id } } });
      return { ok: true };
    },

    // Test seam. The client-id <-> server-id map is the one piece of state
    // this backend cannot recompute (see the header), so losing it loses the
    // session -- worth asserting directly rather than only through behaviour.
    _ids: { toReal, toClient },
  };
}
