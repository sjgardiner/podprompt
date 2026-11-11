// Unit tests for the OpenCode backend.
//
// Run: node viewer/opencode.test.mjs
//
// Hermetic: a tiny fake server stands in for `opencode2 serve`, so this
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
import { createOpenCodeBackend } from "./backends/opencode.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

// ── a fake OpenCode server ───────────────────────────────────────────────────────
const PASSWORD = "testpw";
const state = {
  sessions: new Map(), prompts: [], events: [], interrupts: [], minted: 1,
  clientSuppliedIds: [], permissionReplies: [], formReplies: [],
};

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
        if (req.method === "DELETE") {
          if (state.failDeletes) return send(500, { error: "nope" });
          state.sessions.delete(sid);
          return send(200, { data: {} });
        }
        if (req.method === "GET") {
          return state.sessions.has(sid) ? send(200, { data: state.sessions.get(sid) }) : send(404, { error: "no" });
        }
        return send(200, { data: {} });
      }
      if (rest === "/prompt") { state.prompts.push({ sid, ...json }); return send(200, { data: { id: "msg_1" } }); }
      if (rest === "/interrupt") { state.interrupts.push(sid); return send(200, { data: {} }); }
      if (rest === "/model") return send(204, {});
      if (rest === "/message") return send(200, { data: state.messages || [] });
      // Replies are SESSION-scoped in v2. Recording the full path matters:
      // addressing one of these to the wrong session is a 404, and v1's
      // equivalent bug (a reply resolved against the server's default
      // directory) is exactly the class this shape was chosen to avoid.
      let r = rest.match(/^\/permission\/([^/]+)\/reply$/);
      if (r) { state.permissionReplies.push({ sid, id: r[1], body: json }); return send(204, {}); }
      r = rest.match(/^\/form\/([^/]+)\/reply$/);
      if (r) { state.formReplies.push({ sid, id: r[1], body: json }); return send(204, {}); }
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
  const b = createOpenCodeBackend({
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
  check("a fresh client id has no real id yet", b._ids.toReal(cid) === null);

  const real = await b.setModel(cid, "opencode/big-pickle").then(() => b._ids.toReal(cid));
  check("driving a session mints a real id", typeof real === "string" && real.startsWith("ses_"), real);
  check("...and the client NEVER supplies one",
    state.clientSuppliedIds.length === 0, state.clientSuppliedIds);
  check("the map resolves both ways", b._ids.toClient(real) === cid);
  check("an unknown real id resolves to null", b._ids.toClient("ses_somebodyelse") === null);

  // Durability: the mapping cannot be recomputed, so losing it loses the
  // session. A second backend over the same file must see it.
  const { b: b2 } = make({ stateFile: MAP });
  check("the map survives a restart", b2._ids.toReal(cid) === real);
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
  state.events.forEach((e) => { if (e.data) e.data.sessionID = b._ids.toReal(sid); });
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
    { type: "session.execution.started", data: { sessionID: b._ids.toReal(sid) } },
    { type: "session.step.failed", data: { sessionID: b._ids.toReal(sid), error: { type: "provider.free-limit", message: "Free usage limit reached." } } },
    { type: "session.execution.failed", data: { sessionID: b._ids.toReal(sid), error: { type: "provider.free-limit", message: "Free usage limit reached." } } },
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
    { type: "session.execution.started", data: { sessionID: b._ids.toReal(sid) } },
    { type: "session.execution.interrupted", data: { sessionID: b._ids.toReal(sid) } },
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
  check("...to the right session", last?.sid === b._ids.toReal(sid));
  check("a session we have never driven is refused, not invented",
    (await b.injectIntoTurn("oc2-never-seen", { turnInFlight: true }, "hi")) === false);

  // A refusal must be reported, never thrown: the driver re-queues on false,
  // and an exception would escape into the delivery path instead.
  const dead = createOpenCodeBackend({
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
  // The driver passes its live session index and the pending-approval lookup;
  // a backend that ignores them reports every session as idle forever, which
  // silently disables mid-turn delivery for that backend.
  const idx = new Map([["oc2-listed", { turnInFlight: true }]]);
  const listed = await b.listSessions({}, idx, () => "permission");
  check("listSessions returns an ENVELOPE, not a bare array",
    !Array.isArray(listed) && Array.isArray(listed.sessions), listed);
  check("...with the unreachable fields gatherAllSessions reduces over",
    typeof listed.unreachableCount === "number" && Array.isArray(listed.unreachableSessions));
  const sessions = listed.sessions;
  check("our own sessions are listed", sessions.some((s) => s.sessionId === "oc2-listed"), sessions);
  const row = sessions.find((s) => s.sessionId === "oc2-listed");
  check("a busy session is reported as inFlight, or mail can never fold into it",
    row?.inFlight === true, row);
  check("...and a pending approval is reported too", row?.pendingKind === "permission", row);
  check("every row names its backend, or the session becomes unroutable",
    sessions.every((s) => s.backend === "opencode"), sessions.map((s) => s.backend));
  // The rule is "only sessions we have a map entry for", asserted directly.
  // It used to be expressed as "no row's id looks like a server id", which
  // happened to hold and is NOT the rule: a session migrated from the 1.x
  // line keeps the id the server already gave it, so its map entry is the
  // identity and its PodPrompt id is a ses_ id. Asserting the shape would
  // have failed the moment those were made visible again, for a session that
  // is legitimately ours.
  check("sessions belonging to other clients are filtered out",
    sessions.every((s) => b._ids.toReal(s.sessionId) !== null), sessions.map((s) => s.sessionId));
  check("...and a server session we have no entry for never appears",
    !sessions.some((s) => s.sessionId === "ses_somebodyelse"));

  const models = await b.listModels();
  check("models are composite provider/model ids",
    models.some((m) => m.id === "opencode/big-pickle"), models);
  check("disabled models are omitted", !models.some((m) => m.id.endsWith("/hidden")), models);

  check("resolveValidCwd keeps paths under the root", b.resolveValidCwd("/tmp/sub") === "/tmp/sub");
  check("...and refuses an escape", b.resolveValidCwd("/etc") === null);
  check("...the root itself is allowed", b.resolveValidCwd("/tmp") === "/tmp");
  // THE CLASSIC startsWith TRAP, inherited from the backend this replaced
  // and caught by porting its test: "/tmp-other" starts with "/tmp" but is a
  // SIBLING, not a child. A bare prefix comparison accepts it and the
  // session runs in a foreign tree.
  check("a sibling sharing the root's prefix is refused",
    b.resolveValidCwd("/tmp-other/x") === null, b.resolveValidCwd("/tmp-other/x"));
  check("a relative path resolves under the root",
    b.resolveValidCwd("sub/dir") === "/tmp/sub/dir", b.resolveValidCwd("sub/dir"));
}

// ── permissions ────────────────────────────────────────────────────────────
//
// v2 BLOCKS the tool call and emits permission.asked. Before this was wired,
// nothing listened: pending-approvals stayed empty and the turn died minutes
// later with an unexplained tool failure. So the failure this guards against
// is not a crash — it is silence.
//
// The frames are the real 2.2.7 shape: the request is under `data`, and the
// reply vocabulary is "once" | "always" | "reject".
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: true, always: false }) });
  await b.setModel("oc2-perm", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "session.execution.started", data: { sessionID: real } },
    { type: "permission.asked", data: { sessionID: real, id: "per_1", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-perm", "x", {});
  check("a permission ask produces exactly one reply", state.permissionReplies.length === 1, state.permissionReplies);
  check("...addressed to the SESSION that asked", state.permissionReplies[0]?.sid === real, state.permissionReplies[0]);
  check("...naming the request it answers", state.permissionReplies[0]?.id === "per_1");
  check("allow-once maps to the v2 decision \"once\"",
    state.permissionReplies[0]?.body?.decision === "once", state.permissionReplies[0]?.body);
}
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: true, always: true }) });
  await b.setModel("oc2-perm-always", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm-always");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_2", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-perm-always", "x", {});
  check("allow-always widens the scope to \"always\"",
    state.permissionReplies[0]?.body?.decision === "always", state.permissionReplies[0]?.body);
}
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: false }) });
  await b.setModel("oc2-perm-deny", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm-deny");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_3", action: "podprompt-message", resources: ["@x"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-perm-deny", "x", {});
  check("a denial maps to \"reject\"",
    state.permissionReplies[0]?.body?.decision === "reject", state.permissionReplies[0]?.body);
}
{
  // Auto-approve must be consulted by the BACKEND, not the card. It also has
  // to walk up the parent chain, or a delegated session parks on its first
  // gated action and unattended delegation is impossible.
  let asked = 0;
  const { b } = make({
    stateFile: MAP,
    requestApproval: async () => { asked++; return { allow: true }; },
    autoApproveForSession: () => true,
  });
  await b.setModel("oc2-perm-auto", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm-auto");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_4", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-perm-auto", "x", {});
  check("auto-approve answers without raising a card at all", asked === 0, asked);
  check("...and still replies, or the turn stays blocked forever",
    state.permissionReplies[0]?.body?.decision === "once", state.permissionReplies[0]);
}
{
  // A request answered elsewhere (the OpenCode TUI, or the server giving up)
  // must retract our card. Replying to a dead request is what produces a 404.
  // The stub mirrors driver.mjs: the card's promise stays open until
  // resolveApprovalExternally settles it with {cancelled:true}.
  const resolved = [];
  const open = new Map();
  const { b } = make({
    stateFile: MAP,
    requestApproval: (sid, kind, name, input, opts) =>
      new Promise((resolve) => open.set(opts.externalId, resolve)),
    resolveApprovalExternally: (id) => {
      resolved.push(id);
      open.get(id)?.({ cancelled: true });
      return true;
    },
  });
  await b.setModel("oc2-perm-ext", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm-ext");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_5", action: "read", resources: [".env"] } },
    { type: "permission.replied", data: { sessionID: real, id: "per_5" } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  const outcome = await Promise.race([
    b.runTurn("oc2-perm-ext", "x", {}),
    new Promise((r) => setTimeout(() => r({ reason: "HUNG" }), 8000)),
  ]);
  check("an externally-answered request retracts our card", resolved.includes("per_5"), resolved);
  check("...and the turn still ends", outcome.reason !== "HUNG", outcome);
  check("...and we do NOT reply to it again, which is what produced a 404",
    state.permissionReplies.length === 0, state.permissionReplies);
}
{
  // A card nobody ever answers must not keep the session busy forever. A
  // permission blocks the tool call, so reaching the end of a turn with one
  // outstanding means the turn was aborted or stalled underneath it.
  const { b } = make({
    stateFile: MAP,
    requestApproval: () => new Promise(() => {}),   // never settles, ever
    approvalDrainMs: 200,
  });
  await b.setModel("oc2-perm-stuck", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-perm-stuck");
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_6", action: "read", resources: [".env"] } },
    { type: "session.execution.interrupted", data: { sessionID: real } },
  ];
  const st = {};
  const outcome = await Promise.race([
    b.runTurn("oc2-perm-stuck", "x", st),
    new Promise((r) => setTimeout(() => r({ reason: "HUNG" }), 8000)),
  ]);
  check("an unanswered card does not pin the turn open", outcome.reason !== "HUNG", outcome);
  check("...and the session is released, not left busy", st.turnInFlight === false, st);
}

// ── questions (AskUserQuestion) ────────────────────────────────────────────
//
// v2 models a question as a FORM with typed fields, which is a richer shape
// than v1's question event. The viewer card reads Claude's QuestionInfo[],
// so the mapping is asserted in both directions: fields -> card, answer ->
// {answer: {fieldKey: value}}.
{
  const form = {
    sessionID: null, id: "frm_1", title: "Questions",
    metadata: { kind: "question" },
    fields: [{
      key: "q0", title: "Module name", description: "mailbox or inbox?", type: "string",
      options: [
        { value: "mailbox", label: "mailbox", description: "Name it mailbox." },
        { value: "inbox", label: "inbox", description: "Name it inbox." },
      ],
      custom: true,
    }],
  };
  let seenCard = null;
  const { b } = make({
    stateFile: MAP,
    requestApproval: async (sid, kind, toolName, toolInput) => {
      seenCard = { kind, toolName, toolInput };
      return { text: "inbox", structured: [{ header: "Module name", answer: "inbox" }] };
    },
  });
  await b.setModel("oc2-form", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-form");
  form.sessionID = real;
  state.formReplies.length = 0;
  // NESTED, exactly as the server sends it. permission.asked puts its
  // request directly under `data`; a form event wraps it in `data.form`.
  // Reading a form the same way as a permission finds undefined everywhere,
  // the card silently never appears, and the turn blocks on a question
  // nobody was shown — which is what happened, against a real server, with
  // this test passing on an invented flat shape.
  state.events = [
    { type: "form.created", data: { form: { ...form } } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-form", "x", {});
  check("a question form raises a question card, not a permission one",
    seenCard?.kind === "question" && seenCard?.toolName === "AskUserQuestion", seenCard);
  check("the field becomes a question the viewer can render",
    seenCard?.toolInput?.questions?.[0]?.question === "mailbox or inbox?"
    && seenCard?.toolInput?.questions?.[0]?.header === "Module name", seenCard?.toolInput);
  check("...with its options as {label, description}",
    seenCard?.toolInput?.questions?.[0]?.options?.[1]?.label === "inbox", seenCard?.toolInput);
  check("the answer goes back keyed by FIELD KEY, not by index or header",
    state.formReplies[0]?.body?.answer?.q0 === "inbox", state.formReplies[0]?.body);
  check("...to the form that asked", state.formReplies[0]?.id === "frm_1");
}
{
  // Not every form is a question. Answering a non-question form as if it
  // were multiple-choice would write nonsense into it.
  let asked = 0;
  const { b } = make({ stateFile: MAP, requestApproval: async () => { asked++; return {}; } });
  await b.setModel("oc2-form-other", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-form-other");
  state.formReplies.length = 0;
  state.events = [
    { type: "form.created", data: { form: { sessionID: real, id: "frm_2", metadata: { kind: "login" }, fields: [] } } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc2-form-other", "x", {});
  check("a non-question form is left alone", asked === 0 && state.formReplies.length === 0,
    { asked, replies: state.formReplies.length });
}
{
  // A form belonging to a DIFFERENT session must not reach this turn's
  // watch. Its session id is nested too, so filtering only on
  // data.sessionID sees no id at all and lets it through -- which would put
  // one session's question on another session's screen.
  let asked = 0;
  const { b } = make({ stateFile: MAP, requestApproval: async () => { asked++; return {}; } });
  await b.setModel("oc2-form-mine", "opencode/big-pickle");
  const mine = b._ids.toReal("oc2-form-mine");
  state.formReplies.length = 0;
  state.events = [
    { type: "form.created", data: { form: {
      sessionID: "ses_somebodyelse", id: "frm_3", metadata: { kind: "question" },
      fields: [{ key: "q0", title: "T", description: "?", type: "string", options: [] }],
    } } },
    { type: "session.idle", data: { sessionID: mine } },
  ];
  await b.runTurn("oc2-form-mine", "x", {});
  check("another session's question never reaches this one",
    asked === 0 && state.formReplies.length === 0, { asked, replies: state.formReplies.length });
}

// ── deleting a session forgets its id ──────────────────────────────────────
//
// The map is the one piece of state that cannot be recomputed, so it is also
// the one that must not accumulate junk. A deleted session's entry points at
// a 404: the map would grow without bound, and reusing the client id would
// resolve to a dead session instead of creating a live one.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc2-doomed", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-doomed");
  check("the session is mapped before deletion", typeof real === "string");
  await b.deleteSession("oc2-doomed");
  check("the mapping is gone afterwards", b._ids.toReal("oc2-doomed") === null);
  check("...in both directions", b._ids.toClient(real) === null);
  // Durability: the forget must reach disk, or a restart resurrects it.
  const { b: b2 } = make({ stateFile: MAP });
  check("...and the forget survives a restart", b2._ids.toReal("oc2-doomed") === null);
}
{
  // A FAILED delete must NOT forget: the session is still there, and losing
  // the mapping would strand it with no way to address it again.
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc2-keeper", "opencode/big-pickle");
  const real = b._ids.toReal("oc2-keeper");
  state.failDeletes = true;
  let threw = false;
  try { await b.deleteSession("oc2-keeper"); } catch { threw = true; }
  state.failDeletes = false;
  check("a failed delete is reported, not swallowed", threw);
  check("...and the mapping survives it", b._ids.toReal("oc2-keeper") === real);
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

// ── history: the REAL 2.2.7 wire shape ─────────────────────────────────────
// The block above encodes the shape this backend was *written against*, which
// is the v1 shape. A live 2.2.7 server does not send that, and the mismatch is
// silent: every field reads back undefined, so the viewer showed an EMPTY
// transcript for every v2 session rather than a broken one. These rows are
// copied verbatim from a real server, so the assumption cannot drift back.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc2-real", "opencode/big-pickle");
  state.messages = [ // newest first, exactly as the server returns them
    { id: "m4", type: "idle", content: null, time: { created: 40 } },
    { id: "m3", type: "assistant", time: { created: 30 },
      model: { providerID: "alcf-minerva", id: "beam-1.0-bf16" },
      content: [
        { type: "reasoning", text: "thinking out loud", id: "r1" },
        { type: "text", text: "the answer", id: "t1" },
      ] },
    { id: "m2", type: "user", text: "the question", time: { created: 20 } },
    { id: "m1", type: "model-switched", content: null, time: { created: 10 } },
  ];
  const h = await b.getSessionHistory("oc2-real");
  check("a real v2 transcript is not empty (parts live under `content`)",
    h.length === 3, h);
  check("user text is read from the row itself, which has no parts array",
    h[0]?.role === "user" && h[0]?.text === "the question", h[0]);
  check("assistant reasoning becomes a thinking row",
    h[1]?.role === "thinking" && h[1]?.text === "thinking out loud", h[1]);
  check("assistant text becomes an assistant row",
    h[2]?.role === "assistant" && h[2]?.text === "the answer", h[2]);
  check("a {providerID,id} model is labelled provider/id for the viewer",
    h[2]?.model === "alcf-minerva/beam-1.0-bf16", h[2]?.model);
  check("rows carry their timestamp, so the viewer can order and date them",
    h[0]?.ts === 20 && h[2]?.ts === 30, h.map((x) => x.ts));
  check("non-message rows (idle, model-switched) are dropped, not rendered",
    h.every((x) => ["user", "assistant", "thinking", "tool"].includes(x.role)), h.map((x) => x.role));
}

server.close();
console.log(`\nopencode.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
