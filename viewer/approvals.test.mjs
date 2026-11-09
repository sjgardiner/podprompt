// Unit tests for retracting an approval card whose request has died.
//
// Run: node viewer/approvals.test.mjs
//
// THE BUG THIS GUARDS. OpenCode announces every request that stops being
// live — permission.replied, question.replied, question.rejected — and the
// driver listened for none of them. A card whose request had been answered,
// withdrawn or expired therefore stayed on screen, visually identical to a
// live one. Clicking it POSTed an answer for an id OpenCode had discarded,
// producing PermissionNotFoundError.
//
// That was worse than cosmetic: a dead card sat beside a genuinely blocking
// one, so answering the wrong one left an agent waiting. Measured on a real
// session, two `read` tools blocked for 384 seconds and only ended when the
// user pressed Stop.
//
// Reads resolveApprovalExternally out of driver.mjs at run time, so there is
// no copy to drift from the shipped code.

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
  const start = src.slice(Math.max(0, i - 6), i) === "async " ? i - 6 : i;
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

function fresh(entries = []) {
  const sandbox = `
    const pendingApprovals = new Map(arguments[0]);
    const calls = { broadcasts: [], statuses: [], roster: [], persisted: 0 };
    const persistPendingApprovals = () => { calls.persisted++; };
    const broadcast = (s, kind, payload, id) =>
      calls.broadcasts.push({ s, kind, payload: JSON.parse(payload), id });
    const broadcastStatus = (s, st) => calls.statuses.push({ s, ...st });
    const isRosterChild = (id) => id === "roster-kid";
    const upsertSubAgent = (id, patch) => calls.roster.push({ id, ...patch });
    ${bodyOf("resolveApprovalExternally")}
    return { resolveApprovalExternally, pendingApprovals, calls };
  `;
  return new Function(sandbox)(entries);
}

function card(id, externalId, sessionId = "sess-1", extra = {}) {
  const settled = [];
  return [id, {
    resolve: (v) => settled.push(v),
    sessionId, kind: "permission", toolName: "bash", toolInput: {},
    externalId, settled, ...extra,
  }];
}

// ── The core behaviour ────────────────────────────────────────────────────
{
  const [id, rec] = card("uuid-1", "per_abc");
  const d = fresh([[id, rec]]);

  check("retracting a known external id reports success",
    d.resolveApprovalExternally("per_abc", "gone") === true);
  check("the card is removed from the pending map", d.pendingApprovals.size === 0);
  check("the removal is persisted", d.calls.persisted === 1);

  // The waiter MUST be settled, or whatever the backend is awaiting hangs
  // forever — the failure mode this whole mechanism exists to prevent.
  check("the waiting promise is settled", rec.settled.length === 1, rec.settled);
  // And settled as CANCELLED, not as an allow or deny: answering a dead
  // request is exactly what produced the 404.
  check("...as cancelled, not as a decision",
    rec.settled[0]?.cancelled === true && rec.settled[0].allow === undefined, rec.settled[0]);

  const b = d.calls.broadcasts[0];
  check("the browser is told the card is resolved", b?.payload?.resolved === true, b);
  check("...with the reason given", b?.payload?.resolvedText === "gone", b?.payload);
  check("...keyed by the card's own id, not the external one", b?.id === "uuid-1", b?.id);
  check("the awaiting-input indicator is cleared",
    d.calls.statuses.some((s) => s.type === "awaiting_input" && s.kind === null),
    d.calls.statuses);
}

// ── It must not retract anything else ─────────────────────────────────────
{
  const [idA, recA] = card("uuid-a", "per_a");
  const [idB, recB] = card("uuid-b", "per_b");
  const d = fresh([[idA, recA], [idB, recB]]);

  d.resolveApprovalExternally("per_a", "x");
  check("only the matching card is removed", d.pendingApprovals.size === 1);
  check("...and it is the right one remaining", d.pendingApprovals.has("uuid-b"));
  check("the untouched card's waiter is NOT settled", recB.settled.length === 0);
}

