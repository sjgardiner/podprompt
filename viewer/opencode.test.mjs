// Unit tests for the OpenCode backend.
//
// Run: node viewer/opencode.test.mjs
//
// Hermetic: a tiny fake server stands in for `opencode serve`, so this
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
import { readFileSync } from "node:fs";
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
  clientSuppliedIds: [], permissionReplies: [], formReplies: [], commandDirs: [],
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
    if (p === "/api/session" && req.method === "GET") {
      // PAGED, exactly like the real server: one page of rows plus a cursor
      // SIBLING of `data`. A client that reads only `data` sees page one and
      // cannot tell it from the whole list -- which is the bug this models.
      const all = [...state.sessions.values()];
      const size = state.pageSize || 2;
      const cur = url.searchParams.get("cursor");
      const start = cur ? Number(Buffer.from(cur, "base64").toString()) : 0;
      const page = all.slice(start, start + size);
      const end = start + size;
      state.listCalls = (state.listCalls || 0) + 1;
      // state.stuckCursor models a server that keeps offering a next page
      // without ever advancing -- the shape that spins a paging loop forever.
      const nextAt = state.stuckCursor ? start : end;
      const more = state.stuckCursor ? true : end < all.length;
      return send(200, {
        data: page,
        cursor: { previous: null, next: more ? Buffer.from(String(nextAt)).toString("base64") : null },
      });
    }
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
      if (rest === "/message") {
        // PAGED too, and this is the one that mattered most: a long
        // transcript returned its most recent page and looked whole, so a
        // session appeared to begin in the middle.
        const all = state.messages || [];
        const size = state.msgPageSize || all.length || 1;
        const cur = url.searchParams.get("cursor");
        const start = cur ? Number(Buffer.from(cur, "base64").toString()) : 0;
        const page = all.slice(start, start + size);
        const end = start + size;
        state.msgCalls = (state.msgCalls || 0) + 1;
        return send(200, {
          data: page,
          cursor: { previous: null, next: end < all.length ? Buffer.from(String(end)).toString("base64") : null },
        });
      }
      // Replies are SESSION-scoped. Recording the full path matters:
      // addressing one of these to the wrong session is a 404.
      let r = rest.match(/^\/permission\/([^/]+)\/reply$/);
      if (r) { state.permissionReplies.push({ sid, id: r[1], body: json }); return send(204, {}); }
      r = rest.match(/^\/form\/([^/]+)\/reply$/);
      if (r) { state.formReplies.push({ sid, id: r[1], body: json }); return send(204, {}); }
    }
    if (p === "/api/agent") {
      return send(200, { data: [
        { id: "build", name: "Build", mode: "primary", hidden: false },
        { id: "plan", name: "Plan", mode: "primary", hidden: false },
        { id: "explore", name: "Explore", mode: "subagent", hidden: false },
        { id: "title", name: "Title", mode: "primary", hidden: true },
      ] });
    }
    if (p === "/api/command") {
      state.commandDirs.push(url.searchParams.get("directory"));
      return send(200, { data: [
        { name: "init", description: "setup" },
        { name: "review", description: "review changes" },
      ] });
    }
    if (p === "/api/model/default") {
      return send(200, { data: { id: "default-pick", providerID: "opencode", name: "Default Pick" } });
    }
    if (p === "/api/model") {
      return send(200, { data: [
        { id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true, limit: { context: 200000 } },
        { id: "hidden", providerID: "opencode", name: "Hidden", enabled: false },
        // A provider configured in opencode.jsonc rather than offered by the
        // gateway. Its own `id` says nothing about the provider.
        { id: "beam-1.0-bf16", providerID: "alcf-minerva", name: "Beam 1.0", enabled: true },
      ] });
    }
    if (p === "/api/project") return send(200, { data: [
      // A project's directory is `canonical`. There is no `directory` field;
      // reading one yields an empty path for every row.
      { id: "p1", canonical: "/tmp/sub" },
      { id: "p2", canonical: "/tmp" },                 // the root itself
      { id: "p3", canonical: "/elsewhere/other" },     // outside the root
      { id: "p4", canonical: "/tmp-other/x" },         // sibling, not a child
      { id: "p5", canonical: "/tmp/sub" },             // duplicate
    ] });
    return send(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const MAP = "/tmp/pp-opencode-map-test.json";
try { (await import("node:fs")).rmSync(MAP); } catch { /* fine */ }

function make(extra = {}) {
  const bubbles = [];
  const statuses = [];
  const b = createOpenCodeBackend({
    cwdRoot: "/tmp", baseUrl: `http://127.0.0.1:${PORT}`, password: PASSWORD,
    broadcast: (s, role, text, id) => bubbles.push({ role, text, id }),
    broadcastStatus: (s, st) => statuses.push(st),
    broadcastUserPrompt: (s, t) => bubbles.push({ role: "user", text: t }),
    ...extra,
  });
  return { b, bubbles, statuses };
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
  const cid = "oc-map-a";
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

// ── what the viewer is actually told during a turn ────────────────────────
//
// THE GAP THIS CLOSES. This backend broadcast exactly ONE status type,
// turn_start, while the viewer renders live streaming text, a context bar and
// a spend indicator from three others. None of them ever appeared for an
// OpenCode session, and nothing failed -- the viewer simply had nothing to
// draw. Asserting the SET of types emitted is what turns the next omission
// into a failing test instead of something a user has to notice.
{
  const { b, bubbles, statuses } = make({ stateFile: MAP });
  await b.setModel("oc-stream", "opencode/big-pickle");
  const real = b._ids.toReal("oc-stream");
  state.events = [
    // THE REAL SHAPE. There is no textID: a block is its assistantMessageID
    // plus its ordinal WITHIN that message. Keying on a field that does not
    // exist put every block under `undefined`.
    { type: "session.text.started", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0 } },
    { type: "session.text.delta", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0, delta: "Hel" } },
    { type: "session.text.delta", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0, delta: "lo" } },
    { type: "session.text.ended", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0 } },
    // Reasoning ordinals restart, so this is ALSO ordinal 0 -- the collision
    // that made an answer overwrite the thinking that preceded it.
    { type: "session.reasoning.started", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0 } },
    { type: "session.reasoning.delta", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0, delta: "hmm" } },
    { type: "session.reasoning.ended", data: { sessionID: real, assistantMessageID: "m1", ordinal: 0 } },
    { type: "session.usage.updated", data: { sessionID: real, cost: 0.0123,
      tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 240, write: 0 } } } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-stream", "hi", { model: "opencode/big-pickle" });
  const types = [...new Set(statuses.map((s) => s.type))];

  check("a text block announces itself before any text arrives",
    statuses.some((s) => s.type === "stream_start" && s.role === "assistant"), types);
  const deltas = statuses.filter((s) => s.type === "stream_delta" && s.role === "assistant");
  check("every delta is streamed, not just the finished block",
    deltas.length === 2, deltas.length);
  // THE TRAP: the viewer's handler takes the text SO FAR, not the increment.
  // Sending increments renders "Hel" then "lo" instead of "Hello".
  check("...carrying the text SO FAR, not the increment",
    deltas.map((d) => d.text).join("|") === "Hel|Hello", deltas.map((d) => d.text));
  check("the durable bubble still arrives at the end",
    bubbles.some((x) => x.role === "assistant" && x.text === "Hello"), bubbles);
  const aId = bubbles.find((x) => x.role === "assistant")?.id;
  const tId = bubbles.find((x) => x.role === "thinking")?.id;
  check("...under the SAME id as its stream, so it replaces rather than duplicates",
    aId && statuses.some((s) => s.type === "stream_start" && s.role === "assistant" && s.id === aId), aId);
  // Both blocks are ordinal 0 of the same message; keying on that alone makes
  // the answer land on the thinking's id and replace it in the transcript.
  check("a reasoning block and a text block never share an id",
    aId && tId && aId !== tId, { assistant: aId, thinking: tId });

  check("spend is reported, or the cost indicator never appears",
    statuses.some((s) => s.type === "spend" && s.totalCostUsd === 0.0123), types);
  const ctx = statuses.find((s) => s.type === "context_usage");
  check("context usage is reported", !!ctx, types);
  // Prompt-side only: output and reasoning are generation, and only occupy
  // the window on the NEXT request, where they arrive counted in `input`.
  check("...counting the prompt side, including what came from cache",
    ctx?.totalTokens === 1240, ctx?.totalTokens);
  check("...against the model's real context window",
    ctx?.maxTokens === 200000, ctx?.maxTokens);
  check("...as a percentage the bar can draw",
    Math.abs(ctx.percentage - 0.62) < 0.01, ctx?.percentage);
}
{
  // An unknown context window must draw NO bar rather than one against a
  // guessed denominator.
  const { b, statuses } = make({ stateFile: MAP });
  await b.setModel("oc-nolimit", "opencode/hidden");
  const real = b._ids.toReal("oc-nolimit");
  state.events = [
    { type: "session.usage.updated", data: { sessionID: real, cost: 1,
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-nolimit", "hi", { model: "opencode/no-such-model" });
  check("an unknown context window reports no context usage at all",
    !statuses.some((s) => s.type === "context_usage"), statuses.map((s) => s.type));
  check("...but spend is still reported", statuses.some((s) => s.type === "spend"));
}

// ── commands and modes ────────────────────────────────────────────────────
{
  const { b } = make({ stateFile: MAP });
  await new Promise((r) => setTimeout(r, 120));   // the command fetch is fire-and-forget
  const cmds = b.getKnownCommands();
  check("getKnownCommands returns the contract's shape, not an array",
    !Array.isArray(cmds) && Array.isArray(cmds.slash_commands), cmds);
  check("...with every key the viewer reads",
    "terminal_slash_commands" in cmds && "skills" in cmds, Object.keys(cmds));
  check("...populated from the server", cmds.slash_commands.includes("review"), cmds.slash_commands);
  // Directory-scoped: without one the server answers for ITS default
  // directory and returns nothing, which is indistinguishable from "this
  // backend has no commands".
  check("the command fetch is scoped to the workspace",
    state.commandDirs.includes("/tmp"), state.commandDirs);

  const modes = await b.listModes("oc-modes");
  check("listModes returns {current, available}",
    modes && typeof modes.current === "string" && Array.isArray(modes.available), modes);
  check("only the primary, user-selectable agents are offered",
    modes.available.map((m) => m.id).sort().join(",") === "build,plan",
    modes.available.map((m) => m.id));
  check("...so a subagent-only agent is not offered as a mode",
    !modes.available.some((m) => m.id === "explore"), modes.available);
  check("...and neither is an internal hidden one",
    !modes.available.some((m) => m.id === "title"), modes.available);
}
{
  // THE COLD-START RACE, which is what actually shipped. The backend is
  // constructed in the same tick `opencode serve` is spawned, and the server
  // needs seconds before it accepts connections -- so the first fetch ALWAYS
  // loses. A one-shot filler therefore left the palette empty for the entire
  // life of the process. listModels never showed this because it refetches on
  // every request; a cache with no second chance is a permanent failure.
  const { b: cold } = make({ stateFile: MAP, baseUrl: "http://127.0.0.1:1" });
  await new Promise((r) => setTimeout(r, 120));
  check("a failed first fetch still answers in the contract's shape",
    Array.isArray(cold.getKnownCommands().slash_commands)
    && cold.getKnownCommands().slash_commands.length === 0, cold.getKnownCommands());

  const { b: warm } = make({ stateFile: MAP });
  warm.getKnownCommands();                      // the read that tops it up
  await new Promise((r) => setTimeout(r, 200));
  check("...and a later read recovers it, with no timer and no restart",
    warm.getKnownCommands().slash_commands.includes("review"), warm.getKnownCommands());
}

// ── the project picker ────────────────────────────────────────────────────
//
// THE SHAPE IS THE CONTRACT, for the third time in this backend. viewer.html
// reads data.projects, each row's `cwd` and `label`, and data.root to decide
// which entry means "no cwd at all". Handed a bare array it finds `projects`
// undefined and renders NOTHING -- not even the root, so there is no way to
// start a session in the workspace itself. Reported from a real session.
{
  const { b } = make({ stateFile: MAP });
  const r = await b.listProjects();
  check("listProjects returns an ENVELOPE, not a bare array",
    !Array.isArray(r) && Array.isArray(r.projects), r);
  check("...naming the root, which the picker needs to mean 'no cwd'",
    r.root === "/tmp", r.root);
  check("rows are keyed `cwd`, which is what the picker reads",
    r.projects.every((p) => typeof p.cwd === "string" && p.cwd), r.projects);
  check("the root is always offered, even before anything has run there",
    r.projects.some((p) => p.cwd === "/tmp" && p.label === "(root)"), r.projects);
  check("...exactly once, not duplicated by the server's own row for it",
    r.projects.filter((p) => p.cwd === "/tmp").length === 1, r.projects);
  check("a subdirectory is labelled relative to the root",
    r.projects.some((p) => p.cwd === "/tmp/sub" && p.label === "sub"), r.projects);
  check("duplicates are collapsed", r.projects.filter((p) => p.cwd === "/tmp/sub").length === 1);
  check("a directory outside the root is not offered",
    !r.projects.some((p) => p.cwd === "/elsewhere/other"), r.projects);
  // The startsWith trap again, in a second place.
  check("a sibling sharing the root's prefix is not offered",
    !r.projects.some((p) => p.cwd === "/tmp-other/x"), r.projects);
}
{
  // An unreachable server must still offer the root, or a cold start leaves
  // the picker empty and nothing can be created at all.
  const { b } = make({ stateFile: MAP, baseUrl: "http://127.0.0.1:1" });
  const r = await b.listProjects();
  check("an unreachable server still offers the root",
    r.projects.length === 1 && r.projects[0].cwd === "/tmp", r);
}

// ── the driver's sender translation ───────────────────────────────────────
//
// THE BUG THIS GUARDS, which cost a working feature silently. A plugin tool
// handler is given ctx.sessionID by OpenCode's runtime -- the id the SERVER
// minted. The driver files everything under the CLIENT id. So every tool call
// arrives claiming to come from a session the driver has never heard of, and
// podSessionIdFor() in driver.mjs translates it back through exactly this
// method.
//
// It was missing. The translation fell through to the raw id, the sender
// resolved to nothing, and mail or delegation sent FROM an OpenCode session
// failed with "no-session" -- wording that reads as a problem with the
// RECIPIENT. list_sessions kept working the whole time, because listing peers
// never needs to know who is asking, which made the gap look narrower than it
// was.
//
// Asserted against driver.mjs's actual call site, not just the method's
// existence: a renamed method here is the same outage.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-whoami", "opencode/big-pickle");
  const real = b._ids.toReal("oc-whoami");
  check("the backend can translate a server id back to ours",
    typeof b.clientIdForReal === "function");
  check("...and it round-trips", b.clientIdForReal(real) === "oc-whoami", b.clientIdForReal?.(real));
  check("an id we never minted translates to nothing, not to itself",
    b.clientIdForReal("ses_somebodyelse") === null, b.clientIdForReal?.("ses_somebodyelse"));

  const drv = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
  check("the driver still translates an incoming sender through this method",
    /clientIdForReal\?\.\(/.test(drv));
  check("...and every tool-facing route resolves `from` through that translator",
    (drv.match(/podSessionIdFor\(body\.from\)/g) || []).length >= 2,
    (drv.match(/podSessionIdFor\(body\.from\)/g) || []).length);
}

// ── a successful turn ──────────────────────────────────────────────────────
{
  // THESE FIELD NAMES ARE MEASURED, not guessed. An earlier version of this
  // fixture used textID/reasoningID/callID/tool -- none of which the server
  // sends -- and it PASSED, because every missing field degraded into the
  // same fallback. Fixtures that invent their subject cannot catch anything.
  // Captured from 2.2.7: a block is message+ordinal, a tool call is `id`,
  // and the tool's NAME arrives only on input.started.
  const MSG = "msg_1cc7685ca001zOiaMpw6kJI4vQ";
  state.events = [
    { type: "session.execution.started", data: { sessionID: "SID" } },
    { type: "session.reasoning.started", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0 } },
    { type: "session.reasoning.delta", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0, delta: "think" } },
    { type: "session.reasoning.ended", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0, text: "think" } },
    { type: "session.tool.input.started", data: { sessionID: "SID", id: "chatcmpl-tool-1", name: "shell" } },
    { type: "session.tool.called", data: { sessionID: "SID", id: "chatcmpl-tool-1", input: { command: "echo hi" } } },
    { type: "session.text.started", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0 } },
    { type: "session.text.delta", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0, delta: "HEL" } },
    { type: "session.text.delta", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0, delta: "LO" } },
    { type: "session.text.ended", data: { sessionID: "SID", assistantMessageID: MSG, ordinal: 0, text: "HELLO" } },
    { type: "session.idle", data: { sessionID: "SID" } },
  ];
  const { b, bubbles } = make();
  const sid = "oc-happy";
  state.events.forEach((e) => { if (e.data) e.data.sessionID = b._ids.toReal(sid); });
  const st = { cwd: "/tmp" };
  const outcome = await b.runTurn(sid, "hello", st);
  check("a completed turn reports completed", outcome.reason === "completed", outcome);
  check("turnInFlight is cleared", st.turnInFlight === false);
  check("the user prompt is broadcast", bubbles.some((x) => x.role === "user" && x.text === "hello"));
  check("assistant deltas are accumulated into one bubble",
    bubbles.some((x) => x.role === "assistant" && x.text === "HELLO"), bubbles);
  check("reasoning becomes a thinking bubble", bubbles.some((x) => x.role === "thinking"));
  // The NAME is the assertion. It arrives on input.started and nowhere else,
  // so a bubble that finds it proves the carry-forward works; before that
  // every OpenCode tool bubble in the viewer read "**tool**".
  check("a tool call is summarised BY NAME",
    bubbles.some((x) => x.role === "tool" && /\*\*shell\*\*/.test(x.text)), bubbles);
  check("...and keeps the call id the stored part will also carry",
    bubbles.some((x) => x.role === "tool" && x.id === "chatcmpl-tool-1"), bubbles);
  // Reasoning and text are BOTH ordinal 0 of the same message. Without the
  // kind in the key the answer lands on the thinking block's id and replaces
  // it, so this pins that they stay two bubbles.
  check("reasoning and text at the same ordinal stay distinct bubbles",
    new Set(bubbles.filter((x) => x.id).map((x) => x.id)).size
      === bubbles.filter((x) => x.id).length, bubbles.map((x) => x.id));
}

