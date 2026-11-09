// Unit + integration tests for OpenCode session enumeration (§13).
//
// Run: node viewer/opencode-sessions.test.mjs
//
// THE BUG THIS GUARDS. OpenCode's plain GET /session is not a complete
// listing — it returns only the sessions of the one project OpenCode
// resolves its own cwd to. The driver called it bare and filtered the
// result client-side, as if the response contained everything and merely
// needed narrowing. Measured against the live server: GET /session returned
// 22 sessions, /experimental/session returned 47. Twenty-five were
// invisible, including nineteen in the root directory itself. Sessions
// cannot be filtered back in once the server never sent them, so the whole
// failure was silent — the sessions panel simply showed fewer rows than
// existed, for weeks, and nobody could tell.
//
// Two layers are tested, because the bug had two halves:
//   1. selectVisibleSessions() — pure, decides which rows become top-level
//      entries. This half was always CORRECT; it was being starved.
//   2. listSessions()/listProjects() against a stub OpenCode server —
//      verifies the right endpoint is called with the right parameters, and
//      that the fallback degrades rather than emptying the list.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createOpenCodeBackend, selectVisibleSessions, isUnderRoot, classifyIdleTurn } from "./backends/opencode.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const ROOT = "/workspace";

// ── isUnderRoot ───────────────────────────────────────────────────────────
{
  check("the root itself is under root", isUnderRoot(ROOT, ROOT));
  check("a subdirectory is under root", isUnderRoot("/workspace/podprompt", ROOT));
  check("a deep subdirectory is under root", isUnderRoot("/workspace/a/b/c", ROOT));
  check("an unrelated path is not", !isUnderRoot("/tmp/ocprobe", ROOT));
  // The classic startsWith trap: "/workspace-other" starts with "/workspace"
  // but is a sibling, not a child. Separator-anchored comparison is the only
  // thing standing between us and leaking a foreign repo's sessions.
  check("a sibling sharing the root's prefix is NOT under root",
    !isUnderRoot("/workspace-other/x", ROOT));
  check("missing arguments are safe", !isUnderRoot(null, ROOT) && !isUnderRoot("/x", null));
}

// ── selectVisibleSessions ─────────────────────────────────────────────────
{
  const raw = [
    { id: "a", directory: "/workspace" },                            // root
    { id: "b", directory: "/workspace/podprompt" },                  // git subproject
    { id: "c", directory: "/workspace/geant4" },                     // another subproject
    { id: "d", directory: "/tmp/ocprobe" },                          // foreign
    { id: "e", directory: "/workspace-other/x" },                    // sibling-prefix
    { id: "f", directory: "/workspace", parentID: "a" },             // subtask
    { id: "g" },                                                     // no directory
    { id: "h", directory: "/workspace", time: { archived: 123 } },   // archived
  ];
  const got = selectVisibleSessions(raw, ROOT).map((s) => s.id);

  // The regression that started all this: sessions in a git subdirectory.
  check("a session in a git subproject is kept", got.includes("b"), got);
  check("a second subproject is kept too", got.includes("c"), got);
  check("a root-directory session is kept", got.includes("a"), got);

  check("a foreign directory is dropped", !got.includes("d"), got);
  check("a sibling-prefix directory is dropped", !got.includes("e"), got);
  check("a subtask session is dropped", !got.includes("f"), got);
  check("a session with no directory is dropped", !got.includes("g"), got);

  // Selection must not be archive-aware: the driver decides what Archived
  // means by reading time.archived downstream. Filtering here would empty
  // the Archived tab.
  check("an archived session is still selected", got.includes("h"), got);

  check("exactly the expected set", JSON.stringify(got) === JSON.stringify(["a", "b", "c", "h"]), got);
}

// ── Malformed input must be inert ─────────────────────────────────────────
{
  check("null input yields empty", selectVisibleSessions(null, ROOT).length === 0);
  check("undefined input yields empty", selectVisibleSessions(undefined, ROOT).length === 0);
  let threw = false;
  try { selectVisibleSessions([null, undefined, { id: "x", directory: "/workspace" }], ROOT); }
  catch { threw = true; }
  check("null entries do not throw", !threw);
  check("...and the good row still survives",
    selectVisibleSessions([null, { id: "x", directory: "/workspace" }], ROOT).length === 1);
}

