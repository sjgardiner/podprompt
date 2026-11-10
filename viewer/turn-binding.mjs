// Which `result` message ends OUR turn — pure, no dependencies.
//
// WHY THIS HAS TO BE DECIDED AT ALL
// ---------------------------------
// A single query can produce more than one `result`. Claude Code runs its own
// queued work as complete little turns of its own, each with a result: most
// visibly, a leftover background task from a previous turn is reported and
// dismissed in about two milliseconds at session start, before our prompt is
// looked at.
//
// That matters because of how the SDK ends a turn. We hand it a prompt
// generator; when that generator finishes, the SDK waits for the FIRST result
// and then closes stdin to the CLI (its own debug line: "Calling
// transport.endInput() to close stdin to CLI process"). canUseTool answers
// travel over that same stdin. So a result that is not ours, treated as ours,
// silently ends the permission channel for the rest of a turn that then keeps
// running — tools the CLI permits internally keep working, text keeps
// streaming, and the turn still reports success. That is exactly the failure
// that cost a day on 2026-11-10.
//
// HOW WE TELL
// -----------
// We stamp every prompt with a uuid (we already did, for the chat bubble), and
// the CLI echoes it back on the result for the turn that consumed it. The
// SDK's own type documentation describes this as the intended use:
//
//     "a consumer that sent any of them can bind this result to its own send
//      by finding its uuid anywhere in the list"
//
// Measured on the failing case: the early result carries NO user-message uuid
// at all, because no user message caused it; ours carries exactly the uuid we
// sent. So this is a structural test, not a timing one — no delay, no
// threshold, and no dependence on knowing what produced the early result.
//
// `user_message_uuids` is the authoritative field: several prompts sent close
// together can be merged into one turn, and then only the LAST one appears in
// the singular `user_message_uuid`. We check the list first and fall back to
// the singular field, which the same documentation prescribes for producers
// that do not send the list.

// Does this message end the turn that sent `uuid`?
//
// Returns false for anything that is not a result, so it is safe to call on
// every message in the stream.
export function resultBelongsToTurn(msg, uuid) {
  if (!msg || msg.type !== "result" || !uuid) return false;
  const list = msg.user_message_uuids;
  if (Array.isArray(list)) return list.includes(uuid);
  return msg.user_message_uuid === uuid;
}

// Is this a result that is NOT ours?
//
// Called out separately because it is the condition the turn's safety net
// arms on, and "result that isn't ours" reads better at the call site than a
// negated binding check. See the safety net in claude-code.mjs for why only
// this case needs one: an unmatched result is the single situation where we
// now keep listening where the old code would have stopped.
export function isForeignResult(msg, uuid) {
  return !!msg && msg.type === "result" && !resultBelongsToTurn(msg, uuid);
}
