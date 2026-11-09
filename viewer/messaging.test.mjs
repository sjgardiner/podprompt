// Unit tests for the peer registry and inbox.
//
// Run: node viewer/messaging.test.mjs
//
// As with chains.test.mjs, these are written to contradict the design
// rather than demonstrate it: handle collisions, renames mid-flight,
// realm-qualified addresses that must NOT resolve, cross-chain drains that
// must not mix budgets, and restart survival.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createPeers, createInbox, parseAddress, slugifyHandle, LOCAL_REALM } from "./messaging.mjs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, got, want) {
  check(name, Object.is(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const dir = mkdtempSync(nodePath.join(tmpdir(), "msg-test-"));
let clock = 1_700_000_000_000;
const now = () => clock++;
const file = (n) => nodePath.join(dir, `${n}.json`);

// ── address parsing ──────────────────────────────────────────────────────
{
  eq("bare name is local", parseAddress("researcher").realm, LOCAL_REALM);
  eq("@name is local", parseAddress("@researcher").realm, LOCAL_REALM);
  eq("@name strips the sigil", parseAddress("@researcher").name, "researcher");
  eq("qualified realm is parsed", parseAddress("@host/researcher").realm, "host");
  eq("qualified name is parsed", parseAddress("@host/researcher").name, "researcher");
  check("qualified is flagged", parseAddress("@host/x").qualified === true);
  check("bare is not flagged qualified", parseAddress("x").qualified === false);
  eq("empty is rejected", parseAddress("").reason, "bad-address");
  eq("lone sigil is rejected", parseAddress("@").reason, "bad-address");
  eq("missing name is rejected", parseAddress("@host/").reason, "bad-address");
  eq("missing realm is rejected", parseAddress("@/name").reason, "bad-address");

  eq("slug lowercases and hyphenates", slugifyHandle("Explore Auth Flow"), "explore-auth-flow");
  eq("slug strips punctuation", slugifyHandle("fix: the parser!"), "fix-the-parser");
  eq("slug falls back when empty", slugifyHandle("!!!"), "session");
  check("slug is bounded", slugifyHandle("x".repeat(200)).length <= 32);
}

// ── handles: assigned once, unique, stable ───────────────────────────────
{
  const p = createPeers({ file: file("peers"), now });
  const a = p.ensure("s1", { title: "Explore auth flow", backend: "claude-code" });
  eq("handle from title", a.handle, "explore-auth-flow");
  eq("realm defaults to local", a.realm, LOCAL_REALM);
  eq("messageable by default", a.messageable, true);

  const b = p.ensure("s2", { title: "Explore auth flow", backend: "opencode" });
  eq("collision gets a suffix", b.handle, "explore-auth-flow-2");
  const c = p.ensure("s3", { title: "Explore auth flow" });
  eq("second collision increments", c.handle, "explore-auth-flow-3");

  // A handle that drifted as a title changed would break every reference a
  // model is holding mid-task.
  p.ensure("s1", { title: "Something else entirely" });
  eq("handle is stable across title change", p.get("s1").handle, "explore-auth-flow");
  eq("title itself does update", p.get("s1").title, "Something else entirely");

  eq("resolve by handle", p.resolve("@explore-auth-flow").ref.id, "s1");
  eq("resolve by bare handle", p.resolve("explore-auth-flow-2").ref.id, "s2");
  eq("resolve by raw session id", p.resolve("s3").ref.id, "s3");
  eq("unknown handle is distinct", p.resolve("@nobody").reason, "unknown-handle");
  // The distinction that is free now and expensive later.
  eq("unknown realm is distinct", p.resolve("@mars/nobody").reason, "unknown-realm");
  eq("a known handle in an unknown realm still fails on the realm",
     p.resolve("@mars/explore-auth-flow").reason, "unknown-realm");

  eq("rename works", p.setHandle("s1", "Researcher").ok, true);
  eq("rename slugifies", p.get("s1").handle, "researcher");
  eq("old handle stops resolving", p.resolve("@explore-auth-flow").reason, "unknown-handle");
  eq("new handle resolves", p.resolve("@researcher").ref.id, "s1");
  eq("rename to a taken handle is refused", p.setHandle("s1", "explore-auth-flow-2").reason, "handle-taken");
  eq("rename of unknown session is refused", p.setHandle("nope", "x").reason, "unknown-session");

  p.setMessageable("s2", false);
  eq("messageable can be turned off", p.get("s2").messageable, false);
  check("a non-messageable peer still RESOLVES (the fence is in authz, not lookup)",
    p.resolve("@explore-auth-flow-2").ok === true);
}

// ── provisional handles upgrade once a real title appears ───────────────
{
  const p = createPeers({ file: file("peers-provisional"), now });
  // A session usually has no title until its first turn produces one.
  const early = p.ensure("s1", { backend: "claude-code" });
  eq("untitled session gets a fallback handle", early.handle, "session");
  eq("and is marked provisional", early.provisional, true);

  const later = p.ensure("s1", { title: "Refactor the parser" });
  eq("provisional handle upgrades on first real title", later.handle, "refactor-the-parser");
  eq("and stops being provisional", later.provisional, false);

  p.ensure("s1", { title: "Something else" });
  eq("but never upgrades twice", p.get("s1").handle, "refactor-the-parser");

  // A handle the user chose must survive a title arriving later.
  const q = createPeers({ file: file("peers-provisional2"), now });
  q.ensure("s2", { backend: "opencode" });
  q.setHandle("s2", "reviewer");
  eq("user-chosen handle is not provisional", q.get("s2").provisional, false);
  q.ensure("s2", { title: "Some Auto Title" });
  eq("user-chosen handle survives a later title", q.get("s2").handle, "reviewer");
}

// ── peers survive a restart ──────────────────────────────────────────────
{
  const f = file("peers-restart");
  const p1 = createPeers({ file: f, now });
  p1.ensure("s1", { title: "Main", backend: "claude-code" });
  p1.setHandle("s1", "main");
  p1.setMessageable("s1", false);

  const p2 = createPeers({ file: f, now });
  eq("handle survives restart", p2.get("s1").handle, "main");
  eq("messageable survives restart", p2.get("s1").messageable, false);
  eq("resolution works after restart", p2.resolve("@main").ref.id, "s1");
}

// ── corrupt state must not throw ─────────────────────────────────────────
{
  const f = file("peers-corrupt");
  writeFileSync(f, "}{ not json");
  const p = createPeers({ file: f, now });
  eq("corrupt peers file starts fresh", p.list().length, 0);
  check("still usable", !!p.ensure("s1", { title: "x" }));
}

// ── inbox basics ─────────────────────────────────────────────────────────
{
  const ib = createInbox({ file: file("inbox"), now });
  const e = ib.enqueue({
    to: { realm: LOCAL_REALM, id: "target" },
    from: { realm: LOCAL_REALM, id: "sender" },
    fromHandle: "sender-handle",
    text: "hello",
  });
  eq("starts queued", e.state, "queued");
  eq("kind defaults to peer", e.kind, "peer");
  eq("pending for target", ib.pendingFor("target").length, 1);
  eq("not pending for sender", ib.pendingFor("sender").length, 0);
  // Stored distinctly even though rendered alike — splitting them later must
  // not need a migration.
  const r = ib.enqueue({
    to: { realm: LOCAL_REALM, id: "target" }, from: { realm: LOCAL_REALM, id: "child" },
    text: "report", kind: "result",
  });
  eq("result kind is preserved", ib.byId(r.id).kind, "result");

  eq("nothing is stuck yet", ib.stuck().length, 0);
  ib.markDelivered([e.id, r.id]);
  eq("delivered leaves nothing pending", ib.pendingFor("target").length, 0);
}

// ── a drain takes EVERYTHING pending for that session ────────────────────
{
  // This used to assert the opposite: drains were sliced per chain so one
  // chain's budget could not pay for another's work. §10 (AD2) removed
  // chains entirely for a single global counter, so there is nothing left to
  // keep apart — and coalescing is now strictly better, since one turn
  // carrying three messages costs one charge instead of three.
  const ib = createInbox({ file: file("inbox-drain"), now });
  const to = { realm: LOCAL_REALM, id: "target" };
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "a" }, text: "1" });
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "b" }, text: "2" });
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "c" }, text: "3" });

  const group = ib.pendingFor("target");
  eq("a drain takes all pending mail at once", group.length, 3);
  ib.markDelivered(group.map((g) => g.id));
  eq("and leaves nothing behind", ib.pendingFor("target").length, 0);

  // Other sessions' mail is still untouched — coalescing is per TARGET, not
  // global, which is the one distinction that still matters.
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "a" }, text: "mine" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "other" }, from: { realm: LOCAL_REALM, id: "a" }, text: "theirs" });
  eq("drain is scoped to one target", ib.pendingFor("target").length, 1);
  eq("the other target keeps its own", ib.pendingFor("other").length, 1);
}

