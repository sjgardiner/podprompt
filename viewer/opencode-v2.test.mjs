// Unit tests for the OpenCode v2 backend.
//
// Run: node viewer/opencode-v2.test.mjs
//
// Hermetic: a tiny fake v2 server stands in for `opencode2 serve`, so this
// runs without that binary installed and without touching anything live. The
// EVENT FRAMES it replays were captured from a real 2.2.7 server, including
// the failure path, so the parsing is tested against what the server actually
// emits rather than against what the schema suggests it might.
//
// THE BUG THIS CAUGHT, which is why the terminal-event cases are explicit:
// a turn that FAILS emits session.execution.failed and then nothing at all --
// no session.idle ever follows. The first version set the outcome and kept
// waiting for an idle that was never coming, so one failed turn left the
// session busy forever with no way back.

import { createServer } from "node:http";
import { createOpenCodeV2Backend } from "./backends/opencode-v2.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// ── a fake v2 server ───────────────────────────────────────────────────────
const PASSWORD = "testpw";
const state = { sessions: new Map(), prompts: [], events: [], interrupts: [], minted: 1, clientSuppliedIds: [] };

function sse(res, frames) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= frames.length) { clearInterval(timer); return; }
    res.write(`event: message\ndata: ${JSON.stringify(frames[i++])}\n\n`);
  }, 10);
  res.on("close", () => clearInterval(timer));
}

