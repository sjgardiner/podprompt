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

// What the turn's safety net should do on one tick. Pulled out here because
// the policy is the part worth pinning down, and a decision buried in a timer
// callback cannot be tested at all.
//
// The net watches the silence after a result that was not ours, and gives up
// if that silence runs long. Three outcomes:
//
//   "defer"    a permission card is waiting on a human. Not a stall at any
//              duration — and the caller restarts the clock, so answering
//              after an hour still leaves the full grace for whatever the
//              turn does next.
//   "wait"     silent, but not for long enough yet.
//   "give-up"  silent past the grace with nobody to blame. End the turn.
//
// "defer" outranks "give-up" deliberately. The first draft of the net was a
// one-shot timer that simply returned when a human was pending, which retired
// it for the rest of the turn — and since the unmatched result arrives about a
// millisecond in, its window lines up precisely with the moment an unanswered
// card is most likely. A genuinely wedged turn would then never end.
export function safetyNetAction({ msSinceLastMessage, pendingPermissions, graceMs }) {
  if (pendingPermissions > 0) return "defer";
  if (msSinceLastMessage < graceMs) return "wait";
  return "give-up";
}

// Does this turn still have work the model has not finished?
//
// A `result` is the end of a BATCH OF WORK, not necessarily the end of the
// turn — and the difference matters because the generator finishing is what
// makes the SDK close stdin, which is the channel canUseTool's answers travel
// over. Open the gate while the model still has something to do and it is
// handed work it cannot get permission to perform: every gated tool call
// fails for the rest of that work while ungated ones keep succeeding, so the
// turn still looks healthy. That is the failure of 2026-11-11.
//
// Three sources, each read from something the runtime STATES ABOUT ITSELF —
// no timing in this decision:
//
//   queued         messages in our own input queue, not yet handed over.
//                  Tracked separately from `unanswered` deliberately: a
//                  message still queued has not been delivered, so a check
//                  that only looked at deliveries would let the gate open and
//                  then yield it on the way out — which is the original bug
//                  exactly, reached by a different route.
//   unanswered     messages we delivered that no result has accounted for
//                  (`user_message_uuids`).
//   backgroundTasks the CLI's own live background work, from
//                  `background_tasks_changed` — REPLACE semantics, so it is a
//                  snapshot rather than a counter and cannot drift.
//
// AMBIENT TASKS DO NOT COUNT. The SDK flags them itself: "True for tasks that
// are not activity (every skip_transcript task, plus every live-update
// watcher, requested or auto-started); hosts should exclude them from
// activity indicators." Those may never finish, so counting them would hold
// every turn open until the safety net fired.
export function outstandingWork({ queued = 0, unanswered = 0, backgroundTasks = [] } = {}) {
  const live = (Array.isArray(backgroundTasks) ? backgroundTasks : [])
    .filter((t) => t && !t.ambient).length;
  return { queued, unanswered, backgroundTasks: live, total: queued + unanswered + live };
}
