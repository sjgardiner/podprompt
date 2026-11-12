// Tests for binding a `result` message to the prompt that caused it.
//
// The shapes below are copied from a real run against the SDK and CLI, not
// invented: the "foreign" case is the actual early result observed when a
// background task was orphaned, and the "ours" case is the real result for the
// prompt sent alongside it. Getting this wrong in either direction is
// expensive — too eager and we close the permission channel mid-turn (the
// original bug), too reluctant and the turn never ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resultBelongsToTurn, safetyNetAction, outstandingWork } from "./turn-binding.mjs";

const MINE = "57fba329-b833-47d4-9abd-746db12312fd";
const OTHER = "a47ac131-42fc-42a1-a9ae-b5c5fd0e3e84";

test("binds a result carrying our uuid in the list", () => {
  const msg = { type: "result", subtype: "success", user_message_uuid: MINE, user_message_uuids: [MINE] };
  assert.equal(resultBelongsToTurn(msg, MINE), true);
});

test("the early result observed in the wild carries no uuid at all", () => {
  // Verbatim shape from the reproduction: Claude Code dismissing an orphaned
  // background task emits a complete result ~1ms after init, with both uuid
  // fields absent because no user message caused it.
  const msg = { type: "result", subtype: "success", queued_turn_count: 0 };
  assert.equal(resultBelongsToTurn(msg, MINE), false);
});

test("a result for somebody else's prompt is not ours", () => {
  const msg = { type: "result", user_message_uuid: OTHER, user_message_uuids: [OTHER] };
  assert.equal(resultBelongsToTurn(msg, MINE), false);
});

test("finds our uuid anywhere in a merged batch", () => {
  // Prompts sent close together are merged into one turn; only the LAST
  // appears in the singular field, so the list is what must be searched.
  const msg = { type: "result", user_message_uuid: OTHER, user_message_uuids: [MINE, OTHER] };
  assert.equal(resultBelongsToTurn(msg, MINE), true);
});

test("falls back to the singular field when no list is present", () => {
  assert.equal(resultBelongsToTurn({ type: "result", user_message_uuid: MINE }, MINE), true);
  assert.equal(resultBelongsToTurn({ type: "result", user_message_uuid: OTHER }, MINE), false);
});

test("an empty list means not ours, and does not fall through to the singular field", () => {
  // Guards a plausible mis-implementation: `list?.includes(...) ?? singular`
  // would wrongly bind here. If the producer sent a list, the list is the
  // answer.
  const msg = { type: "result", user_message_uuid: MINE, user_message_uuids: [] };
  assert.equal(resultBelongsToTurn(msg, MINE), false);
});

test("ignores every message that is not a result", () => {
  for (const msg of [
    null,
    {},
    { type: "assistant", user_message_uuid: MINE },
    { type: "user", user_message_uuid: MINE },
    { type: "system", subtype: "init", user_message_uuid: MINE },
  ]) {
    assert.equal(resultBelongsToTurn(msg, MINE), false);
  }
});

test("without a uuid of our own, nothing binds", () => {
  // Defensive: a turn that somehow lost its uuid must not start matching
  // arbitrary results. The safety net ends such a turn instead.
  const msg = { type: "result", user_message_uuid: undefined };
  assert.equal(resultBelongsToTurn(msg, undefined), false);
  assert.equal(resultBelongsToTurn(msg, null), false);
});

// ── the safety net's policy ────────────────────────────────────────────────

test("safety net waits while the silence is short", () => {
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 1_000, pendingPermissions: 0, graceMs: 300_000 }), "wait");
});

test("safety net gives up once the silence passes the grace", () => {
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 300_000, pendingPermissions: 0, graceMs: 300_000 }), "give-up");
});

test("a pending permission defers, no matter how long the silence", () => {
  // THE BUG THIS PINS: the first draft returned early here and never re-armed,
  // retiring the net for the rest of the turn. Waiting on a human must defer,
  // and deferring must outrank giving up at every duration.
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 60 * 60 * 1000, pendingPermissions: 1, graceMs: 300_000 }), "defer");
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 0, pendingPermissions: 3, graceMs: 300_000 }), "defer");
});

test("exactly at the grace boundary, give up", () => {
  // Stated so the boundary is a decision rather than an accident.
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 299_999, pendingPermissions: 0, graceMs: 300_000 }), "wait");
  assert.equal(safetyNetAction(
    { msSinceLastMessage: 300_001, pendingPermissions: 0, graceMs: 300_000 }), "give-up");
});

// ── outstandingWork: when is a turn actually over? ─────────────────────────
//
// A result ends a BATCH, not necessarily the turn. Opening the gate while
// the model still has work closes stdin underneath it, and canUseTool's
// answers travel over that stdin — so every permission-gated call fails for
// the rest of the work while ungated ones keep succeeding, and the turn
// still reports success. That is the 2026-11-11 failure.
test("a turn with nothing outstanding is over", () => {
  assert.equal(outstandingWork({}).total, 0);
  assert.equal(outstandingWork({ queued: 0, unanswered: 0, backgroundTasks: [] }).total, 0);
});

test("a message still QUEUED holds the turn open", () => {
  // The race that a delivered-only check misses: the result lands while the
  // fold is still in the queue, so nothing is "unanswered" — and the drain
  // then yields it on the way out, which is the original bug by another road.
  assert.equal(outstandingWork({ queued: 1 }).total, 1);
});

test("a message delivered but unanswered holds the turn open", () => {
  assert.equal(outstandingWork({ unanswered: 1 }).total, 1);
});

test("a live background task holds the turn open", () => {
  // The one that actually bit: a backgrounded Bash job reported in six
  // milliseconds after the turn's result.
  const tasks = [{ task_id: "t1", task_type: "local_bash", ambient: false }];
  assert.equal(outstandingWork({ backgroundTasks: tasks }).total, 1);
});

test("AMBIENT tasks do not, or no turn would ever end", () => {
  // The SDK's own flag for work that is "not activity ... hosts should
  // exclude them from activity indicators" — live-update watchers that may
  // never finish.
  const tasks = [
    { task_id: "t1", task_type: "watcher", ambient: true },
    { task_id: "t2", task_type: "local_bash" },
  ];
  const r = outstandingWork({ backgroundTasks: tasks });
  assert.equal(r.backgroundTasks, 1);
  assert.equal(r.total, 1);
});

test("the three sources are counted separately, not conflated", () => {
  const r = outstandingWork({
    queued: 2, unanswered: 3,
    backgroundTasks: [{ task_id: "a" }, { task_id: "b", ambient: true }],
  });
  assert.deepEqual(r, { queued: 2, unanswered: 3, backgroundTasks: 1, total: 6 });
});

test("junk in the task list cannot crash the decision", () => {
  assert.equal(outstandingWork({ backgroundTasks: null }).total, 0);
  assert.equal(outstandingWork({ backgroundTasks: [null, undefined] }).total, 0);
});