const server = createServer((req, res) => {
  const auth = req.headers.authorization || "";
  const want = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
  if (auth !== want) { res.writeHead(401).end('{"error":"unauthorized"}'); return; }
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    if (p === "/api/event") return sse(res, state.events);
    if (p === "/api/session" && req.method === "POST") {
      // The real server MINTS the id; a client-supplied one loses free-model
      // access entirely (see the backend header). The fake mints too, and
      // records whether anyone tried to supply one.
      if (json.id) state.clientSuppliedIds.push(json.id);
      const id = `ses_${(state.minted++).toString(16).padStart(8, "0")}sv`;
      state.sessions.set(id, { id, title: json.title || null, time: { created: Date.now() } });
      return send(200, { data: state.sessions.get(id) });
    }
    if (p === "/api/session" && req.method === "GET") return send(200, { data: [...state.sessions.values()] });
    const m = p.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
    if (m) {
      const [, sid, rest] = m;
      if (!rest) {
        if (req.method === "GET") {
          return state.sessions.has(sid) ? send(200, { data: state.sessions.get(sid) }) : send(404, { error: "no" });
        }
        return send(200, { data: {} });
      }
      if (rest === "/prompt") { state.prompts.push({ sid, ...json }); return send(200, { data: { id: "msg_1" } }); }
      if (rest === "/interrupt") { state.interrupts.push(sid); return send(200, { data: {} }); }
      if (rest === "/model") return send(204, {});
      if (rest === "/message") return send(200, { data: state.messages || [] });
    }
    if (p === "/api/model") {
      return send(200, { data: [
        { id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true },
        { id: "hidden", providerID: "opencode", name: "Hidden", enabled: false },
      ] });
    }
    if (p === "/api/project") return send(200, { data: [{ id: "p1", directory: "/tmp", name: "tmp" }] });
    return send(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const MAP = "/tmp/pp-oc2-map-test.json";
try { (await import("node:fs")).rmSync(MAP); } catch { /* fine */ }

function make(extra = {}) {
  const bubbles = [];
  const b = createOpenCodeV2Backend({
    cwdRoot: "/tmp", baseUrl: `http://127.0.0.1:${PORT}`, password: PASSWORD,
    broadcast: (s, role, text, id) => bubbles.push({ role, text }),
    broadcastStatus: () => {},
    broadcastUserPrompt: (s, t) => bubbles.push({ role: "user", text: t }),
    ...extra,
  });
  return { b, bubbles };
}

// ── ids: the server mints, we remember ────────────────────────────────────
//
// A session created with a CLIENT-SUPPLIED id cannot use the free models --
// it fails every time with provider.free-limit, while a server-minted one
// succeeds. Reproduced repeatedly against a real server, seconds apart, same
// model and project. So this asserts the thing that was got wrong: we must
// never hand the server an id of our own.
{
  const { b } = make({ stateFile: MAP });
  state.clientSuppliedIds.length = 0;
  const cid = "oc2-map-a";
  check("a fresh client id has no real id yet", b._ids.toV2(cid) === null);

  const real = await b.setModel(cid, "opencode/big-pickle").then(() => b._ids.toV2(cid));
  check("driving a session mints a real id", typeof real === "string" && real.startsWith("ses_"), real);
  check("...and the client NEVER supplies one",
    state.clientSuppliedIds.length === 0, state.clientSuppliedIds);
  check("the map resolves both ways", b._ids.fromV2(real) === cid);
  check("an unknown real id resolves to null", b._ids.fromV2("ses_somebodyelse") === null);

  // Durability: the mapping cannot be recomputed, so losing it loses the
  // session. A second backend over the same file must see it.
  const { b: b2 } = make({ stateFile: MAP });
  check("the map survives a restart", b2._ids.toV2(cid) === real);
}

// ── a successful turn ──────────────────────────────────────────────────────
{
  state.events = [
    { type: "session.execution.started", data: { sessionID: "SID" } },
    { type: "session.reasoning.started", data: { sessionID: "SID", reasoningID: "r1" } },
    { type: "session.reasoning.delta", data: { sessionID: "SID", reasoningID: "r1", delta: "think" } },
    { type: "session.reasoning.ended", data: { sessionID: "SID", reasoningID: "r1" } },
    { type: "session.tool.called", data: { sessionID: "SID", callID: "c1", tool: "bash", input: { command: "echo hi" } } },
    { type: "session.text.started", data: { sessionID: "SID", textID: "t1" } },
    { type: "session.text.delta", data: { sessionID: "SID", textID: "t1", delta: "HEL" } },
    { type: "session.text.delta", data: { sessionID: "SID", textID: "t1", delta: "LO" } },
    { type: "session.text.ended", data: { sessionID: "SID", textID: "t1" } },
    { type: "session.idle", data: { sessionID: "SID" } },
  ];
  const { b, bubbles } = make();
  const sid = "oc2-happy";
  state.events.forEach((e) => { if (e.data) e.data.sessionID = b._ids.toV2(sid); });
  const st = { cwd: "/tmp" };
  const outcome = await b.runTurn(sid, "hello", st);
  check("a completed turn reports completed", outcome.reason === "completed", outcome);
  check("turnInFlight is cleared", st.turnInFlight === false);
  check("the user prompt is broadcast", bubbles.some((x) => x.role === "user" && x.text === "hello"));
  check("assistant deltas are accumulated into one bubble",
    bubbles.some((x) => x.role === "assistant" && x.text === "HELLO"), bubbles);
  check("reasoning becomes a thinking bubble", bubbles.some((x) => x.role === "thinking"));
  check("a tool call is summarised", bubbles.some((x) => x.role === "tool" && /bash/.test(x.text)), bubbles);
}

// ── THE HANG: a failed turn emits no session.idle ──────────────────────────
{
  const { b } = make();
  const sid = "oc2-fail";
  state.events = [
    { type: "session.execution.started", data: { sessionID: b._ids.toV2(sid) } },
    { type: "session.step.failed", data: { sessionID: b._ids.toV2(sid), error: { type: "provider.free-limit", message: "Free usage limit reached." } } },
    { type: "session.execution.failed", data: { sessionID: b._ids.toV2(sid), error: { type: "provider.free-limit", message: "Free usage limit reached." } } },
    // deliberately NO session.idle — this is what the real server does
  ];
  const st = {};
  const outcome = await Promise.race([
    b.runTurn(sid, "x", st),
    new Promise((r) => setTimeout(() => r({ reason: "HUNG" }), 8000)),
  ]);
  check("a failed turn ENDS rather than waiting for an idle that never comes",
    outcome.reason === "error", outcome);
  check("...carrying the server's own message",
    /Free usage limit/.test(outcome.error || ""), outcome.error);
  check("...and releases the session", st.turnInFlight === false);
}

// ── interruption ───────────────────────────────────────────────────────────
{
  const { b } = make();
  const sid = "oc2-int";
  state.events = [
    { type: "session.execution.started", data: { sessionID: b._ids.toV2(sid) } },
    { type: "session.execution.interrupted", data: { sessionID: b._ids.toV2(sid) } },
  ];
  const st = {};
  const outcome = await Promise.race([
    b.runTurn(sid, "x", st),
    new Promise((r) => setTimeout(() => r({ reason: "HUNG" }), 8000)),
  ]);
  check("an interrupted turn reports aborted and ends", outcome.reason === "aborted", outcome);
}

// ── steer: the reason this backend exists ──────────────────────────────────
{
  const { b } = make({ stateFile: MAP });
  const sid = "oc2-steer";
  // A session with a RUNNING turn necessarily has a real id already; mint one
  // the way driving it would.
  await b.setModel(sid, "opencode/big-pickle");
  state.prompts.length = 0;
  check("refused when no turn is running",
    (await b.injectIntoTurn(sid, { turnInFlight: false }, "hi")) === false);
  check("refused on empty text",
    (await b.injectIntoTurn(sid, { turnInFlight: true }, "")) === false);
  check("accepted into a running turn",
    (await b.injectIntoTurn(sid, { turnInFlight: true }, "hi")) === true);
  const last = state.prompts[state.prompts.length - 1];
  check("...posted with delivery \"steer\", not as a fresh prompt",
    last?.delivery === "steer", last);
  check("...to the right session", last?.sid === b._ids.toV2(sid));
  check("a session we have never driven is refused, not invented",
    (await b.injectIntoTurn("oc2-never-seen", { turnInFlight: true }, "hi")) === false);

  // A refusal must be reported, never thrown: the driver re-queues on false,
  // and an exception would escape into the delivery path instead.
  const dead = createOpenCodeV2Backend({
    cwdRoot: "/tmp", baseUrl: "http://127.0.0.1:1", password: "x",
    broadcast() {}, broadcastStatus() {}, broadcastUserPrompt() {},
  });
  check("an unreachable server is a refusal, not a throw",
    (await dead.injectIntoTurn(sid, { turnInFlight: true }, "hi")) === false);
}

// ── listings ───────────────────────────────────────────────────────────────
{
  const { b } = make();
  await b.setModel("oc2-listed", "opencode/big-pickle");
  // THE SHAPE IS THE CONTRACT. gatherAllSessions() does
  // `perBackend.flatMap((r) => r.sessions)`, so returning the array directly
  // yields [undefined] and kills every /sessions poll with an error naming a
  // property rather than a backend. That happened; this pins it.
  const listed = await b.listSessions();
  check("listSessions returns an ENVELOPE, not a bare array",
    !Array.isArray(listed) && Array.isArray(listed.sessions), listed);
  check("...with the unreachable fields gatherAllSessions reduces over",
    typeof listed.unreachableCount === "number" && Array.isArray(listed.unreachableSessions));
  const sessions = listed.sessions;
  check("our own sessions are listed", sessions.some((s) => s.sessionId === "oc2-listed"), sessions);
  check("every row names its backend, or the session becomes unroutable",
    sessions.every((s) => s.backend === "opencode-v2"), sessions.map((s) => s.backend));
  check("sessions belonging to other clients are filtered out",
    sessions.every((s) => typeof s.sessionId === "string" && !s.sessionId.startsWith("ses")));

  const models = await b.listModels();
  check("models are composite provider/model ids",
    models.some((m) => m.id === "opencode/big-pickle"), models);
  check("disabled models are omitted", !models.some((m) => m.id.endsWith("/hidden")), models);

  check("resolveValidCwd keeps paths under the root", b.resolveValidCwd("/tmp/sub") === "/tmp/sub");
  check("...and refuses an escape", b.resolveValidCwd("/etc") === null);
}

// ── history ordering ───────────────────────────────────────────────────────
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc2-hist", "opencode/big-pickle");   // mint its real id
  state.messages = [ // v2 returns NEWEST first
    { type: "assistant", info: { id: "a2", modelID: "m" }, parts: [{ type: "text", text: "second", id: "p2" }] },
    { type: "user", info: { id: "u1" }, parts: [{ type: "text", text: "first" }] },
  ];
  const h = await b.getSessionHistory("oc2-hist");
  check("history for an unknown session is empty, not an error",
    (await b.getSessionHistory("oc2-no-such")).length === 0);
  check("history is re-ordered oldest-first for the viewer",
    h[0]?.text === "first" && h[1]?.text === "second", h.map((x) => x.text));
}

server.close();
console.log(`\nopencode-v2.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
