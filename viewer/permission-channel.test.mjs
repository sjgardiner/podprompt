// Tests for the permission-channel failure detector; see
// permission-channel.mjs for what the failure is and how it was reproduced.
//
// The detector is worth testing properly rather than trusting in place: it is
// a substring match buried in a stream loop, it fires on a condition that is
// rare and hard to stage on demand, and both ways of getting it wrong are
// bad. Too eager and it cries outage during ordinary denials; too narrow and
// it stays silent through the exact event it exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countPermissionChannelFailures } from "./permission-channel.mjs";

const toolResult = (text) => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: text }] },
});

test("detects the real failure text the CLI emits", () => {
  assert.equal(
    countPermissionChannelFailures(
      toolResult("Tool permission request failed: AbortError: Stream closed")),
    1,
  );
});

test("counts every failing result in one message", () => {
  const msg = {
    type: "user",
    message: {
      content: [
        { type: "tool_result", content: "Tool permission request failed: AbortError: Stream closed" },
        { type: "tool_result", content: "ok" },
        { type: "tool_result", content: "Tool permission request failed: AbortError: Stream closed" },
      ],
    },
  };
  assert.equal(countPermissionChannelFailures(msg), 2);
});

test("does not fire on ordinary tool failures", () => {
  // The distinction that matters: a tool that ran and failed, or a DENIED
  // permission, are both normal. Only an undeliverable request is the bug.
  for (const text of [
    "Error: ENOENT: no such file or directory",
    "The user doesn't want to proceed with this tool use",
    "Command failed with exit code 1",
    "permission denied",
  ]) {
    assert.equal(countPermissionChannelFailures(toolResult(text)), 0, text);
  }
});

test("handles structured (non-string) tool_result content", () => {
  const msg = {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        content: [{ type: "text", text: "Tool permission request failed: AbortError: Stream closed" }],
      }],
    },
  };
  assert.equal(countPermissionChannelFailures(msg), 1);
});

test("ignores everything that is not a user message with tool results", () => {
  assert.equal(countPermissionChannelFailures(null), 0);
  assert.equal(countPermissionChannelFailures({}), 0);
  assert.equal(countPermissionChannelFailures({ type: "assistant" }), 0);
  assert.equal(countPermissionChannelFailures({ type: "user" }), 0);
  assert.equal(countPermissionChannelFailures({ type: "user", message: {} }), 0);
  assert.equal(
    countPermissionChannelFailures({ type: "user", message: { content: "plain text" } }), 0);
  // An assistant message quoting the phrase must not count -- only an actual
  // tool_result does. Otherwise discussing this bug would trigger it, which is
  // not hypothetical: this very session did exactly that for hours.
  assert.equal(countPermissionChannelFailures({
    type: "assistant",
    message: { content: [{ type: "text", text: "Tool permission request failed: ..." }] },
  }), 0);
});
