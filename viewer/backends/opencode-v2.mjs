// OpenCode v2 backend.
//
// WHAT THIS IS, AND WHY IT IS NOT A VERSION BUMP
// ----------------------------------------------
// OpenCode v2 ships as a SEPARATE npm package (`@opencode/cli`, 2.x) from the
// one backends/opencode.mjs drives (`opencode-ai`, 1.x). Independent release
// lines, different binaries, different APIs; the Dockerfile installs both and
// exposes v2 as `opencode2`. "We are already on the latest opencode" was true
// of 1.x and said nothing about 2.x, which cost most of a session to work out.
//
// The reason to carry a third backend at all is that v2 can execute
// `delivery: "steer"` -- admitting a message into a turn that is ALREADY
// RUNNING, folded in at the next step boundary with nothing aborted and no
// work discarded. 1.19.5 advertises that field and silently drops it: its
// model resolver only understands the legacy `aisdk` provider descriptors
// while every active model is now published against the native
// `@opencode/ai/providers/*` adapters, so no turn ever runs on that path.
//
// WHY THERE IS AN ID MAP HERE, THE SAME AS IN v1
// ----------------------------------------------
// v2's `POST /api/session` ACCEPTS a caller-supplied id, which looked like an
// invitation to drop v1's clientToReal/realToClient bookkeeping and derive one
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
// The change is kept regardless, because it is also simply what v1 does and
// what the API documents: the server owns its ids. Relying on an undocumented
// willingness to accept arbitrary ones was the riskier design even if it
// turns out not to have been the cause.
//
// WHAT IS STILL MISSING
// ---------------------
// Permission prompts, sub-agent rosters and slash commands are not wired yet;
// a v2 session runs with whatever the server's own defaults allow. Those are
// additive and are called out rather than stubbed silently.

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