// ── parking, releasing, discarding ───────────────────────────────────────
{
  const ib = createInbox({ file: file("inbox-park"), now });
  const to = { realm: LOCAL_REALM, id: "t" };
  const e = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "x" });
  ib.park(e.id, "steps");
  eq("parked is not pending", ib.pendingFor("t").length, 0);
  eq("parked counts as stuck", ib.stuck().length, 1);
  eq("park reason recorded", ib.byId(e.id).parkedReason, "steps");

  eq("release restores it", ib.release(e.id).ok, true);
  eq("released is pending again", ib.pendingFor("t").length, 1);
  eq("released is no longer stuck", ib.stuck().length, 0);
  eq("releasing a non-parked entry is refused", ib.release(e.id).reason, "not-parked");
  eq("releasing an unknown entry is refused", ib.release("nope").reason, "no-such-entry");

  ib.discard(e.id);
  eq("discarded is not pending", ib.pendingFor("t").length, 0);
  eq("discarded is not stuck", ib.stuck().length, 0);
}

// ── inbox survives a restart ─────────────────────────────────────────────
{
  const f = file("inbox-restart");
  const i1 = createInbox({ file: f, now });
  const to = { realm: LOCAL_REALM, id: "t" };
  const queued = i1.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "still here" });
  const parked = i1.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "parked" });
  i1.park(parked.id, "deadline");

  // A restart must not drop mail — that is the whole reason this is durable.
  const i2 = createInbox({ file: f, now });
  eq("queued mail survives restart", i2.pendingFor("t").length, 1);
  eq("and it is the right one", i2.pendingFor("t")[0].id, queued.id);
  eq("parked mail survives restart", i2.stuck().length, 1);
  eq("park reason survives restart", i2.byId(parked.id).parkedReason, "deadline");
}

