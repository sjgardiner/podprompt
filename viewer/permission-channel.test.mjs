// Tests for the permission-channel alarm; see permission-channel.mjs for what
// the failure is and why the alarm outlived the fix for it.
//
// Worth testing properly rather than trusting in place: it is a substring
// match buried in a stream loop, it now fires on a condition that should never
// occur, and both ways of getting it wrong are bad. Too eager and it cries
// outage during ordinary denials; too narrow and it stays silent through the
// exact event it exists to catch — and since the expected number of real
// firings is now zero, nothing else would reveal that it had stopped working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countPermissionChannelFailures } from "./permission-channel.mjs";

const toolResult = (text, is_error = true) => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: text, is_error }] },
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
        { type: "tool_result", is_error: true, content: "Tool permission request failed: AbortError: Stream closed" },
        { type: "tool_result", content: "ok" },
        { type: "tool_result", is_error: true, content: "Tool permission request failed: AbortError: Stream closed" },
      ],
    },
  };
  assert.equal(countPermissionChannelFailures(msg), 2);
});

test("the exact shape observed in real transcripts", () => {
  // Pinned verbatim. If the CLI ever changes this shape the alarm goes quiet,
  // and silence is indistinguishable from health -- so this test is the only
  // thing that would notice.
  const msg = {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        content: "Tool permission request failed: AbortError: Stream closed",
        is_error: true,
        tool_use_id: "toolu_01Qvn5HzpBpwBLdLbuW2HxRZ",
      }],
    },
  };
  assert.equal(countPermissionChannelFailures(msg), 1);
});

test("does not fire when a tool merely READS text containing the marker", () => {
  // Not hypothetical: an `includes` version reported three outages during a
  // code review, because reading this module returns its own source and the
  // marker is defined in it. An alarm that fires when somebody investigates
  // it is worse than no alarm.
  const fileRead = "     1\t// The alarm for a turn that has lost its permission channel\n"
    + "     2\tconst FAILURE_MARKER = \"Tool permission request failed\";\n";
  assert.equal(countPermissionChannelFailures(toolResult(fileRead, false)), 0);
  // ...and not even if the read somehow came back flagged as an error.
  assert.equal(countPermissionChannelFailures(toolResult(fileRead, true)), 0);
  // A grep whose output happens to lead with the phrase is still not a failure,
  // because a successful grep is not an errored tool result.
  assert.equal(countPermissionChannelFailures(
    toolResult("Tool permission request failed: AbortError: Stream closed", false)), 0);
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

test("ignores structured (non-string) tool_result content", () => {
  // The real shape is a plain string. A JSON-serialised array starts with "[",
  // so it cannot lead with the marker -- deliberately not special-cased: every
  // observed failure is a string, and loosening this is how the false-positive
  // bug got in.
  const msg = {
    type: "user",
    message: {
      content: [{
        type: "tool_result",
        is_error: true,
        content: [{ type: "text", text: "Tool permission request failed: AbortError: Stream closed" }],
      }],
    },
  };
  assert.equal(countPermissionChannelFailures(msg), 0);
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
