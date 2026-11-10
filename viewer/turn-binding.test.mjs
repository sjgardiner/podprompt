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
import { resultBelongsToTurn, isForeignResult } from "./turn-binding.mjs";

const MINE = "57fba329-b833-47d4-9abd-746db12312fd";
const OTHER = "a47ac131-42fc-42a1-a9ae-b5c5fd0e3e84";

test("binds a result carrying our uuid in the list", () => {
  const msg = { type: "result", subtype: "success", user_message_uuid: MINE, user_message_uuids: [MINE] };
  assert.equal(resultBelongsToTurn(msg, MINE), true);
  assert.equal(isForeignResult(msg, MINE), false);
});

test("the early result observed in the wild carries no uuid at all", () => {
  // Verbatim shape from the reproduction: Claude Code dismissing an orphaned
  // background task emits a complete result ~1ms after init, with both uuid
  // fields absent because no user message caused it.
  const msg = { type: "result", subtype: "success", queued_turn_count: 0 };
  assert.equal(resultBelongsToTurn(msg, MINE), false);
  assert.equal(isForeignResult(msg, MINE), true);
});

test("a result for somebody else's prompt is not ours", () => {
  const msg = { type: "result", user_message_uuid: OTHER, user_message_uuids: [OTHER] };
  assert.equal(resultBelongsToTurn(msg, MINE), false);
  assert.equal(isForeignResult(msg, MINE), true);
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
    assert.equal(isForeignResult(msg, MINE), false);
  }
});

test("without a uuid of our own, nothing binds", () => {
  // Defensive: a turn that somehow lost its uuid must not start matching
  // arbitrary results. The safety net ends such a turn instead.
  const msg = { type: "result", user_message_uuid: undefined };
  assert.equal(resultBelongsToTurn(msg, undefined), false);
  assert.equal(resultBelongsToTurn(msg, null), false);
});