// ── Integration against a stub OpenCode server ────────────────────────────
//
// What makes this worth the machinery: the whole bug was about WHICH
// endpoint got called and with what. A pure test cannot see that.

function stubServer(routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const key = Object.keys(routes).find((k) => req.url.startsWith(k));
    const handler = key ? routes[key] : null;
    if (!handler) { res.writeHead(404); res.end("no route"); return; }
    const out = handler(req.url);
    if (out === 404) { res.writeHead(404); res.end("gone"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, seen, port: server.address().port });
    });
  });
}

function backendFor(port) {
  return createOpenCodeBackend({
    cwdRoot: ROOT,
    baseUrl: `http://127.0.0.1:${port}`,
    broadcast() {}, broadcastStatus() {}, requestApproval() {},
    registerChild() {}, autoApproveForSession: () => false,
    updateSubAgent() {}, noteDelegateAnchor() {},
  });
}

const stubArgs = [{ includeUnreachable: false }, new Map(), () => null];

// Two projects' worth of sessions, as the real server returns them: the
// bare route sees only one project, the experimental route sees both.
const ONE_PROJECT = [{ id: "ses_old", directory: "/workspace", time: { updated: 1 } }];
const BOTH_PROJECTS = [
  ...ONE_PROJECT,
  { id: "ses_new", directory: "/workspace/podprompt", time: { updated: 2 } },
  { id: "ses_arch", directory: "/workspace", time: { updated: 3, archived: 99 } },
];

// Primary path: experimental route used, archived requested, both projects seen.
{
  const { server, seen, port } = await stubServer({
    "/experimental/session": () => BOTH_PROJECTS,
    "/session": () => ONE_PROJECT,
  });
  const be = backendFor(port);
  const { sessions } = await be.listSessions(...stubArgs);
  const ids = sessions.map((s) => s.sessionId);

  check("the experimental route is the one called", seen.some((u) => u.startsWith("/experimental/session")), seen);
  check("the bare route is NOT called on the happy path", !seen.some((u) => u === "/session"), seen);
  check("archived=true is requested", seen.some((u) => u.includes("archived=true")), seen);
  check("a session from the second project appears", ids.includes("ses_new"), ids);
  check("the first project's session still appears", ids.includes("ses_old"), ids);

  const arch = sessions.find((s) => s.sessionId === "ses_arch");
  check("an archived session is listed", !!arch, ids);
  check("...and is tagged for the Archived tab", arch?.tag === "archived" && arch?.archived === true, arch);
  server.close();
}

// Fallback: experimental route gone (as an unstable endpoint may be).
{
  const quiet = console.error; console.error = () => {};
  const { server, seen, port } = await stubServer({
    "/experimental/session": () => 404,
    "/session": () => ONE_PROJECT,
  });
  const be = backendFor(port);
  const { sessions } = await be.listSessions(...stubArgs);
  console.error = quiet;

  check("the stable route is tried when experimental 404s", seen.some((u) => u === "/session"), seen);
  check("the list degrades rather than emptying",
    sessions.map((s) => s.sessionId).includes("ses_old"), sessions);
  server.close();
}

// Both routes down: must THROW, not return empty. An unreachable backend has
// to keep propagating to the driver's backend-failure tracking — returning
// [] would render "opencode is down" as "opencode has no sessions", which is
// the same class of silent lie this whole file exists to prevent.
{
  const quiet = console.error; console.error = () => {};
  const { server, port } = await stubServer({});
  const be = backendFor(port);
  let threw = false;
  try { await be.listSessions(...stubArgs); } catch { threw = true; }
  console.error = quiet;
  check("a fully unreachable backend throws rather than reporting empty", threw);
  server.close();
}

