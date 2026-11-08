// Unit test for HD2's cascade rule, extracted so it can be exercised without
// a server, two backends and a live model.
//
// The rule under test: Stop follows THE WAIT, not the parent edge. The thing
// it must get right is the failure that motivated it —
//
//   delegate a long job on Monday (async, so the parent's turn ends at once),
//   prompt that parent about something unrelated on Tuesday, hit Stop, and
//   the old parent-edge cascade killed Monday's delegate.
//
// This is a COPY of abortCascadeTargets from driver.mjs, because driver.mjs
// exports nothing and starts a server on import. A copy that silently drifts
// is worse than no test — it reports green about code nobody runs — so the
// last check in this file READS driver.mjs and fails if the two have diverged
// beyond two deliberate renames (`sessions` -> `sess`,
// `sessionRelations` -> `rels`).

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eqSet(name, got, want) {
  const a = [...got].sort().join(","), b = [...want].sort().join(",");
  check(name, a === b, `got [${a}], want [${b}]`);
}

function makeWorld() {
  const rels = {};
  const sess = new Map();
  const isRosterChild = (id) => {
    const r = rels[id];
    return !!(r && r.rel === "parent" && !r.promoted && r.childKind === "native-task");
  };
  const childrenOfSession = (pid) =>
    Object.entries(rels).filter(([, r]) => r.rel === "parent" && !r.promoted && r.parent === pid)
      .map(([id]) => id);

  function abortCascadeTargets(sessionId, seen = new Set()) {
    if (seen.has(sessionId)) return [];
    seen.add(sessionId);
    const out = [];
    const parentTurnId = sess.get(sessionId)?.turnId || null;
    for (const childId of childrenOfSession(sessionId)) {
      const rel = rels[childId] || {};
      let blocking = isRosterChild(childId);
      if (!blocking && rel.awaitedByParentTurn && rel.parentTurnId
          && parentTurnId && rel.parentTurnId === parentTurnId) {
        blocking = true;
      }
      if (!blocking) continue;
      out.push(childId);
      out.push(...abortCascadeTargets(childId, seen));
    }
    return out;
  }
  return { rels, sess, abortCascadeTargets };
}

// ── THE motivating failure ────────────────────────────────────────────────
{
  const w = makeWorld();
  w.sess.set("P", { turnId: "turn-MONDAY" });
  w.rels["async-kid"] = {
    rel: "parent", parent: "P", childKind: "delegated",
    awaitedByParentTurn: false, parentTurnId: null,
  };
  eqSet("Monday: an async delegate is never this turn's work",
        w.abortCascadeTargets("P"), []);

  // Tuesday: a brand-new, unrelated turn in the same parent.
  w.sess.set("P", { turnId: "turn-TUESDAY" });
  eqSet("Tuesday: Stop must NOT reach Monday's delegate",
        w.abortCascadeTargets("P"), []);
}

// ── An awaited delegate IS this turn's work ───────────────────────────────
{
  const w = makeWorld();
  w.sess.set("P", { turnId: "t1" });
  w.rels["awaited"] = {
    rel: "parent", parent: "P", childKind: "delegated",
    awaitedByParentTurn: true, parentTurnId: "t1",
  };
  eqSet("an awaited child of THIS turn is stopped", w.abortCascadeTargets("P"), ["awaited"]);

  // The same child, one turn later: the parent is no longer waiting on it.
  w.sess.set("P", { turnId: "t2" });
  eqSet("an awaited child of a PAST turn is not", w.abortCascadeTargets("P"), []);
}

// ── Roster children are always this turn's work ───────────────────────────
{
  const w = makeWorld();
  w.sess.set("P", { turnId: "t1" });
  w.rels["task"] = { rel: "parent", parent: "P", childKind: "native-task" };
  eqSet("a native sub-agent is always stopped", w.abortCascadeTargets("P"), ["task"]);
  // Even with no turn id at all — a roster child cannot outlive its parent's
  // turn, so there is no stale case to protect against.
  w.sess.set("P", {});
  eqSet("and does not depend on a turn id", w.abortCascadeTargets("P"), ["task"]);
}

// ── Restart safety: no id matches, so nothing is wrongly killed ───────────
{
  const w = makeWorld();
  w.sess.set("P", { turnId: null });            // post-restart: no live turn id
  w.rels["awaited"] = {
    rel: "parent", parent: "P", childKind: "delegated",
    awaitedByParentTurn: true, parentTurnId: "turn-from-before-the-restart",
  };
  eqSet("a stranded parentTurnId kills nothing", w.abortCascadeTargets("P"), []);
}

// ── Recursion, and the promoted/detached exclusion ────────────────────────
{
  const w = makeWorld();
  w.sess.set("P", { turnId: "t1" });
  w.sess.set("mid", { turnId: "t9" });
  w.rels["mid"] = { rel: "parent", parent: "P", childKind: "native-task" };
  w.rels["leaf"] = { rel: "parent", parent: "mid", childKind: "native-task" };
  w.rels["leaf-async"] = {
    rel: "parent", parent: "mid", childKind: "delegated", awaitedByParentTurn: false,
  };
  eqSet("the rule applies recursively", w.abortCascadeTargets("P"), ["mid", "leaf"]);

  w.rels["detached"] = { rel: "parent", parent: "P", childKind: "native-task", promoted: true };
  eqSet("a detached child is out of the cascade", w.abortCascadeTargets("P"), ["mid", "leaf"]);
}

// ── A cycle in a corrupt sidecar must not hang ────────────────────────────
{
  const w = makeWorld();
  w.sess.set("A", { turnId: "t" });
  w.sess.set("B", { turnId: "t" });
  w.rels["B"] = { rel: "parent", parent: "A", childKind: "native-task" };
  w.rels["A"] = { rel: "parent", parent: "B", childKind: "native-task" };
  const got = w.abortCascadeTargets("A");
  check("a cycle terminates", Array.isArray(got), "did not return");
  check("and visits each node once", new Set(got).size === got.length, `got [${got}]`);
}


// ── The copy must not drift from the shipped function ────────────────────
{
  const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
  const self = readFileSync(new URL("./cascade.test.mjs", import.meta.url), "utf8");
  const bodyOf = (text, name) => {
    const i = text.indexOf(`function ${name}(`);
    if (i < 0) return null;
    let d = 0;
    const j = text.indexOf("{", i);
    for (let k = j; k < text.length; k++) {
      if (text[k] === "{") d++;
      else if (text[k] === "}" && --d === 0) return text.slice(j, k + 1);
    }
    return null;
  };
  // Two deliberate renames, and ONLY two: the harness names its fakes `sess`
  // and `rels` where the driver uses the module-level `sessions` map and
  // `sessionRelations` object. Anything else differing is real drift.
  const norm = (t) => t
    .replace(/\/\/[^\n]*/g, "")                 // comments differ by design
    .replace(/\bsessions\.get\b/g, "sess.get")
    .replace(/\bsessionRelations\b/g, "rels")
    .replace(/\s+/g, " ").trim();
  const shipped = bodyOf(src, "abortCascadeTargets");
  const copy = bodyOf(self, "abortCascadeTargets");
  check("driver.mjs still defines abortCascadeTargets", !!shipped);
  check("this file still defines the copy", !!copy);
  check("the copy matches the shipped logic", shipped && copy && norm(shipped) === norm(copy),
        "they have diverged — update this copy, or the test is lying");
}

console.log(`cascade rule (HD2): ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
