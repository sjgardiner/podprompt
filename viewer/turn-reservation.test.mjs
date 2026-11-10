// Regression guard for a latent turn-reservation race.
//
// THE RACE (found by inspection 2026-11-10; NOT observed in the wild)
// ------------------------------------------------------------------
// startTurn() refuses a second turn with `if (state.turnInFlight) return busy`,
// but turnInFlight used to be set only by the BACKEND's runTurn, several awaits
// downstream: startTurn calls driver runTurn un-awaited, and that function
// awaits buildPromotedSeed() before it ever reaches backend.runTurn. The await
// yields the event loop with turnInFlight still false, so two inputs arriving
// inside that window both passed the guard and both started a backend turn for
// the same session.
//
// HONESTY ABOUT SCOPE. This was found while investigating a real failure --
// sessions losing the ability to get any permission decision, while still able
// to run auto-permitted read-only tools -- and it was initially believed to be
// the cause. It is not. Applying this fix did not stop that failure recurring,
// and no log has ever shown two turns starting for one session. That failure
// was later traced to something else entirely -- see permission-channel.mjs --
// so this change is credited with nothing but itself. The race is real as a
// matter of code reading, and closing it is cheap and correct, but it stays on
// those merits alone unless something actually demonstrates it firing.
//
// WHY THIS TEST IS SHAPED LIKE THIS
// ---------------------------------
// driver.mjs is a standalone server script with no exports, so startTurn cannot
// be imported and driven directly. Rather than refactor the driver to make one
// race testable, this asserts the ordering invariant against the source: the
// reservation must happen with no await between the guard and the assignment.
// That is the property that actually matters, and it is the one a well-meaning
// future edit ("move this next to the other state setup") would quietly break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import nodePath from "node:path";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(nodePath.join(here, "driver.mjs"), "utf8");

/** Remove // and block comments so prose cannot satisfy or fail a code check. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Extract a top-level function body by brace matching from its declaration. */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find "${declaration}" in driver.mjs`);
  // Skip the parameter list before looking for the body. Both functions
  // destructure an options object, so a naive indexOf("{") lands on the
  // PARAMETER braces and brace-matches out of the wrong block entirely.
  let paren = 0, i = source.indexOf("(", start);
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++;
    else if (source[i] === ")") { paren--; if (paren === 0) break; }
  }
  const open = source.indexOf("{", i);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${declaration}`);
}

test("startTurn reserves the session before it can yield the event loop", () => {
  // startTurn itself is a thin logging wrapper; the guard and the reservation
  // live in startTurnInner, which is what this invariant is about.
  const body = functionBody(src, "function startTurnInner(");

  const guard = body.indexOf("state.turnInFlight");
  assert.notEqual(guard, -1, "startTurn must still check turnInFlight");

  const reserve = body.indexOf("state.turnInFlight = true");
  assert.notEqual(
    reserve, -1,
    "startTurn must set state.turnInFlight = true itself. Leaving it to the "
    + "backend reopens the race: there is an await between here and there.",
  );

  // The whole point: nothing may await between passing the guard and taking
  // the reservation, or two callers can both pass. Comments are stripped
  // first -- the explanation of this very race says the word "await" several
  // times, and prose must not fail the test.
  const between = stripComments(body.slice(guard, reserve));
  assert.equal(
    /\bawait\b/.test(between), false,
    "an `await` appeared between the turnInFlight check and the reservation. "
    + "That is precisely the race this guards: the event loop can run another "
    + "delivery in that gap and it will also pass the guard.",
  );
});

test("runTurn releases the reservation even if it never reaches the backend", () => {
  const body = functionBody(src, "async function runTurn(");

  const backendCall = body.indexOf("state.backend.runTurn");
  assert.notEqual(backendCall, -1, "runTurn must still invoke the backend");

  const release = body.lastIndexOf("state.turnInFlight = false");
  assert.notEqual(
    release, -1,
    "runTurn must clear turnInFlight in its finally. The backends clear it "
    + "too, but only once reached -- anything throwing earlier (buildPromotedSeed, "
    + "stampSessionHost) would strand the session as permanently busy.",
  );
  assert.ok(
    release > backendCall,
    "the release must come after the backend call, i.e. in the finally block",
  );
});

test("the backends still set turnInFlight themselves (harmless, and correct alone)", () => {
  // Not redundant: a backend's runTurn is also reachable in tests and by any
  // future caller that does not route through startTurn, so it must keep
  // working on its own.
  for (const file of ["backends/claude-code.mjs", "backends/opencode.mjs"]) {
    const text = readFileSync(nodePath.join(here, file), "utf8");
    assert.ok(
      text.includes("state.turnInFlight = true"),
      `${file} should still set turnInFlight for callers that bypass startTurn`,
    );
  }
});
