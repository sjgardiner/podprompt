// Unit tests for self-teaching model selection on delegate_session.
//
// Run: node viewer/model.test.mjs
//
// Nothing in this environment lists the model ids a backend accepts — no
// list_models tool, no mention of the driver's /models route in any system
// prompt — so delegate_session is designed to teach them through its own
// rejection: guess wrong once and the error carries the whole list. That
// makes two things load-bearing, and both are tested here:
//
//   1. resolveModelId() must reject only genuinely unknown ids, and must
//      never reject when the backend simply cannot answer (fail open).
//   2. describeReceipt() must actually PUT THE IDS in the message. If that
//      string ever loses the list, the feature silently becomes an ordinary
//      dead-end error and no caller can ever recover from a wrong guess.
//
// Like anchor.test.mjs, this reads the functions out of driver.mjs at run
// time and evaluates them against stub globals, so there is no copy to drift.

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
  // Keep the `async` prefix if there is one, or the extracted body loses its
  // ability to await and fails in a way that looks like a logic bug.
  const start = src.slice(Math.max(0, i - 6), i) === "async " ? i - 6 : i;
  // Walk the PARAMETER LIST to its closing paren before looking for the
  // body's opening brace. toolDelegate destructures its second argument, so
  // the first "{" after the name is inside the signature; stopping there
  // yields a body consisting of the signature alone, which then fails every
  // assertion for reasons that look nothing like the real cause.
  let parens = 0, open = -1;
  for (let k = src.indexOf("(", i); k < src.length; k++) {
    if (src[k] === "(") parens++;
    else if (src[k] === ")" && --parens === 0) { open = src.indexOf("{", k); break; }
  }
  if (open < 0) throw new Error(`could not find the body of ${name}()`);
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces reading ${name}()`);
}

function freshDriver(backends) {
  const sandbox = `
    const backends = BACKENDS;
    ${bodyOf("resolveModelId")}
    ${bodyOf("describeReceipt")}
    return { resolveModelId, describeReceipt };
  `.replace("BACKENDS", "arguments[0]");
  return new Function(sandbox)(backends);
}

const realish = {
  "claude-code": {
    listModels: async () => ({
      current: "sonnet",
      available: [
        { id: "default", label: "Default" },
        { id: "sonnet", label: "Sonnet" },
        { id: "opus[1m]", label: "Opus" },
        { id: "haiku", label: "Haiku" },
      ],
    }),
  },
  opencode: {
    listModels: async () => ({
      available: [
        { id: "opencode/iceman-free", label: "Iceman" },
        { id: "opencode/big-pickle", label: "Big Pickle" },
      ],
    }),
  },
};

// ── Ids that exist ────────────────────────────────────────────────────────
{
  const d = freshDriver(realish);
  const a = await d.resolveModelId("claude-code", "sonnet");
  check("an exact id is accepted", a.ok && a.id === "sonnet", a);

  // The two backends' id shapes do not rhyme; the slashed form must work too.
  const b = await d.resolveModelId("opencode", "opencode/iceman-free");
  check("a slashed opencode id is accepted", b.ok && b.id === "opencode/iceman-free", b);

  // Bracketed ids are real ("opus[1m]") and must not be mangled.
  const c = await d.resolveModelId("claude-code", "opus[1m]");
  check("a bracketed id is accepted verbatim", c.ok && c.id === "opus[1m]", c);
}

// ── Case is a typo, not a teaching moment ─────────────────────────────────
{
  const d = freshDriver(realish);
  const a = await d.resolveModelId("claude-code", "Sonnet");
  check("case-insensitive match is accepted", a.ok, a);
  check("...and normalizes to the canonical id", a.id === "sonnet", a);
  const b = await d.resolveModelId("opencode", "OpenCode/Iceman-Free");
  check("case folding works on slashed ids too", b.ok && b.id === "opencode/iceman-free", b);
}

// ── The teaching rejection ────────────────────────────────────────────────
{
  const d = freshDriver(realish);
  const r = await d.resolveModelId("claude-code", "gpt-4o");
  check("an unknown id is rejected", r.ok === false, r);
  check("and the rejection carries the full list",
    Array.isArray(r.available) && r.available.length === 4 && r.available.includes("haiku"),
    r.available);

  // Ids are checked against the TARGET backend, not any backend: a perfectly
  // valid opencode id is meaningless on claude-code and must still be
  // rejected, or the child would start on a model its backend cannot load.
  const x = await d.resolveModelId("claude-code", "opencode/iceman-free");
  check("a valid id for the OTHER backend is still rejected", x.ok === false, x);
  check("...and is answered with the target backend's ids",
    x.available?.includes("sonnet") && !x.available?.includes("opencode/iceman-free"),
    x.available);
}

// ── Failing open: a backend that cannot answer must not block delegation ──
{
  const d = freshDriver({
    nolist: {},                                     // backend with no model concept
    broken: { listModels: async () => { throw new Error("serve is down"); } },
    empty: { listModels: async () => ({ available: [] }) },
    nullish: { listModels: async () => null },
  });
  for (const [id, label] of [
    ["nolist", "a backend with no listModels"],
    ["broken", "a backend whose listModels throws"],
    ["empty", "a backend with an empty model list"],
    ["nullish", "a backend returning null"],
  ]) {
    const r = await d.resolveModelId(id, "whatever");
    check(`${label} fails open`, r.ok === true && r.id === "whatever", r);
  }
  const unknown = await d.resolveModelId("no-such-backend", "whatever");
  check("an unknown backend id fails open here", unknown.ok === true, unknown);
}

// ── Junk in the model list must not crash or create phantom matches ───────
{
  const d = freshDriver({
    junk: { listModels: async () => ({ available: [null, {}, { id: "" }, { id: "real" }] }) },
  });
  const good = await d.resolveModelId("junk", "real");
  check("a usable id survives junk entries", good.ok && good.id === "real", good);
  const bad = await d.resolveModelId("junk", "fake");
  check("junk entries do not become matches", bad.ok === false, bad);
  check("...and are filtered out of the taught list",
    JSON.stringify(bad.available) === JSON.stringify(["real"]), bad.available);
}

// ── The receipt text is the documentation ─────────────────────────────────
{
  const d = freshDriver(realish);
  const msg = d.describeReceipt(
    { ok: false, reason: "unknown-model", backend: "claude-code", model: "gpt-4o",
      available: ["default", "sonnet", "opus[1m]", "haiku"] },
    "claude-code");
  check("the message names the rejected model", msg.includes("gpt-4o"), msg);
  check("the message names the backend", msg.includes("claude-code"), msg);
  for (const id of ["default", "sonnet", "opus[1m]", "haiku"]) {
    check(`the message lists "${id}"`, msg.includes(id), msg);
  }
  check("the message says how to retry", /call delegate_session again/i.test(msg), msg);
  check("the message offers the omit-it escape", /omit/i.test(msg), msg);

  // Degenerate case: fail-open means we should never GET here with an empty
  // list, but if we do the text must not promise a list it does not have.
  const bare = d.describeReceipt(
    { ok: false, reason: "unknown-model", backend: "opencode", model: "x", available: [] },
    "opencode");
  check("with no ids to give, it does not claim to list any",
    !/ids it accepts are/i.test(bare) && /omit/i.test(bare), bare);
}

// ── Order inside toolDelegate: a wrong guess must be CHEAP ────────────────
//
// Guessing is the intended discovery path, so being wrong must cost nothing
// but a round trip. If the model check ever moves below noteFanout, each
// wrong guess would burn one of the turn's few delegation slots and a model
// probing for an id could exhaust its own fanout budget before learning
// anything. That ordering is not visible to any unit test, so assert it
// against the source directly.
{
  const body = bodyOf("toolDelegate");
  const checkAt = body.indexOf('reason: "unknown-model"');
  const fanoutAt = body.indexOf("noteFanout(");
  check("toolDelegate still has the unknown-model check", checkAt >= 0);
  check("toolDelegate still charges fanout", fanoutAt >= 0);
  check("the model check runs BEFORE fanout is charged", checkAt >= 0 && checkAt < fanoutAt,
    { checkAt, fanoutAt });

  // Same reasoning for depth and the autonomy pause: all three are cheap
  // refusals, and the model check must not be the one that lets a typo
  // consume budget.
  const depthAt = body.indexOf("creationDepthExceeded(");
  check("the model check runs before the depth cap", checkAt < depthAt, { checkAt, depthAt });
}

// ── Both shims must actually OFFER the parameter ──────────────────────────
//
// The driver can validate all it likes; if neither tool schema exposes
// `model`, no caller can ever pass one. This caught exactly that gap: the
// descriptions promised "a different backend or model than yours" for weeks
// while the schemas had no model field at all.
{
  const cc = readFileSync(new URL("./backends/claude-code.mjs", import.meta.url), "utf8");
  const oc = readFileSync(new URL("./opencode-plugin.ts", import.meta.url), "utf8");
  const ccDelegate = cc.slice(cc.indexOf('"delegate_session"'));
  const ocDelegate = oc.slice(oc.indexOf("delegate_session: tool("));

  check("claude-code's schema declares model", /model: z\.string\(\)\.optional\(\)/.test(ccDelegate));
  check("opencode's schema declares model", /model: tool\.schema\.string\(\)\.optional\(\)/.test(ocDelegate));
  check("claude-code forwards model to the driver", /model: args\.model \|\| null/.test(ccDelegate));
  check("opencode forwards model to the driver", /model: args\.model \|\| null/.test(ocDelegate));

  // The self-teaching contract has to be stated where the caller reads it,
  // or guessing never occurs to anyone.
  for (const [name, text] of [["claude-code", ccDelegate], ["opencode", ocDelegate]]) {
    const desc = text.slice(0, text.indexOf("await:"));
    check(`${name}'s model description invites a guess`, /guess/i.test(desc));
    check(`${name}'s model description promises the list back`, /full list of ids/i.test(desc));
  }

  // And the driver must accept it over HTTP, which is the only path the
  // opencode shim has.
  check("the /delegate route forwards model", /model: body\.model \|\| null/.test(src));
}

console.log(`delegate model selection: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
