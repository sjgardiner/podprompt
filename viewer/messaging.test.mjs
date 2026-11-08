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
    chainId: "chn_1",
  });
  eq("starts queued", e.state, "queued");
  eq("kind defaults to peer", e.kind, "peer");
  eq("pending for target", ib.pendingFor("target").length, 1);
  eq("not pending for sender", ib.pendingFor("sender").length, 0);
  // Stored distinctly even though rendered alike — splitting them later must
  // not need a migration.
  const r = ib.enqueue({
    to: { realm: LOCAL_REALM, id: "target" }, from: { realm: LOCAL_REALM, id: "child" },
    text: "report", kind: "result", chainId: "chn_1",
  });
  eq("result kind is preserved", ib.byId(r.id).kind, "result");

  eq("nothing is stuck yet", ib.stuck().length, 0);
  ib.markDelivered([e.id, r.id]);
  eq("delivered leaves nothing pending", ib.pendingFor("target").length, 0);
}

// ── a drain must never mix chains ────────────────────────────────────────
{
  const ib = createInbox({ file: file("inbox-chains"), now });
  const to = { realm: LOCAL_REALM, id: "target" };
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "a" }, text: "1", chainId: "chn_A" });
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "b" }, text: "2", chainId: "chn_B" });
  ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "c" }, text: "3", chainId: "chn_A" });

  const group = ib.nextDrainGroup("target");
  eq("drain group takes the oldest chain only", group.length, 2);
  check("drain group is single-chain", group.every((g) => g.chainId === "chn_A"));
  // A turn belongs to exactly one chain; mixing would make one chain's
  // budget silently pay for another's work.
  ib.markDelivered(group.map((g) => g.id));
  const next = ib.nextDrainGroup("target");
  eq("the other chain drains next", next.length, 1);
  eq("and it is the right one", next[0].chainId, "chn_B");
}

// ── parking, releasing, discarding ───────────────────────────────────────
{
  const ib = createInbox({ file: file("inbox-park"), now });
  const to = { realm: LOCAL_REALM, id: "t" };
  const e = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "x", chainId: "chn" });
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
  const queued = i1.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "still here", chainId: "c" });
  const parked = i1.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "parked", chainId: "c" });
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
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "a" }, from: { realm: LOCAL_REALM, id: "z" }, text: "1", chainId: "c" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "b" }, from: { realm: LOCAL_REALM, id: "z" }, text: "2", chainId: "c" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "a" }, from: { realm: LOCAL_REALM, id: "z" }, text: "3", chainId: "c" });
  const s = ib.sessionsWithPending().sort();
  eq("distinct targets only", s.length, 2);
  eq("targets are right", s.join(","), "a,b");
}

// ── pruning keeps everything still actionable ────────────────────────────
{
  const ib = createInbox({ file: file("inbox-prune"), now });
  const to = { realm: LOCAL_REALM, id: "t" };
  for (let i = 0; i < 50; i++) {
    const e = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: `${i}`, chainId: "c" });
    ib.markDelivered([e.id]);
  }
  const live = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "live", chainId: "c" });
  const held = ib.enqueue({ to, from: { realm: LOCAL_REALM, id: "s" }, text: "held", chainId: "c" });
  ib.park(held.id, "steps");

  ib.prune(10);
  check("queued entry survives pruning", ib.byId(live.id) !== null);
  check("parked entry survives pruning", ib.byId(held.id) !== null);
  check("history is bounded", ib.all().length <= 10, `got ${ib.all().length}`);
}

// ── forgetting a session drops its mail in both directions ───────────────
{
  const ib = createInbox({ file: file("inbox-forget"), now });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "gone" }, from: { realm: LOCAL_REALM, id: "s" }, text: "in", chainId: "c" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "t" }, from: { realm: LOCAL_REALM, id: "gone" }, text: "out", chainId: "c" });
  ib.enqueue({ to: { realm: LOCAL_REALM, id: "t" }, from: { realm: LOCAL_REALM, id: "s" }, text: "keep", chainId: "c" });
  ib.forgetSessions(["gone"]);
  eq("mail to and from the forgotten session is gone", ib.all().length, 1);
  eq("unrelated mail is kept", ib.all()[0].text, "keep");
}

rmSync(dir, { recursive: true, force: true });

console.log(`\nmessaging.mjs: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
process.exit(fail ? 1 : 0);