// ── THE HANG: a failed turn emits no session.idle ──────────────────────────
{
  const { b } = make();
  const sid = "oc-fail";
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
  const sid = "oc-int";
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
  const sid = "oc-steer";
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
    (await b.injectIntoTurn("oc-never-seen", { turnInFlight: true }, "hi")) === false);

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
  await b.setModel("oc-listed", "opencode/big-pickle");
  // THE SHAPE IS THE CONTRACT. gatherAllSessions() does
  // `perBackend.flatMap((r) => r.sessions)`, so returning the array directly
  // yields [undefined] and kills every /sessions poll with an error naming a
  // property rather than a backend. That happened; this pins it.
  // The driver passes its live session index and the pending-approval lookup;
  // a backend that ignores them reports every session as idle forever, which
  // silently disables mid-turn delivery for that backend.
  const idx = new Map([["oc-listed", { turnInFlight: true }]]);
  const listed = await b.listSessions({}, idx, () => "permission");
  check("listSessions returns an ENVELOPE, not a bare array",
    !Array.isArray(listed) && Array.isArray(listed.sessions), listed);
  check("...with the unreachable fields gatherAllSessions reduces over",
    typeof listed.unreachableCount === "number" && Array.isArray(listed.unreachableSessions));
  const sessions = listed.sessions;
  check("our own sessions are listed", sessions.some((s) => s.sessionId === "oc-listed"), sessions);
  const row = sessions.find((s) => s.sessionId === "oc-listed");
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
}

