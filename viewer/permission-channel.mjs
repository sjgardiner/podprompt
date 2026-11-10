// The alarm for a turn that has lost its permission channel — pure, no deps.
//
// THIS IS NOT THE FIX. The cause was found and closed off in
// claude-code.mjs — read turn-binding.mjs for the mechanism. This module is
// what stays behind to tell us if it ever happens again, for a reason we have
// not characterised.
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
// and auto-approve cannot be seen to have failed. That combination cost a day
// on 2026-11-10.
//
// WHY IT IS STILL HERE. Of the 33 failures recorded that day, the mechanism we
// found and fixed accounts for the three sustained outages. Seven others have
// no explanation: no orphaned task, no identified trigger. They may share the
// same cause, or not. Until something proves otherwise this alarm is how we
// would find out, and it costs one substring check per message.
//
// SCOPE. Alarm only. No retry, no abort, no recovery attempt: a turn that
// cannot ask permission also cannot be meaningfully repaired from here, and
// anything automatic risks a loop. The value is that the outage gets named
// while it is happening instead of being reconstructed from transcripts
// afterwards.

// The CLI surfaces an undeliverable request as an ERRORED tool_result whose
// text begins with this, usually "...: AbortError: Stream closed". Verified
// against real records: { type: "tool_result", is_error: true,
// content: "Tool permission request failed: AbortError: Stream closed" }.
const FAILURE_MARKER = "Tool permission request failed";

// How many tool results in this message report that the permission request
// itself could not be delivered.
//
// Deliberately narrow, in three separate ways. Each one is load-bearing.
//
// 1. tool_result blocks only, never assistant text. Matching prose would mean
//    that discussing this bug triggers it.
//
// 2. is_error must be true. A successful tool result that merely CONTAINS the
//    phrase is not a failure.
//
// 3. The text must START with the marker, not contain it.
//
// Rules 2 and 3 exist because the obvious `includes` version was wrong, and
// wrong in the least convenient way: it reported three "permission channel
// lost" events during a code review of this very file. Reading
// permission-channel.mjs returns its source — which contains the marker,
// because the marker is defined here — and grepping for the phrase returns
// matching lines. Every such read was counted as an outage. An alarm that
// fires when somebody investigates it is worse than no alarm.
//
// It must also NOT fire on a tool that ran and failed, nor on a permission
// that was legitimately DENIED — both are normal. Only a request that never
// reached whoever decides counts, because only that leaves the agent unable to
// get an answer at all.
//
// Known limitation, stated rather than papered over: if a future CLI stops
// setting is_error on these, this goes quiet. Since the expected firing count
// is already zero, silence would look identical to health. The tests pin the
// exact observed shape so a change to it shows up there first.
export function countPermissionChannelFailures(msg) {
  if (!msg || msg.type !== "user") return 0;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (!block || block.type !== "tool_result" || block.is_error !== true) continue;
    const text = typeof block.content === "string"
      ? block.content
      : JSON.stringify(block.content ?? "");
    if (text.trimStart().startsWith(FAILURE_MARKER)) n++;
  }
  return n;
}