// listProjects had the identical bug: same bare call, so a directory whose
// sessions all lived in another project could never be offered in the
// new-chat picker. Uses real paths, since it drops directories that are
// missing from disk.
{
  const { server, seen, port } = await stubServer({
    "/experimental/session": () => [
      { id: "s1", directory: "/workspace" },
      { id: "s2", directory: "/workspace/podprompt" },
    ],
    "/session": () => [{ id: "s1", directory: "/workspace" }],
  });
  const be = backendFor(port);
  const { projects } = await be.listProjects();
  const cwds = projects.map((p) => p.cwd);
  check("listProjects uses the complete listing too",
    seen.some((u) => u.startsWith("/experimental/session")), seen);
  check("a subproject directory becomes offerable", cwds.includes("/workspace/podprompt"), cwds);
  check("the root is still offered", cwds.includes(ROOT), cwds);
  server.close();
}

// ── The durable id mapping ────────────────────────────────────────────────
//
// PodPrompt keys everything off a minted "oc-<uuid>" client id; OpenCode
// knows the same session as "ses_...". The pairing lived only in the
// backend's memory, so a restart listed the session under its real id while
// its relation row, turn state and resumable record stayed under the client
// id — a delegated child came back detached from its parent with no Continue
// bar. Verified against the live driver before this was written:
// /resume-state said available:true for the oc-... id and available:false
// for the ses_... id of the same crashed session.
{
  const { server, port } = await stubServer({
    "/experimental/session": () => [
      { id: "ses_real", directory: "/workspace", time: { updated: 5 } },
    ],
  });
  const be = backendFor(port);

  // Before seeding, the session can only be known by its real id.
  const before = (await be.listSessions(...stubArgs)).sessions.map((s) => s.sessionId);
  check("unseeded, the session lists under its real id", before.includes("ses_real"), before);
  check("unseeded, clientIdForReal knows nothing", be.clientIdForReal("ses_real") === null);

  const n = be.seedRealIds([["oc-abc", "ses_real"]]);
  check("seeding reports what it restored", n === 1, n);
  check("clientIdForReal resolves after seeding", be.clientIdForReal("ses_real") === "oc-abc");

  // The point of the whole exercise: the row now carries the id that the
  // relation row, turn state and resumable record are all keyed by.
  const after = (await be.listSessions(...stubArgs)).sessions.map((s) => s.sessionId);
  check("seeded, the session lists under its CLIENT id", after.includes("oc-abc"), after);
  check("...and no longer under the real id", !after.includes("ses_real"), after);

  // Idempotence and junk tolerance — this runs on every boot against a file
  // written by older versions, so it must never throw or double-map.
  check("re-seeding the same pair is a no-op", be.seedRealIds([["oc-abc", "ses_real"]]) === 0);
  check("junk pairs are skipped", be.seedRealIds([[null, "x"], ["y", null], []]) === 0);
  check("null input is safe", be.seedRealIds(null) === 0 && be.seedRealIds(undefined) === 0);
  server.close();
}

// ── The write half, asserted against source ───────────────────────────────
//
// ensureSession creating a real id is the only moment the pairing is
// learned; if it stops reporting it, nothing persists and the restore above
// has nothing to restore from. That call can't be reached without driving a
// whole turn, so assert its presence structurally.
{
  const { readFileSync } = await import("node:fs");
  const oc = readFileSync(new URL("./backends/opencode.mjs", import.meta.url), "utf8");
  const drv = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");

  const body = oc.slice(oc.indexOf("async function ensureSession("));
  const end = body.indexOf("\n  }");
  const ensure = body.slice(0, end);
  check("ensureSession reports a newly created real id",
    /noteRealSessionId\?\.\(sessionId, created\.id\)/.test(ensure));
  check("...after recording it locally",
    ensure.indexOf("realToClient.set(created.id") < ensure.indexOf("noteRealSessionId"));

  check("the driver supplies the callback", /noteRealSessionId,/.test(drv));
  check("the driver persists it onto the relation row",
    /rel\.native = \{ \.\.\.\(rel\.native \|\| \{\}\), realSessionId: realId \}/.test(drv));
  check("the driver seeds mappings at startup", /^seedOpenCodeRealIds\(\);$/m.test(drv));
  // Ordering: the seed is useless if it runs before the backend exists, and
  // dangerous-looking if it runs after the first listing.
  check("the seed runs after the backends are built",
    drv.indexOf("const backends = {") < drv.indexOf("\nseedOpenCodeRealIds();"));
}