// ── the session list is PAGED ──────────────────────────────────────────────
//
// GET /api/session returns ONE page plus a cursor in a sibling of `data`. It
// reports no total and no error for the rows it withheld, so a single call is
// indistinguishable from a complete list. That is exactly how sessions
// carried over from the 1.x line stayed invisible: they were older than the
// most recent page, and nothing said so.
//
// A bigger `limit` is NOT the fix -- it raises the cliff and leaves it there.
{
  const { b } = make({ stateFile: MAP });
  // Enough sessions to need several pages at the fake server's page size.
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const cid = `oc-page-${i}`;
    await b.setModel(cid, "opencode/big-pickle");
    ids.push(cid);
  }
  state.pageSize = 2;
  state.listCalls = 0;
  const { sessions } = await b.listSessions({}, new Map(), () => null);
  check("every page is followed, not just the first",
    ids.every((id) => sessions.some((s) => s.sessionId === id)),
    { want: ids.length, got: sessions.length });
  check("...which takes more than one request", state.listCalls > 1, state.listCalls);
  check("no session is listed twice", new Set(sessions.map((s) => s.sessionId)).size === sessions.length);
}
{
  // A cursor that never advances must not spin. The guard is "a page that
  // added nothing new ends the walk" -- without it this hangs until the page
  // cap, re-fetching the same rows every time.
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-stuck-page", "opencode/big-pickle");
  state.pageSize = 2;
  state.stuckCursor = true;
  state.listCalls = 0;
  const done = await Promise.race([
    b.listSessions({}, new Map(), () => null).then(() => "returned"),
    new Promise((r) => setTimeout(() => r("HUNG"), 8000)),
  ]);
  state.stuckCursor = false;
  check("a cursor that never advances ends the walk", done === "returned", done);
  check("...without grinding through every allowed page", state.listCalls < 10, state.listCalls);
}