// ── Unknown and malformed ids are inert ───────────────────────────────────
//
// This runs for OUR OWN replies too — OpenCode emits permission.replied for
// those, by which time the card is already gone — so "no match" is the
// common case and must be silent and cheap, not an error.
{
  const [id, rec] = card("uuid-1", "per_abc");
  const d = fresh([[id, rec]]);
  check("an unknown external id is a no-op",
    d.resolveApprovalExternally("per_nope", "x") === false);
  check("a null id is a no-op", d.resolveApprovalExternally(null, "x") === false);
  check("an undefined id is a no-op", d.resolveApprovalExternally(undefined, "x") === false);
  check("nothing was removed", d.pendingApprovals.size === 1);
  check("nothing was broadcast", d.calls.broadcasts.length === 0);
  check("nothing was settled", rec.settled.length === 0);
}

// ── A card with no external id can never be matched ───────────────────────
//
// claude-code supplies no per-request id of its own, so its cards carry
// externalId null. A null lookup must not sweep them all away.
{
  const [id, rec] = card("uuid-cc", null);
  const d = fresh([[id, rec]]);
  check("a null-external card is not matched by a null query",
    d.resolveApprovalExternally(null, "x") === false);
  check("...and survives", d.pendingApprovals.size === 1 && rec.settled.length === 0);
}

// ── Roster children get their 'waiting' flag cleared ──────────────────────
{
  const [id, rec] = card("uuid-r", "per_r", "roster-kid");
  const d = fresh([[id, rec]]);
  d.resolveApprovalExternally("per_r", "x");
  check("a sub-agent's roster row stops saying 'waiting'",
    d.calls.roster.some((r) => r.id === "roster-kid" && r.awaiting === null), d.calls.roster);
}

// ── Wiring: the events must actually be handled ───────────────────────────
//
// All of the above is inert unless the backend listens for the announcements
// and threads its own request id through. Asserted against source, since the
// event dispatcher cannot be unit-tested in isolation.
{
  const oc = readFileSync(new URL("./backends/opencode.mjs", import.meta.url), "utf8");
  for (const evt of ["permission.replied", "question.replied", "question.rejected"]) {
    check(`${evt} is handled`, oc.includes(`"${evt}"`));
  }
  check("every ask records its OpenCode request id",
    (oc.match(/externalId:/g) || []).length === 4,
    (oc.match(/externalId:/g) || []).length);
  check("a retracted card is not answered",
    /cancelled \? undefined :/.test(oc) || /if \(decision\?\.cancelled\) return undefined;/.test(oc));
  // Replies MUST go to the session-scoped route. The bare one is silently
  // directory-scoped and resolves against the server's default directory,
  // so every answer to a session outside it returned PermissionNotFound.
  check("permission replies use the session-scoped route",
    /\/api\/session\/\$\{realId\}\/permission\/\$\{requestID\}\/reply/.test(oc));
  check("question replies use the session-scoped route",
    /\/api\/session\/\$\{realId\}\/question\/\$\{requestID\}\/reply/.test(oc));
  check("the bare directory-scoped reply routes are gone",
    !/api\(`\/permission\/\$\{requestID\}\/reply`/.test(oc)
    && !/api\(`\/question\/\$\{requestID\}\/reply`/.test(oc));
  // A 404 must NOT retract: an earlier version assumed "not found" meant
  // the request had died, when it meant we were asking the wrong place, so
  // it destroyed live requests and reported them as expired.
  // Assert on the FUNCTION, not the file: "PermissionNotFoundError" appears
  // in a comment explaining why the route changed, so a file-wide string
  // search would fail for the wrong reason.
  const replyFn = oc.slice(oc.indexOf("async function replyPermission("));
  const replyBody = replyFn.slice(0, replyFn.indexOf("\n  }") + 4);
  check("a failed reply does NOT retract the card",
    !/resolveApprovalExternally/.test(replyBody), replyBody.slice(-260));
  check("answered ids stop being tracked",
    /permissionSessionOf\.delete\(requestID\)/.test(oc));
  check("the driver exposes the retraction hook to backends",
    /resolveApprovalExternally,/.test(src));
}

console.log(`approval retraction: ${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(fail ? 1 : 0);