// ── Classifying a silent turn (§13e) ─────────────────────────────────────
//
// Layer 3 of turn completion. Once a session has gone quiet, this decides
// what the silence MEANS: a finished turn whose session.idle we missed, or
// an upstream provider stall (opencode#54888 — the provider accepts the
// request, stops sending, and opencode v1 has no stream timeout at all).
//
// The distinction rests on one fact: a tool call lives INSIDE an assistant
// message, so a message cannot be marked completed while its tool runs.
// Therefore "complete" means generation really ended; "incomplete" means it
// stopped part-way, which is the stall's signature.
//
// Both error directions are costly, so both are pinned. Saying "finished"
// too early truncates a live agent. Saying "stalled" too early aborts and
// re-runs work that was fine.
{
  const T = 300000;
  const complete   = { info: { role: "assistant", time: { created: 1, completed: 2 } } };
  const midStream  = { info: { role: "assistant", time: { created: 1 } } };
  const userLast   = { info: { role: "user", time: { created: 1 } } };

  // Too early to judge: this is what holds on every healthy turn, and it is
  // why the probe issues no request and the turn is never disturbed.
  check("below the threshold it declines to judge",
    classifyIdleTurn(5000, complete, T) === null);
  check("...even one tick short", classifyIdleTurn(T - 1, complete, T) === null);
  check("...and that holds for an incomplete message too",
    classifyIdleTurn(T - 1, midStream, T) === null);

  check("silent with generation complete means finished",
    classifyIdleTurn(T, complete, T) === "finished");

  // The failure that actually happens: generation stopped part-way.
  check("silent with generation incomplete means stalled",
    classifyIdleTurn(T, midStream, T) === "stalled");
  check("...however long it has been silent",
    classifyIdleTurn(T * 20, midStream, T) === "stalled");

  // "Provider accepted the request and never sent a first token" — the
  // assistant message does not exist yet, so the user prompt is last.
  check("a trailing user message means stalled",
    classifyIdleTurn(T, userLast, T) === "stalled");

  // Absent or malformed data must read as STALLED, not finished. Stalled is
  // recoverable (abort and resume); wrongly declaring "finished" silently
  // truncates a turn and loses the rest of the work.
  for (const [label, msg] of [
    ["null", null], ["undefined", undefined], ["empty object", {}],
    ["no time field", { info: { role: "assistant" } }],
    ["completed=0", { info: { role: "assistant", time: { completed: 0 } } }],
  ]) {
    check(`a ${label} last message is treated as stalled`,
      classifyIdleTurn(T, msg, T) === "stalled");
  }

  // The API has returned both nested and un-nested message shapes.
  check("an un-nested message shape still reads as finished",
    classifyIdleTurn(T, { role: "assistant", time: { completed: 2 } }, T) === "finished");

  // The shipped threshold must sit above a stall that was observed to
  // RECOVER on its own (112s) and below every stall that never did (738s+).
  const src = readFileSync(new URL("./backends/opencode.mjs", import.meta.url), "utf8");
  const ms = (name) => Number((src.match(new RegExp(name + " = ([\\d *]+);")) || [])[1]
    ?.split("*").reduce((a, b) => a * Number(b.trim()), 1));
  const inactivity = ms("TURN_INACTIVITY_MS");
  check("the threshold is above the observed self-recovery (112s)", inactivity > 112000, inactivity);
  check("...and below the shortest stall that never recovered (738s)", inactivity < 738000, inactivity);
  check("the probe polls more often than the threshold",
    ms("TURN_INACTIVITY_POLL_MS") < inactivity);

  // The structures the old design left behind must be gone, not orphaned.
  check("the one-hour ceiling is removed", !/TURN_IDLE_CEILING_MS/.test(src));
  check("a stall aborts the session server-side", /\/abort`, \{ method: "POST"/.test(src));
  check("a stall reports its own outcome reason",
    /reason: "stalled"/.test(src));
}

console.log(`opencode session enumeration: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