// ── archived state ─────────────────────────────────────────────────────────
//
// Reported as a TIMESTAMP at time.archived, not a boolean at `archived`.
// Reading the wrong field made the flag permanently false, which stayed
// invisible only while the un-paged list happened to contain almost no
// archived sessions. Paging surfaces all of them.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-arch", "opencode/big-pickle");
  const real = b._ids.toReal("oc-arch");
  state.sessions.get(real).time.archived = 1794358597744;
  state.pageSize = 50;
  const { sessions } = await b.listSessions({}, new Map(), () => null);
  const row = sessions.find((s) => s.sessionId === "oc-arch");
  check("an archived session is reported as archived", row?.archived === true, row);
  check("...and tagged for the panel", row?.tag === "archived", row?.tag);
  const live = sessions.find((s) => s.sessionId === "oc-page-0");
  check("...while a live one is not", live?.archived === false && live?.tag === null, live);

  // THE SHAPE IS THE CONTRACT, and asserting only the contents missed that.
  // viewer.html reads data.available and data.current. Handed a bare array it
  // finds neither and renders NO OPTIONS -- the model picker just is not
  // there, with no error, because an array is perfectly good JSON. A session
  // then silently runs on the server's default, which is the one outcome the
  // picker exists to prevent. Reported from a real session.
  const models = await b.listModels();
  check("listModels returns an ENVELOPE, not a bare array",
    !Array.isArray(models) && Array.isArray(models.available), models);
  check("...with the current model the viewer preselects",
    "current" in models, Object.keys(models));
  check("...which is what the server will actually use by default",
    models.current === "opencode/default-pick", models.current);
  check("models are composite provider/model ids",
    models.available.some((m) => m.id === "opencode/big-pickle"), models.available);
  check("disabled models are omitted",
    !models.available.some((m) => m.id.endsWith("/hidden")), models.available);
  // A model from a provider configured in opencode.jsonc (ALCF, a local
  // llama server) must be offered too -- the id is only unique as the
  // provider/model PAIR, and reading the bare `id` makes custom providers
  // look absent when they are not.
  check("a custom provider's models are offered as well",
    models.available.some((m) => m.id === "alcf-minerva/beam-1.0-bf16"), models.available);

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
// OpenCode BLOCKS the tool call and emits permission.asked. Before this was wired,
// nothing listened: pending-approvals stayed empty and the turn died minutes
// later with an unexplained tool failure. So the failure this guards against
// is not a crash — it is silence.
//
// The frames are the real 2.2.7 shape: the request is under `data`, and the
// reply vocabulary is "once" | "always" | "reject".
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: true, always: false }) });
  await b.setModel("oc-perm", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "session.execution.started", data: { sessionID: real } },
    { type: "permission.asked", data: { sessionID: real, id: "per_1", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-perm", "x", {});
  check("a permission ask produces exactly one reply", state.permissionReplies.length === 1, state.permissionReplies);
  check("...addressed to the SESSION that asked", state.permissionReplies[0]?.sid === real, state.permissionReplies[0]);
  check("...naming the request it answers", state.permissionReplies[0]?.id === "per_1");
  check("allow-once maps to the decision \"once\"",
    state.permissionReplies[0]?.body?.decision === "once", state.permissionReplies[0]?.body);
}
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: true, always: true }) });
  await b.setModel("oc-perm-always", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm-always");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_2", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-perm-always", "x", {});
  check("allow-always widens the scope to \"always\"",
    state.permissionReplies[0]?.body?.decision === "always", state.permissionReplies[0]?.body);
}
{
  const { b } = make({ stateFile: MAP, requestApproval: async () => ({ allow: false }) });
  await b.setModel("oc-perm-deny", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm-deny");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_3", action: "podprompt-message", resources: ["@x"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-perm-deny", "x", {});
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
  await b.setModel("oc-perm-auto", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm-auto");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_4", action: "read", resources: [".env"] } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-perm-auto", "x", {});
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
  await b.setModel("oc-perm-ext", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm-ext");
  state.permissionReplies.length = 0;
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_5", action: "read", resources: [".env"] } },
    { type: "permission.replied", data: { sessionID: real, id: "per_5" } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  const outcome = await Promise.race([
    b.runTurn("oc-perm-ext", "x", {}),
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
  await b.setModel("oc-perm-stuck", "opencode/big-pickle");
  const real = b._ids.toReal("oc-perm-stuck");
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_6", action: "read", resources: [".env"] } },
    { type: "session.execution.interrupted", data: { sessionID: real } },
  ];
  const st = {};
  const outcome = await Promise.race([
    b.runTurn("oc-perm-stuck", "x", st),
    new Promise((r) => setTimeout(() => r({ reason: "HUNG" }), 8000)),
  ]);
  check("an unanswered card does not pin the turn open", outcome.reason !== "HUNG", outcome);
  check("...and the session is released, not left busy", st.turnInFlight === false, st);
}

// ── a turn parked on a human is not a stalled turn ────────────────────────
//
// A permission BLOCKS the tool call and the server then emits nothing at all,
// so the silence watchdog cannot tell "waiting for you" from "wedged".
// Without an exemption, walking away from a card for ten minutes killed the
// work that was waiting for the answer -- the opposite of what the card is
// for. Proven with a watchdog shortened to the point where any unexempted
// wait would trip it several times over.
{
  let release;
  const { b } = make({
    stateFile: MAP,
    requestApproval: () => new Promise((r) => { release = r; }),
    silenceLimitMs: 300,
  });
  await b.setModel("oc-park", "opencode/big-pickle");
  const real = b._ids.toReal("oc-park");
  state.events = [
    { type: "permission.asked", data: { sessionID: real, id: "per_park", action: "read", resources: [".env"] } },
  ];
  let settled = null;
  const turn = b.runTurn("oc-park", "x", {}).then((o) => { settled = o; return o; });
  // Four times the watchdog. An unexempted turn is long dead by now; the
  // exempted one is still sitting on the card, which is the whole point.
  await new Promise((r) => setTimeout(r, 1200));
  check("a turn waiting on a card is still alive well past the stall limit",
    settled === null, settled);
  release({ allow: true });
  await Promise.race([turn, new Promise((r) => setTimeout(r, 3000))]);
  // Once the human HAS answered, the exemption lifts -- a turn that then goes
  // quiet is genuinely wedged and must still be reaped.
  check("...and the watchdog resumes once the answer is in",
    settled === null || settled.reason === "stalled", settled);
}

// ── questions (AskUserQuestion) ────────────────────────────────────────────
//
// A question is modelled as a FORM with typed fields. The viewer card reads
// Claude's QuestionInfo[],
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
  await b.setModel("oc-form", "opencode/big-pickle");
  const real = b._ids.toReal("oc-form");
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
  await b.runTurn("oc-form", "x", {});
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
  await b.setModel("oc-form-other", "opencode/big-pickle");
  const real = b._ids.toReal("oc-form-other");
  state.formReplies.length = 0;
  state.events = [
    { type: "form.created", data: { form: { sessionID: real, id: "frm_2", metadata: { kind: "login" }, fields: [] } } },
    { type: "session.idle", data: { sessionID: real } },
  ];
  await b.runTurn("oc-form-other", "x", {});
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
  await b.setModel("oc-form-mine", "opencode/big-pickle");
  const mine = b._ids.toReal("oc-form-mine");
  state.formReplies.length = 0;
  state.events = [
    { type: "form.created", data: { form: {
      sessionID: "ses_somebodyelse", id: "frm_3", metadata: { kind: "question" },
      fields: [{ key: "q0", title: "T", description: "?", type: "string", options: [] }],
    } } },
    { type: "session.idle", data: { sessionID: mine } },
  ];
  await b.runTurn("oc-form-mine", "x", {});
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
  await b.setModel("oc-doomed", "opencode/big-pickle");
  const real = b._ids.toReal("oc-doomed");
  check("the session is mapped before deletion", typeof real === "string");
  await b.deleteSession("oc-doomed");
  check("the mapping is gone afterwards", b._ids.toReal("oc-doomed") === null);
  check("...in both directions", b._ids.toClient(real) === null);
  // Durability: the forget must reach disk, or a restart resurrects it.
  const { b: b2 } = make({ stateFile: MAP });
  check("...and the forget survives a restart", b2._ids.toReal("oc-doomed") === null);
}
{
  // A FAILED delete must NOT forget: the session is still there, and losing
  // the mapping would strand it with no way to address it again.
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-keeper", "opencode/big-pickle");
  const real = b._ids.toReal("oc-keeper");
  state.failDeletes = true;
  let threw = false;
  try { await b.deleteSession("oc-keeper"); } catch { threw = true; }
  state.failDeletes = false;
  check("a failed delete is reported, not swallowed", threw);
  check("...and the mapping survives it", b._ids.toReal("oc-keeper") === real);
}

// ── history ordering ───────────────────────────────────────────────────────
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-hist", "opencode/big-pickle");   // mint its real id
  state.messages = [ // the server returns NEWEST first
    { type: "assistant", info: { id: "a2", modelID: "m" }, parts: [{ type: "text", text: "second", id: "p2" }] },
    { type: "user", info: { id: "u1" }, parts: [{ type: "text", text: "first" }] },
  ];
  const h = await b.getSessionHistory("oc-hist");
  check("history for an unknown session is empty, not an error",
    (await b.getSessionHistory("oc-no-such")).length === 0);
  check("history is re-ordered oldest-first for the viewer",
    h[0]?.text === "first" && h[1]?.text === "second", h.map((x) => x.text));
}

// ── history: the REAL 2.2.7 wire shape ─────────────────────────────────────
// The block above encodes the shape this backend was *written against*, which
// is the shape this backend was first written against. A live server does not
// send that, and the mismatch is
// silent: every field reads back undefined, so the viewer showed an EMPTY
// transcript for every session rather than a broken one. These rows are
// copied verbatim from a real server, so the assumption cannot drift back.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-real", "opencode/big-pickle");
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
  const h = await b.getSessionHistory("oc-real");
  check("a real transcript is not empty (parts live under `content`)",
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

// ── a transcript is PAGED, and the whole of it has to be read ──────────────
//
// The worst instance of the cursor bug. /message returns the most recent page
// -- 50 messages -- and says nothing about the rest, so a long session
// rendered as though it began in the middle. Measured against a real server:
// 50 of 374.
//
// Ordering is the subtle half. Pages run NEWEST first and cursor.next walks
// further BACK, so the pages concatenate newest-to-oldest and ONE reverse at
// the end is correct. Reversing per page would interleave them.
{
  const { b } = make({ stateFile: MAP });
  await b.setModel("oc-long", "opencode/big-pickle");
  // 9 user messages, newest first, as the server would hand them over.
  state.messages = [];
  for (let i = 9; i >= 1; i--) {
    state.messages.push({ id: `m${i}`, type: "user", text: `msg ${i}`, time: { created: i * 100 } });
  }
  state.msgPageSize = 2;
  state.msgCalls = 0;
  const h = await b.getSessionHistory("oc-long");
  check("the whole transcript is read, not just the first page",
    h.length === 9, { got: h.length, want: 9, calls: state.msgCalls });
  check("...which takes more than one request", state.msgCalls > 1, state.msgCalls);
  check("the session begins at its REAL beginning",
    h[0]?.text === "msg 1", h[0]?.text);
  check("...and ends at its real end", h[h.length - 1]?.text === "msg 9", h[h.length - 1]?.text);
  check("every message appears exactly once",
    new Set(h.map((x) => x.text)).size === h.length);
  const ts = h.map((x) => x.ts);
  check("timestamps run oldest-first across page boundaries",
    ts.every((v, i) => i === 0 || v >= ts[i - 1]), ts);
  state.msgPageSize = 0;
}

// ── the sub-agent roster ───────────────────────────────────────────────────
//
// A sub-agent on this backend is a REAL session: its own id, its own
// transcript, its own events on the server-wide stream. Everything here
// turns on that, and on the one thing it is NOT -- a session the user
// addresses. The two questions are separate, and conflating them is what
// put eleven sub-agent children into the session picker and the peer list
// as though they were independent chats.
{
  const PARENT = "ses_PARENT", CHILD = "ses_CHILD", TOOLCALL = "chatcmpl-tool-sub";
  const registered = [];
  const subAgentPatches = [];
  const { b, bubbles } = make({
    registerChild: (id, info) => registered.push({ id, ...info }),
    updateSubAgent: (id, patch) => subAgentPatches.push({ id, ...patch }),
  });
  const sid = "oc-parent";
  await b.setModel(sid, "opencode/big-pickle");
  const realParent = b._ids.toReal(sid) || PARENT;
  state.messages = [
    { id: "cm2", type: "assistant", content: [{ type: "text", text: "KUMQUAT" }],
      model: { providerID: "alcf-minerva", id: "beam-1.0-bf16" }, time: { created: 2 } },
    { id: "cm1", type: "user", text: "do the thing", time: { created: 1 } },
  ];
  state.events = [
    { type: "session.execution.started", data: { sessionID: realParent } },
    { type: "session.tool.input.started", data: { sessionID: realParent, id: TOOLCALL, name: "subagent" } },
    { type: "session.tool.called", data: { sessionID: realParent, id: TOOLCALL, input: { agent: "explore", description: "Find the thing" } } },
    // The child announces itself. Nothing before this names it.
    { type: "session.created", data: { sessionID: CHILD, parentID: realParent, title: "Find the thing", agent: "explore" } },
    { type: "session.tool.progress", data: { sessionID: realParent, id: TOOLCALL, metadata: { sessionID: CHILD, status: "running" } } },
    // ...and then works under ITS OWN id.
    { type: "session.tool.input.started", data: { sessionID: CHILD, id: "chatcmpl-tool-kid", name: "grep" } },
    { type: "session.tool.called", data: { sessionID: CHILD, id: "chatcmpl-tool-kid", input: { pattern: "x" } } },
    { type: "session.text.ended", data: { sessionID: CHILD, assistantMessageID: "msg_kid", ordinal: 0, text: "KUMQUAT" } },
    { type: "session.step.ended", data: { sessionID: CHILD, assistantMessageID: "msg_kid", tokens: { input: 10, output: 2 } } },
    { type: "session.execution.succeeded", data: { sessionID: CHILD } },
    { type: "session.tool.success", data: { sessionID: realParent, id: TOOLCALL, metadata: { sessionID: CHILD, status: "completed" } } },
    { type: "session.idle", data: { sessionID: realParent } },
  ];
  const outcome = await b.runTurn(sid, "spawn one", { cwd: "/tmp" });
  check("the parent's turn still completes", outcome.reason === "completed", outcome);

  const reg = registered.find((r) => r.id === CHILD);
  check("a sub-agent is registered as a child of the session that spawned it",
    reg && reg.parent === sid, registered);
  check("...with the role that keeps it out of the session list",
    reg?.childKind === "native-task", reg);
  check("...labelled with the agent it runs as", reg?.subagentType === "explore", reg);
  check("...and described by the title the server gave it",
    reg?.description === "Find the thing", reg);
  // The tool call's id is also the Task bubble's id in the parent's feed, so
  // this pairing is what lets the browser hang live status off that bubble.
  check("the spawning tool call is paired to the child",
    registered.some((r) => r.id === CHILD && r.native?.toolUseId === TOOLCALL), registered);

  const forChild = subAgentPatches.filter((x) => x.id === CHILD);
  check("the roster sees it start", forChild.some((x) => x.status === "running"), forChild);
  check("...reports the tool it is using", forChild.some((x) => x.lastTool === "grep"), forChild);
  check("...never blanks that name when the call actually runs",
    !forChild.some((x) => "lastTool" in x && x.lastTool === null), forChild);
  check("...summarises what it answered", forChild.some((x) => x.summary === "KUMQUAT"), forChild);
  check("...carries its token usage", forChild.some((x) => x.usage?.input === 10), forChild);
  check("...and sees it finish", forChild.some((x) => x.status === "completed"), forChild);

  // THE DISTINCTION. The map is "ids this backend can resolve"; the list is
  // "sessions the user may open". A child needs the first and must not get
  // the second.
  check("the child's transcript resolves through the id map",
    (await b.getSessionHistory(CHILD)).length === 2);
  state.sessions.set(CHILD, { id: CHILD, parentID: realParent, title: "Find the thing" });
  const listed = await b.listSessions({}, new Map(), () => null);
  check("...but it is NOT offered as a session of its own",
    !listed.sessions.some((x) => x.sessionId === CHILD), listed.sessions.map((x) => x.sessionId));

  // Claude Code must relay a sub-agent's text because nothing else records
  // it. Here the server already has it, and the two records cannot share
  // ids -- so relaying would double every block. The transcript is replayed
  // once, at completion, carrying the STORED ids.
  const childBubbles = bubbles.filter((x) => x.text === "KUMQUAT" && x.role === "assistant");
  check("a finished sub-agent's transcript is replayed exactly once",
    childBubbles.length === 1, childBubbles);
  check("...with the same id the live stream would have minted",
    childBubbles[0]?.id === "text:cm2:0", childBubbles[0]);
  state.messages = [];
}

// ── a stored part has no id of its own ─────────────────────────────────────
//
// `p.id || randomUUID()` minted a FRESH id per fetch, so server.py's
// (id, role, text) dedup could never match and one unchanged message read as
// two. Parts are identified positionally -- message plus index within their
// own KIND -- which is exactly the live stream's `ordinal`.
{
  const { b } = make();
  // Mapped the only way a session ever is: by actually driving a turn, which
  // is what makes the server mint an id for it.
  state.events = [{ type: "session.idle", data: {} }];
  await b.runTurn("oc-stable", "x", { cwd: "/tmp" });
  state.messages = [
    { id: "msgX", type: "assistant", time: { created: 1 },
      content: [
        { type: "reasoning", text: "first thought" },
        { type: "text", text: "" },                 // empty: rendered by nobody
        { type: "text", text: "the answer" },       // ...but it still took ordinal 0
        { type: "tool", id: "call-1", name: "shell", state: { input: { command: "ls" } } },
      ] },
  ];
  const a = await b.getSessionHistory("oc-stable");
  const c = await b.getSessionHistory("oc-stable");
  check("two reads of one transcript agree on every id",
    JSON.stringify(a.map((x) => x.id)) === JSON.stringify(c.map((x) => x.id)), a.map((x) => x.id));
  check("a block's id is its message and its ordinal within its kind",
    a.find((x) => x.role === "thinking")?.id === "reasoning:msgX:0", a);
  check("an unrendered part still consumes its ordinal",
    a.find((x) => x.role === "assistant")?.id === "text:msgX:1", a);
  check("a stored tool part keeps the provider's call id",
    a.find((x) => x.role === "tool")?.id === "call-1", a);
  check("...and reads its arguments out of state.input",
    /\*\*shell\*\* `ls`/.test(a.find((x) => x.role === "tool")?.text || ""), a);
  state.messages = [];
}

// ── the pairing survives a restart ─────────────────────────────────────────
//
// The map file is the primary record, but the driver ALSO keeps each pairing
// on the relation row and hands them all back at startup. Both halves of
// that -- reporting a new pairing, and accepting seeded ones -- were simply
// never implemented here, and the driver's optional-call swallowed the
// absence silently, so a map that lost an entry lost it for good. The
// symptom is the one that matters most: a delegated child reappearing
// detached from its parent with no Continue bar.
{
  const noted = [];
  const { b } = make({ noteRealSessionId: (c, r) => noted.push([c, r]) });
  state.events = [{ type: "session.idle", data: {} }];
  await b.runTurn("oc-pairing", "x", { cwd: "/tmp" });
  const real = b._ids.toReal("oc-pairing");
  check("a new pairing is reported to the driver as it is minted",
    noted.some(([c, r]) => c === "oc-pairing" && r === real), noted);

  // A fresh backend, as after a restart, with nothing in its map.
  const { b: fresh } = make();
  check("...which starts out knowing nothing about it",
    fresh._ids.toReal("oc-pairing") === null);
  check("seeding restores it", fresh.seedRealIds([["oc-pairing", real]]) === 1);
  check("...and the session resolves again", fresh._ids.toReal("oc-pairing") === real);
  check("seeding twice changes nothing", fresh.seedRealIds([["oc-pairing", real]]) === 0);
  check("a junk pair is ignored rather than stored",
    fresh.seedRealIds([[null, real], ["x", null]]) === 0);
}

// ── a turn does not end while the server still has work for it ─────────────
//
// A message folded in as the turn finishes is admitted to the server's
// DURABLE inbox and run as a fresh execution at the next step boundary. If
// we have already stopped reading the event stream, that execution runs
// unobserved: no turn_start, no streaming, the session reads idle while the
// model works, and a permission card inside it is shown to nobody. Measured
// against a live server: a steer POSTed to an already-idle session is NOT
// refused, it is executed.
{
  const { b, bubbles } = make();
  const sid = "oc-hold";
  await b.setModel(sid, "opencode/big-pickle");
  state.events = [
    { type: "session.inbox.enqueued", data: { inboxID: "in-1" } },
    { type: "session.inbox.delivered", data: { inboxID: "in-1" } },
    // a fold lands while the turn is still running
    { type: "session.inbox.enqueued", data: { inboxID: "in-2" } },
    // ...and the turn's own terminal event arrives before it is delivered
    { type: "session.idle", data: {} },
    // the server then runs it: WE MUST STILL BE LISTENING FOR THIS
    { type: "session.inbox.delivered", data: { inboxID: "in-2" } },
    { type: "session.text.ended", data: { assistantMessageID: "m9", ordinal: 0, text: "LATE WORK" } },
    { type: "session.idle", data: {} },
  ];
  const outcome = await b.runTurn(sid, "go", { cwd: "/tmp" });
  check("the turn still completes", outcome.reason === "completed", outcome);
  check("work the server ran AFTER the first idle is not missed",
    bubbles.some((x) => x.text === "LATE WORK"), bubbles.map((x) => x.text));
}

// The ordinary case must not be held open by its own opening prompt.
{
  const { b } = make();
  const sid = "oc-nohold";
  await b.setModel(sid, "opencode/big-pickle");
  state.events = [
    { type: "session.inbox.enqueued", data: { inboxID: "p-1" } },
    { type: "session.inbox.delivered", data: { inboxID: "p-1" } },
    { type: "session.text.ended", data: { assistantMessageID: "m1", ordinal: 0, text: "hi" } },
    { type: "session.idle", data: {} },
  ];
  const t0 = Date.now();
  const outcome = await b.runTurn(sid, "go", { cwd: "/tmp" });
  check("a turn with nothing outstanding ends at its first idle",
    outcome.reason === "completed" && Date.now() - t0 < 4000, { outcome, ms: Date.now() - t0 });
}

// ── the steer window ───────────────────────────────────────────────────────
//
// injectIntoTurn used to gate on state.turnInFlight, which the driver clears
// only at the very end of runTurn's finally -- after an approval drain
// bounded at 30 seconds. A steer accepted in that window is POSTed to a
// session the server has already finished with, and runs unwatched.
{
  const { b } = make();
  const sid = "oc-steer-window";
  await b.setModel(sid, "opencode/big-pickle");
  const st = { cwd: "/tmp", turnInFlight: true };
  check("a steer is taken while the turn is genuinely live",
    (await b.injectIntoTurn(sid, st, "hello")) === true);
  // What the terminal event sets, in the same tick it stops reading events.
  st.steerClosed = true;
  check("...and refused once the turn has seen its terminal event, even though"
    + " turnInFlight is still set",
    (await b.injectIntoTurn(sid, st, "too late")) === false);
  check("refusing is not losing: the driver re-queues what this declines,"
    + " so nothing was posted for the second one",
    state.prompts.filter((p) => p.text === "too late").length === 0);
}

server.close();
console.log(`\nopencode.test.mjs: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail === 0 ? 0 : 1);
