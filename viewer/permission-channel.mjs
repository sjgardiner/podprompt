// Detecting a turn that has lost its permission channel — pure, no deps.
//
// THE FAILURE. A turn can lose the ability to obtain ANY permission decision
// while continuing to look completely healthy. Tools the CLI permits
// internally (ls, grep, pwd, reads) keep working and text keeps streaming, so
// the turn ends `outcome=completed` and nothing anywhere records that the
// agent could not write a file, run a command or reach an MCP tool for its
// entire duration. From the driver's side it is invisible.
//
// It also impersonates a settings problem, which is what makes it expensive:
// auto-approve is evaluated driver-side inside canUseTool, so when the channel
// carrying that question is the broken thing, every visible setting is correct
// and auto-approve cannot be seen to have failed.
//
// THE TRIGGER, reproduced deliberately 2026-11-10: a background Bash task that
// outlives the turn that started it. The task is a child of that turn's CLI
// process, so ending the turn orphans it; the harness later notices there is
// no completion record and the NEXT turn opens with a task-notification of
// status=stopped. That turn, and only that turn, cannot reach canUseTool.
// Reproduced with a single orphaned task and no other concurrent input, so the
// concurrency present in the original occurrences was incidental.
//
// WHOSE BUG. Claude Code's background-task handling, not podprompt's — and
// claude-code-only, since OpenCode has no background-task mechanism. The
// driver is doing nothing wrong, which is exactly why detection has to be
// explicit rather than falling out of normal error handling.
//
// SCOPE. Detection only. No retry, no abort, no recovery attempt: a turn that
// cannot ask permission also cannot be meaningfully repaired from here, and
// anything automatic risks a loop. The value is that the outage gets named
// while it is happening instead of being reconstructed from transcripts
// afterwards.

// The CLI surfaces an undeliverable request as a tool_result whose text begins
// "Tool permission request failed", usually "...: AbortError: Stream closed".
const FAILURE_MARKER = "Tool permission request failed";

// How many tool results in this message report that the permission request
// itself could not be delivered.
//
// Deliberately narrow. This must NOT fire on a tool that ran and failed, nor
// on a permission that was legitimately DENIED — both are normal. Only a
// request that never reached whoever decides counts, because only that leaves
// the agent unable to get an answer at all.
//
// It also only inspects tool_result blocks, never assistant text. Matching
// prose would mean that discussing this bug triggers it, which is not a
// hypothetical: the session that found it did exactly that for hours.
export function countPermissionChannelFailures(msg) {
  if (!msg || msg.type !== "user") return 0;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (!block || block.type !== "tool_result") continue;
    const text = typeof block.content === "string"
      ? block.content
      : JSON.stringify(block.content ?? "");
    if (text.includes(FAILURE_MARKER)) n++;
  }
  return n;
}
