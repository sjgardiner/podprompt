// Unit tests for delegation-anchor matching (§12 follow-up).
//
// Run: node viewer/anchor.test.mjs
//
// The anchor is how a delegated session's "Delegated" label links back to the
// exact bubble in its parent that created it. claude-code supplies the call
// id directly; OpenCode cannot — its ToolContext exposes sessionID and
// messageID but no per-call id — so the driver recovers it downstream by
// matching the delegate tool part streaming back from the parent against the
// prompt it delegated with. THAT matching is what this file tests, because it
// is the part that can silently pick the wrong bubble.
//
// Unlike cascade.test.mjs, this does not keep a COPY of the logic: it reads
// the functions out of driver.mjs at run time and evaluates them in a
// sandbox that supplies the module globals they close over. There is
// therefore no drift to guard against — the code under test is the shipped
// code, byte for byte.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
}

const src = readFileSync(new URL("./driver.mjs", import.meta.url), "utf8");
function bodyOf(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`driver.mjs no longer defines ${name}()`);
  let depth = 0;
  const open = src.indexOf("{", i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

function freshDriver() {
  // Only the module globals the two functions actually touch.
  const sandbox = `
    const pendingDelegateAnchors = new Map();
    let sessionRelations = {};
    let saves = 0;
    const saveSessionRelations = () => { saves++; };
    ${bodyOf("expectDelegateAnchor")}
    ${bodyOf("noteDelegateAnchor")}
    return {
      expectDelegateAnchor, noteDelegateAnchor,
      rels: () => sessionRelations,
      setRels: (r) => { sessionRelations = r; },
      pendingFor: (p) => pendingDelegateAnchors.get(p),
      saves: () => saves,
    };
  `;
  return new Function(sandbox)();
}

// ── The happy path ────────────────────────────────────────────────────────
{
  const d = freshDriver();
  d.setRels({ kid: { childKind: "delegated", native: {} } });
  d.expectDelegateAnchor("P", "kid", "Research task. Do the thing.");
  d.noteDelegateAnchor("P", { id: "prt_123", state: { input: { prompt: "Research task. Do the thing." } } });
  check("a matching part stamps the anchor", d.rels().kid.native.toolUseId === "prt_123", d.rels().kid.native);
  check("the pending entry is consumed", !d.pendingFor("P"));
  check("and the relation index is persisted", d.saves() > 0);
}

// ── It must not stamp the wrong thing ─────────────────────────────────────
{
  const d = freshDriver();
  d.setRels({ kid: { childKind: "delegated", native: {} } });
  d.expectDelegateAnchor("P", "kid", "prompt A");

  // Ordinary tool calls stream past constantly; none of them are the one.
  d.noteDelegateAnchor("P", { id: "prt_ls", state: { input: { command: "ls -la" } } });
  check("an unrelated tool part is ignored", !d.rels().kid.native.toolUseId);
  d.noteDelegateAnchor("P", { id: "prt_other", state: { input: { prompt: "a different prompt" } } });
  check("a non-matching prompt is ignored", !d.rels().kid.native.toolUseId);
  d.noteDelegateAnchor("P", { id: "prt_right", state: { input: { prompt: "prompt A" } } });
  check("and the real one still matches afterwards", d.rels().kid.native.toolUseId === "prt_right");
}

// ── Two delegations in flight from one parent ─────────────────────────────
{
  const d = freshDriver();
  d.setRels({ a: { childKind: "delegated", native: {} }, b: { childKind: "delegated", native: {} } });
  d.expectDelegateAnchor("P", "a", "first job");
  d.expectDelegateAnchor("P", "b", "second job");
  // Parts need not arrive in the order the delegations were made.
  d.noteDelegateAnchor("P", { id: "prt_b", state: { input: { prompt: "second job" } } });
  d.noteDelegateAnchor("P", { id: "prt_a", state: { input: { prompt: "first job" } } });
  check("concurrent delegations match independently, out of order",
    d.rels().a.native.toolUseId === "prt_a" && d.rels().b.native.toolUseId === "prt_b",
    { a: d.rels().a.native, b: d.rels().b.native });
}

// ── Malformed and hostile input must be inert ─────────────────────────────
{
  const d = freshDriver();
  d.setRels({ kid: { childKind: "delegated", native: {} } });
  d.expectDelegateAnchor("P", "kid", "p");

  d.noteDelegateAnchor("P", { state: { input: { prompt: "p" } } });
  check("a part with no id is ignored", !d.rels().kid.native.toolUseId);
  d.noteDelegateAnchor("P", { id: "x" });
  check("a part with no state is ignored", !d.rels().kid.native.toolUseId);
  d.noteDelegateAnchor("P", { id: "x", state: { input: { prompt: 42 } } });
  check("a non-string prompt is ignored", !d.rels().kid.native.toolUseId);
  d.noteDelegateAnchor("nobody", { id: "x", state: { input: { prompt: "p" } } });
  check("an unknown parent is a no-op", !d.rels().kid.native.toolUseId);

  // The expectation survives all of that and still resolves.
  d.noteDelegateAnchor("P", { id: "prt_ok", state: { input: { prompt: "p" } } });
  check("the expectation survives junk and still resolves", d.rels().kid.native.toolUseId === "prt_ok");
}

// ── Long prompts: comparison is on a bounded prefix ───────────────────────
{
  const d = freshDriver();
  d.setRels({ kid: { childKind: "delegated", native: {} } });
  const long = "long ".repeat(400);
  d.expectDelegateAnchor("P", "kid", long);
  // The part carries the same prompt. Storing it whole would mean holding a
  // copy of every delegation prompt; a prefix is enough to identify one.
  d.noteDelegateAnchor("P", { id: "prt_long", state: { input: { prompt: long } } });
  check("a long prompt matches on its prefix", d.rels().kid.native.toolUseId === "prt_long");
}

// ── A stamped anchor must not clobber the rest of the relation row ────────
{
  const d = freshDriver();
  d.setRels({ kid: { childKind: "delegated", parent: "P", hadUserTurn: true, native: { agentId: "keep-me" } } });
  d.expectDelegateAnchor("P", "kid", "p");
  d.noteDelegateAnchor("P", { id: "prt_1", state: { input: { prompt: "p" } } });
  const r = d.rels().kid;
  check("other relation fields survive", r.childKind === "delegated" && r.parent === "P" && r.hadUserTurn === true, r);
  check("other native ids survive", r.native.agentId === "keep-me" && r.native.toolUseId === "prt_1", r.native);
}

// ── A child whose relation row has gone must not throw ────────────────────
{
  const d = freshDriver();
  d.setRels({});
  d.expectDelegateAnchor("P", "deleted-kid", "p");
  let threw = false;
  try { d.noteDelegateAnchor("P", { id: "prt_1", state: { input: { prompt: "p" } } }); }
  catch { threw = true; }
  check("a deleted child is handled without throwing", !threw);
}

console.log(`delegation anchors: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