export function createOpenCodeV2Backend({
  cwdRoot, broadcast, broadcastStatus, broadcastUserPrompt,
  messaging, baseUrl, password, stateFile,
} = {}) {
  const BASE = baseUrl || "http://127.0.0.1:7856";
  // v2 always uses HTTP Basic auth with the username "opencode"; only the
  // password is settable, and `OPENCODE_SERVER_USERNAME` does not exist in the
  // v2 binary at all. If the password is not supplied the server generates a
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
      console.error("[opencode-v2] failed to write the session id map:", e.message);
    }
  }

  function remember(clientId, realId) {
    if (clientToReal.get(clientId) === realId) return;
    clientToReal.set(clientId, realId);
    realToClient.set(realId, clientId);
    saveMap();
  }

  const toV2 = (clientId) => clientToReal.get(clientId) || null;
  const fromV2 = (realId) => realToClient.get(realId) || null;

  loadMap();

  async function api(path, { method = "GET", body, timeoutMs = 30000, raw = false } = {}) {
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
        const err = new Error(`OpenCode v2 ${method} ${path} -> ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      const payload = await res.json().catch(() => null);
      // Every v2 response wraps its result in `data`.
      return payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
    } finally {
      clearTimeout(timer);
    }
  }

  // THE SERVER MINTS THE ID. Never `POST /api/session` with one of ours --
  // see the header: a client-supplied id loses free-model access entirely.
  async function ensureSession(sessionId, { title = null, cwd = null } = {}) {
    const known = toV2(sessionId);
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
    if (!realId) throw new Error("OpenCode v2 created a session with no id");
    remember(sessionId, realId);
    return realId;
  }

  // For the read-only calls: resolve without creating. A session PodPrompt has
  // never driven has no real id yet, and inventing one would both fail and
  // pollute the map.
  function requireRealId(sessionId) {
    const id = toV2(sessionId);
    if (!id) {
      const e = new Error(`OpenCode v2 has no session for ${sessionId}`);
      e.status = 404;
      throw e;
    }
    return id;
  }

  // ── the event stream ─────────────────────────────────────────────────────
  // One long-lived SSE connection per TURN rather than one shared for the
  // process. A turn is the only thing that needs it, the server is local, and
  // a per-turn connection cannot leak events from one turn into another's
  // bubbles -- which is the failure v1 spent real effort on.
  async function* sessionEvents(v2id, signal) {
    const res = await fetch(`${BASE}/api/event`, {
      headers: { Authorization: AUTH, Accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`OpenCode v2 event stream -> ${res.status}`);
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
        const sid = ev?.data?.sessionID;
        if (sid && sid !== v2id) continue;
        yield ev;
      }
    }
  }

  // ── turns ────────────────────────────────────────────────────────────────
  async function runTurn(sessionId, promptText, state) {
    state.turnInFlight = true;
    broadcastStatus(sessionId, { type: "turn_start", backend: "opencode-v2" });
    const v2id = await ensureSession(sessionId, { cwd: state?.cwd, title: state?.title });
    if (state?.model) {
      const [providerID, ...rest] = String(state.model).split("/");
      const id = rest.join("/");
      if (providerID && id) {
        await api(`/api/session/${v2id}/model`, { method: "POST", body: { model: { providerID, id } } })
          .catch((e) => console.error(`[opencode-v2] set-model failed for ${sessionId}:`, e.message));
      }
    }

    const userMsgId = randomUUID();
    broadcastUserPrompt(sessionId, promptText, userMsgId, state.turnOrigin);

    const ctl = new AbortController();
    state.abortController = ctl;
    let outcome = { reason: "completed" };
    // Text and reasoning arrive as deltas keyed by an id; they are accumulated
    // and broadcast on their `ended` event rather than per delta, matching how
    // the viewer already renders v1's parts.
    const text = new Map();
    const reasoning = new Map();

    // A turn is ended by a terminal EVENT. If the server never sends one --
    // it died, the stream wedged, a new event type we do not know about
    // replaced the ones we do -- nothing else would ever end this turn, and
    // the session would be busy forever with no way back. So the watch is
    // also bounded by silence: not by total duration, which would kill
    // legitimate long work, but by how long since anything at all arrived.
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
      const stream = sessionEvents(v2id, ctl.signal);
      // The prompt is posted AFTER the stream is open, or the first events of
      // the turn race the subscription and are lost.
      const started = (async () => {
        await new Promise((r) => setTimeout(r, 50));
        return api(`/api/session/${v2id}/prompt`, { method: "POST", body: { text: promptText } });
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
      state.abortController = null;
      state.turnInFlight = false;
    }
    state.turnOutcome = outcome;
    return outcome;
  }

  function summarizeTool(d) {
    const name = d.tool || d.name || "tool";
    const input = d.input && typeof d.input === "object" ? d.input : {};
    const first = input.command || input.filePath || input.path || input.pattern || "";
    return first ? `**${name}** \`${String(first).slice(0, 120)}\`` : `**${name}**`;
  }

  return {
    id: "opencode-v2",

    async runTurn(sessionId, promptText, state) {
      return runTurn(sessionId, promptText, state);
    },

    abort(sessionId, state) {
      state?.abortController?.abort();
      api(`/api/session/${requireRealId(sessionId)}/interrupt`, { method: "POST", body: {}, timeoutMs: 5000 })
        .catch((e) => console.error(`[opencode-v2] interrupt failed for ${sessionId}:`, e.message));
    },

    // THE REASON THIS BACKEND EXISTS.
    //
    // Hands a message to a turn that is already running. v2 admits it to the
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
        console.error(`[opencode-v2] steer refused for ${sessionId}:`, e.message);
        return false;
      }
    },

    getKnownCommands() { return []; },

    cwdForSession(sessionId, fallbackCwd) { return fallbackCwd || cwdRoot; },

    resolveValidCwd(candidate) {
      if (!candidate) return null;
      const root = cwdRoot || process.cwd();
      const abs = candidate.startsWith("/") ? candidate : `${root}/${candidate}`;
      return abs.startsWith(root) ? abs : null;
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
    // the runtime that owns it. Without it a v2 session becomes unroutable
    // the moment the in-memory state is lost.
    // The driver hands every backend its own live session index and the
    // pending-approval lookup, and both v1 backends use them. Omitting
    // `inFlight` here did not break the listing -- it just made every v2
    // session look permanently idle, to the browser and to anything asking
    // "is this session busy?", which is the question the whole mid-turn
    // delivery path turns on.
    async listSessions(opts, sessionsIndex, pendingKindForSession) {
      const rows = await api("/api/session", { timeoutMs: 15000 });
      const out = [];
      for (const s of rows || []) {
        // Only sessions PodPrompt drove: anything else is another client's
        // and has no entry in our map.
        const clientId = fromV2(s.id);
        if (!clientId) continue;
        const cwd = s.location?.directory || cwdRoot;
        out.push({
          sessionId: clientId,
          backend: "opencode-v2",
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
          archived: !!s.archived,
          tag: s.archived ? "archived" : null,
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
      // v2 returns NEWEST FIRST; the viewer renders oldest first.
      const ordered = [...(rows || [])].reverse();
      const out = [];
      for (const m of ordered) {
        const info = m.info || m;
        const parts = Array.isArray(m.parts) ? m.parts : [];
        const type = m.type || info.role;
        const body = (p) => p.text || "";
        if (type === "user") {
          const t = parts.filter((p) => p.type === "text").map(body).join("\n")
            || (typeof m.payload?.text === "string" ? m.payload.text : "");
          if (t.trim()) out.push({ role: "user", text: t, id: info.id || randomUUID(), ts: info.time?.created || null, model: null });
          continue;
        }
        if (type !== "assistant") continue;
        for (const p of parts) {
          if (p.type === "text" && p.text?.trim()) {
            out.push({ role: "assistant", text: p.text, id: p.id || randomUUID(), ts: null, model: info.modelID || null });
          } else if (p.type === "reasoning" && p.text?.trim()) {
            out.push({ role: "thinking", text: p.text, id: p.id || randomUUID(), ts: null, model: info.modelID || null });
          } else if (p.type === "tool") {
            out.push({ role: "tool", text: summarizeTool(p), id: p.id || randomUUID(), ts: null, model: info.modelID || null });
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
      await api(`/api/session/${requireRealId(sessionId)}`, { method: "DELETE" });
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
        console.error("[opencode-v2] listModels failed:", e.message);
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

    // Test seam: the id encoding is the one piece of state v1 needed and this
    // backend does not, so it is worth asserting directly.
    _ids: { toV2, fromV2 },
  };
}