// ── sessionsWithPending drives the resume-from-pause drain ───────────────
{
  const ib = createInbox({ file: file("inbox-pending"), now });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "a" }, from: { realm: LOCAL_REALM, id: "z" }, text: "1" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "b" }, from: { realm: LOCAL_REALM, id: "z" }, text: "2" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "a" }, from: { realm: LOCAL_REALM, id: "z" }, text: "3" });
  const s = ib.sessionsWithPending().sort();
  eq("distinct targets only", s.length, 2);
  eq("targets are right", s.join(","), "a,b");
}

// ── pruning keeps everything still actionable ────────────────────────────
{
  const ib = createInbox({ file: file("inbox-prune"), now });
  const to = { realm: LOCAL_REALM, id: "t" };
  for (let i = 0; i < 50; i++) {
    const e = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: `${i}` });
    ib.markDelivered([e.id]);
  }
  const live = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "live" });
  const held = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "held" });
  ib.park(held.id, "steps");

  ib.prune(10);
  check("queued entry survives pruning", ib.byId(live.id) !== null);
  check("parked entry survives pruning", ib.byId(held.id) !== null);
  check("history is bounded", ib.all().length <= 10, `got ${ib.all().length}`);
}

// ── forgetting a session drops its mail in both directions ───────────────
{
  const ib = createInbox({ file: file("inbox-forget"), now });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "gone" }, from: { realm: LOCAL_REALM, id: "s" }, text: "in" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "t" }, from: { realm: LOCAL_REALM, id: "gone" }, text: "out" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "t" }, from: { realm: LOCAL_REALM, id: "s" }, text: "keep" });
  ib.forgetSessions(["gone"]);
  eq("mail to and from the forgotten session is gone", ib.all().length, 1);
  eq("unrelated mail is kept", ib.all()[0].text, "keep");
}

rmSync(dir, { recursive: true, force: true });

// ── Three small sharp edges ──────────────────────────────────────────────
{
  const { readFileSync: rf } = await import("node:fs");
  const drv = rf(new URL("./driver.mjs", import.meta.url), "utf8");

  // /inbox takes `session`. Passing `sessionId` — the name every other route
  // uses — fell through to the unfiltered branch and returned EVERY
  // session's mail. That is how an agent read another session's inbox and
  // believed it was its own: not an error, a different plausible answer.
  const inboxAt = drv.indexOf('path === "/inbox"');
  const route = drv.slice(inboxAt, inboxAt + 1400);
  check("an unknown /inbox parameter is rejected", /unknown query parameter/.test(route));
  check("...and the message names the right parameter", /not "sessionId"/.test(route));
  check("...before any entries are read",
    route.indexOf("unknown") < route.indexOf("inbox.open()"));

  // `all` should lift the DEFAULT cap, not discard a limit the caller chose.
  // {all:true, limit:3} used to return every peer, which reads as a bug and
  // was reported as one.
  const capAt = drv.indexOf("const cap = all");
  const cap = drv.slice(capAt, capAt + 200);
  check("all respects an explicit limit", /limit \? Math\.max\(1, limit\)/.test(cap));
  check("...and still returns everything when no limit is given",
    /: matched\.length/.test(cap));
  for (const f of ["./backends/claude-code.mjs", "./opencode-plugin.ts"]) {
    const t = rf(new URL(f, import.meta.url), "utf8");
    check(f.split("/").pop() + " documents it",
      /a limit you pass alongside it is still respected/.test(t));
  }

  // The comment claimed OpenCode has no per-call id and therefore no anchor.
  // The first half is still true; the conclusion no longer is.
  const cc = rf(new URL("./backends/claude-code.mjs", import.meta.url), "utf8");
  check("the stale 'OpenCode has no equivalent' claim is gone",
    !/OpenCode has no equivalent/.test(cc));
  check("...replaced by what actually happens now",
    /rescans the finished message at turn end/.test(cc));
}

console.log(`\nmessaging.mjs: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
